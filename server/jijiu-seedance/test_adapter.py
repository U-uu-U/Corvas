import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('jijiu_adapter', Path(__file__).with_name('adapter.py'))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


def fixture():
    return {'model': adapter.SPEC['model'], 'prompt': 'test', 'duration': 30, 'ratio': '9:16', 'resolution': '720p',
            'images': [{'url': f'https://example.com/image-{i}.png'} for i in range(30)],
            'videos': [f'https://example.com/video-{i}.mp4' for i in range(10)],
            'audio_urls': [f'https://example.com/audio-{i}.mp3' for i in range(10)]}


class JijiuAdapterTests(unittest.TestCase):
    def test_full_reference_conversion_preserves_order(self):
        body = fixture()
        saved = copy.deepcopy(body)
        wire = adapter.build_request(body)
        self.assertEqual(body, saved)
        self.assertEqual(wire, {'model': adapter.SPEC['upstreamModel'], 'prompt': 'test', 'seconds': 30,
            'resolution': '720p', 'aspect_ratio': '9:16', 'images': [item['url'] for item in body['images']],
            'reference_videos': body['videos'], 'reference_audios': body['audio_urls']})

    def test_limits_and_conflicting_fields_are_not_silently_truncated(self):
        for field, value in [('duration', 3), ('duration', 31), ('duration', True), ('seconds', 4), ('resolution', '1080p'),
                             ('images', ['https://example.com/x']*31), ('videos', ['https://example.com/x']*11),
                             ('audio_urls', ['https://example.com/x']*11), ('images', [{'url': 'http://127.0.0.1/x'}])]:
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                adapter.build_request({**fixture(), field: value})

    def test_submit_uses_id_and_never_retries(self):
        with patch.object(adapter, 'request_json', return_value={'id': 'task-ok', 'status': 'queued'}) as request:
            result = adapter.submit(fixture(), 'Bearer fixture')
            self.assertEqual(result['task_id'], 'task-ok')
            self.assertEqual(request.call_args.args[0], '/v1/videos')
            self.assertEqual(request.call_args.args[2]['model'], adapter.SPEC['upstreamModel'])
        with patch.object(adapter, 'request_json', side_effect=TimeoutError) as request:
            with self.assertRaises(TimeoutError):
                adapter.submit(fixture(), 'Bearer fixture')
            request.assert_called_once()

    def test_signed_content_is_preferred_and_private_metadata_omitted(self):
        url = adapter.SPEC['origin']+'/v1/tasks/task-ok/artifacts/video/content?access=signed-ticket'
        payload = {'id': 'task-ok', 'status': 'completed', 'content_url': url, 'video_url': 'https://example.com/expired.mp4',
                   'cost': 5.5, 'balance': 99, 'completed_at': 1791766800, 'prompt': 'private-prompt'}
        with patch.object(adapter, 'request_json', return_value=payload):
            result = adapter.poll('task-ok', 'Bearer fixture')
        self.assertEqual(result['video_url'], url)
        self.assertEqual(result['completed_at'], 1791766800)
        self.assertFalse(set(result) & {'cost', 'balance', 'prompt', 'usage'})

    def test_actual_nested_video_response_is_completed(self):
        task = 'task_ZuGOh6AVPonVcOLxn9lWt8nYp2g81IbQ'
        url = adapter.SPEC['origin']+'/v1/tasks/'+task+'/artifacts/video/content?access=fixture-ticket'
        payload = {'id': task, 'status': 'completed', 'progress': 100, 'created_at': 1791745842,
                   'completed_at': 1791746414, 'video': {'duration': 15, 'url': url}}
        with patch.object(adapter, 'request_json', return_value=payload):
            result = adapter.poll(task, 'Bearer fixture')
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['video_url'], url)
        self.assertEqual(result['completed_at'], 1791746414)

    def test_nested_unsigned_wrong_task_and_invalid_candidates(self):
        prefix = adapter.SPEC['origin']+'/v1/tasks/'
        for url in [prefix+'task-ok/artifacts/video/content', prefix+'task-other/artifacts/video/content?access=fixture']:
            with self.assertRaises(ValueError):
                adapter.media_url({'video': {'url': url}}, 'task-ok')
        self.assertEqual(adapter.media_url({'content_url': 'invalid', 'video': {'url': 'https://example.com/result.mp4'}}, 'task-ok'),
                         'https://example.com/result.mp4')

    def test_poll_failures_are_retryable_but_real_task_failure_is_terminal(self):
        for payload in [{'id': 'task-other', 'status': 'completed'}, {'id': 'task-ok', 'status': 'unknown'},
                        {'id': 'task-ok', 'status': 'completed', 'content_url': adapter.SPEC['origin']+'/v1/videos/task-ok/content'}]:
            with patch.object(adapter, 'request_json', return_value=payload):
                result = adapter.poll('task-ok', 'Bearer fixture')
                self.assertEqual(result['corvas_query_state'], 'unavailable')
        with patch.object(adapter, 'request_json', side_effect=urllib.error.HTTPError('', 404, '', {}, None)):
            self.assertEqual(adapter.poll('task-ok', 'Bearer fixture')['status'], 'in_progress')
        with patch.object(adapter, 'request_json', return_value={'id': 'task-ok', 'status': 'failed', 'error': {'message': 'invalid image', 'code': 'bad_image'}}):
            self.assertEqual(adapter.poll('task-ok', 'Bearer fixture')['error']['message'], 'invalid image')


if __name__ == '__main__':
    unittest.main()
