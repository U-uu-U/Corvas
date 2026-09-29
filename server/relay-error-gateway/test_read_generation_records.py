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
