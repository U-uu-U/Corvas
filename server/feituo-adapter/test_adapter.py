import importlib.util
import io
import json
from pathlib import Path
import threading
import unittest
from unittest.mock import patch
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('feituo_adapter', Path(__file__).with_name('adapter.py'))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
IMAGE30, ALLREF, REF933, LONGTERM = adapter.MODELS


class ContractTests(unittest.TestCase):
    def test_longterm_duration_choices_and_full_reference_arrays(self):
        for duration in (5, 10, 15):
            body = adapter.build_request({'model': LONGTERM, 'prompt': 'fixture', 'duration': duration, 'ratio': '21:9',
                'images': [{'url': 'https://example.test/image.png'}]*9,
                'videos': ['https://example.test/video.mp4']*3, 'audio_urls': ['https://example.test/audio.mp3']*3})
            self.assertEqual(body['duration'], duration)
            self.assertEqual([len(body[key]) for key in ('imageUrls', 'videoUrls', 'audioUrls')], [9, 3, 3])
        for duration in (4, 6, 9, 11, 14, 16):
            with self.assertRaises(ValueError):
                adapter.build_request({'model': LONGTERM, 'prompt': 'fixture', 'duration': duration})
        with self.assertRaises(ValueError):
            adapter.build_request({'model': LONGTERM, 'prompt': 'x'*6001, 'duration': 5})

    def test_30_image_range_and_order(self):
        urls = ['https://example.test/' + str(index) + '.png' for index in range(30)]
        for duration in (4, 30):
            body = adapter.build_request({'model': IMAGE30, 'prompt': '@image1 fixture', 'duration': duration,
                                          'ratio': '21:9', 'images': [{'url': url} for url in urls]})
            self.assertEqual(body['imageUrls'], urls)
            self.assertEqual(body['duration'], duration)
            self.assertEqual(body['videoUrls'], [])

    def test_allref_fixed_duration_and_three_media_arrays(self):
        source = {'model': ALLREF, 'prompt': '@image1 @video1 @audio1', 'duration': 30,
                  'images': ['https://example.test/image.png'] * 30,
                  'videos': ['https://example.test/video.mp4'] * 10,
                  'audio_urls': ['https://example.test/audio.mp3'] * 10}
        body = adapter.build_request(source)
        self.assertEqual([len(body[key]) for key in ('imageUrls', 'videoUrls', 'audioUrls')], [30, 10, 10])
        self.assertEqual(adapter.build_request(body), body)

    def test_933_preserves_audio_video_distinction(self):
        body = adapter.build_request({'model': REF933, 'prompt': 'fixture', 'seconds': '15',
            'image_urls': ['https://example.test/a.png'] * 9,
            'video_urls': ['https://example.test/a.mp4'] * 3,
            'audios': [{'url': 'https://example.test/a.mp3'}] * 3})
        self.assertEqual(body['videoUrls'][0], 'https://example.test/a.mp4')
        self.assertEqual(body['audioUrls'][0], 'https://example.test/a.mp3')

    def test_invalid_parameters_rejected_before_charging(self):
        cases = [(IMAGE30, {'duration': 3}), (IMAGE30, {'duration': 31}), (IMAGE30, {'duration': True}),
                 (IMAGE30, {'duration': 4.5}), (IMAGE30, {'resolution': '1080p'}),
                 (IMAGE30, {'videos': ['https://example.test/a.mp4']}),
                 (IMAGE30, {'audio_urls': ['https://example.test/a.mp3']}),
                 (IMAGE30, {'images': ['https://example.test/a.png'] * 31}),
                 (ALLREF, {'duration': 15}), (ALLREF, {'prompt': 'x' * 6001}),
                 (ALLREF, {'videos': ['https://example.test/a.mp4'] * 11}),
                 (REF933, {'ratio': '21:9'}), (REF933, {'duration': 16}),
                 (REF933, {'audios': ['https://example.test/a.mp3'] * 4}),
                 (REF933, {'images': ['data:image/png;base64,eA==']}),
                 (REF933, {'images': ['https://secret@example.test/a.png']}),
                 (REF933, {'images': ['https://localhost/a.png']}),
                 (REF933, {'images': [], 'image_urls': ['https://example.test/a.png']})]
        for model, changes in cases:
            with self.subTest(model=model, changes=changes), self.assertRaises(ValueError):
                adapter.build_request({'model': model, 'prompt': 'fixture', **changes})

    def test_submission_uses_job_id_not_provider_task_id(self):
        with patch.object(adapter, 'request_json', return_value={
                'success': True, 'jobId': 'cm_job', 'taskId': 'upstream_other_id', 'costYuan': 1.2}):
            result = adapter.submit({'model': IMAGE30, 'prompt': 'fixture'}, 'Bearer test')
        self.assertEqual(result['task_id'], 'cm_job')
        self.assertNotIn('costYuan', result)

    def test_submission_timeout_is_not_retried(self):
        with patch.object(adapter, 'request_json', side_effect=TimeoutError) as request:
            with self.assertRaises(TimeoutError):
                adapter.submit({'model': IMAGE30, 'prompt': 'fixture'}, 'Bearer test')
        self.assertEqual(request.call_count, 1)

    def test_submission_rejection_retains_error_without_billing(self):
        with patch.object(adapter, 'request_json', return_value={
                'success': False, 'error': {'message': 'Invalid image dimensions'}, 'costYuan': 1.2}):
            with self.assertRaises(adapter.SubmissionRejected) as rejected:
                adapter.submit({'model': IMAGE30, 'prompt': 'fixture'}, 'Bearer test')
        self.assertEqual(rejected.exception.detail, {'message': 'Invalid image dimensions'})

    def test_completed_result_preserves_signature_without_private_billing(self):
        url = 'https://example.test/result?exp=123&sig=a%2Fb%2Bc&download=1'
        with patch.object(adapter, 'request_json', return_value={
                'success': True, 'jobId': 'cm_job', 'status': 'success', 'videoUrl': url,
                'billing': {'settled': True, 'charged_cost_cents': 120}, 'quota': 999, 'costYuan': 1.2}):
            result = adapter.poll('cm_job', 'Bearer test')
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['video_url'], url)
        self.assertTrue({'billing', 'quota', 'costYuan'}.isdisjoint(result))

    def test_http200_failed_job_retains_actual_error(self):
        with patch.object(adapter, 'request_json', return_value={
                'success': True, 'jobId': 'cm_job', 'status': 'failed',
                'errorMessage': 'Image dimensions must be between 256 and 5760 pixels'}):
            result = adapter.poll('cm_job', 'Bearer test')
        self.assertEqual(result['status'], 'failed')
        self.assertIn('256 and 5760', result['error']['message'])

    def test_query_failure_and_missing_media_remain_recoverable(self):
        cases = [TimeoutError(), urllib.error.HTTPError('https://fixture', 404, 'Not found', {}, io.BytesIO()),
                 {'success': False, 'jobId': 'cm_job', 'errorMessage': 'Service unavailable'},
                 {'success': True, 'jobId': 'another_job', 'status': 'failed'},
                 {'success': True, 'jobId': 'cm_job', 'status': 'unknown'},
                 {'success': True, 'jobId': 'cm_job', 'status': 'success'},
                 {'success': True, 'jobId': 'cm_job', 'status': 'success',
                  'videoUrl': 'https://example.test/a.mp4', 'billing': {'mode': 'token', 'settled': False}}]
        for payload in cases:
            kwargs = {'side_effect': payload} if isinstance(payload, Exception) else {'return_value': payload}
            with self.subTest(payload=payload), patch.object(adapter, 'request_json', **kwargs):
                result = adapter.poll('cm_job', 'Bearer test')
            self.assertEqual(result['status'], 'in_progress')
            self.assertEqual(result['corvas_query_state'], 'unavailable')
            self.assertNotIn('error', result)

    def test_poll_interval_is_not_treated_as_completion(self):
        with patch.object(adapter, 'request_json', return_value={
                'success': True, 'jobId': 'cm_job', 'status': 'submitted', 'pollAfterSeconds': 60, 'progress': 100}):
            result = adapter.poll('cm_job', 'Bearer test')
        self.assertEqual(result['status'], 'in_progress')
        self.assertEqual(result['poll_after_seconds'], 60)
        self.assertNotIn('progress', result)


class HttpTests(unittest.TestCase):
    def test_signed_cache_redirect_is_resolved_without_forwarding_credentials(self):
        initial = 'https://feituokuajing.com/api/video/cache/cm_job?exp=123&sig=keep%2Bsig'
        final = 'https://media.feituokuajing.com/videos/cm_job.mp4?token=keep%2Ftoken'
        redirect = urllib.error.HTTPError(initial, 302, 'Found', {'Location': final}, io.BytesIO())
        response = io.BytesIO(b'v')
        response.headers = {'Content-Type': 'video/mp4'}
        with patch.object(adapter.HTTP, 'open', side_effect=[redirect, response]) as request:
            result = adapter.resolve_media_url(initial, 'cm_job')
        self.assertEqual(result, final)
        self.assertEqual(request.call_args_list[0].args[0].full_url, initial)
        for call in request.call_args_list:
            headers = {key.lower(): value for key, value in call.args[0].header_items()}
            self.assertNotIn('authorization', headers)
            self.assertEqual(headers['range'], 'bytes=0-0')

    def test_unready_media_remains_recoverable_instead_of_caching_failed_generation(self):
        initial = 'https://feituokuajing.com/api/video/cache/cm_job?exp=123&sig=fixture'
        error = urllib.error.HTTPError(initial, 409, 'Not ready', {}, io.BytesIO())
        with patch.object(adapter, 'request_json', return_value={
                'success': True, 'jobId': 'cm_job', 'status': 'success', 'videoUrl': initial}), \
                patch.object(adapter.HTTP, 'open', side_effect=error):
            result = adapter.poll('cm_job', 'Bearer private')
        self.assertEqual(result['status'], 'in_progress')
        self.assertTrue(result['remote_completed'])
        self.assertEqual(result['corvas_query_state'], 'unavailable')

    def test_media_redirect_rejects_unexpected_host_and_non_media_response(self):
        initial = 'https://feituokuajing.com/api/video/cache/cm_job?exp=123&sig=fixture'
        for target in ['https://evil.example/cm_job.mp4', 'http://media.feituokuajing.com/a.mp4',
                       'https://media.feituokuajing.com:444/a.mp4', 'https://user:pass@media.feituokuajing.com/a.mp4']:
            redirect = urllib.error.HTTPError(initial, 302, 'Found', {'Location': target}, io.BytesIO())
            with patch.object(adapter.HTTP, 'open', side_effect=redirect) as request, self.assertRaises(ValueError):
                adapter.resolve_media_url(initial, 'cm_job')
            self.assertEqual(request.call_count, 1)
        final = 'https://media.feituokuajing.com/videos/cm_job.mp4'
        redirect = urllib.error.HTTPError(initial, 302, 'Found', {'Location': final}, io.BytesIO())
        response = io.BytesIO(b'{"error":"not ready"}')
        response.headers = {'Content-Type': 'application/json'}
        with patch.object(adapter.HTTP, 'open', side_effect=[redirect, response]), self.assertRaises(ValueError):
            adapter.resolve_media_url(initial, 'cm_job')

    def test_native_http_headers_paths_and_no_redirect(self):
        calls = []

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def reply(self, body):
                raw = json.dumps(body).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                calls.append(('POST', self.path, dict(self.headers), body))
                self.reply({'success': True, 'jobId': 'cm_http', 'taskId': 'provider_task'})

            def do_GET(self):
                calls.append(('GET', self.path, dict(self.headers), None))
                if self.path == '/redirect':
                    self.send_response(302)
                    self.send_header('Location', '/must-not-follow')
                    self.end_headers()
                else:
                    self.reply({'success': True, 'jobId': 'cm_http', 'status': 'success',
                                'videoUrl': 'https://example.test/result?sig=kept'})

        server = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.object(adapter, 'UPSTREAM', f'http://127.0.0.1:{server.server_port}'):
                result = adapter.submit({'model': ALLREF, 'prompt': 'fixture', 'duration': 30}, 'Bearer test-owner')
                self.assertEqual(adapter.poll(result['id'], 'Bearer test-owner')['status'], 'completed')
                with self.assertRaises(urllib.error.HTTPError):
                    adapter.request_json('/redirect', 'Bearer test-owner')
            self.assertEqual(len(calls), 3)
            self.assertEqual(calls[0][1], '/video/generate')
            self.assertTrue(calls[1][1].startswith('/video/status?jobId=cm_http&'))
            for _, _, headers, _ in calls:
                headers = {key.lower(): value for key, value in headers.items()}
                self.assertEqual(headers['authorization'], 'Bearer test-owner')
                self.assertEqual(headers['x-public-model-ids'], '1')
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
