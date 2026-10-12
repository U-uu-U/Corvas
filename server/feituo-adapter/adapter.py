"""Adapt the Feituo native video API to the relay's existing async contract."""
import http.client
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = 'https://feituokuajing.com/api/open/v1'
MODELS = {row['model']: row for row in json.loads(Path(__file__).with_name('models.json').read_text(encoding='utf-8'))}
MAX_JSON = 1024 * 1024
JOB_ID = re.compile(r'^[A-Za-z0-9_-]{1,200}$')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


HTTP = urllib.request.build_opener(NoRedirect)


class SubmissionRejected(ValueError):
    def __init__(self, detail):
        super().__init__('Submission rejected')
        self.detail = detail


def request_json(path, auth, body=None):
    headers = {'Authorization': auth, 'X-Public-Model-Ids': '1', 'Accept': 'application/json',
               'Cache-Control': 'no-cache', 'User-Agent': 'Corvas-Video-Adapter/1.0'}
    data = None
    if body is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    with HTTP.open(urllib.request.Request(UPSTREAM + path, data=data, headers=headers), timeout=90) as response:
        raw = response.read(MAX_JSON + 1)
        if len(raw) > MAX_JSON:
            raise ValueError('Response exceeds the JSON limit')
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError('Response must be a JSON object')
        return payload


def public_url(value):
    if not isinstance(value, str):
        raise ValueError('Reference or result must use a public HTTPS URL')
    parsed = urllib.parse.urlsplit(value.strip())
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('Reference or result must use a public HTTPS URL')
    if parsed.hostname in ('localhost', '127.0.0.1', '::1'):
        raise ValueError('Local reference addresses are not supported')
    return value.strip()


def resolve_media_url(value, job):
    url = public_url(value)
    parsed = urllib.parse.urlsplit(url)
    if parsed.hostname != 'feituokuajing.com' or parsed.path not in (
            '/api/video/cache/' + job, '/api/video/result/' + job):
        return url
    # Older clients mistake the signed jobId path for a polling endpoint. Resolve
    # the provider's redirect without forwarding any account credentials.
    for _ in range(5):
        parsed = urllib.parse.urlsplit(public_url(url))
        if parsed.hostname not in ('feituokuajing.com', 'media.feituokuajing.com') or parsed.port not in (None, 443):
            raise ValueError('Unexpected media redirect host')
        request = urllib.request.Request(url, headers={'Range': 'bytes=0-0', 'Accept': 'video/*,application/octet-stream',
                                                      'User-Agent': 'Corvas-Video-Adapter/1.0'})
        try:
            with HTTP.open(request, timeout=20) as response:
                content_type = response.headers.get('Content-Type', '').split(';', 1)[0].strip().lower()
                if not (content_type.startswith('video/') or content_type == 'application/octet-stream'):
                    raise ValueError('Media endpoint returned non-video content')
                if parsed.path.rstrip('/').endswith('/' + job):
                    raise ValueError('Media endpoint has not resolved a downloadable path')
                if not response.read(1):
                    raise ValueError('Media endpoint returned an empty file')
                return url
        except urllib.error.HTTPError as error:
            location = error.headers.get('Location')
            code = error.code
            error.close()
            if code not in (301, 302, 303, 307, 308) or not location:
                raise
            url = urllib.parse.urljoin(url, location)
    raise ValueError('Media redirect limit exceeded')


def field(body, keys, default=None):
    values = [body[key] for key in keys if key in body]
    if any(value != values[0] for value in values[1:]):
        raise ValueError('Conflicting parameters: ' + ', '.join(keys))
    return values[0] if values else default


def references(body, keys, maximum):
    values = field(body, keys, [])
    if not isinstance(values, list) or len(values) > maximum:
        raise ValueError(f'{keys[0]} accepts at most {maximum} references')
    result = []
    for value in values:
        if isinstance(value, dict):
            value = field(value, ('url', 'image_url', 'video_url', 'audio_url'))
            if isinstance(value, dict):
                value = value.get('url')
        result.append(public_url(value))
    return result


def build_request(body):
    if not isinstance(body, dict) or not isinstance(body.get('model'), str) or body['model'] not in MODELS:
        raise ValueError('Unsupported video model')
    spec = MODELS[body['model']]
    prompt = body.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError('prompt is required')
    if spec['promptMaxChars'] and len(prompt) > spec['promptMaxChars']:
        raise ValueError(f"prompt accepts at most {spec['promptMaxChars']} characters")
    duration = field(body, ('duration', 'seconds'), spec['minSeconds'])
    if isinstance(duration, str) and re.fullmatch(r'[0-9]+', duration):
        duration = int(duration)
    if isinstance(duration, bool) or not isinstance(duration, int) or not spec['minSeconds'] <= duration <= spec['maxSeconds']:
        raise ValueError(f"duration must be an integer from {spec['minSeconds']} to {spec['maxSeconds']} seconds")
    if spec.get('durations') and duration not in spec['durations']:
        raise ValueError('duration must be one of '+', '.join(str(value) for value in spec['durations'])+' seconds')
    ratio = field(body, ('ratio', 'aspect_ratio'), '16:9')
    if ratio not in spec['ratios']:
        raise ValueError('ratio must be one of ' + ', '.join(spec['ratios']))
    resolution = field(body, ('resolution', 'resolution_tier'), spec['resolution'])
    if resolution != spec['resolution']:
        raise ValueError('resolution must be ' + spec['resolution'])
    return {'model': body['model'], 'prompt': prompt, 'duration': duration, 'ratio': ratio, 'resolution': resolution,
            'imageUrls': references(body, ('imageUrls', 'image_urls', 'images', 'reference_images'), spec['images']),
            'videoUrls': references(body, ('videoUrls', 'video_urls', 'videos', 'reference_videos'), spec['videos']),
            'audioUrls': references(body, ('audioUrls', 'audio_urls', 'audios', 'reference_audios'), spec['audios'])}


def job_id(payload):
    value = payload.get('jobId')
    if not isinstance(value, str) or not JOB_ID.fullmatch(value):
        raise ValueError('Response has no valid jobId')
    return value


def error_detail(payload, fallback='Video generation failed'):
    # Extract only error fields; costs, quotas, prompts and references never enter the relay result.
    value = payload.get('errorMessage') or payload.get('error') or fallback
    if isinstance(value, dict):
        value = value.get('message') or fallback
    return {'message': value if isinstance(value, str) else fallback}


def submit(body, auth):
    payload = request_json('/video/generate', auth, build_request(body))
    if payload.get('success') is False and not payload.get('jobId'):
        raise SubmissionRejected(error_detail(payload, 'Video submission rejected'))
    job = job_id(payload)
    # A provider taskId can be absent or different. Always poll the platform jobId.
    return {'id': job, 'task_id': job, 'object': 'video', 'status': 'queued', 'poll_after_seconds': 30}


def poll(job, auth):
    remote_completed = False
    try:
        query = urllib.parse.urlencode({'jobId': job, '_t': int(time.time() * 1000)})
        payload = request_json('/video/status?' + query, auth)
        if payload.get('success') is not True or job_id(payload) != job:
            raise ValueError('Task query is unsuccessful or mismatched')
        interval = payload.get('pollAfterSeconds', 30)
        interval = max(30, min(3600, int(interval))) if not isinstance(interval, bool) else 30
        result = {'id': job, 'task_id': job, 'object': 'video', 'poll_after_seconds': interval}
        state = payload.get('status')
        if state == 'submitted':
            result['status'] = 'in_progress'
            progress = payload.get('progress')
            if isinstance(progress, (int, float)) and not isinstance(progress, bool) and 0 <= progress < 100:
                result['progress'] = progress
            return result
        if state == 'failed':
            return {**result, 'status': 'failed', 'error': error_detail(payload)}
        if state != 'success':
            raise ValueError('Unknown task status')
        remote_completed = True
        billing = payload.get('billing')
        if isinstance(billing, dict) and billing.get('mode') == 'token' and billing.get('settled') is not True:
            raise ValueError('Task settlement pending')
        url = resolve_media_url(payload.get('videoUrl') or payload.get('contentUrl'), job)
        return {**result, 'status': 'completed', 'progress': 100, 'video_url': url}
    except (OSError, http.client.HTTPException, ValueError, TypeError, KeyError) as error:
        print(json.dumps({'event': 'query_unavailable', 'job_id': job, 'http_status': getattr(error, 'code', None),
                          'error_type': type(error).__name__}), flush=True)
        # The relay can cache/refund polling errors. Preserve nonterminal state until the job itself fails.
        return {'id': job, 'task_id': job, 'status': 'in_progress', 'corvas_query_state': 'unavailable',
                'remote_completed': remote_completed, 'retry_after': 30, 'poll_after_seconds': 30}


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
            return self.reply(200, {'ok': True, 'adapter': 'feituo-v1', 'models': len(MODELS)})
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Bearer ') or len(auth) < 9:
            return self.reply(401, {'error': {'message': 'Bearer authentication required'}})
        try:
            if submitting:
                if path not in ('/v1/videos', '/v1/video/generations', '/v1/videos/generations'):
                    return self.reply(404, {'error': {'message': 'Unsupported submission path'}})
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    if length <= 0 or length > MAX_JSON:
                        return self.reply(413, {'error': {'message': 'Invalid request size'}})
                    body = build_request(json.loads(self.rfile.read(length)))
                except (ValueError, TypeError, AttributeError) as error:
                    return self.reply(400, {'error': {'message': str(error)}})
                return self.reply(202, submit(body, auth))
            match = re.fullmatch(r'/v1/(?:videos(?:/generations)?|video/generations|tasks)/([A-Za-z0-9_-]{1,200})', path)
            if not match:
                return self.reply(404, {'error': {'message': 'Unsupported task path'}})
            return self.reply(200, poll(match[1], auth))
        except SubmissionRejected as error:
            return self.reply(400, {'error': error.detail})
        except urllib.error.HTTPError as error:
            try:
                payload = json.loads(error.read(MAX_JSON))
                detail = error_detail(payload, 'Video service returned HTTP ' + str(error.code))
            except (ValueError, TypeError, AttributeError):
                detail = {'message': 'Video service returned HTTP ' + str(error.code)}
            return self.reply(error.code if 400 <= error.code <= 599 else 502, {'error': detail})
        except Exception:
            return self.reply(502, {'error': {'code': 'VIDEO_SUBMISSION_UNKNOWN',
                'message': 'Submission response unavailable; preserve this task and do not resubmit automatically'}})


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 3012), Handler).serve_forever()
