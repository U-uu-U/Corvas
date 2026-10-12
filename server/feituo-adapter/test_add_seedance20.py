import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import configure
import test_configure

spec = importlib.util.spec_from_file_location('add_seedance20', Path(__file__).with_name('add-seedance20.py'))
addition = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addition)


def fixture():
    initial = test_configure.MigrationTests().fixture()
    original_models = {key: value for key, value in configure.MODELS.items() if key != addition.NEW}
    with patch.object(configure, 'MODELS', original_models):
        result, _, _ = configure.plan(initial, 'ftk_existing-private', '2026-10-08T00:00:00Z')
    return result


class Seedance20AdditionTests(unittest.TestCase):
    def test_reuses_credentials_and_preserves_prices_while_appending_one_model(self):
        before = fixture()
        saved = copy.deepcopy(before)
        after, receipt = addition.plan(before, '2026-10-12T00:00:00Z')
        self.assertEqual(before, saved)
        for table in ('models', 'billing_rules', 'forward_rules'):
            self.assertEqual(after[table][:len(before[table])], before[table])
        old_channel = next(row for row in before['channels'] if row['id'] == receipt['channelId'])
        new_channel = next(row for row in after['channels'] if row['id'] == receipt['channelId'])
        self.assertEqual(new_channel['api_key'], old_channel['api_key'])
        self.assertEqual(new_channel['total_used'], old_channel['total_used'])
        self.assertEqual(json.loads(new_channel['models'])[:-1], json.loads(old_channel['models']))
        self.assertEqual(after['models'][-1]['pre_deduction'], 7.5)
        self.assertEqual(after['billing_rules'][-1]['fixed_rate'], 7.5)
        self.assertEqual(receipt['existingSaleCny'], 3.6)
        self.assertTrue(addition.migration(before, after, receipt).endswith('ROLLBACK;'))
        self.assertNotIn('setval(', addition.migration(before, after, receipt))
        self.assertTrue(addition.migration(before, after, receipt, True).endswith('COMMIT;'))

    def test_existing_model_and_unexpected_price_are_rejected(self):
        before = fixture()
        after, _ = addition.plan(before, '2026-10-12T00:00:00Z')
        with self.assertRaises(AssertionError):
            addition.plan(after, '2026-10-12T00:00:00Z')
        source = next(row for row in before['models'] if row['model_id'] == addition.EXISTING)
        source['pre_deduction'] = 9
        with self.assertRaises(AssertionError):
            addition.plan(before, '2026-10-12T00:00:00Z')


if __name__ == '__main__':
    unittest.main()
