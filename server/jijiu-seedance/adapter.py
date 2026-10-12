"""Normalize Jijiu references and signed results for the existing relay contract."""
import http.client
import ipaddress
import json
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SPEC = json.loads(Path(__file__).with_name('model.json').read_text(encoding='utf-8'))
MAX_JSON = 1024 * 1024
TASK_ID = re.compile(r'^[A-Za-z0-9_-]{1,200}$')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


HTTP = urllib.request.build_opener(NoRedirect())


def request_json(path, auth, body=None):
    headers = {'Authorization': auth, 'Accept': 'application/json', 'User-Agent': 'Corvas-Video-Adapter/1.0'}
    data = None
    if body is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    with HTTP.open(urllib.request.Request(SPEC['origin']+path, data=data, headers=headers), timeout=90) as response:
        raw = response.read(MAX_JSON+1)
        if len(raw) > MAX_JSON:
            raise ValueError('Response exceeds JSON limit')
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError('Response must be a JSON object')
        return payload


def public_url(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('A public reference URL is required')
    value = value.strip()
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or any(c.isspace() for c in value):
        raise ValueError('A public HTTP(S) reference URL is required')
    if parsed.hostname.lower() in ('localhost', 'localhost.localdomain'):
        raise ValueError('Local references are not supported')
    try:
        address = ipaddress.ip_address(parsed.hostname)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise ValueError('Local references are not supported')
    return value


def field(body, keys, default=None):
    values = [body[key] for key in keys if key in body]
    if any(value != values[0] for value in values[1:]):
        raise ValueError('Conflicting fields: '+', '.join(keys))
    return values[0] if values else default


def references(body, keys, maximum):
    value = field(body, keys, [])
    if not isinstance(value, list) or len(value) > maximum:
        raise ValueError(f'{keys[0]} accepts at most {maximum} references')
    result = []
    for item in value:
        if isinstance(item, dict):
            item = field(item, ('url', 'image_url', 'video_url', 'audio_url'))
            if isinstance(item, dict):
                item = item.get('url')
        result.append(public_url(item))
    return result


def build_request(body):
    if not isinstance(body, dict) or body.get('model') != SPEC['model']:
        raise ValueError('Unsupported video model')
    prompt = body.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError('prompt is required')
    seconds = field(body, ('duration', 'seconds'), 5)
    if isinstance(seconds, str) and re.fullmatch(r'[0-9]+', seconds):
        seconds = int(seconds)
    if isinstance(seconds, bool) or not isinstance(seconds, int) or not 4 <= seconds <= 30:
        raise ValueError('seconds must be an integer between 4 and 30')
    ratio = field(body, ('ratio', 'aspect_ratio'), '16:9')
    if ratio not in SPEC['ratios']:
        raise ValueError('aspect_ratio must be 16:9, 9:16 or 1:1')
    if field(body, ('resolution', 'resolution_tier'), '720p') != '720p':
        raise ValueError('resolution must be 720p')
    if any(body.get(key) for key in ('first_frame_image', 'last_frame_image', 'input_reference')):
        raise ValueError('Use images for reference inputs')
    return {'model': SPEC['upstreamModel'], 'prompt': prompt, 'seconds': seconds, 'resolution': '720p', 'aspect_ratio': ratio,
            'images': references(body, ('images', 'image_urls', 'reference_images'), SPEC['images']),
            'reference_videos': references(body, ('videos', 'video_urls', 'reference_videos'), SPEC['videos']),
            'reference_audios': references(body, ('audio_urls', 'audios', 'reference_audios'), SPEC['audios'])}


def task_id(payload):
    task = payload.get('id')
    if not isinstance(task, str) or not TASK_ID.fullmatch(task):
        raise ValueError('Response has no valid task ID')
    return task


def error_detail(payload):
    error = payload.get('error') or payload.get('message') or 'Video generation failed'
    if isinstance(error, dict):
        return {key: error[key] for key in ('message', 'code', 'type', 'param') if isinstance(error.get(key), (str, int, float))}
    return {'message': error if isinstance(error, str) else 'Video generation failed'}


def submit(body, auth):
    payload = request_json('/v1/videos', auth, build_request(body))
    task = task_id(payload)
    return {'id': task, 'task_id': task, 'object': 'video', 'status': 'queued', 'poll_after_seconds': 10}


def media_url(payload, task):
    video = payload.get('video') if isinstance(payload.get('video'), dict) else {}
    candidates = [payload.get('content_url'), video.get('content_url'), video.get('url'),
                  video.get('video_url'), video.get('download_url'),
                  payload.get('video_url'), payload.get('download_url'), payload.get('url')]
    for candidate in candidates:
        if not candidate:
            continue
        try:
            value = public_url(candidate)
        except ValueError:
            continue
        parsed = urllib.parse.urlsplit(value)
        if parsed.netloc == urllib.parse.urlsplit(SPEC['origin']).netloc and parsed.path.startswith('/v1/'):
            if (parsed.scheme+'://'+parsed.netloc == SPEC['origin'] and urllib.parse.parse_qs(parsed.query).get('access')
                    and parsed.path.startswith('/v1/tasks/'+task+'/artifacts/') and parsed.path.endswith('/content')):
                return value
        else:
            return value
    raise ValueError('Completed task is missing downloadable media')


def poll(task, auth):
    completed = False
    try:
        payload = request_json('/v1/videos/'+task, auth)
        if task_id(payload) != task:
            raise ValueError('Task identity mismatch')
        result = {'id': task, 'task_id': task, 'object': 'video', 'poll_after_seconds': 10}
        for key in ('created_at', 'completed_at'):
            if isinstance(payload.get(key), (int, float)) and not isinstance(payload[key], bool) and payload[key] > 0:
                result[key] = payload[key]
        state = payload.get('status')
        if state in ('queued', 'in_progress'):
            return {**result, 'status': state}
        if state == 'failed':
            return {**result, 'status': 'failed', 'error': error_detail(payload)}
        if state != 'completed':
            raise ValueError('Unknown task status')
        completed = True
        return {**result, 'status': 'completed', 'progress': 100, 'video_url': media_url(payload, task)}
    except (OSError, http.client.HTTPException, ValueError, TypeError, KeyError):
        return {'id': task, 'task_id': task, 'status': 'in_progress', 'corvas_query_state': 'unavailable',
                'remote_completed': completed, 'retry_after': 10, 'poll_after_seconds': 10}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.handle_request(False)

    def do_POST(self):
        self.handle_request(True)

    def handle_request(self, submitting):
        path = urllib.parse.urlsplit(self.path).path
        if path == '/health' and not submitting:
            return self.reply(200, {'ok': True, 'adapter': 'jijiu-video-v1'})
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Bearer ') or len(auth) < 9:
            return self.reply(401, {'error': {'message': 'Bearer authentication required'}})
        try:
            if submitting:
                if path not in ('/v1/videos', '/v1/video/generations'):
                    return self.reply(404, {'error': {'message': 'Unsupported submission path'}})
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    if not 0 < length <= MAX_JSON:
                        return self.reply(413, {'error': {'message': 'Invalid request size'}})
                    body = json.loads(self.rfile.read(length))
                    build_request(body)
                except (ValueError, TypeError, AttributeError) as error:
                    return self.reply(400, {'error': {'message': str(error)}})
                return self.reply(202, submit(body, auth))
            match = re.fullmatch(r'/v1/(?:videos|video/generations|tasks)/([A-Za-z0-9_-]{1,200})', path)
            if not match:
                return self.reply(404, {'error': {'message': 'Unsupported task path'}})
            return self.reply(200, poll(match[1], auth))
        except urllib.error.HTTPError as error:
            try:
                detail = error_detail(json.loads(error.read(MAX_JSON)))
            except (ValueError, TypeError, AttributeError):
                detail = {'message': 'Video service returned HTTP '+str(error.code)}
            return self.reply(error.code if 400 <= error.code <= 599 else 502, {'error': detail})
        except Exception:
            return self.reply(502, {'error': {'code': 'VIDEO_SUBMISSION_UNKNOWN',
                'message': 'Submission response unavailable; preserve this task and do not resubmit automatically'}})


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 3014), Handler).serve_forever()
