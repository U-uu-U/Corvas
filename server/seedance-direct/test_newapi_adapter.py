import os
import unittest
from unittest.mock import patch

os.environ.setdefault('UPSTREAM', 'http://upstream.test')
import adapter


class NewApiModelMappingTest(unittest.TestCase):
    def test_public_model_stays_stable_when_upstream_name_changes(self):
        body = {'model': 'b_seedance_v2.0', 'prompt': 'fixture', 'duration': 15}
        with patch.object(adapter, 'UPSTREAM_MODEL', 'seedance_v2.0'), patch.object(adapter, 'request_json', return_value={'task_id': 123}) as request:
            self.assertEqual(adapter.submit(body, 'Bearer fixture')['task_id'], '123')
        request.assert_called_once()
        self.assertEqual(request.call_args.args[2]['model'], 'seedance_v2.0')
        self.assertEqual(body['model'], 'b_seedance_v2.0')
        self.assertEqual(adapter.build_request(body)['model'], 'b_seedance_v2.0')


if __name__ == '__main__':
    unittest.main()
