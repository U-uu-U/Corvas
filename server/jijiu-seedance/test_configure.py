import copy
import json
from pathlib import Path
import runpy
import unittest

HERE = Path(__file__).resolve().parent
module = runpy.run_path(str(HERE/'configure.py'))
template = runpy.run_path(str(HERE.parent/'seedance-hm/test_add_zhubo_september.py'))


def fixture():
    value = template['fixture']()
    value['models'][0]['model_id'] = module['SOURCE']
    value['forward_rules'][0]['config_json'] = json.dumps({'mode': 'passthrough', 'auth_type': 'bearer',
        'path_rewrite': {'old': '/v1/video/generations', 'new': '/v1/videos'}, 'poll_path': '/v1/videos/${task_id}'})
    return value


class JijiuConfigurationTests(unittest.TestCase):
    def test_append_only_fixed_price_and_exact_upstream_mapping(self):
        before = fixture()
        saved = copy.deepcopy(before)
        after, receipt = module['plan'](before, 'private-test-key', '2026-10-12T00:00:00Z')
        self.assertEqual(before, saved)
        for table in module['HELPER']['TABLES']:
            self.assertEqual(after[table][:len(before[table])], before[table])
        model, rule, channel = after['models'][-1], after['billing_rules'][-1], after['channels'][-1]
        self.assertEqual((rule['billing_type'], rule['billing_rule'], rule['fixed_rate'], rule['duration_rate']), ('requests', 'fixed', 11, 0))
        self.assertEqual((model['pre_deduction'], receipt['saleCny']), (11, 11))
        self.assertEqual(model['group_ratios'], '{}')
        self.assertFalse(model['site_discount_enabled'] or model['global_discount_enabled'])
        self.assertEqual(json.loads(channel['model_mapping']), {module['SPEC']['model']: module['SPEC']['model']})
        self.assertEqual(model['original_id'], module['SPEC']['model'])
        self.assertEqual(channel['base_url'], module['ADAPTER'])
        self.assertEqual(model['provider_id'], before['models'][0]['provider_id'])
        self.assertNotIn('private-test-key', json.dumps(receipt))

    def test_duplicates_currency_and_wrong_endpoint_rejected(self):
        changes = [lambda value: value['currency'].update(default_currency='USD'),
                   lambda value: value['models'][1].update(model_id=module['SPEC']['model']),
                   lambda value: value['channels'][0].update(base_url=module['SPEC']['origin']),
                   lambda value: value['forward_rules'][0].update(config_json=json.dumps({'mode': 'passthrough',
                       'auth_type': 'bearer', 'path_rewrite': {'new': '/v1/video/generations'}, 'poll_path': '/v1/videos/${task_id}'}))]
        for change in changes:
            value = fixture()
            change(value)
            with self.assertRaises(AssertionError):
                module['plan'](value, 'private-test-key', '2026-10-12T00:00:00Z')

    def test_preview_rolls_back_and_apply_guards_all_prior_rows(self):
        before = fixture()
        after, _ = module['plan'](before, 'private-test-key', '2026-10-12T00:00:00Z')
        preview = module['migration'](before, after)
        self.assertTrue(preview.endswith('ROLLBACK;'))
        self.assertNotIn('setval(', preview)
        applied = module['migration'](before, after, True)
        self.assertTrue(applied.endswith('COMMIT;'))
        self.assertIn('Currency settings changed', applied)
        for table in module['HELPER']['TABLES']:
            self.assertIn('Catalog guard failed: '+table, applied)


if __name__ == '__main__':
    unittest.main()
