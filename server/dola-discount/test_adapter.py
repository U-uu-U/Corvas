import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import io
import urllib.error

spec = importlib.util.spec_from_file_location('dola_discount_adapter', Path(__file__).with_name('adapter.py'))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class ContractTests(unittest.TestCase):
    def setUp(self):
        adapter.CACHE.clear()

    def test_canvas_request_maps_to_exact_public_model_and_native_fields(self):
        urls = ['https://example.test/ref.png'] * 10
        for duration in (4, 30):
            body = adapter.build_request({'model': adapter.MODEL, 'prompt': 'fixture', 'duration': duration,
                                          'ratio': '9:16', 'images': [{'url': url} for url in urls]})
            self.assertEqual(body, {'model': adapter.MODEL, 'prompt': 'fixture', 'seconds': duration,
                                    'size': '9:16', 'aspect_ratio': '9:16', 'images': urls})

    def test_seconds_priority_and_first_last_frames(self):
        body = adapter.build_request({'model': adapter.MODEL, 'prompt': 'fixture', 'seconds': '12', 'duration': 30,
            'first_frame_url': 'https://example.test/first.png', 'last_frame_url': 'https://example.test/last.png'})
        self.assertEqual(body['seconds'], 12)
        self.assertIn('last_frame_url', body)
        self.assertNotIn('images', body)

    def test_invalid_requests_fail_before_submission(self):
        for change in [{'model': 'Seedance 2.5'}, {'duration': 3}, {'duration': 31}, {'duration': True},
                       {'duration': 4.5}, {'prompt': 'x' * 5001}, {'size': '1024x1024'},
                       {'images': ['https://example.test/a.png'] * 11},
                       {'videos': ['https://example.test/a.mp4']}, {'audios': ['https://example.test/a.mp3']},
                       {'images': ['https://secret@example.test/a.png']},
                       {'images': ['data:image/png;base64,eA==']}, {'n': 2}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                adapter.build_request({'model': adapter.MODEL, 'prompt': 'fixture', **change})

    def test_submit_is_not_repeated_and_discards_supplier_prices(self):
        with patch.object(adapter, 'request_json', return_value={
                'task_id': 'task_1', 'id': 'task_1', 'status': 'queued', 'cost': 99}) as request:
            value = adapter.submit({'model': adapter.MODEL, 'prompt': 'fixture'}, 'Bearer private')
        self.assertEqual(request.call_args.args[0], '/v1/video/generations')
        self.assertEqual(value['task_id'], 'task_1')
        self.assertNotIn('cost', value)
        with patch.object(adapter, 'request_json', side_effect=TimeoutError) as request:
            with self.assertRaises(TimeoutError):
                adapter.submit({'model': adapter.MODEL, 'prompt': 'fixture'}, 'Bearer private')
        self.assertEqual(request.call_count, 1)

    def test_completed_media_is_cached_without_returning_supplier_billing(self):
        url = 'https://art.ravenhash.org/fc-media/files/dola25-fixture.mp4'
        with patch.object(adapter, 'request_json', return_value={
                'id': 'task_1', 'status': 'completed', 'metadata': {'url': 'https://supplier.test/a.mp4'},
                'billing': {'cost': 99}}), patch.object(adapter, 'ensure_media', return_value=url) as media:
            result = adapter.poll('task_1', 'Bearer private')
        media.assert_called_once_with(adapter.UPSTREAM, 'task_1', 'Bearer private')
        self.assertEqual(result['video_url'], url)
        self.assertEqual(result['status'], 'completed')
        self.assertNotIn('billing', result)

    def test_query_failures_are_not_terminal_failures(self):
        for payload in [TimeoutError(), {'id': 'task_other', 'status': 'completed'},
                        {'success': False}, {'id': 'task_1', 'status': 'unexpected'}]:
            adapter.CACHE.clear()
            kw = {'side_effect': payload} if isinstance(payload, Exception) else {'return_value': payload}
            with patch.object(adapter, 'request_json', **kw):
                result = adapter.poll('task_1', 'Bearer private')
            self.assertEqual(result['status'], 'in_progress')
            self.assertEqual(result['corvas_query_state'], 'unavailable')
            self.assertNotIn('error', result)

    def test_explicit_failure_preserves_error_and_queue_stays_pending(self):
        with patch.object(adapter, 'request_json', return_value={
                'id': 'task_1', 'status': 'failed', 'error': {'message': 'Invalid reference dimensions'}}):
            result = adapter.poll('task_1', 'Bearer private')
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['error']['message'], 'Invalid reference dimensions')
        adapter.CACHE.clear()
        with patch.object(adapter, 'request_json', return_value={'id': 'task_1', 'status': 'queued', 'progress': 100}):
            result = adapter.poll('task_1', 'Bearer private')
        self.assertEqual(result['status'], 'queued')
        self.assertEqual(result['poll_after_seconds'], 60)

    def test_documented_data_envelope_without_id_and_processing_alias(self):
        with patch.object(adapter, 'request_json', return_value={'data': {'status': 'succeeded',
                'url': adapter.UPSTREAM + '/v1/videos/task_1/content'}}), \
                patch.object(adapter, 'ensure_media', return_value=None):
            result = adapter.poll('task_1', 'Bearer private')
        self.assertEqual(result['stage'], 'downloading')
        self.assertTrue(result['remote_completed'])
        self.assertNotIn('video_url', result)
        adapter.CACHE.clear()
        with patch.object(adapter, 'request_json', return_value={'data': {'status': 'processing'}}):
            self.assertEqual(adapter.poll('task_1', 'Bearer private')['status'], 'in_progress')

    def test_poll_fallback_and_cache_limit_upstream_to_one_query_per_minute(self):
        missing = urllib.error.HTTPError('http://fixture', 404, 'Not found', {}, io.BytesIO())
        with patch.object(adapter, 'request_json', side_effect=[missing, {'id': 'task_1', 'status': 'queued'}]) as request:
            adapter.poll('task_1', 'Bearer private')
            adapter.poll('task_1', 'Bearer private')
        self.assertEqual([call.args[0] for call in request.call_args_list],
                         ['/v1/video/generations/task_1', '/v1/videos/task_1'])


if __name__ == '__main__':
    unittest.main()
