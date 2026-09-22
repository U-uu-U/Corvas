"""OpenAI-style relay adapter for the Shanhai video API.

The relay receives the Shanhai credential in the incoming Bearer header.  It
keeps that credential in memory only and uses a hash of it when partitioning
the local task cache.  No key is written to the task database or media files.
"""

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


UPSTREAM = os.getenv("UPSTREAM", "https://shanhai.vnshu.cn/api/v1").rstrip("/")
PUBLIC_MEDIA = os.getenv("PUBLIC_MEDIA", "https://art.ravenhash.org/fc-media/files").rstrip("/")
MEDIA_DIR = Path(os.getenv("MEDIA_DIR", "/media"))
STATE_DB = os.getenv("STATE_DB", "/state/tasks.sqlite")
PORT = int(os.getenv("PORT", "3011"))

MAX_REQUEST_BYTES = 32 * 1024 * 1024
MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
TASK_TTL_SECONDS = 7 * 86400
POLL_CACHE_SECONDS = 15
TASK_ID = re.compile(r"^[A-Za-z0-9_-]{1,160}$")
COMMON_RATIOS = {"21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "adaptive"}
TRANSIENT_HTTP = {404, 408, 425, 429, 500, 502, 503, 504}

# Shanhai exposes the same public IDs through both relay sites.  The relay
# deliberately sends the ID unchanged so channel accounting remains exact.
MODEL_RULES = {
    "oc-model-qbdmeb": {
        "durations": {5, 10, 15},
        "resolutions": {"720p"},
        "image_limit": 10,
        "default_duration": 15,
    },
    "oc-model-1iq31f": {
        "min_duration": 5,
        "max_duration": 15,
        "resolutions": {"480p", "720p", "1080p"},
        "image_limit": 9,
        "default_duration": 10,
    },
    "oc-model-bkb50q": {
        "min_duration": 4,
        "max_duration": 15,
        "resolutions": {"720p"},
        "no_references": True,
        "default_duration": 10,
    },
    "oc-model-c6ws7e": {
        "min_duration": 4,
        "max_duration": 15,
        "resolutions": {"720p"},
        "no_references": True,
        "default_duration": 10,
    },
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Do not let urllib carry an Authorization header over a redirect."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


HTTP = urllib.request.build_opener(NoRedirect())
LOCKS = [threading.Lock() for _ in range(128)]


def _upstream_url(path):
    return UPSTREAM + "/" + str(path).lstrip("/")


def request(path, auth, data=None, timeout=30):
    """Issue one upstream request with the supplied Shanhai Bearer token."""
    headers = {
        "Authorization": auth,
        "Accept": "application/json",
        "User-Agent": "FlowCanvas-Shanhai-Adapter/1.0",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(_upstream_url(path), data=data, headers=headers)
    return HTTP.open(req, timeout=timeout)


def _as_list(value, field):
    if value is None:
        return []
    if isinstance(value, (str, dict)):
        value = [value]
    if not isinstance(value, list):
        raise ValueError(f"{field} 必须是数组")
    return value


def _public_url(value, field):
    candidate = value.get("url") if isinstance(value, dict) else value
    if isinstance(value, dict) and candidate is None:
        candidate = value.get("image_url") or value.get("video_url") or value.get("audio_url")
    if not isinstance(candidate, str) or not candidate.strip():
        raise ValueError(f"{field} 包含无效 URL")
    try:
        parsed = urllib.parse.urlsplit(candidate.strip())
    except ValueError as error:
        raise ValueError(f"{field} 必须使用 HTTPS URL") from error
    if parsed.scheme.lower() != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError(f"{field} 必须使用公开 HTTPS URL")
    return candidate.strip()


def _media_values(body, keys, field):
    for key in keys:
        if key in body:
            return [_public_url(item, field) for item in _as_list(body.get(key), field)]
    return []


def _integer(value, field):
    if isinstance(value, bool):
        raise ValueError(f"{field} 必须是整数")
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    if isinstance(value, float) and value.is_integer():
        return int(value)
    raise ValueError(f"{field} 必须是整数")


def build_request(body):
    """Validate the relay contract and build the documented Shanhai body."""
    if not isinstance(body, dict):
        raise ValueError("请求体必须是 JSON 对象")
    model = body.get("model")
    if not isinstance(model, str) or model not in MODEL_RULES:
        raise ValueError("不支持的山海视频模型")
    prompt = body.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("prompt 不能为空")
    rules = MODEL_RULES[model]

    duration_value = body.get("duration", body.get("seconds", rules["default_duration"]))
    duration = _integer(duration_value, "duration")
    if "durations" in rules:
        valid_duration = duration in rules["durations"]
    else:
        valid_duration = rules["min_duration"] <= duration <= rules["max_duration"]
    if not valid_duration:
        raise ValueError("视频时长不符合当前山海模型限制")

    ratio = body.get("aspect_ratio", body.get("ratio", "16:9"))
    if not isinstance(ratio, str) or ratio.strip().lower() not in COMMON_RATIOS:
        raise ValueError("不支持的 aspect_ratio")
    ratio = ratio.strip()
    if ratio.lower() == "adaptive":
        ratio = "16:9"
    resolution = str(body.get("resolution", "720p")).strip().lower()
    if resolution not in rules["resolutions"]:
        raise ValueError("分辨率不符合当前山海模型限制")

    images = _media_values(body, ("image_urls", "reference_images", "images"), "图片参考")
    videos = _media_values(body, ("video_urls", "reference_videos"), "视频参考")
    audios = _media_values(body, ("audio_urls", "reference_audios"), "音频参考")
    if "image_limit" in rules and len(images) > rules["image_limit"]:
        raise ValueError(f"当前模型最多支持 {rules['image_limit']} 张参考图片")
    if rules.get("no_references") and images + videos + audios:
        raise ValueError("当前模型不支持参考素材")
    if len(images) + len(videos) + len(audios) > 10:
        raise ValueError("山海最多支持 10 个参考素材")

    inputs = ([{"type": "image", "url": url} for url in images]
              + [{"type": "video", "url": url} for url in videos]
              + [{"type": "audio", "url": url} for url in audios])
    result = {
        "model": model,
        "prompt": prompt.strip(),
        "media_type": "video",
        "options": {"aspect_ratio": ratio, "resolution": resolution, "duration": str(duration)},
    }
    if inputs:
        result["inputs"] = inputs
    return result


def identity(auth, task):
    return hashlib.sha256((auth + "\0" + task).encode("utf-8")).hexdigest()


def _lock_for(key):
    return LOCKS[int(key[:8], 16) % len(LOCKS)]


@contextmanager
def db():
    connection = sqlite3.connect(STATE_DB, timeout=20)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def init():
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    Path(STATE_DB).parent.mkdir(parents=True, exist_ok=True)
    with db() as connection:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS tasks ("
            "key TEXT PRIMARY KEY, born REAL NOT NULL, checked REAL NOT NULL, payload TEXT NOT NULL)"
        )
        connection.execute("DELETE FROM tasks WHERE born < ?", (time.time() - TASK_TTL_SECONDS,))


def save(key, born, payload, checked=None):
    with db() as connection:
        connection.execute(
            "INSERT OR REPLACE INTO tasks(key, born, checked, payload) VALUES (?, ?, ?, ?)",
            (key, born, time.time() if checked is None else checked, json.dumps(payload)),
        )


def _read_task(key):
    with db() as connection:
        return connection.execute("SELECT born, checked, payload FROM tasks WHERE key=?", (key,)).fetchone()


def _payload_data(payload):
    data = payload.get("data") if isinstance(payload, dict) else None
    return data if isinstance(data, dict) else (payload if isinstance(payload, dict) else {})


def _task_from_payload(payload):
    data = _payload_data(payload)
    for source in (payload, data):
        for key in ("id", "task_id", "request_id"):
            if isinstance(source, dict) and source.get(key) is not None:
                value = str(source[key]).strip()
                if TASK_ID.fullmatch(value):
                    return value
    return ""


def _status_from_payload(payload):
    data = _payload_data(payload)
    value = payload.get("status") if isinstance(payload, dict) else None
    if value is None:
        value = data.get("status")
    return str(value or "").strip().lower()


def _output_url(payload):
    data = _payload_data(payload)
    candidates = []
    for source in (payload, data):
        if not isinstance(source, dict):
            continue
        output = source.get("output")
        if isinstance(output, dict):
            candidates.append(output.get("url"))
        candidates.append(source.get("video_url"))
        candidates.append(source.get("url"))
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return ""


def _safe_output_url(raw):
    raw = str(raw or "").strip()
    if raw.startswith("/"):
        raw = urllib.parse.urljoin(UPSTREAM + "/", raw)
    try:
        parsed = urllib.parse.urlsplit(raw)
    except ValueError as error:
        raise ValueError("山海任务返回的产物地址无效") from error
    if parsed.scheme.lower() not in ("https", "http") or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError("山海任务返回的产物地址必须是 HTTPS URL")
    # HTTP is permitted only for a local mock/test upstream. Production
    # defaults to HTTPS and never forwards a credential to a different origin.
    if parsed.scheme.lower() != urllib.parse.urlsplit(UPSTREAM).scheme.lower() and parsed.scheme.lower() != "https":
        raise ValueError("山海任务返回的产物地址协议无效")
    return raw


def _same_origin(left, right):
    a, b = urllib.parse.urlsplit(left), urllib.parse.urlsplit(right)
    return a.scheme.lower() == b.scheme.lower() and a.netloc.lower() == b.netloc.lower()


def _download_media(key, task, raw_url, auth):
    """Download a completed output without forwarding auth across origins."""
    current = _safe_output_url(raw_url)
    original = current
    for _ in range(6):
        parsed = urllib.parse.urlsplit(current)
        headers = {
            "Accept": "video/*,application/octet-stream;q=0.9,*/*;q=0.1",
            "User-Agent": "FlowCanvas-Shanhai-Adapter/1.0",
        }
        if _same_origin(current, UPSTREAM):
            headers["Authorization"] = auth
        req = urllib.request.Request(current, headers=headers)
        try:
            response = HTTP.open(req, timeout=300)
        except urllib.error.HTTPError as error:
            if 300 <= error.code < 400:
                location = error.headers.get("Location")
                if not location:
                    raise ValueError("山海视频产物重定向缺少地址")
                current = _safe_output_url(urllib.parse.urljoin(current, location))
                continue
            raise
        temporary = MEDIA_DIR / (key + ".part")
        try:
            total = 0
            try:
                with temporary.open("wb") as output:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > MAX_DOWNLOAD_BYTES:
                            raise ValueError("视频产物超过下载大小限制")
                        output.write(chunk)
                if not total:
                    raise ValueError("山海返回了空视频产物")
                extension = ".mp4"
                content_type = response.headers.get("Content-Type", "").lower()
                if "webm" in content_type:
                    extension = ".webm"
                elif "quicktime" in content_type:
                    extension = ".mov"
                destination = MEDIA_DIR / (key + extension)
                temporary.replace(destination)
                return destination.name, original
            finally:
                response.close()
        finally:
            temporary.unlink(missing_ok=True)
    raise ValueError("山海视频产物重定向次数过多")


def _public_media_url(filename):
    return PUBLIC_MEDIA + "/" + urllib.parse.quote(filename)


def _error_payload(message, **extra):
    result = {"error": {"message": message}}
    result["error"].update(extra)
    return result


def _normalized_pending(task):
    return {"id": task, "task_id": task, "status": "in_progress"}


def _poll(task, auth):
    key = identity(auth, task)
    lock = _lock_for(key)
    with lock:
        row = _read_task(key)
        born = row[0] if row else time.time()
        cached = json.loads(row[2]) if row else None
        checked = row[1] if row else 0
        # A just-submitted placeholder is queried once immediately. Further
        # reads use the short cache to prevent duplicate upstream polls.
        if cached and checked and time.time() - checked < POLL_CACHE_SECONDS:
            payload = cached
        else:
            try:
                with request("/tasks/" + urllib.parse.quote(task, safe="_-"), auth, timeout=30) as response:
                    payload = json.load(response)
            except urllib.error.HTTPError as error:
                raise error
            save(key, born, payload)

        status = _status_from_payload(payload)
        if not status and _output_url(payload):
            status = "succeeded"
        if status in {"queued", "pending", "created", "received", "running", "processing", "in_progress", "started"}:
            if time.time() - born > 3600:
                timeout_payload = {"status": "failed", "error": {"message": "任务等待超过一小时，未重复提交"}}
                save(key, born, timeout_payload)
                return {"id": task, "task_id": task, "status": "failed", "error": timeout_payload["error"]}
            return _normalized_pending(task)
        if status in {"failed", "error", "cancelled", "canceled", "rejected"}:
            data = _payload_data(payload)
            error = payload.get("error") if isinstance(payload, dict) else None
            if not error:
                error = data.get("error") if isinstance(data, dict) else None
            if not error:
                error = {"message": "山海视频任务失败"}
            return {"id": task, "task_id": task, "status": "failed", "error": error}
        if status not in {"succeeded", "success", "completed", "done"}:
            raise ValueError("山海任务返回了无法识别的状态")

        data = _payload_data(payload)
        media_file = data.get("_relay_media_file") if isinstance(data, dict) else None
        if media_file and (MEDIA_DIR / media_file).is_file():
            return {"id": task, "task_id": task, "status": "completed", "video_url": _public_media_url(media_file)}
        raw_url = _output_url(payload)
        if not raw_url:
            raise ValueError("山海任务已完成但没有 output.url")
        try:
            media_file, _ = _download_media(key, task, raw_url, auth)
        except Exception as error:
            # Keep the terminal upstream payload cached. A later poll retries
            # only the download and never submits another generation.
            raise RuntimeError("山海视频产物下载失败，请稍后重试") from error
        stored = dict(payload)
        stored_data = dict(_payload_data(stored))
        stored_data["_relay_media_file"] = media_file
        if stored.get("data") and isinstance(stored.get("data"), dict):
            stored["data"] = stored_data
        else:
            stored["_relay_media_file"] = media_file
        save(key, born, stored)
        return {"id": task, "task_id": task, "status": "completed", "video_url": _public_media_url(media_file)}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if self._serve_media(path):
            return
        self.handle_request(False)

    def do_POST(self):
        self.handle_request(True)

    def _serve_media(self, path):
        prefix = "/media/"
        if path.startswith(prefix):
            filename = urllib.parse.unquote(path[len(prefix):])
        elif path.startswith("/") and re.fullmatch(r"/[a-f0-9]{64}\.(?:mp4|webm|mov)", path, re.IGNORECASE):
            filename = path[1:]
        else:
            return False
        if not re.fullmatch(r"[a-f0-9]{64}\.(?:mp4|webm|mov)", filename, re.IGNORECASE):
            self.reply(404, _error_payload("media not found"))
            return True
        file_path = MEDIA_DIR / filename
        if not file_path.is_file():
            self.reply(404, _error_payload("media not found"))
            return True
        size = file_path.stat().st_size
        start, end = 0, size - 1
        range_header = self.headers.get("Range", "")
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header)
        if match:
            if match.group(1): start = int(match.group(1))
            if match.group(2): end = min(end, int(match.group(2)))
            elif not match.group(1): start = max(0, size - 1)
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return True
            status = 206
        else:
            status = 200
        content_type = {".webm": "video/webm", ".mov": "video/quicktime"}.get(Path(filename).suffix.lower(), "video/mp4")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if status == 206: self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with file_path.open("rb") as source:
            source.seek(start)
            remaining = end - start + 1
            while remaining:
                chunk = source.read(min(1024 * 1024, remaining))
                if not chunk: break
                self.wfile.write(chunk)
                remaining -= len(chunk)
        return True

    def handle_request(self, submit):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/health" and not submit:
            return self.reply(200, {"ok": True, "adapter": "shanhai-v1"})
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer ") or not auth[7:].strip():
            return self.reply(401, _error_payload("Bearer authentication required"))
        try:
            if submit:
                if path.rstrip("/") not in ("/v1/videos", "/v1/video/generations", "/v1/videos/generations"):
                    return self.reply(404, _error_payload("Unsupported submission path"))
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                except ValueError:
                    length = 0
                if length <= 0 or length > MAX_REQUEST_BYTES:
                    return self.reply(413, _error_payload("Invalid request size"))
                try:
                    body = json.loads(self.rfile.read(length))
                    translated = build_request(body)
                except (ValueError, TypeError, json.JSONDecodeError) as error:
                    return self.reply(400, _error_payload(str(error)))
                # This is the only POST. Any transport exception below is an
                # ambiguous outcome and is surfaced without a second attempt.
                try:
                    with request("/generations", auth, json.dumps(translated).encode("utf-8"), timeout=180) as response:
                        upstream_payload = json.load(response)
                except urllib.error.HTTPError as error:
                    try:
                        payload = json.loads(error.read(16384))
                    except (ValueError, TypeError):
                        payload = _error_payload("山海提交失败", status=error.code)
                    return self.reply(error.code, payload)
                except Exception:
                    return self.reply(502, _error_payload(
                        "提交结果未知，请从任务记录恢复，不会自动重复提交",
                        code="submission_unknown", submission_unknown=True,
                    ))
                task = _task_from_payload(upstream_payload)
                if not task:
                    return self.reply(502, _error_payload(
                        "山海提交未返回有效任务 ID，结果未知，不会自动重复提交",
                        code="submission_unknown", submission_unknown=True,
                    ))
                save(identity(auth, task), time.time(), {"status": "queued", "id": task}, checked=0)
                return self.reply(200, {"id": task, "task_id": task, "status": "queued"})

            match = re.fullmatch(r"/v1/(?:videos(?:/generations)?|video/generations|tasks)/([A-Za-z0-9_-]{1,160})/?", path)
            if not match:
                return self.reply(404, _error_payload("Unsupported task path"))
            return self.reply(200, _poll(match.group(1), auth))
        except urllib.error.HTTPError as error:
            try:
                payload = json.loads(error.read(16384))
            except (ValueError, TypeError):
                payload = _error_payload("上游 HTTP " + str(error.code), status=error.code)
            self.reply(error.code, payload)
        except RuntimeError as error:
            self.reply(502, _error_payload(str(error)))
        except (ValueError, TypeError) as error:
            self.reply(502, _error_payload(str(error)))
        except Exception:
            print(json.dumps({"event": "upstream_error", "error_type": "unknown"}), flush=True)
            self.reply(502, _error_payload("上游查询失败，请稍后使用同一任务 ID 重试"))


def serve():
    init()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    serve()
