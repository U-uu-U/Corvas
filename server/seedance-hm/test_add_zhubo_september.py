import copy
from decimal import Decimal
import json
from pathlib import Path
import runpy
import unittest


module = runpy.run_path(str(Path(__file__).with_name("add-zhubo-september.py")))
make_plan = module["make_plan"]
build_migration = module["build_migration"]
verify = module["verify"]
TARGETS = module["TARGETS"]
TIMESTAMP = "2026-09-24T04:00:00+00:00"


def fixture():
    model = {"id": 7, "mid": "307001", "model_id": "seedance_v2.5", "original_id": "seedance_v2.5",
             "model_id_alias": "", "name": "Existing route", "billing_rule_id": 4,
             "provider_id": 2, "api_provider_id": 5, "forward_rule_ids": "[37]", "type_id": 4,
             "pre_deduction": 5, "site_discount_enabled": 0, "global_discount_enabled": 0,
             "group_ratios": "{}", "is_active": 1, "sort_order": 4}
    rule = {"id": 4, "pid": "", "name": "Old billing", "is_active": 1, "is_system": 0,
            "billing_type": "requests", "billing_rule": "fixed", "fixed_rate": 5,
            "duration_rate": 0, "prompt_rate": 0, "completion_rate": 0, "cached_rate": 0,
            "claude_cache_read_rate": 0, "claude_cache_creation_rate": 0,
            "extended_config": '{"supported_models":["seedance_v2.5"]}', "pricing_tiers": "[]"}
    channel = {"id": 3, "base_url": "https://video.zhubo.asia", "status": 1, "api_key": "keep-private",
               "models": '["307001","307009"]', "model_mapping": '{"seedance_v2.5":"seedance_v2.5","peer":"peer-upstream"}',
               "quota_used": 12, "daily_quota_used": 2, "quota_limit": 100, "rate": 1}
    return {"models": [model, {**model, "id": 8, "mid": "307009", "model_id": "peer", "is_active": 0}],
            "billing_rules": [rule], "channels": [channel], "forward_rules": [{"id": 37, "is_active": 1,
                "config_json": '{"mode":"passthrough","target_type":"seedance25"}'}],
            "model_providers": [{"id": 2, "is_active": 1}], "model_api_providers": [{"id": 5, "is_active": 1}],
            "channel_categories": [{"id": 1, "name": "Existing group"}], "channel_configs": [],
            "currency": {"default_currency": "CNY", "auxiliary_currencies": []}}


class ZhuboSeptemberTests(unittest.TestCase):
    def test_prices_preserve_commission_margin_and_are_already_cny(self):
        expected = {"art": ["0.84", "1.12", "8", "10", "12"],
                    "cart": ["0.96", "1.28", "9.15", "11.43", "13.72"]}
        for site, prices in expected.items():
            for target, amount in zip(TARGETS, prices):
                actual = module["price_for"](target, site)
                self.assertEqual(actual, Decimal(amount))
                if site == "cart":
                    self.assertGreaterEqual(actual * Decimal(".7"), Decimal(target["upstreamCny"]) * 2 * Decimal(".8"))

    def test_append_only_inherits_route_groups_and_sets_billing_by_unit(self):
        for site in ("art", "cart"):
            before = fixture()
            saved = copy.deepcopy(before)
            after, report, channel_id = make_plan(before, site, TIMESTAMP)
            self.assertEqual(before, saved)
            self.assertEqual(channel_id, 3)
            self.assertEqual(after["models"][:2], before["models"])
            self.assertEqual(after["billing_rules"][:1], before["billing_rules"])
            self.assertEqual(len(after["models"]), 7)
            self.assertEqual(len(after["billing_rules"]), 6)
            self.assertEqual(len({item["ruleId"] for item in report}), 5)
            for model, rule, item, target in zip(after["models"][2:], after["billing_rules"][1:], report, TARGETS):
                self.assertEqual((model["provider_id"], model["api_provider_id"], model["forward_rule_ids"]), (2, 5, "[37]"))
                self.assertEqual(model["billing_rule_id"], rule["id"])
                self.assertEqual(model["original_id"], target["model"])
                self.assertEqual(item["referenceLimits"], {"images": 30, "videos": 0, "audios": 10})
                self.assertEqual(item["minSeconds"], 4)
                self.assertEqual(json.loads(rule["extended_config"])["supported_models"], [target["model"]])
                if target["unit"] == "second":
                    self.assertEqual((rule["billing_type"], rule["billing_rule"]), ("duration", "video_resolution"))
                    self.assertEqual(rule["duration_rate"], item["saleCny"])
                    self.assertEqual(rule["fixed_rate"], 0)
                    self.assertEqual(json.loads(rule["pricing_tiers"]), [{"resolution": target["resolution"],
                                     "rate": item["saleCny"], "cached_rate": 0, "enabled": True}])
                    self.assertAlmostEqual(model["pre_deduction"], item["saleCny"] * 4)
                else:
                    self.assertEqual((rule["billing_type"], rule["billing_rule"]), ("requests", "fixed"))
                    self.assertEqual(rule["fixed_rate"], item["saleCny"])
                    self.assertEqual(rule["duration_rate"], 0)
                    self.assertEqual(json.loads(rule["pricing_tiers"]), [])
                    self.assertEqual(model["pre_deduction"], item["saleCny"])
            mapped = json.loads(after["channels"][0]["model_mapping"])
            self.assertEqual(mapped["peer"], "peer-upstream")
            self.assertEqual(set(mapped) - {"peer", "seedance_v2.5"}, {item["model"] for item in TARGETS})
            self.assertEqual(after["channels"][0]["api_key"], "keep-private")
            self.assertEqual(json.loads(after["channels"][0]["models"])[:2], ["307001", "307009"])

    def test_unexpected_currency_duplicates_or_source_contract_abort(self):
        changes = [
            lambda before: before["currency"].update(default_currency="USD"),
            lambda before: before["models"][1].update(model_id=TARGETS[0]["model"]),
            lambda before: before["channels"][0].update(model_mapping=json.dumps({TARGETS[0]["model"]: "occupied", "seedance_v2.5": "seedance_v2.5"})),
            lambda before: before["channels"][0].update(status=0),
            lambda before: before["forward_rules"][0].update(is_active=0),
            lambda before: before["model_providers"][0].update(is_active=0),
            lambda before: before["models"][0].update(global_discount_enabled=1),
            lambda before: before["billing_rules"][0].update(billing_type="tokens"),
        ]
        for change in changes:
            before = fixture()
            change(before)
            with self.assertRaises(AssertionError):
                make_plan(before, "art", TIMESTAMP)

    def test_double_encoded_channel_json_is_normalized_without_losing_existing_members(self):
        before = fixture()
        channel = before["channels"][0]
        old_members = json.loads(channel["models"])
        old_mapping = json.loads(channel["model_mapping"])
        for key in ("models", "model_mapping"):
            channel[key] = json.dumps(channel[key])
        self.assertEqual(module["normalized_channel_fields"](channel), ["models", "model_mapping"])
        after, _, _ = make_plan(before, "art", TIMESTAMP)
        members = json.loads(after["channels"][0]["models"])
        mapping = json.loads(after["channels"][0]["model_mapping"])
        self.assertIsInstance(members, list)
        self.assertIsInstance(mapping, dict)
        self.assertEqual(members[:len(old_members)], old_members)
        self.assertTrue(all(mapping[key] == value for key, value in old_mapping.items()))
        for key in ("models", "model_mapping"):
            channel[key] = json.dumps(channel[key])
        with self.assertRaises(AssertionError):
            make_plan(before, "art", TIMESTAMP)

    def test_preview_cannot_advance_sequences_and_apply_advances_before_commit_under_lock(self):
        before = fixture()
        after, _, channel = make_plan(before, "cart", TIMESTAMP)
        preview = build_migration(before, after, channel)
        self.assertTrue(preview.endswith("ROLLBACK;"))
        self.assertNotIn("nextval", preview)
        self.assertNotIn("setval", preview)
        self.assertNotIn("COMMIT", preview)
        applied = build_migration(before, after, channel, apply=True)
        self.assertTrue(applied.endswith("COMMIT;"))
        self.assertLess(applied.index("LOCK TABLE"), applied.index("INSERT INTO"))
        self.assertLess(applied.rindex("Catalog guard failed"), applied.index("SELECT setval"))
        self.assertLess(applied.index("SELECT setval"), applied.index("COMMIT"))
        self.assertEqual(applied.count("INSERT INTO models "), 5)
        self.assertEqual(applied.count("INSERT INTO billing_rules "), 5)
        self.assertEqual(applied.count("UPDATE channels "), 1)
        self.assertNotIn("UPDATE models ", applied)
        self.assertNotIn("UPDATE billing_rules ", applied)

    def test_verification_tolerates_usage_but_detects_unrelated_catalog_changes(self):
        before = fixture()
        after, _, _ = make_plan(before, "art", TIMESTAMP)
        actual = copy.deepcopy(after)
        actual["channels"][0].update(quota_used=14, daily_quota_used=4, updated_at="later")
        verify(after, actual)
        for table, key, value in (("models", "name", "changed"), ("billing_rules", "fixed_rate", 99),
                                  ("channels", "quota_limit", 999), ("forward_rules", "is_active", 0)):
            actual = copy.deepcopy(after)
            actual[table][0][key] = value
            with self.assertRaises(AssertionError):
                verify(after, actual)


if __name__ == "__main__":
    unittest.main()
