"""Video-only adapter for the documented Dola 2.5 discount route."""
import http.client
from collections import OrderedDict
import hashlib
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from media import ensure_media, init as init_media

UPSTREAM = 'http://160.202.238.97:3000'
MODEL = 'dola2.5\u7279\u4ef7'
TASK_ID = re.compile(r'^[A-Za-z0-9_-]{1,200}$')
MAX_JSON = 1024 * 1024
RATIOS = ('16:9', '9:16', '1:1')
CACHE = OrderedDict()
CACHE_LOCK = threading.Lock()
POLL_LOCKS = [threading.Lock() for _ in range(32)]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
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
            raise ValueError('Response exceeds the JSON limit')
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError('Response must be a JSON object')
        return payload


def public_url(value):
    if isinstance(value, dict):
        value = value.get('url', value.get('image_url'))
    if not isinstance(value, str):
        raise ValueError('Reference or result URL is missing')
    parsed = urllib.parse.urlsplit(value.strip())
    if parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('Use a public HTTP(S) reference URL; upload local images first')
    if parsed.hostname in ('localhost', '127.0.0.1', '::1'):
        raise ValueError('Local reference addresses are not supported')
    return value.strip()


def build_request(body):
    if not isinstance(body, dict) or body.get('model') != MODEL:
        raise ValueError('Unsupported video model')
    prompt = body.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 5000:
        raise ValueError('prompt must contain 1 to 5000 characters')
    seconds = body.get('seconds', body.get('duration', 4))
    if isinstance(seconds, str) and re.fullmatch(r'[0-9]+', seconds):
        seconds = int(seconds)
    if isinstance(seconds, bool) or not isinstance(seconds, int) or not 4 <= seconds <= 30:
        raise ValueError('seconds must be an integer from 4 to 30')
    ratios = [body[key] for key in ('size', 'ratio', 'aspect_ratio') if key in body]
    ratio = ratios[0] if ratios else '16:9'
    if ratio not in RATIOS or any(value != ratio for value in ratios):
        raise ValueError('size must be 16:9, 9:16 or 1:1, without conflicting ratio aliases')
    if any(body.get(key) for key in ('videos', 'video_urls', 'reference_videos', 'videoUrls',
                                     'audios', 'audio_urls', 'reference_audios', 'audioUrls')):
        raise ValueError('This route has no documented video or audio reference support')
    sources = [body[key] for key in ('images', 'image_urls', 'reference_images', 'imageUrls') if key in body]
    if any(value != sources[0] for value in sources[1:]):
        raise ValueError('Conflicting image reference fields')
    images = sources[0] if sources else []
    if not isinstance(images, list) or len(images) > 10:
        raise ValueError('At most 10 reference images are supported')
    if body.get('input_reference'):
        if images:
            raise ValueError('Use images or input_reference, not both')
        images = [body['input_reference']]
    frames = {key: public_url(body[key]) for key in ('first_frame_url', 'last_frame_url') if body.get(key)}
    if images and frames:
        raise ValueError('Use image references or first/last frames, not both')
    if body.get('n', 1) != 1 or isinstance(body.get('n'), bool):
        raise ValueError('n must be 1')
    result = {'model': MODEL, 'prompt': prompt, 'seconds': seconds, 'size': ratio, 'aspect_ratio': ratio}
    if images:
        result['images'] = [public_url(value) for value in images]
    result.update(frames)
    if 'request_id' in body:
        if not isinstance(body['request_id'], str) or not TASK_ID.fullmatch(body['request_id']):
            raise ValueError('Invalid request_id')
        result['request_id'] = body['request_id']
    return result


def task_id(payload):
    value = payload.get('task_id') or payload.get('id')
    if not isinstance(value, str) or not TASK_ID.fullmatch(value):
        raise ValueError('Response contains no valid task ID')
    if payload.get('task_id') and payload.get('id') and payload['task_id'] != payload['id']:
        raise ValueError('Conflicting task IDs')
    return value


def error_detail(payload):
    value = payload.get('error') or payload.get('message') or payload.get('error_message')
    if isinstance(value, dict):
        value = value.get('message')
    return {'message': value if isinstance(value, str) and value else 'Video service request failed'}


def submit(body, auth):
    payload = request_json('/v1/video/generations', auth, build_request(body))
    payload = payload.get('data') if isinstance(payload.get('data'), dict) else payload
    task = task_id(payload)
    return {'id': task, 'task_id': task, 'object': 'video', 'status': 'queued', 'poll_after_seconds': 60}


def query_task(task, auth):
    key = hashlib.sha256((auth + '\0' + task).encode()).hexdigest()
    with POLL_LOCKS[int(key[:8], 16) % len(POLL_LOCKS)]:
        with CACHE_LOCK:
            cached = CACHE.get(key)
            if cached and time.monotonic() - cached[0] < 60:
                return cached[1]
        try:
            envelope = request_json('/v1/video/generations/' + urllib.parse.quote(task, safe=''), auth)
        except urllib.error.HTTPError as error:
            if error.code not in (404, 405):
                raise
            error.close()
            envelope = request_json('/v1/videos/' + urllib.parse.quote(task, safe=''), auth)
        payload = envelope.get('data') if isinstance(envelope.get('data'), dict) else envelope
        if envelope.get('success') is False or payload.get('success') is False:
            raise ValueError('Task query failed')
        if (payload.get('task_id') or payload.get('id')) and task_id(payload) != task:
            raise ValueError('Task query returned a different task')
        with CACHE_LOCK:
            CACHE[key] = (time.monotonic(), payload)
            CACHE.move_to_end(key)
            while len(CACHE) > 1024:
                CACHE.popitem(last=False)
        return payload


def poll(task, auth):
    completed = False
    try:
        payload = query_task(task, auth)
        result = {'id': task, 'task_id': task, 'object': 'video', 'poll_after_seconds': 60}
        state = payload.get('status')
        if state in ('queued', 'in_progress', 'processing'):
            return {**result, 'status': 'queued' if state == 'queued' else 'in_progress'}
        if state == 'failed':
            return {**result, 'status': 'failed', 'error': error_detail(payload)}
        if state not in ('completed', 'succeeded'):
            raise ValueError('Unknown task status')
        completed = True
        url = ensure_media(UPSTREAM, task, auth)
        if not url:
            return {**result, 'status': 'in_progress', 'stage': 'downloading', 'remote_completed': True}
        return {**result, 'status': 'completed', 'progress': 100, 'video_url': url}
    except (OSError, http.client.HTTPException, ValueError, TypeError) as error:
        print(json.dumps({'event': 'query_unavailable', 'task_id': task,
                          'http_status': getattr(error, 'code', None), 'error_type': type(error).__name__}), flush=True)
        return {'id': task, 'task_id': task, 'status': 'in_progress', 'corvas_query_state': 'unavailable',
                'remote_completed': completed, 'retry_after': 60, 'poll_after_seconds': 60}


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
            return self.reply(200, {'ok': True, 'adapter': 'dola-discount-v1'})
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
                        return self.reply(413, {'error': {'message': 'Request too large; use public reference URLs'}})
                    body = build_request(json.loads(self.rfile.read(length)))
                except (ValueError, TypeError) as error:
                    return self.reply(400, {'error': {'message': str(error)}})
                return self.reply(202, submit(body, auth))
            match = re.fullmatch(r'/v1/(?:videos|video/generations|tasks)/([A-Za-z0-9_-]{1,200})', path)
            if not match:
                return self.reply(404, {'error': {'message': 'Unsupported query path'}})
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
    ThreadingHTTPServer(('0.0.0.0', 3013), Handler).serve_forever()
