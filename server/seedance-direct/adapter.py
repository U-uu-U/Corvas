"""Translate the numeric-task video API to the existing relay video contract."""
import datetime
import http.client
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = os.environ['UPSTREAM'].rstrip('/')
MODEL = 'b_seedance_v2.0'
MAX_JSON = 1024 * 1024
TASK_ID = re.compile(r'^[1-9][0-9]{0,18}$')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


HTTP = urllib.request.build_opener(NoRedirect)


def request_json(path, auth, body=None):
    headers = {'Authorization': auth, 'Accept': 'application/json', 'User-Agent': 'Corvas-Video-Adapter/1.0'}
    data = None
    if body is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(body).encode('utf-8')
    with HTTP.open(urllib.request.Request(UPSTREAM + path, data=data, headers=headers), timeout=45) as response:
        payload = response.read(MAX_JSON + 1)
        if len(payload) > MAX_JSON:
            raise ValueError('Task response exceeds the JSON limit')
        decoded = json.loads(payload)
        if not isinstance(decoded, dict):
            raise ValueError('Task response must be a JSON object')
        return decoded


def public_url(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('Reference or result URL is missing')
    parsed = urllib.parse.urlsplit(value.strip())
    if parsed.scheme not in ('https', 'http') or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError('Reference or result must use an HTTP(S) URL')
    return value.strip()


def build_request(body):
    if not isinstance(body, dict) or body.get('model') != MODEL:
        raise ValueError('Unsupported video model')
    prompt = body.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError('prompt is required')
    seconds = body.get('seconds', body.get('duration', 15))
    if isinstance(seconds, bool) or seconds not in (15, '15'):
        raise ValueError('This video model requires exactly 15 seconds')
    ratio = body.get('aspect_ratio', body.get('ratio', '9:16'))
    if ratio not in ('9:16', '16:9'):
        raise ValueError('aspect_ratio must be 9:16 or 16:9')
    images = next((body[key] for key in ('reference_images', 'image_urls', 'images') if key in body), [])
    if not isinstance(images, list) or len(images) > 9:
        raise ValueError('At most 9 reference images are supported')
    images = [public_url(value.get('url', value.get('image_url')) if isinstance(value, dict) else value)
              for value in images]
    if any(body.get(key) for key in ('video_urls', 'videos', 'reference_videos', 'audio_urls', 'audios', 'reference_audios')):
        raise ValueError('This video model accepts image references only')
    result = {'model': MODEL, 'prompt': prompt, 'seconds': 15, 'aspect_ratio': ratio}
    if images:
        result['reference_images'] = images
    return result


def task_id(payload):
    value = payload.get('task_id')
    if isinstance(value, bool) or not TASK_ID.fullmatch(str(value)):
        raise ValueError('Response does not contain a valid numeric task ID')
    return str(value)


def submit(body, auth):
    payload = request_json('/v1/videos/generations', auth, build_request(body))
    task = task_id(payload)
    return {'id': task, 'task_id': task, 'object': 'video', 'status': 'queued'}


def poll(task, auth):
    phase = 'task'
    try:
        payload = request_json('/v1/tasks/' + task, auth)
        if task_id(payload) != task:
            raise ValueError('Task response does not match the requested task ID')
        state = payload.get('status')
        if state in ('pending', 'processing'):
            return {'id': task, 'task_id': task, 'status': 'queued' if state == 'pending' else 'in_progress'}
        if state == 'failed':
            completed_at = payload.get('completed_at')
            if not isinstance(completed_at, str):
                raise ValueError('Failure is missing a terminal timestamp')
            datetime.datetime.fromisoformat(completed_at.replace('Z', '+00:00'))
            error = payload.get('error') or payload.get('error_message') or 'Video generation failed'
            return {'id': task, 'task_id': task, 'status': 'failed',
                    'error': error if isinstance(error, dict) else {'message': str(error)},
                    'completed_at': completed_at}
        if state != 'completed':
            raise ValueError('Unrecognized task status')
        phase = 'media'
        # The documented download_url is JSON with a short-lived token, never an MP4.
        resolved = request_json('/v1/tasks/' + task + '/url', auth)
        if task_id(resolved) != task:
            raise ValueError('Resolved media belongs to another task')
        return {'id': task, 'task_id': task, 'object': 'video', 'status': 'completed', 'progress': 100,
                'video_url': public_url(resolved.get('url')), 'completed_at': payload.get('completed_at')}
    except (OSError, http.client.HTTPException, ValueError, TypeError, KeyError) as error:
        print(json.dumps({'event': 'query_unavailable', 'task_id': task, 'phase': phase,
                          'http_status': getattr(error, 'code', None), 'error_type': type(error).__name__}), flush=True)
        # The relay treats polling HTTP failures as terminal and refunds them. A query failure
        # must stay nonterminal here; the public gateway turns this marker into retryable 503.
        return {'id': task, 'task_id': task, 'status': 'in_progress',
                'corvas_query_state': 'unavailable', 'retry_after': 5, 'remote_completed': phase == 'media'}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.handle_request(False)

    def do_POST(self):
        self.handle_request(True)

    def handle_request(self, submitting):
        path = urllib.parse.urlsplit(self.path).path
        if path == '/health' and not submitting:
            return self.reply(200, {'ok': True, 'adapter': 'seedance-direct-v1'})
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Bearer ') or len(auth) < 9:
            return self.reply(401, {'error': {'message': 'Bearer authentication required'}})
        try:
            if submitting:
                if path not in ('/v1/videos', '/v1/video/generations', '/v1/videos/generations'):
                    return self.reply(404, {'error': {'message': 'Unsupported submission path'}})
                length = int(self.headers.get('Content-Length', 0))
                if length <= 0 or length > MAX_JSON:
                    return self.reply(413, {'error': {'message': 'Invalid request size'}})
                try:
                    body = build_request(json.loads(self.rfile.read(length)))
                except (ValueError, TypeError, AttributeError) as error:
                    return self.reply(400, {'error': {'message': str(error)}})
                return self.reply(202, submit(body, auth))
            match = re.fullmatch(r'/v1/(?:videos(?:/generations)?|video/generations|tasks)/([1-9][0-9]{0,18})', path)
            if not match:
                return self.reply(404, {'error': {'message': 'Unsupported task path'}})
            return self.reply(200, poll(match[1], auth))
        except urllib.error.HTTPError as error:
            try:
                payload = json.loads(error.read(MAX_JSON))
                if not isinstance(payload, dict) or 'error' not in payload:
                    raise ValueError('Invalid error envelope')
            except (ValueError, TypeError):
                payload = {'error': {'message': 'Video service returned HTTP ' + str(error.code)}}
            return self.reply(error.code, payload)
        except Exception:
            return self.reply(502, {'error': {
                'code': 'VIDEO_SUBMISSION_UNKNOWN' if submitting else 'VIDEO_QUERY_UNAVAILABLE',
                'message': 'Submission response unavailable; preserve this task and do not resubmit automatically'
                if submitting else 'Task query or media resolution unavailable; retry the same task ID'}})


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 3011), Handler).serve_forever()
