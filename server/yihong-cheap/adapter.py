"""Normalize the canvas video contract for Yihong Cheap; no automatic submissions."""
import http.client
import ipaddress
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from media import ensure_media, init as init_media

UPSTREAM = 'https://yihongapi.com'
MODEL = 'yh-video-v25-cheap'
UPSTREAM_MODEL = 'seedance2.5 cheap'
RATIOS = ('16:9', '9:16', '1:1', '4:3', '3:4', '21:9')
TASK_ID = re.compile(r'^[A-Za-z0-9_-]{1,200}$')
MAX_JSON = 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_):
        return None


HTTP = urllib.request.build_opener(NoRedirect)


def request_json(path, auth, body=None):
    headers = {'Authorization': auth, 'Accept': 'application/json', 'Cache-Control': 'no-cache'}
    data = None
    if body is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    with HTTP.open(urllib.request.Request(UPSTREAM + path, data=data, headers=headers), timeout=60) as response:
        raw = response.read(MAX_JSON + 1)
        if len(raw) > MAX_JSON:
            raise ValueError('Response exceeds JSON size limit')
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError('Response must be an object')
        return result


def public_url(value):
    if isinstance(value, dict):
        value = value.get('url') or value.get('image_url')
    if not isinstance(value, str):
        raise ValueError('Reference image URL is required')
    url = urllib.parse.urlsplit(value.strip())
    if url.scheme not in ('https', 'http') or not url.hostname or url.username or url.password:
        raise ValueError('Reference images require public HTTP(S) links; upload the file first')
    if url.hostname.lower() == 'localhost' or url.hostname.lower().endswith(('.local', '.localhost')):
        raise ValueError('Reference image URL must be public')
    try:
        address = ipaddress.ip_address(url.hostname)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise ValueError('Reference image URL must be public')
    return value.strip()


def build_request(body):
    if not isinstance(body, dict) or body.get('model') not in (MODEL, UPSTREAM_MODEL):
        raise ValueError('Unsupported model')
    prompt = body.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError('prompt is required')
    durations = [body[key] for key in ('seconds', 'duration') if key in body]
    def seconds(value):
        if isinstance(value, str) and re.fullmatch(r'[0-9]+', value):
            value = int(value)
        if isinstance(value, bool) or not isinstance(value, int) or not 4 <= value <= 30:
            raise ValueError('seconds must be an integer from 4 to 30')
        return value
    duration = seconds(durations[0]) if durations else 15
    if any(seconds(value) != duration for value in durations):
        raise ValueError('Conflicting duration fields')
    ratios = [body[key] for key in ('ratio', 'aspect_ratio') if key in body]
    ratio = ratios[0] if ratios else '16:9'
    if ratio not in RATIOS or any(value != ratio for value in ratios):
        raise ValueError('ratio must be 16:9, 9:16, 1:1, 4:3, 3:4 or 21:9')
    if body.get('resolution', '720p') != '720p':
        raise ValueError('resolution must be 720p')
    if any(body.get(key) for key in ('videos', 'video_urls', 'reference_videos', 'audios', 'audio_urls', 'reference_audios')):
        raise ValueError('This route supports image references only')
    sources = [body[key] for key in ('images', 'image_urls', 'reference_images') if key in body]
    if any(not isinstance(value, list) for value in sources):
        raise ValueError('image_urls must be an array')
    if any(len(value) > 30 for value in sources):
        raise ValueError('At most 30 reference images are supported')
    normalized = [[public_url(value) for value in source] for source in sources]
    if any(value != normalized[0] for value in normalized[1:]):
        raise ValueError('Conflicting image reference fields')
    images = normalized[0] if normalized else []
    if body.get('input_reference'):
        if images:
            raise ValueError('Use image_urls or input_reference, not both')
        images = [public_url(body['input_reference'])]
    if body.get('n', 1) != 1 or isinstance(body.get('n'), bool):
        raise ValueError('n must be 1')
    result = {'model': UPSTREAM_MODEL, 'prompt': prompt, 'seconds': duration, 'resolution': '720p', 'ratio': ratio}
    if images:
        result['image_urls'] = images
    return result


def unwrap(payload):
    return payload['data'] if isinstance(payload.get('data'), dict) else payload


def task_id(payload):
    value = payload.get('task_id') or payload.get('id')
    if not isinstance(value, str) or not TASK_ID.fullmatch(value):
        raise ValueError('Missing task identifier')
    if payload.get('task_id') and payload.get('id') and payload['task_id'] != payload['id']:
        raise ValueError('Conflicting task identifiers')
    return value


def error_detail(payload):
    value = payload.get('error') or payload.get('message') or payload.get('error_message')
    if isinstance(value, dict):
        value = value.get('message')
    return {'message': value if isinstance(value, str) and value else 'Video service request failed'}


def submit(body, auth):
    payload = unwrap(request_json('/v1/videos', auth, build_request(body)))
    task = task_id(payload)
    return {'id': task, 'task_id': task, 'object': 'video', 'status': 'queued', 'poll_after_seconds': 30}


def poll(task, auth):
    completed = False
    result = {'id': task, 'task_id': task, 'object': 'video', 'poll_after_seconds': 30}
    try:
        envelope = request_json('/v1/videos/' + urllib.parse.quote(task, safe=''), auth)
        payload = unwrap(envelope)
        if envelope.get('success') is False or payload.get('success') is False:
            raise ValueError('Task query unavailable')
        if (payload.get('id') or payload.get('task_id')) and task_id(payload) != task:
            raise ValueError('Task identifier mismatch')
        state = str(payload.get('status', '')).lower()
        if state in ('failed', 'error', 'canceled', 'cancelled', 'rejected'):
            return {**result, 'status': 'failed', 'error': error_detail(payload)}
        if state in ('queued', 'pending', 'processing', 'in_progress', 'running'):
            return {**result, 'status': 'queued' if state in ('queued', 'pending') else 'in_progress'}
        if state not in ('completed', 'success', 'succeeded'):
            raise ValueError('Unknown task status')
        completed = True
        url = ensure_media(UPSTREAM, task, auth)
        if not url:
            return {**result, 'status': 'in_progress', 'stage': 'downloading', 'remote_completed': True}
        return {**result, 'status': 'completed', 'progress': 100, 'video_url': url}
    except (OSError, http.client.HTTPException, ValueError, TypeError) as error:
        print(json.dumps({'event': 'query_unavailable', 'task_id': task,
                          'http_status': getattr(error, 'code', None), 'error_type': type(error).__name__}), flush=True)
        return {**result, 'status': 'in_progress', 'corvas_query_state': 'unavailable', 'remote_completed': completed}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, body):
        raw = json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self.handle_request(False)

    def do_POST(self):
        self.handle_request(True)

    def handle_request(self, submitting):
        path = urllib.parse.urlsplit(self.path).path
        if path == '/health' and not submitting:
            return self.reply(200, {'ok': True, 'adapter': 'yihong-cheap-v1'})
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Bearer ') or len(auth) < 9:
            return self.reply(401, {'error': {'message': 'Bearer authentication required'}})
        try:
            if submitting:
                if path not in ('/v1/videos', '/v1/video/generations'):
                    return self.reply(404, {'error': {'message': 'Unknown submission path'}})
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    if not 0 < length <= MAX_JSON:
                        return self.reply(413, {'error': {'message': 'Request too large; upload reference images first'}})
                    body = build_request(json.loads(self.rfile.read(length)))
                except (ValueError, TypeError) as error:
                    return self.reply(400, {'error': {'message': str(error)}})
                return self.reply(202, submit(body, auth))
            match = re.fullmatch(r'/v1/(?:videos|video/generations|tasks)/([A-Za-z0-9_-]{1,200})', path)
            if not match:
                return self.reply(404, {'error': {'message': 'Unknown task path'}})
            return self.reply(200, poll(match[1], auth))
        except urllib.error.HTTPError as error:
            try:
                detail = error_detail(json.loads(error.read(MAX_JSON)))
            except (ValueError, TypeError, AttributeError):
                detail = {'message': 'Video service returned HTTP ' + str(error.code)}
            return self.reply(error.code if 400 <= error.code <= 599 else 502, {'error': detail})
        except Exception:
            return self.reply(502, {'error': {'code': 'VIDEO_SUBMISSION_UNKNOWN',
                'message': 'Submission response unavailable; preserve the task and do not resubmit automatically'}})


if __name__ == '__main__':
    init_media()
    ThreadingHTTPServer(('0.0.0.0', 3015), Handler).serve_forever()
