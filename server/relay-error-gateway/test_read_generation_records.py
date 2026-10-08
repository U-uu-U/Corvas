import importlib.util
import pathlib
import unittest
import json
import sys

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('records', pathlib.Path(__file__).with_name('read-generation-records.py'))
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


class GenerationProjectionTest(unittest.TestCase):
    def test_terminal_video_elapsed_is_distinct_from_pending_http_latency(self):
        row = {'user_id': 'private-user', 'channel_id': 3, 'model': 'seedance_v2.0-933',
               'task_id': 'private-task', 'log_id': 'private-log', 'id': 893,
               'created_at': '2026-10-06T10:30:43Z', 'status_code': 200, 'is_completed': 1,
               'endpoint': '/v1/video/generations', 'latency_ms': 405916, 'error_message': None,
               'response_content': json.dumps({'status': 'completed'})}
        result = reader.project_record(row)
        self.assertEqual(result['completionElapsedMs'], 405916)
        self.assertEqual(result['completionTimeSource'], 'relay_terminal_elapsed')
        self.assertEqual(result['response']['completedAt'], '2026-10-06T10:37:28.916000+00:00')
        self.assertEqual(reader.project_record({**row, 'response_content': json.dumps({
            'status': 'completed', 'completed_at': '2026-10-06T10:36:00Z'})})['response']['completedAt'],
            '2026-10-06T10:36:00Z')
        self.assertNotIn('private', json.dumps(result))
        for patch in [{'is_completed': 0}, {'status_code': 202}, {'status_code': 503},
                      {'task_id': ''}, {'latency_ms': 0}, {'latency_ms': -1},
                      {'latency_ms': 8 * 86400000}, {'error_message': 'error'},
                      {'response_content': json.dumps({'status': 'processing'})},
                      {'response_content': json.dumps({'status': 'failed'})}]:
            self.assertNotIn('completionElapsedMs', reader.project_record({**row, **patch}))

    def test_projection_omits_private_inputs_outputs_and_billing(self):
        projected = reader.project_response(json.dumps({'status': 'completed', 'completed_at': 123,
            'prompt': 'private prompt', 'cost': 12, 'balance': 45, 'api_key': 'private-key',
            'data': [{'url': 'https://private/media?token=secret'}]}))
        self.assertTrue(projected['hasOutput'])
        self.assertEqual(projected['completedAt'], 123)
        self.assertNotIn('private', json.dumps(projected))
        self.assertNotIn('balance', json.dumps(projected))

    def test_nested_failure_reasons_survive_for_private_classification(self):
        projected = reader.project_response(json.dumps({'data': {'status': 'failed', 'message': 'content policy rejected'}}))
        self.assertEqual(projected['states'], ['', 'failed'])
        self.assertEqual(projected['errors'][0]['message'], 'content policy rejected')

    def test_malformed_or_truncated_response_does_not_imply_success(self):
        self.assertEqual(reader.project_response('{"status":"completed"'), {})
        self.assertEqual(reader.project_response(None)['hasOutput'], False)


if __name__ == '__main__':
    unittest.main()
