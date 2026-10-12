"""Cache authenticated MP4 results in the relay's existing expiring media folder."""
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

MEDIA_DIR = Path(os.environ.get('MEDIA_DIR', '/media'))
PUBLIC_MEDIA = os.environ.get('PUBLIC_MEDIA', '').rstrip('/')
MAX_BYTES = 512 * 1024 * 1024
ACTIVE = set()
RETRY_AT = {}
LOCK = threading.Lock()
MAX_ACTIVE = 8


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


HTTP = urllib.request.build_opener(NoRedirect)


def init():
    if not PUBLIC_MEDIA.startswith('https://'):
        raise ValueError('PUBLIC_MEDIA must be the relay HTTPS media base')
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)


def validate_redirect(value):
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('Invalid media redirect')
    addresses = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == 'https' else 80), type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(row[4][0]).is_global for row in addresses):
        raise ValueError('Media redirect must resolve to a public address')
    return value


def transfer(upstream, task, auth, destination):
    current = upstream + '/v1/videos/' + urllib.parse.quote(task, safe='') + '/content'
    origin = urllib.parse.urlsplit(upstream)
    auth_allowed = True
    temporary = destination.with_suffix('.part')
    started = time.monotonic()
    try:
        for _ in range(6):
            parsed = urllib.parse.urlsplit(current)
            headers = {'Accept': 'video/mp4,application/octet-stream', 'User-Agent': 'Corvas-Video-Adapter/1.0',
                       'Accept-Encoding': 'identity'}
            if auth_allowed and (parsed.scheme, parsed.netloc) == (origin.scheme, origin.netloc):
                headers['Authorization'] = auth
            try:
                response = HTTP.open(urllib.request.Request(current, headers=headers), timeout=90)
            except urllib.error.HTTPError as error:
                location, status = error.headers.get('Location'), error.code
                error.close()
                if status not in (301, 302, 303, 307, 308) or not location:
                    raise
                current = validate_redirect(urllib.parse.urljoin(current, location))
                target = urllib.parse.urlsplit(current)
                if (target.scheme, target.netloc) != (origin.scheme, origin.netloc):
                    auth_allowed = False
                continue
            with response:
                content_type = response.headers.get('Content-Type', '').split(';', 1)[0].lower()
                if content_type not in ('video/mp4', 'application/octet-stream'):
                    raise ValueError('Content endpoint did not return MP4 media')
                declared = response.headers.get('Content-Length')
                expected = int(declared) if declared is not None else None
                if expected is not None and not 0 < expected <= MAX_BYTES:
                    raise ValueError('Invalid video content length')
                total = 0
                with temporary.open('wb') as output:
                    prefix = response.read(12)
                    if len(prefix) != 12 or prefix[4:8] != b'ftyp':
                        raise ValueError('Content endpoint returned a non-MP4 file')
                    output.write(prefix)
                    total += len(prefix)
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > MAX_BYTES or time.monotonic() - started > 600:
                            raise ValueError('Video transfer limit exceeded')
                        output.write(chunk)
                if expected is not None and total != expected:
                    raise ValueError('Video transfer ended before Content-Length')
            temporary.chmod(0o644)
            temporary.replace(destination)
            return
        raise ValueError('Media redirect limit exceeded')
    finally:
        temporary.unlink(missing_ok=True)


def worker(upstream, task, auth, key, destination):
    failed = False
    try:
        transfer(upstream, task, auth, destination)
    except Exception as error:
        failed = True
        print(json.dumps({'event': 'media_download_unavailable', 'task_id': task,
                          'error_type': type(error).__name__, 'http_status': getattr(error, 'code', None)}), flush=True)
    finally:
        with LOCK:
            ACTIVE.discard(key)
            if failed:
                RETRY_AT[key] = time.monotonic() + 60


def ensure_media(upstream, task, auth):
    if not PUBLIC_MEDIA:
        raise ValueError('Public relay media route is not configured')
    key = hashlib.sha256((upstream + '\0' + auth + '\0' + task).encode()).hexdigest()
    destination = MEDIA_DIR / ('dola25-' + key + '.mp4')
    if destination.is_file() and destination.stat().st_mtime > time.time() - 23 * 3600:
        return PUBLIC_MEDIA + '/' + destination.name
    with LOCK:
        now = time.monotonic()
        for previous in [value for value, deadline in RETRY_AT.items() if deadline <= now]:
            del RETRY_AT[previous]
        if key in ACTIVE or key in RETRY_AT or len(ACTIVE) >= MAX_ACTIVE:
            return None
        ACTIVE.add(key)
        threading.Thread(target=worker, args=(upstream, task, auth, key, destination), daemon=True).start()
    return None
