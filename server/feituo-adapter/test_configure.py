import copy
import json
import unittest

import configure


class MigrationTests(unittest.TestCase):
    def fixture(self):
        snapshot = {table: [] for table in configure.TABLES}
        snapshot.update(currency={'default_currency': 'CNY'})
        snapshot['models'] = [{'id': 10, 'mid': '310001', 'model_id': 'seedance_v2.0-933',
                               'billing_rule_id': 20, 'is_active': 1, 'forward_rule_ids': '[30]', 'sort_order': 4}]
        snapshot['billing_rules'] = [{'id': 20, 'is_active': 1}]
        snapshot['channels'] = [{'id': 4, 'base_url': 'https://video.zhubo.asia', 'rate': 1, 'status': 1,
                                'models': '["310001"]', 'api_key': 'existing-private', 'total_used': 500}]
        snapshot['forward_rules'] = [{'id': 30, 'is_active': 1, 'config_json': json.dumps({
            'mode': 'passthrough', 'path_rewrite': {'new': '/v1/videos'}, 'poll_path': '/v1/videos/${task_id}'})}]
        return snapshot

    def test_append_only_models_and_fixed_price_rules(self):
        before = self.fixture()
        original = copy.deepcopy(before)
        after, additions, channel = configure.plan(before, 'ftk_test-only', '2026-10-08T00:00:00Z')
        self.assertEqual(before, original)
        for table in configure.TABLES:
            self.assertEqual(after[table][:len(before[table])], before[table])
        self.assertEqual([row['saleCny'] for row in additions], [3.6, 7.5, 3.6, 7.5])
        self.assertEqual([row['pre_deduction'] for row in after['models'][1:]], [3.6, 7.5, 3.6, 7.5])
        self.assertTrue(all(row['billing_type'] == 'requests' and row['billing_rule'] == 'fixed'
                            and row['duration_rate'] == 0 for row in after['billing_rules'][1:]))
        self.assertEqual(after['channels'][-1]['total_used'], 0)
        self.assertEqual(channel, 5)
        self.assertEqual(json.loads(after['channels'][-1]['models']), ['310002', '310003', '310004', '310005'])
        self.assertTrue(configure.migration(before, after).endswith('ROLLBACK;'))
        self.assertTrue(configure.migration(before, after, apply=True).endswith('COMMIT;'))

    def test_existing_target_or_changed_forward_rule_prevents_migration(self):
        before = self.fixture()
        after, _, _ = configure.plan(before, 'ftk_test-only', '2026-10-08T00:00:00Z')
        with self.assertRaises(AssertionError):
            configure.plan(after, 'ftk_test-only', '2026-10-08T00:00:00Z')
        before['forward_rules'][0]['config_json'] = '{}'
        with self.assertRaises((AssertionError, KeyError)):
            configure.plan(before, 'ftk_test-only', '2026-10-08T00:00:00Z')


if __name__ == '__main__':
    unittest.main()
