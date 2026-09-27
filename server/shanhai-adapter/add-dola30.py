"""Add Dola 30s to an existing Shanhai relay channel, preserving its peers."""

import argparse
import copy
import datetime as dt
import json
import os
from pathlib import Path
import subprocess


MODEL = "oc-model-r5cfh8"
SOURCE = "oc-model-qbdmeb"
LABEL = "dola（9图30秒）"
SALES = {"art": 5.0, "cart": 5.72}
TABLES = ("models", "billing_rules", "channels", "forward_rules", "model_providers",
          "model_api_providers", "channel_categories")


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def stable_channel(row):
    return {key: value for key, value in row.items()
            if not (key.endswith("_used") or key.startswith("last_reset_") or key == "updated_at")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site", choices=SALES)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    container = "tokensbyte-postgres" if args.site == "art" else "tkeapi-postgres"
    info = json.loads(subprocess.check_output(["docker", "inspect", container], text=True))[0]
    env = dict(value.split("=", 1) for value in info["Config"]["Env"] if "=" in value)
    user = env.get("POSTGRES_USER", "postgres")
    database = env.get("POSTGRES_DB", user)
    command = ["docker", "exec", "-i", container, "psql", "-X", "-U", user,
               "-d", database, "-At", "-v", "ON_ERROR_STOP=1"]

    def query(sql):
        result = subprocess.run(command, input=sql, text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError("Dola 30s database operation failed; transaction was not committed")
        return result.stdout.strip()

    snapshot_sql = "SELECT jsonb_build_object(" + ",".join(
        f"'{table}',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM {table} t)"
        for table in TABLES) + ");"
    before = json.loads(query(snapshot_sql))
    assert not any(row["model_id"] == MODEL for row in before["models"]), "Dola 30s already exists"
    source = next(row for row in before["models"] if row["model_id"] == SOURCE)
    rule = next(row for row in before["billing_rules"] if row["id"] == source["billing_rule_id"])
    channel = next(row for row in before["channels"]
                   if row["base_url"].rstrip("/") == "http://shanhai-video-adapter:3011")
    mappings = json.loads(channel["model_mapping"])
    assert source["is_active"] == rule["is_active"] == channel["status"] == 1
    assert str(source["mid"]) in json.loads(channel["models"]) and mappings[SOURCE] == SOURCE
    assert rule["billing_type"] == "requests" and rule["billing_rule"] == "fixed"
    forward_ids = json.loads(source["forward_rule_ids"])
    assert len(forward_ids) == 1
    forward = next(row for row in before["forward_rules"] if row["id"] == forward_ids[0])
    assert forward["eid"] == "shanhai-video-backup-2" and forward["is_active"] == 1

    currency = json.loads(query("SELECT coalesce((SELECT value::jsonb FROM settings WHERE key='currency_settings'),'{\"default_currency\":\"CNY\"}'::jsonb);"))
    exchange = 1.0
    if args.site == "art":
        assert currency["default_currency"] == "USD"
        exchange = float(next(item["exchange_rate"] for item in currency["auxiliary_currencies"]
                              if item["code"] == "CNY" and item["enabled"]))
    else:
        assert currency["default_currency"] == "CNY"
    sale = SALES[args.site]
    assert abs(rule["fixed_rate"] * exchange - sale) < 0.00001, "Existing Dola price changed"
    assert abs(source["pre_deduction"] - rule["fixed_rate"]) < 0.00001
    timestamp = dt.datetime.now(dt.timezone.utc).isoformat()
    model = copy.deepcopy(source)
    billing = copy.deepcopy(rule)
    billing.update(id=max(row["id"] for row in before["billing_rules"]) + 1, pid="",
                   name=f"{LABEL} CNY {sale:.2f}/次", created_at=timestamp, updated_at=timestamp)
    extended = json.loads(billing.get("extended_config") or "{}")
    extended["supported_models"] = [MODEL]
    billing["extended_config"] = json.dumps(extended, ensure_ascii=False)
    model.update(id=max(row["id"] for row in before["models"]) + 1,
                 mid=str(max(int(row["mid"]) for row in before["models"] if str(row["mid"]).isdigit()) + 1),
                 model_id=MODEL, original_id=MODEL, model_id_alias="", name=LABEL,
                 billing_rule_id=billing["id"], created_at=timestamp, updated_at=timestamp,
                 sort_order=int(source.get("sort_order", 0)) + 1,
                 description=f"720p；固定30秒；最多10张参考图；不支持视频/音频参考；{sale:.2f}元/次",
                 remark="Dola 30s; public API limit 10 images; same upstream cost as Dola 15s")
    expected_channel = copy.deepcopy(channel)
    expected_channel["models"] = json.dumps([*json.loads(channel["models"]), model["mid"]])
    expected_channel["model_mapping"] = json.dumps({**mappings, MODEL: MODEL})

    statements = ["BEGIN;", "SET LOCAL lock_timeout='5s';",
                  "LOCK TABLE models,billing_rules,channels,forward_rules IN SHARE ROW EXCLUSIVE MODE;"]
    for table, row in [("models", source), ("billing_rules", rule), ("forward_rules", forward)]:
        payload = literal(json.dumps(row, ensure_ascii=False))
        statements.append(f"DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM {table} t WHERE id={row['id']} AND to_jsonb(t)={payload}::jsonb) THEN RAISE EXCEPTION 'Source configuration changed'; END IF; END $$;")
    statements.append(f"DO $$ BEGIN IF EXISTS(SELECT 1 FROM models WHERE model_id='{MODEL}' OR mid='{model['mid']}') THEN RAISE EXCEPTION 'Model added concurrently'; END IF; END $$;")
    statements.append(f"DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM channels WHERE id={channel['id']} AND status=1 AND base_url={literal(channel['base_url'])} AND models={literal(channel['models'])} AND model_mapping={literal(channel['model_mapping'])}) THEN RAISE EXCEPTION 'Channel changed'; END IF; END $$;")
    for table, row in [("billing_rules", billing), ("models", model)]:
        statements.append(f"INSERT INTO {table} SELECT * FROM jsonb_populate_record(NULL::{table},{literal(json.dumps(row, ensure_ascii=False))}::jsonb);")
    statements.append(f"UPDATE channels SET models={literal(expected_channel['models'])},model_mapping={literal(expected_channel['model_mapping'])},updated_at=now() WHERE id={channel['id']};")
    migration = "\n".join(statements)

    def verify(actual):
        for table in TABLES:
            expected = {row["id"]: row for row in before[table]}
            if table == "models":
                expected[model["id"]] = model
            elif table == "billing_rules":
                expected[billing["id"]] = billing
            elif table == "channels":
                expected[channel["id"]] = expected_channel
            current = {row["id"]: row for row in actual[table]}
            assert current.keys() == expected.keys(), f"Unexpected {table} additions/removals"
            for key in expected:
                left, right = expected[key], current[key]
                if table == "channels":
                    left, right = stable_channel(left), stable_channel(right)
                else:
                    left = {k: v for k, v in left.items() if k not in {"created_at", "updated_at"}}
                    right = {k: v for k, v in right.items() if k not in {"created_at", "updated_at"}}
                assert left == right, f"Unexpected {table} mutation at {key}"

    preview = query(migration + "\n" + snapshot_sql + "\nROLLBACK;")
    verify(json.loads(next(line for line in preview.splitlines() if line.startswith("{"))))
    summary = {"site": args.site, "model": MODEL, "saleCnyPerRequest": sale, "siteRate": rule["fixed_rate"],
               "modelId": model["id"], "modelMid": model["mid"], "billingRuleId": billing["id"],
               "channelId": channel["id"], "previewPassed": True, "applied": False}
    if args.apply:
        backup = Path("/root/flow-canvas-operations") / ("dola30-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
        backup.mkdir(mode=0o700, parents=True)
        with (backup / "before.dump").open("wb") as target:
            subprocess.run(["docker", "exec", container, "pg_dump", "-U", user, "-d", database, "-Fc"], stdout=target, check=True)
        (backup / "before.json").write_text(json.dumps(before, ensure_ascii=False), encoding="utf-8")
        sequence_updates = "\n".join(
            f"SELECT setval(pg_get_serial_sequence('{table}','id'),greatest((SELECT max(id) FROM {table}),nextval(pg_get_serial_sequence('{table}','id'))));"
            for table in ("models", "billing_rules"))
        applied_migration = migration + "\n" + sequence_updates + "\nCOMMIT;\n"
        (backup / "migration.sql").write_text(applied_migration, encoding="utf-8")
        query(applied_migration)
        verify(json.loads(query(snapshot_sql)))
        summary.update(applied=True, verified=True, backup=str(backup))
        (backup / "receipt.json").write_text(json.dumps(summary, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    os.umask(0o077)
    main()
