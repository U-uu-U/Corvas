"""Add five September Zhubo routes to one CNY relay; default to a rollback preview."""

import argparse
import copy
import datetime as dt
from decimal import Decimal, ROUND_CEILING
import json
import os
from pathlib import Path
import subprocess


SOURCE = "seedance_v2.5"
UPSTREAM = "https://video.zhubo.asia"
PRICE_SOURCE = UPSTREAM + "/api/video/models"
MARKER = "Zhubo September 2026; 30 images / 0 videos / 10 audios"
TABLES = ("models", "billing_rules", "channels", "forward_rules", "model_providers",
          "model_api_providers", "channel_categories", "channel_configs")
TARGETS = (
    {"model": "LongXia-video-seedance2_5-standard-480p-express-PerSecond",
     "label": "LongXia Seedance 2.5 480p", "resolution": "480p", "maxSeconds": 25,
     "unit": "second", "upstreamCny": "0.42"},
    {"model": "LongXia-video-seedance2_5-standard-720p-express-PerSecond",
     "label": "LongXia Seedance 2.5 720p", "resolution": "720p", "maxSeconds": 25,
     "unit": "second", "upstreamCny": "0.56"},
    {"model": "seedance-2.5-480p", "label": "Seedance 2.5 480p", "resolution": "480p",
     "maxSeconds": 30, "unit": "request", "upstreamCny": "4"},
    {"model": "seedance-2.5-720p", "label": "Seedance 2.5 720p", "resolution": "720p",
     "maxSeconds": 30, "unit": "request", "upstreamCny": "5"},
    {"model": "seedance-2.5-1080p", "label": "Seedance 2.5 1080p", "resolution": "1080p",
     "maxSeconds": 30, "unit": "request", "upstreamCny": "6"},
)


def price_for(target, site):
    assert site in {"art", "cart"}, "Unknown site"
    sale = Decimal(target["upstreamCny"]) * 2
    return sale if site == "art" else (sale * 8 / 7).quantize(Decimal(".01"), rounding=ROUND_CEILING)


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def json_text(value):
    return json.dumps(value, ensure_ascii=False)


def decode_json(value, expected_type):
    for _ in range(2):
        if not isinstance(value, str):
            break
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            raise AssertionError("Invalid channel JSON") from None
    assert isinstance(value, expected_type), "Unexpected channel JSON structure"
    return value


def normalized_channel_fields(channel):
    return [key for key in ("models", "model_mapping")
            if isinstance(channel[key], str) and isinstance(json.loads(channel[key]), str)]


def ignored_fields(table, rows):
    fields = {"created_at", "updated_at"}
    if table in {"channels", "channel_configs"}:
        fields.update(key for row in rows for key in row
                      if key.endswith("_used") or key.startswith("last_reset_"))
    return fields


def stable_rows(table, rows):
    ignored = ignored_fields(table, rows)
    return [{key: value for key, value in row.items() if key not in ignored}
            for row in sorted(rows, key=lambda row: row["id"])]


def one(rows, predicate, message):
    matches = [row for row in rows if predicate(row)]
    assert len(matches) == 1, message
    return matches[0]


def make_plan(before, site, timestamp):
    assert before["currency"].get("default_currency") == "CNY", "This migration requires CNY billing"
    target_ids = {target["model"] for target in TARGETS}
    assert not any(row["model_id"] in target_ids for row in before["models"]), "Target model already exists"
    source = one(before["models"], lambda row: row["model_id"] == SOURCE, "Missing or duplicate source model")
    rule = one(before["billing_rules"], lambda row: row["id"] == source["billing_rule_id"], "Missing source billing rule")
    channel = one(before["channels"], lambda row: row["base_url"].rstrip("/") in {UPSTREAM, UPSTREAM + "/v1"}
                  and str(source["mid"]) in decode_json(row["models"], list), "Missing or ambiguous Zhubo channel")
    assert source["is_active"] == rule["is_active"] == channel["status"] == 1, "Source route is disabled"
    assert channel["rate"] == 1, "Source channel multiplier needs review"
    assert rule["billing_type"] == "requests" and rule["billing_rule"] == "fixed", "Unexpected source billing contract"
    assert not source["site_discount_enabled"] and not source["global_discount_enabled"], "Source discounts need review"
    assert json.loads(source["group_ratios"] or "{}") == {}, "Source group discounts need review"
    mappings = decode_json(channel["model_mapping"], dict)
    members = decode_json(channel["models"], list)
    assert all(isinstance(key, str) and isinstance(value, str) for key, value in mappings.items()), "Invalid model mapping"
    assert all(isinstance(mid, str) for mid in members) and len(set(members)) == len(members), "Invalid channel model IDs"
    assert mappings.get(SOURCE) == SOURCE, "Unexpected source model mapping"
    assert target_ids.isdisjoint(mappings), "Target mapping already exists"
    forward_ids = json.loads(source["forward_rule_ids"] or "[]")
    assert forward_ids and len(set(forward_ids)) == len(forward_ids), "Missing or duplicate source forward rules"
    for forward_id in forward_ids:
        forward = one(before["forward_rules"], lambda row: row["id"] == forward_id, "Missing source forward rule")
        assert forward["is_active"] == 1, "Source forward rule is disabled"
        forward_config = json.loads(forward["config_json"])
        assert forward_config.get("mode") == "passthrough" and forward_config.get("target_type") == "seedance25", "Unexpected source forwarding contract"
    for table, field in (("model_providers", "provider_id"), ("model_api_providers", "api_provider_id")):
        group = one(before[table], lambda row: row["id"] == source[field], "Missing source provider group")
        assert group["is_active"] == 1, "Source provider group is disabled"

    next_model = max(row["id"] for row in before["models"]) + 1
    next_rule = max(row["id"] for row in before["billing_rules"]) + 1
    next_mid = max(int(row["mid"]) for row in before["models"] if str(row["mid"]).isdigit()) + 1
    after = copy.deepcopy(before)
    report = []
    for index, target in enumerate(TARGETS):
        name = target["model"]
        sale = price_for(target, site)
        duration = target["unit"] == "second"
        suffix = "second" if duration else "request"
        billing = copy.deepcopy(rule)
        billing.update(id=next_rule + index, pid="", name=f"{target['label']} CNY {sale:.2f}/{suffix}",
                       is_system=0, pricing_type="custom", is_active=1,
                       billing_type="duration" if duration else "requests",
                       billing_rule="video_resolution" if duration else "fixed",
                       fixed_rate=0 if duration else float(sale), duration_rate=float(sale) if duration else 0,
                       prompt_rate=0, completion_rate=0, cached_rate=0,
                       claude_cache_creation_rate=0, claude_cache_read_rate=0,
                       pricing_tiers=json_text([{"resolution": target["resolution"], "rate": float(sale),
                                                 "cached_rate": 0, "enabled": True}] if duration else []),
                       extended_config=json_text({"supported_models": [name], "enable_time_multipliers": False,
                                                  "time_multipliers": []}),
                       created_at=timestamp, updated_at=timestamp)
        model = copy.deepcopy(source)
        model.update(id=next_model + index, mid=str(next_mid + index), model_id=name, original_id=name,
                     model_id_alias="", name=target["label"], billing_rule_id=billing["id"],
                     pre_deduction=float(sale * (4 if duration else 1)), is_system=0,
                     sort_order=int(source.get("sort_order", 0)) + index + 1,
                     description=f"{target['resolution']}; 4-{target['maxSeconds']} seconds; "
                                 f"30 image / 0 video / 10 audio references; CNY {sale:.2f}/{suffix}",
                     remark=f"{MARKER}; sale CNY {sale:.2f}/{suffix}; source {PRICE_SOURCE}",
                     feature_attributes=json_text(["文生视频", "图生视频", "多模态参考生视频"]),
                     created_at=timestamp, updated_at=timestamp)
        after["models"].append(model)
        after["billing_rules"].append(billing)
        members.append(model["mid"])
        mappings[name] = name
        report.append({"model": name, "modelId": model["id"], "modelMid": model["mid"],
                       "ruleId": billing["id"], "saleCny": float(sale), "unit": suffix,
                       "resolution": target["resolution"], "minSeconds": 4, "maxSeconds": target["maxSeconds"],
                       "preDeduction": model["pre_deduction"], "referenceLimits": {"images": 30, "videos": 0, "audios": 10}})
    destination = one(after["channels"], lambda row: row["id"] == channel["id"], "Missing destination channel")
    destination.update(models=json_text(members), model_mapping=json_text(mappings), updated_at=timestamp)
    return after, report, channel["id"]


def snapshot_sql():
    entries = [f"'{table}',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM {table} t)"
               for table in TABLES]
    entries.append("'currency',coalesce((SELECT value::jsonb FROM settings WHERE key='currency_settings'),'{\"default_currency\":\"CNY\"}'::jsonb)")
    return "SELECT jsonb_build_object(" + ",".join(entries) + ");"


def guard_catalog(snapshot):
    statements = []
    for table in TABLES:
        ignored = ",".join(literal(key) for key in sorted(ignored_fields(table, snapshot[table])))
        expected = literal(json_text(stable_rows(table, snapshot[table])))
        statements.append(f"DO $$ BEGIN IF (SELECT coalesce(jsonb_agg(to_jsonb(t)-ARRAY[{ignored}]::text[] ORDER BY id),'[]'::jsonb) FROM {table} t) IS DISTINCT FROM {expected}::jsonb THEN RAISE EXCEPTION 'Catalog guard failed: {table}'; END IF; END $$;")
    currency = literal(json_text(snapshot["currency"]))
    statements.append(f"DO $$ BEGIN IF coalesce((SELECT value::jsonb FROM settings WHERE key='currency_settings'),'{{\"default_currency\":\"CNY\"}}'::jsonb) IS DISTINCT FROM {currency}::jsonb THEN RAISE EXCEPTION 'Currency settings changed'; END IF; END $$;")
    return statements


def build_migration(before, after, channel_id, apply=False):
    statements = ["BEGIN;", "SET LOCAL lock_timeout='5s';",
                  "LOCK TABLE " + ",".join((*TABLES, "settings")) + " IN SHARE ROW EXCLUSIVE MODE;"]
    statements.extend(guard_catalog(before))
    for table in ("billing_rules", "models"):
        old_ids = {row["id"] for row in before[table]}
        for row in after[table]:
            if row["id"] not in old_ids:
                statements.append(f"INSERT INTO {table} SELECT * FROM jsonb_populate_record(NULL::{table},{literal(json_text(row))}::jsonb);")
    channel = one(after["channels"], lambda row: row["id"] == channel_id, "Missing updated channel")
    statements.append(f"UPDATE channels SET models={literal(channel['models'])}, model_mapping={literal(channel['model_mapping'])}, updated_at=now() WHERE id={channel_id};")
    statements.extend(guard_catalog(after))
    if apply:
        # Explicit IDs are preview-safe; advance sequences only under the apply lock.
        for table in ("billing_rules", "models"):
            statements.append(f"SELECT setval(pg_get_serial_sequence('{table}','id'),greatest((SELECT max(id) FROM {table}),nextval(pg_get_serial_sequence('{table}','id'))));")
        statements.append("COMMIT;")
    else:
        statements.extend([snapshot_sql(), "ROLLBACK;"])
    return "\n".join(statements)


def verify(expected, actual):
    assert expected["currency"] == actual["currency"], "Currency changed"
    for table in TABLES:
        assert stable_rows(table, expected[table]) == stable_rows(table, actual[table]), f"Unexpected {table} changes"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site", choices=("art", "cart"))
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    container = "tokensbyte-postgres" if args.site == "art" else "tkeapi-postgres"
    info = json.loads(subprocess.check_output(["docker", "inspect", container], text=True))[0]
    env = dict(value.split("=", 1) for value in info["Config"]["Env"] if "=" in value)
    user = env.get("POSTGRES_USER", "postgres")
    database = env.get("POSTGRES_DB", user)
    command = ["docker", "exec", "-i", container, "psql", "-X", "-qAt", "-U", user,
               "-d", database, "-v", "ON_ERROR_STOP=1"]

    def query(sql):
        result = subprocess.run(command, input=sql, text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError("Zhubo database operation failed; inspect the private backup before retrying")
        return result.stdout.strip()

    before = json.loads(query(snapshot_sql()))
    after, report, channel_id = make_plan(before, args.site, dt.datetime.now(dt.timezone.utc).isoformat())
    preview = query(build_migration(before, after, channel_id))
    verify(after, json.loads(preview))
    verify(before, json.loads(query(snapshot_sql())))
    old_channel = one(before["channels"], lambda row: row["id"] == channel_id, "Missing source channel")
    summary = {"site": args.site, "currency": "CNY", "channelId": channel_id,
               "previewPassed": True, "applied": False, "models": report,
               "normalizedChannelFields": normalized_channel_fields(old_channel)}
    if args.apply:
        backup = Path("/root/flow-canvas-operations") / (f"zhubo-september-{args.site}-" +
                 dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ"))
        backup.mkdir(mode=0o700, parents=True)
        with (backup / "before.dump").open("wb") as target:
            result = subprocess.run(["docker", "exec", container, "pg_dump", "-U", user, "-d", database, "-Fc"],
                                    stdout=target, stderr=subprocess.PIPE)
        if result.returncode:
            raise RuntimeError("Database backup failed; no migration was applied")
        (backup / "before.json").write_text(json_text(before), encoding="utf-8")
        migration = build_migration(before, after, channel_id, apply=True)
        (backup / "migration.sql").write_text(migration, encoding="utf-8")
        query(migration)
        actual = json.loads(query(snapshot_sql()))
        (backup / "after.json").write_text(json_text(actual), encoding="utf-8")
        verify(after, actual)
        summary.update(applied=True, verified=True, backup=str(backup))
        (backup / "receipt.json").write_text(json_text(summary), encoding="utf-8")
    print(json_text(summary))


if __name__ == "__main__":
    main()
