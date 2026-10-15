import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'dola-discount'))
spec = importlib.util.spec_from_file_location('cheap_adapter', Path(__file__).with_name('adapter.py'))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class AdapterTests(unittest.TestCase):
    def body(self, **changes):
        return {'model': adapter.MODEL, 'prompt': 'fixture', **changes}

    def test_exact_upstream_fields_and_full_image_count(self):
        urls = ['https://example.com/' + str(i) + '.png' for i in range(30)]
        value = adapter.build_request(self.body(images=[{'url': url, 'name': 'fixture'} for url in urls],
                                               duration=30, ratio='21:9', size='1920x1080', seed=123))
        self.assertEqual(value, {'model': adapter.UPSTREAM_MODEL, 'prompt': 'fixture', 'seconds': 30,
                                'resolution': '720p', 'ratio': '21:9', 'image_urls': urls})

    def test_range_and_alias_conflicts(self):
        for duration in (3, 31, 4.5, True):
            with self.assertRaises(ValueError):
                adapter.build_request(self.body(duration=duration))
        self.assertEqual(adapter.build_request(self.body(duration=4, seconds='4'))['seconds'], 4)
        self.assertEqual(adapter.build_request(self.body())['seconds'], 15)
        for changes in ({'duration': 4, 'seconds': 5}, {'ratio': '9:16', 'aspect_ratio': '16:9'}, {'resolution': '480p'}):
            with self.assertRaises(ValueError):
                adapter.build_request(self.body(**changes))

    def test_unsupported_references_and_nonpublic_inputs(self):
        for changes in ({'videos': ['https://example.com/v.mp4']}, {'audio_urls': ['https://example.com/a.mp3']},
                        {'images': ['https://example.com/a.png'] * 31}, {'images': ['data:image/png;base64,AAAA']},
                        {'images': ['http://127.0.0.1/a.png']}, {'n': 2}):
            with self.assertRaises(ValueError):
                adapter.build_request(self.body(**changes))

    def test_submission_uses_exact_endpoint_once(self):
        with patch.object(adapter, 'request_json', return_value={'id': 'task_1'}) as request:
            self.assertEqual(adapter.submit(self.body(), 'Bearer fixture')['id'], 'task_1')
            self.assertEqual(request.call_count, 1)
            self.assertEqual(request.call_args.args[0], '/v1/videos')
            self.assertEqual(request.call_args.args[2]['model'], adapter.UPSTREAM_MODEL)

    def test_completed_result_waits_for_owned_media(self):
        with patch.object(adapter, 'request_json', return_value={'id': 'task_1', 'status': 'completed'}), patch.object(adapter, 'ensure_media', return_value=None):
            result = adapter.poll('task_1', 'Bearer fixture')
            self.assertEqual(result['status'], 'in_progress')
            self.assertEqual(result['stage'], 'downloading')
            self.assertTrue(result['remote_completed'])
        with patch.object(adapter, 'request_json', return_value={'id': 'task_1', 'status': 'completed'}), patch.object(adapter, 'ensure_media', return_value='https://art.ravenhash.org/fc-media/files/result.mp4'):
            self.assertEqual(adapter.poll('task_1', 'Bearer fixture')['status'], 'completed')

    def test_query_outage_and_mismatch_do_not_invent_terminal_failure(self):
        with patch.object(adapter, 'request_json', side_effect=TimeoutError):
            self.assertEqual(adapter.poll('task_1', 'Bearer fixture')['corvas_query_state'], 'unavailable')
        with patch.object(adapter, 'request_json', return_value={'id': 'task_other', 'status': 'completed'}), patch.object(adapter, 'ensure_media') as download:
            self.assertEqual(adapter.poll('task_1', 'Bearer fixture')['corvas_query_state'], 'unavailable')
            download.assert_not_called()
        with patch.object(adapter, 'request_json', return_value={'status': 'failed', 'error': {'message': 'Image too large'}}):
            self.assertEqual(adapter.poll('task_1', 'Bearer fixture')['error']['message'], 'Image too large')


if __name__ == '__main__':
    unittest.main()
