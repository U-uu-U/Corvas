import importlib.util
import json
import os
import io
from pathlib import Path
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
import urllib.error

os.environ.setdefault('UPSTREAM', 'http://127.0.0.1:1')
spec = importlib.util.spec_from_file_location('seedance_direct_adapter', Path(__file__).with_name('adapter.py'))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class ContractTests(unittest.TestCase):
    def test_current_generic_client_fields_are_translated_without_losing_references(self):
        images = [{'url': 'https://example.test/a.png'}, {'url': 'https://example.test/a.png'}]
        self.assertEqual(adapter.build_request({'model': adapter.MODEL, 'prompt': 'fixture', 'duration': 15,
                                                'ratio': '16:9', 'images': images, 'resolution': '720p'}),
                         {'model': adapter.MODEL, 'prompt': 'fixture', 'seconds': 15, 'aspect_ratio': '16:9',
                          'reference_images': ['https://example.test/a.png'] * 2})

    def test_invalid_references_duration_and_ratio_are_rejected_before_submission(self):
        source = {'model': adapter.MODEL, 'prompt': 'fixture', 'seconds': 15}
        for change in [{'seconds': 10}, {'seconds': True}, {'ratio': '1:1'}, {'model': 'seedance-video'},
                       {'image_urls': ['https://example.test/a.png'] * 10}, {'audio_urls': ['https://example.test/a.mp3']},
                       {'image_urls': ['data:image/png;base64,YQ==']}]:
            with self.assertRaises(ValueError):
                adapter.build_request({**source, **change})

    def test_complete_task_resolves_json_url_with_auth_and_drops_private_billing(self):
        responses = [{'task_id': 123, 'status': 'completed', 'download_url': 'https://wrong.test/steal?token=secret',
                      'billing': {'credits_charged': 4}, 'completed_at': '2026-10-08T00:00:00Z'},
                     {'task_id': 123, 'url': 'https://cdn.example.test/video.mp4'}]
        with patch.object(adapter, 'request_json', side_effect=responses) as request:
            value = adapter.poll('123', 'Bearer private')
        self.assertEqual(request.call_args_list[1].args, ('/v1/tasks/123/url', 'Bearer private'))
        self.assertEqual(value['video_url'], 'https://cdn.example.test/video.mp4')
        self.assertNotIn('billing', value)
        self.assertNotIn('download_url', value)

    def test_mismatched_task_id_does_not_attach_another_video(self):
        with patch.object(adapter, 'request_json', return_value={'task_id': 124, 'status': 'completed'}):
            value = adapter.poll('123', 'Bearer private')
        self.assertEqual(value['status'], 'in_progress')
        self.assertEqual(value['corvas_query_state'], 'unavailable')
        self.assertNotIn('video_url', value)

    def test_first_poll_not_found_recovers_same_task_without_resubmission(self):
        error = urllib.error.HTTPError('http://fixture/v1/tasks/123', 404, 'Task not found', {},
                                       io.BytesIO(b'{"error":{"message":"Task not found"}}'))
        responses = [error, {'task_id': 123, 'status': 'processing'},
                     {'task_id': 123, 'status': 'completed'},
                     {'task_id': 123, 'url': 'https://cdn.example.test/video.mp4'}]
        with patch.object(adapter, 'request_json', side_effect=responses) as request:
            first = adapter.poll('123', 'Bearer private')
            second = adapter.poll('123', 'Bearer private')
            final = adapter.poll('123', 'Bearer private')
        self.assertEqual(first['corvas_query_state'], 'unavailable')
        self.assertEqual(first['status'], 'in_progress')
        self.assertEqual(second['status'], 'in_progress')
        self.assertEqual(final['status'], 'completed')
        self.assertTrue(all(call.args[0].startswith('/v1/tasks/123') and len(call.args) == 2
                            for call in request.call_args_list))

    def test_query_transport_and_server_errors_never_claim_generation_failure(self):
        for error in [TimeoutError(), urllib.error.URLError('connection interrupted'),
                      urllib.error.HTTPError('http://fixture', 503, 'unavailable', {}, io.BytesIO())]:
            with patch.object(adapter, 'request_json', side_effect=error):
                result = adapter.poll('123', 'Bearer private')
            self.assertEqual(result['status'], 'in_progress')
            self.assertEqual(result['corvas_query_state'], 'unavailable')
            self.assertNotIn('error', result)

    def test_failed_query_envelope_without_terminal_evidence_is_recoverable(self):
        with patch.object(adapter, 'request_json', return_value={
                'task_id': 123, 'status': 'failed', 'error': 'Task not found'}):
            result = adapter.poll('123', 'Bearer private')
        self.assertEqual(result['corvas_query_state'], 'unavailable')

    def test_confirmed_failed_task_still_reports_terminal_failure(self):
        with patch.object(adapter, 'request_json', return_value={
                'task_id': 123, 'status': 'failed', 'completed_at': '2026-10-08T03:00:00+08:00',
                'error': 'Content rejected'}):
            result = adapter.poll('123', 'Bearer private')
        self.assertEqual(result['status'], 'failed')
        self.assertNotIn('corvas_query_state', result)

    def test_video_url_not_ready_does_not_turn_completed_generation_into_failed(self):
        error = urllib.error.HTTPError('http://fixture', 409, 'not ready', {}, io.BytesIO())
        with patch.object(adapter, 'request_json', side_effect=[{'task_id': 123, 'status': 'completed'}, error]):
            result = adapter.poll('123', 'Bearer private')
        self.assertEqual(result['status'], 'in_progress')
        self.assertTrue(result['remote_completed'])
        self.assertNotIn('video_url', result)

    def test_submission_transport_failure_is_attempted_once(self):
        with patch.object(adapter, 'request_json', side_effect=TimeoutError) as request:
            with self.assertRaises(TimeoutError):
                adapter.submit({'model': adapter.MODEL, 'prompt': 'fixture'}, 'Bearer private')
        self.assertEqual(request.call_count, 1)


class IntegrationTests(unittest.TestCase):
    def test_real_http_numeric_task_and_two_step_resolution(self):
        calls = []

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def reply(self, value):
                raw = json.dumps(value).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_POST(self):
                calls.append(('POST', self.path, self.headers.get('Authorization'),
                              json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                self.reply({'task_id': 123, 'status': 'pending', 'billing': {'credits_reserved': 4}})

            def do_GET(self):
                calls.append(('GET', self.path, self.headers.get('Authorization')))
                if self.path.endswith('/url'):
                    self.reply({'task_id': 123, 'url': 'https://cdn.example.test/video.mp4'})
                else:
                    self.reply({'task_id': 123, 'status': 'completed'})

        server = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.object(adapter, 'UPSTREAM', f'http://127.0.0.1:{server.server_port}'):
                result = adapter.submit({'model': adapter.MODEL, 'prompt': 'fixture'}, 'Bearer test-owner')
                self.assertEqual(result['task_id'], '123')
                self.assertEqual(adapter.poll('123', 'Bearer test-owner')['video_url'],
                                 'https://cdn.example.test/video.mp4')
            self.assertEqual([call[1] for call in calls],
                             ['/v1/videos/generations', '/v1/tasks/123', '/v1/tasks/123/url'])
            self.assertTrue(all(call[2] == 'Bearer test-owner' for call in calls))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
