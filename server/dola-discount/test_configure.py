import copy
import json
import unittest

import configure


class MigrationTests(unittest.TestCase):
    def test_only_requested_model_and_cny10_fixed_billing_are_added(self):
        before = {table: [] for table in configure.HELPER['TABLES']}
        before['currency'] = {'default_currency': 'CNY'}
        before['models'] = [{'id': 10, 'mid': '310001', 'model_id': 'seedance_v2.0-933',
                             'billing_rule_id': 20, 'is_active': 1, 'forward_rule_ids': '[30]', 'sort_order': 4}]
        before['billing_rules'] = [{'id': 20, 'is_active': 1}]
        before['channels'] = [{'id': 4, 'base_url': 'https://video.zhubo.asia', 'rate': 1, 'status': 1,
                              'models': '["310001"]', 'api_key': 'existing-private', 'total_used': 500}]
        before['forward_rules'] = [{'id': 30, 'is_active': 1, 'config_json': json.dumps({
            'mode': 'passthrough', 'path_rewrite': {'new': '/v1/videos'}, 'poll_path': '/v1/videos/${task_id}'})}]
        original = copy.deepcopy(before)
        after, receipt = configure.plan(before, 'fixture-key', '2026-10-08T00:00:00Z')
        self.assertEqual(before, original)
        for table in configure.HELPER['TABLES']:
            self.assertEqual(after[table][:len(before[table])], before[table])
        self.assertEqual(receipt['saleCny'], 10)
        self.assertEqual(after['models'][-1]['pre_deduction'], 10)
        self.assertEqual(after['billing_rules'][-1]['billing_type'], 'requests')
        self.assertEqual(after['billing_rules'][-1]['fixed_rate'], 10)
        self.assertEqual(after['billing_rules'][-1]['duration_rate'], 0)
        self.assertEqual(after['models'][-1]['model_id'], configure.MODEL)
        self.assertTrue(configure.migration(before, after).endswith('ROLLBACK;'))
        with self.assertRaises(AssertionError):
            configure.plan(after, 'fixture-key', '2026-10-08T00:00:00Z')
