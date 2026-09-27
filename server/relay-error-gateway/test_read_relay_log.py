import importlib.util
import json
from pathlib import Path
import types
import unittest


spec = importlib.util.spec_from_file_location("read_relay_log", Path(__file__).with_name("read-relay-log.py"))
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


class ReadRelayLogTest(unittest.TestCase):
    def test_exact_read_only_lookup_and_private_redaction(self):
        calls = []
        request_id = "rh_" + "a" * 32

        def run(command, **kwargs):
            calls.append((command, kwargs))
            if "-i" not in command:
                return types.SimpleNamespace(stdout="app\nappdb\n")
            return types.SimpleNamespace(stdout=json.dumps([{"log_id": request_id, "cost": 4, "is_completed": 1,
                "channel_name": "private-provider", "user_id": 42, "token_id": 91, "input_tokens": 15,
                "completed_at": "2026-09-27T10:00:00Z", "elapsed_time": 1234, "refund_status": "pending",
                "response_body": json.dumps({"prompt": "remove me", "error": {"message": "Bearer abc123 https://private/image?token=secret"}})}]))

        result = reader.read_log("art", request_id, run)
        self.assertEqual(result["state"], "found")
        self.assertEqual(result["billingState"], "unknown")
        self.assertEqual(result["rows"][0]["cost"], 4)
        self.assertEqual(result["rows"][0]["channel_name"], "private-provider")
        self.assertEqual(result["rows"][0]["user_id"], 42)
        self.assertEqual(result["rows"][0]["token_id"], 91)
        self.assertEqual(result["rows"][0]["input_tokens"], 15)
        self.assertEqual(result["rows"][0]["refund_status"], "pending")
        raw = json.dumps(result)
        for value in ("remove me", "abc123", "https://private", "never-print"):
            self.assertNotIn(value, raw)
        sql = calls[1][1]["input"]
        self.assertIn("BEGIN READ ONLY", sql)
        self.assertIn("WHERE log_id = '" + request_id + "'", sql)
        self.assertIn("LIMIT 5", sql)
        self.assertNotIn("SELECT *", sql)
        for field in ("user_id", "token_id", "channel_id", "completed_at", "elapsed_time", "refund_status", "billing_status"):
            self.assertIn("to_jsonb(l)->'" + field + "'", sql)
        for field in ("password", "api_key", "authorization", "request_body", "request_data", "prompt", "token"):
            self.assertNotIn("to_jsonb(l)->'" + field + "'", sql)
            self.assertNotIn("to_jsonb(l)->>'" + field + "'", sql)
        self.assertNotIn("never-print", json.dumps(calls))
        self.assertNotIn("inspect", calls[0][0])
        self.assertNotIn("PASSWORD", json.dumps(calls))

    def test_no_row_is_unknown_not_free(self):
        def run(command, **kwargs):
            return types.SimpleNamespace(stdout='postgres\npostgres\n' if "-i" not in command else '[]')
        result = reader.read_log("cart", "rh_" + "b" * 32, run)
        self.assertEqual(result["reason"], "no_matching_log")
        self.assertEqual(result["billingState"], "unknown")

    def test_legacy_fc_log_id_is_matched_exactly(self):
        request_id = "fc_" + "c" * 32
        calls = []
        def run(command, **kwargs):
            calls.append((command, kwargs))
            return types.SimpleNamespace(stdout='postgres\npostgres\n' if "-i" not in command else '[]')
        reader.read_log("art", request_id, run)
        self.assertIn("WHERE log_id = '" + request_id + "'", calls[1][1]["input"])

    def test_rejects_injection_before_subprocess(self):
        def never(*args, **kwargs):
            self.fail("subprocess must not run")
        for request_id in ("x'; DROP TABLE logs;--", "../../secret", "rh_" + "a" * 33, "fc_" + "c" * 33):
            with self.assertRaises(ValueError):
                reader.read_log("art", request_id, never)

    def test_discards_mismatched_rows_and_keeps_token_ids_numeric(self):
        request_id = "fc_" + "b" * 32
        def run(command, **kwargs):
            return types.SimpleNamespace(stdout='postgres\npostgres\n' if "-i" not in command else json.dumps([
                {"log_id": "rh_" + "a" * 32, "error": "other request"},
                {"log_id": request_id, "token_id": "sk-secret-not-an-id", "access_token": "secret-token", "prompt_tokens": "10", "token_count": "secret"}
            ]))
        result = reader.read_log("cart", request_id, run)
        self.assertEqual(len(result["rows"]), 1)
        self.assertEqual(result["rows"][0]["prompt_tokens"], "10")
        for value in ("other request", "sk-secret-not-an-id", "secret-token"):
            self.assertNotIn(value, json.dumps(result))


if __name__ == "__main__":
    unittest.main()
