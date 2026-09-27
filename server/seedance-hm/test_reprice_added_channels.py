import copy
from decimal import Decimal
from pathlib import Path
import runpy
import unittest

module = runpy.run_path(str(Path(__file__).with_name('reprice-added-channels.py')))
make_plan = module['make_plan']
price_for = module['price_for']
OLD_CNY = module['OLD_CNY']


def fixture(site):
    exchange = 6.75 if site == 'art' else 1
    models, rules = [], []
    for i, (name, value) in enumerate(OLD_CNY.items(), 1):
        cny = 4 if name == 'oc-model-qbdmeb' else float(value)
        rate = cny / exchange
        duration = name == 'oc-model-1iq31f'
        rules.append({'id': i, 'is_system': 0, 'is_active': 1, 'billing_type': 'duration' if duration else 'requests',
                      'billing_rule': 'video_resolution' if duration else 'fixed', 'fixed_rate': 0 if duration else rate,
                      'duration_rate': rate if duration else 0, 'extended_config': '{}',
                      'pricing_tiers': module['json'].dumps([{'resolution': r, 'rate': rate, 'cached_rate': 0, 'enabled': True}
                                                            for r in ['480p', '720p', '1080p']] if duration else []),
                      'name': 'sale CNY %.2f/request' % cny})
        models.append({'id': i, 'model_id': name, 'billing_rule_id': i, 'pre_deduction': rate * (5 if duration else 1),
                       'site_discount_enabled': 0, 'global_discount_enabled': 0, 'group_ratios': '{}',
                       'description': 'sale CNY %.2f/request' % cny, 'remark': '', 'is_active': i % 2})
    models.append({'id': 90, 'model_id': 'unrelated', 'billing_rule_id': 90, 'is_active': 0})
    rules.append({'id': 90, 'fixed_rate': 11})
    return {'models': models, 'billing_rules': rules}, exchange


class AddedChannelPricingTests(unittest.TestCase):
    def test_exact_prices_and_commission_receipts(self):
        expected = {'sd2-fast': '4.58', 'seedance-2.5-pro': '11.20', 'seedance-2.5-pro-720': '14.86',
                    'oc-model-qbdmeb': '5.72', 'oc-model-1iq31f': '5.72', 'oc-model-bkb50q': '8.00', 'oc-model-c6ws7e': '8.00'}
        for model, price in expected.items():
            self.assertEqual(price_for(model, 'cart'), Decimal(price))
            self.assertGreaterEqual(Decimal(price) * Decimal('.7'), OLD_CNY[model] * Decimal('.8'))

    def test_old_site_changes_only_dola_and_keeps_the_currency_contract(self):
        before, exchange = fixture('art')
        after, report = make_plan(before, 'art', exchange)
        self.assertEqual([row['model'] for row in report], ['oc-model-qbdmeb'])
        self.assertAlmostEqual(report[0]['preDeduction'] * exchange, 5)
        for previous, current in zip(before['models'], after['models']):
            if previous['model_id'] != 'oc-model-qbdmeb': self.assertEqual(previous, current)

    def test_cart_tiers_pre_deduction_and_idempotency(self):
        before, exchange = fixture('cart'); original = copy.deepcopy(before)
        after, report = make_plan(before, 'cart', exchange)
        self.assertEqual(len(report), 7)
        self.assertEqual(next(r for r in report if r['model'] == 'oc-model-1iq31f')['preDeduction'], 28.6)
        self.assertEqual([m['is_active'] for m in after['models']], [m['is_active'] for m in before['models']])
        self.assertEqual(after['models'][-1], before['models'][-1])
        self.assertEqual(after['billing_rules'][-1], before['billing_rules'][-1])
        self.assertEqual(before, original)
        repeated, repeated_report = make_plan(after, 'cart', exchange)
        self.assertEqual(repeated, after)
        self.assertEqual(repeated_report, [])

    def test_unexpected_price_or_shared_rules_abort(self):
        before, exchange = fixture('cart')
        before['billing_rules'][0]['fixed_rate'] = 99
        with self.assertRaises(AssertionError): make_plan(before, 'cart', exchange)
        before, exchange = fixture('cart')
        before['models'][-1]['billing_rule_id'] = before['models'][0]['billing_rule_id']
        with self.assertRaises(AssertionError): make_plan(before, 'cart', exchange)


if __name__ == '__main__':
    unittest.main()
