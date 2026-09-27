import copy
from contextlib import redirect_stdout
import importlib.util
import io
from pathlib import Path
import json
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location('migration', Path(__file__).with_name('migrate-art-cny.py'))
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class CurrencyMigrationTests(unittest.TestCase):
    def test_equivalent_money_and_unlimited_quota(self):
        self.assertEqual(migration.scale(100), 675)
        self.assertEqual(migration.scale(-20), -135)
        self.assertEqual(migration.scale(-1, sentinel=True), -1)
        self.assertEqual(migration.scale(0, sentinel=True), 0)
        self.assertEqual(migration.scale(5 / 6.75, 12), 5)
        self.assertEqual(migration.scale(0.000001), 0.000007)

    def test_rate_json_preserves_counts_flags_and_multipliers(self):
        original = {'resolution_rates': {'720p': {'with_video': 3.3, 'without_video': 5.6}},
                    'price_table': {'fast|720p|no': 1}, 'image_prompt_rate': 0.1,
                    'ref_token_rate_per_1k': 0.02, 'free_ref_tokens': 4096, 'image_tokens_default': 1024,
                    'video_ref_tokens_per_sec': {'720p': 7459}, 'audio_ref_tokens_per_sec': 80,
                    'time_multipliers': [{'multiplier': 0.9}], 'enable_time_multipliers': True}
        expected = copy.deepcopy(original)
        expected.update(resolution_rates={'720p': {'with_video': 22.275, 'without_video': 37.8}},
                        price_table={'fast|720p|no': 6.75}, image_prompt_rate=0.675, ref_token_rate_per_1k=0.135)
        self.assertEqual(json.loads(migration.convert_rule_json(json.dumps(original), 'extended_config')), expected)
        tiers = [{'resolution': '720p', 'rate': 1, 'cached_rate': 0.2, 'enabled': True, 'max_tokens': 4096}]
        self.assertEqual(json.loads(migration.convert_rule_json(json.dumps(tiers), 'pricing_tiers')),
                         [{'resolution': '720p', 'rate': 6.75, 'cached_rate': 1.35, 'enabled': True, 'max_tokens': 4096}])

    def test_currency_conversion_is_not_repeatable(self):
        original = {'default_currency': 'USD', 'currency_symbol': '$', 'currency_unit': 'dollar',
                    'token_ratio': 1, 'quick_amounts': [20, 100], 'min_recharge_amount': 5,
                    'auxiliary_currencies': [{'code': 'CNY', 'enabled': True, 'exchange_rate': 6.75}]}
        changed = migration.convert_currency(json.dumps(original))
        actual = json.loads(changed)
        self.assertEqual(actual['default_currency'], 'CNY')
        self.assertEqual(actual['quick_amounts'], [135, 675])
        self.assertEqual(actual['min_recharge_amount'], 33.75)
        self.assertEqual(actual['token_ratio'], 1)
        self.assertEqual(actual['auxiliary_currencies'], [])
        with self.assertRaises(AssertionError):
            migration.convert_currency(changed)

    def test_unreviewed_billing_price_is_rejected(self):
        with self.assertRaisesRegex(AssertionError, 'Unreviewed'):
            migration.convert_rule_json('{"audio_rate":0.2}', 'extended_config')
        with self.assertRaisesRegex(AssertionError, 'Unreviewed'):
            migration.convert_rule_json('[{"rate":1,"cache_write_rate":0.1}]', 'pricing_tiers')

    def test_whole_snapshot_preserves_original_and_non_currency_settings(self):
        before = {'users': [{'id': 1, **dict.fromkeys(migration.FIELDS['users'], 1)}],
                  'logs': [{'id': 5, 'cost': 2, 'pre_deduct_gift': 0, 'billing_detail': 'original USD formula'}],
                  'settings': [{'key': 'storage_settings', 'value': '{"unchanged":true}'}]}
        original = copy.deepcopy(before)
        expected = migration.convert_snapshot(before)
        self.assertEqual(before, original)
        self.assertEqual(expected['users'][0]['balance'], 6.75)
        self.assertEqual(expected['logs'][0]['cost'], 13.5)
        self.assertTrue(expected['logs'][0]['billing_detail'].endswith('original USD formula'))
        self.assertEqual(expected['settings'], before['settings'])
        migration.verify(expected, copy.deepcopy(expected))
        expected['users'][0]['balance'] = 0
        with self.assertRaises(AssertionError):
            migration.verify(expected, migration.convert_snapshot(before))

    def test_stop_or_database_close_failure_still_restarts_backend(self):
        database = Mock()
        database.json.return_value = {'default_currency': 'USD'}
        database.close.side_effect = RuntimeError('close failed')
        def run(command, **_kwargs):
            if 'stop' in command:
                raise RuntimeError('stop response lost after container exited')
        with patch.object(migration, 'Database', return_value=database), \
                patch.object(migration, 'preflight'), \
                patch('sys.argv', ['migrate-art-cny.py', '--apply']), \
                patch.object(migration.subprocess, 'check_output', return_value='[{"State":{"Running":true}}]'), \
                patch.object(migration.subprocess, 'run', side_effect=run) as commands, \
                redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, 'close failed'):
                migration.main()
        self.assertEqual(commands.call_args_list[-1].args[0], ['docker', 'start', 'tokensbyte-backend'])


if __name__ == '__main__':
    unittest.main()
