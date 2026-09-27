import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

import adapter


class UpstreamFixture:
    def __init__(self):
        self.calls = []
        self.status = "queued"
        self.output_url = None
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def respond(self, code, payload, headers=None):
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(code)
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                owner.calls.append(("POST", self.path, self.headers.get("Authorization"), body))
                self.respond(200, {"id": "shan-task-1", "status": "queued"})

            def do_GET(self):
                owner.calls.append(("GET", self.path, self.headers.get("Authorization")))
                if self.path == "/api/v1/tasks/shan-task-1":
                    payload = {"id": "shan-task-1", "status": owner.status}
                    if owner.output_url:
                        payload["output"] = {"url": owner.output_url}
                    self.respond(200, payload)
                elif self.path == "/api/v1/files/result.mp4":
                    self.respond(200, b"\x00\x00\x00\x18ftypisom" + b"x" * 100,
                                 {"Content-Type": "video/mp4"})
                else:
                    self.respond(404, {"error": {"message": "not found"}})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}/api/v1"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class ContractTests(unittest.TestCase):
    def test_body_aliases_limits_and_input_order(self):
        body = adapter.build_request({
            "model": "oc-model-1iq31f", "prompt": "  make it move  ", "seconds": "5",
            "ratio": "9:16", "resolution": "1080p",
            "images": [{"url": "https://images.example/a.png"}, "https://images.example/b.png"],
            "reference_videos": ["https://videos.example/m.mp4"],
            "audio_urls": ["https://audio.example/v.mp3"],
        })
        self.assertEqual(body["model"], "oc-model-1iq31f")
        self.assertEqual(body["prompt"], "make it move")
        self.assertEqual(body["options"], {"aspect_ratio": "9:16", "resolution": "1080p", "duration": "5"})
        self.assertEqual([item["type"] for item in body["inputs"]], ["image", "image", "video", "audio"])
        self.assertEqual([item["url"] for item in body["inputs"]], [
            "https://images.example/a.png", "https://images.example/b.png",
            "https://videos.example/m.mp4", "https://audio.example/v.mp3",
        ])

    def test_model_limits_and_public_https(self):
        with self.assertRaises(ValueError):
            adapter.build_request({"model": "oc-model-qbdmeb", "prompt": "x", "duration": 4})
        with self.assertRaises(ValueError):
            adapter.build_request({"model": "oc-model-qbdmeb", "prompt": "x", "duration": 5,
                                   "image_urls": [f"https://x.example/{index}.png" for index in range(11)]})
        with self.assertRaises(ValueError):
            adapter.build_request({"model": "oc-model-1iq31f", "prompt": "x", "duration": 5,
                                   "resolution": "360p"})
        with self.assertRaises(ValueError):
            adapter.build_request({"model": "oc-model-bkb50q", "prompt": "x", "duration": 4,
                                   "image_urls": ["https://x.example/a.png"]})
        with self.assertRaises(ValueError):
            adapter.build_request({"model": "oc-model-qbdmeb", "prompt": "x", "duration": 5,
                                   "image_urls": ["http://x.example/a.png"]})

    def test_model_id_is_not_rewritten(self):
        body = adapter.build_request({"model": "oc-model-c6ws7e", "prompt": "x", "duration": 4})
        self.assertEqual(body["model"], "oc-model-c6ws7e")
        adaptive = adapter.build_request({"model": "oc-model-qbdmeb", "prompt": "x", "duration": 5,
                                          "ratio": "adaptive"})
        self.assertEqual(adaptive["options"]["aspect_ratio"], "16:9")

    def test_dola_30_fixed_duration_and_ten_image_contract(self):
        images = [f"https://images.example/{index}.png" for index in range(10)]
        for ratio in ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]:
            with self.subTest(ratio=ratio):
                body = adapter.build_request({
                    "model": "oc-model-r5cfh8", "prompt": " fixture ",
                    "image_urls": images, "aspect_ratio": ratio,
                })
                self.assertEqual(body, {
                    "model": "oc-model-r5cfh8", "prompt": "fixture", "media_type": "video",
                    "inputs": [{"type": "image", "url": url} for url in images],
                    "options": {"duration": "30", "resolution": "720p", "aspect_ratio": ratio},
                })

    def test_dola_30_rejects_unsupported_parameters(self):
        invalid = [
            ({"duration": 15}, "时长"),
            ({"duration": 31}, "时长"),
            ({"resolution": "480p"}, "分辨率"),
            ({"resolution": "1080p"}, "分辨率"),
            ({"ratio": "2:1"}, "aspect_ratio"),
            ({"image_urls": [f"https://images.example/{index}.png" for index in range(11)]}, "10 张参考图片"),
            ({"video_urls": ["https://videos.example/a.mp4"]}, "不支持视频参考"),
            ({"videos": ["https://videos.example/a.mp4"]}, "不支持视频参考"),
            ({"audio_urls": ["https://audio.example/a.mp3"]}, "不支持音频参考"),
        ]
        for overrides, message in invalid:
            with self.subTest(overrides=overrides), self.assertRaisesRegex(ValueError, message):
                adapter.build_request({"model": "oc-model-r5cfh8", "prompt": "fixture", **overrides})

    def test_no_redirect_helper_never_carries_auth(self):
        self.assertIsNone(adapter.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.example"))


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="flow-shanhai-adapter-")
        self.upstream = UpstreamFixture()
        self.config = patch.multiple(
            adapter,
            UPSTREAM=self.upstream.base,
            PUBLIC_MEDIA="https://relay.example/fc-media/files",
            MEDIA_DIR=Path(self.temp.name) / "media",
            STATE_DB=str(Path(self.temp.name) / "state.sqlite"),
        )
        self.config.start()
        adapter.init()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), adapter.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.upstream.close()
        self.config.stop()
        self.temp.cleanup()

    def call(self, path, body=None, auth="Bearer oc_live_fixture"):
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.server.server_port}{path}",
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": auth, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request) as response:
            return json.load(response)

    def test_submit_poll_download_and_cache(self):
        submitted = self.call("/v1/video/generations", {
            "model": "oc-model-qbdmeb", "prompt": "fixture", "duration": 5,
            "reference_images": ["https://images.example/a.png"],
        })
        self.assertEqual(submitted, {"id": "shan-task-1", "task_id": "shan-task-1", "status": "queued"})
        self.assertEqual(self.upstream.calls[0][0:3], ("POST", "/api/v1/generations", "Bearer oc_live_fixture"))
        self.assertEqual(self.upstream.calls[0][3]["model"], "oc-model-qbdmeb")

        self.upstream.status = "succeeded"
        self.upstream.output_url = self.upstream.base + "/files/result.mp4"
        result = self.call("/v1/tasks/shan-task-1")
        self.assertEqual(result["status"], "completed")
        self.assertTrue(result["video_url"].startswith("https://relay.example/fc-media/files/"))
        self.assertIn(("GET", "/api/v1/tasks/shan-task-1", "Bearer oc_live_fixture"), self.upstream.calls)
        self.assertIn(("GET", "/api/v1/files/result.mp4", "Bearer oc_live_fixture"), self.upstream.calls)

        call_count = len(self.upstream.calls)
        self.assertEqual(self.call("/v1/video/generations/shan-task-1")["status"], "completed")
        self.assertEqual(len(self.upstream.calls), call_count)

    def test_failed_status_and_unknown_post_do_not_resubmit(self):
        self.upstream.status = "failed"
        self.upstream.output_url = None
        self.call("/v1/videos", {"model": "oc-model-qbdmeb", "prompt": "fixture", "duration": 5})
        result = self.call("/v1/videos/shan-task-1")
        self.assertEqual(result["status"], "failed")

        with patch.object(adapter, "request", side_effect=TimeoutError("socket closed")) as request:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.call("/v1/videos", {"model": "oc-model-qbdmeb", "prompt": "fixture", "duration": 5})
            self.assertEqual(error.exception.code, 502)
            payload = json.loads(error.exception.read().decode())
            self.assertIn("结果未知", payload["error"]["message"])
            self.assertEqual(payload["error"]["code"], "submission_unknown")
            self.assertEqual(request.call_count, 1)

    def test_dola_30_submit_and_resume_does_not_resubmit(self):
        images = [f"https://images.example/{index}.png" for index in range(10)]
        submitted = self.call("/v1/video/generations", {
            "model": "oc-model-r5cfh8", "prompt": "fixture", "seconds": "30",
            "ratio": "21:9", "resolution": "720p", "images": [{"url": url} for url in images],
        })
        self.assertEqual(submitted["task_id"], "shan-task-1")
        self.assertEqual(self.upstream.calls[0][3], {
            "model": "oc-model-r5cfh8", "prompt": "fixture", "media_type": "video",
            "inputs": [{"type": "image", "url": url} for url in images],
            "options": {"duration": "30", "resolution": "720p", "aspect_ratio": "21:9"},
        })
        self.upstream.status = "succeeded"
        self.upstream.output_url = self.upstream.base + "/files/result.mp4"
        with patch.object(adapter, "POLL_CACHE_SECONDS", 0):
            result = self.call("/v1/videos/shan-task-1")
        self.assertEqual(result["status"], "completed")
        self.assertTrue(result["video_url"].startswith("https://relay.example/fc-media/files/"))
        call_count = len(self.upstream.calls)
        self.assertEqual(self.call("/v1/tasks/shan-task-1")["status"], "completed")
        self.assertEqual(len(self.upstream.calls), call_count)
        self.assertEqual(sum(call[0] == "POST" for call in self.upstream.calls), 1)

    def test_dola_30_invalid_references_are_rejected_without_upstream_requests(self):
        for field, values in [
            ("image_urls", [f"https://images.example/{index}.png" for index in range(11)]),
            ("video_urls", ["https://videos.example/a.mp4"]),
            ("videos", ["https://videos.example/a.mp4"]),
            ("audio_urls", ["https://audio.example/a.mp3"]),
        ]:
            with self.subTest(field=field), self.assertRaises(urllib.error.HTTPError) as error:
                self.call("/v1/videos", {"model": "oc-model-r5cfh8", "prompt": "fixture", field: values})
            self.assertEqual(error.exception.code, 400)
        self.assertEqual(self.upstream.calls, [])

    def test_poll_status_is_cached_and_auth_is_partitioned(self):
        self.call("/v1/videos", {"model": "oc-model-qbdmeb", "prompt": "fixture", "duration": 5})
        self.call("/v1/videos/shan-task-1")
        calls = len(self.upstream.calls)
        self.call("/v1/videos/shan-task-1")
        self.assertEqual(len(self.upstream.calls), calls)
        self.call("/v1/videos/shan-task-1", auth="Bearer other-key")
        self.assertEqual(len(self.upstream.calls), calls + 1)

    def test_auth_and_health(self):
        request = urllib.request.Request(f"http://127.0.0.1:{self.server.server_port}/v1/videos")
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(request)
        self.assertEqual(error.exception.code, 401)
        with urllib.request.urlopen(f"http://127.0.0.1:{self.server.server_port}/health") as response:
            self.assertEqual(json.load(response)["ok"], True)


if __name__ == "__main__":
    unittest.main()
