"""Install the Shanhai backup catalog on one existing relay site.

The script is intentionally run on the relay host.  It keeps the supplier key
in the private database backup and channel row, never in source or container
environment, and refuses to mutate an already-present Shanhai catalog.
"""

import copy
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys


SITE = {
    "art": {
        "postgres": "tokensbyte-postgres",
        "backup_root": "/opt/tokensbyte-backups",
        "exchange": 6.75,
    },
    "cart": {
        "postgres": "tkeapi-postgres",
        "backup_root": "/root/tkeapi-backups",
        "exchange": 1.0,
    },
}
GROUP = "备用分组2"
GROUP_EN = "Shanhai Backup 2"
CHANNEL = "Shanhai视频 · 备用分组2"
FORWARD_EID = "shanhai-video-backup-2"
MODEL_SPECS = (
    {
        "model_id": "oc-model-qbdmeb",
        "name": "dola（9图15秒）",
        "price": 4.0,
        "unit": "request",
        "pre_seconds": 1,
        "sort_order": 1,
        "feature_attributes": ["文生视频", "图生视频"],
        "description": "720p；5/10/15秒；最多10张参考图；按次计费；用户售价CNY4/次",
        "remark": "Shanhai backup 2026-09-22; sale CNY 4.00/request",
    },
    {
        "model_id": "oc-model-1iq31f",
        "name": "sd-2.0（官渠）-极稳",
        "price": 5.0,
        "unit": "second",
        "pre_seconds": 5,
        "sort_order": 2,
        "feature_attributes": ["文生视频", "图生视频"],
        "description": "480p/720p/1080p；5-15秒；最多9张参考图；按秒计费；用户售价CNY5.00/秒",
        "remark": "Shanhai backup 2026-09-22; sale CNY 5.00/second",
    },
    {
        "model_id": "oc-model-bkb50q",
        "name": "S-2.0 官转933",
        "price": 7.0,
        "unit": "request",
        "pre_seconds": 1,
        "sort_order": 3,
        "feature_attributes": ["文生视频"],
        "description": "720p；4-15秒；不支持参考素材；按次计费；用户售价CNY7/次",
        "remark": "Shanhai backup 2026-09-22; sale CNY 7.00/request",
    },
    {
        "model_id": "oc-model-c6ws7e",
        "name": "S-2.0 满血933（不卡人脸）",
        "price": 7.0,
        "unit": "request",
        "pre_seconds": 1,
        "sort_order": 4,
        "feature_attributes": ["文生视频", "不卡人脸"],
        "description": "720p；4-15秒；不支持参考素材；不卡人脸；按次计费；用户售价CNY7/次",
        "remark": "Shanhai backup 2026-09-22; sale CNY 7.00/request",
    },
)
CATALOG_TABLES = [
    "model_providers",
    "model_api_providers",
    "channel_categories",
    "billing_rules",
    "forward_rules",
    "models",
    "channels",
]
PROTECTED_TABLES = [
    "settings",
    "users",
    "api_tokens",
    "orders",
    "recharge_records",
    "user_levels",
    "plugins",
    "plugin_configs",
    "channel_configs",
]


def sql_json(value):
    return "'" + json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("'", "''") + "'::jsonb"


def sql_text(value):
    return "'" + str(value).replace("'", "''") + "'"


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def scrub_output(value, secret):
    return value.replace(secret, "[REDACTED]")


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in SITE:
        raise SystemExit("usage: deploy-db.py art|cart [--apply]")
    site = sys.argv[1]
    apply = "--apply" in sys.argv[2:]
    try:
        credential = json.load(sys.stdin)["apiKey"]
    except (ValueError, KeyError) as error:
        raise SystemExit("stdin must contain {\"apiKey\": \"...\"}") from error
    if not isinstance(credential, str) or len(credential) < 20 or "\n" in credential:
        raise SystemExit("invalid API key")

    os.umask(0o077)
    settings = SITE[site]
    postgres = settings["postgres"]
    inspected = json.loads(subprocess.check_output(["docker", "inspect", postgres], text=True))[0]
    env = dict(item.split("=", 1) for item in inspected["Config"].get("Env", []) if "=" in item)
    user = env.get("POSTGRES_USER", "postgres")
    database = env.get("POSTGRES_DB", user)
    psql = ["docker", "exec", "-i", postgres, "psql", "-X", "-U", user, "-d", database, "-At", "-v", "ON_ERROR_STOP=1"]

    def query(sql):
        result = subprocess.run(psql, input=sql, text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError(scrub_output(result.stderr, credential).strip())
        return result.stdout.strip()

    def rows(table):
        return json.loads(query(f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM {table} t;"))

    def snapshot():
        return {table: rows(table) for table in CATALOG_TABLES}

    def digest(table):
        return query(
            f"SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM {table} t;"
        )

    before = snapshot()
    for spec in MODEL_SPECS:
        if any(row["model_id"] == spec["model_id"] for row in before["models"]):
            raise RuntimeError(f"model already exists: {spec['model_id']}")
    if any(row["base_url"].rstrip("/") == "http://shanhai-video-adapter:3011" for row in before["channels"]):
        raise RuntimeError("Shanhai adapter channel already exists")
    if any(row["eid"] == FORWARD_EID for row in before["forward_rules"]):
        raise RuntimeError("Shanhai forward rule already exists")
    for table in ("model_providers", "model_api_providers", "channel_categories"):
        if sum(row["name"] == GROUP for row in before[table]) > 1:
            raise RuntimeError(f"duplicate group name in {table}")

    currency = json.loads(query(
        "SELECT coalesce((SELECT value::jsonb FROM settings WHERE key='currency_settings'),"
        "'{\"default_currency\":\"CNY\"}'::jsonb);"
    ))
    if site == "cart" and currency.get("default_currency") != "CNY":
        raise RuntimeError("cart currency is not CNY")
    if site == "art" and currency.get("default_currency") != "USD":
        raise RuntimeError("art currency is not USD")
    exchange = float(settings["exchange"])
    if site == "art":
        configured = next(
            (item for item in currency.get("auxiliary_currencies", [])
             if item.get("code") == "CNY" and item.get("enabled")),
            None,
        )
        if configured and abs(float(configured.get("exchange_rate", 0)) - exchange) > 1e-9:
            raise RuntimeError("art CNY exchange rate changed; inspect before applying")

    protected_before = {table: digest(table) for table in PROTECTED_TABLES}
    timestamp = utc_now()
    backup = Path(settings["backup_root"]) / (
        "shanhai-backup-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    )
    backup.mkdir(mode=0o700)
    subprocess.run(
        ["docker", "exec", postgres, "pg_dump", "-U", user, "-d", database, "-Fc"],
        stdout=(backup / "before.dump").open("wb"),
        check=True,
    )
    (backup / "before.json").write_text(json.dumps(before, ensure_ascii=False), encoding="utf-8")

    additions = {table: [] for table in CATALOG_TABLES}

    next_ids = {}

    def candidate_id(table):
        if table not in next_ids:
            next_ids[table] = int(query(f"SELECT coalesce(max(id),0)+1 FROM {table};"))
        value = next_ids[table]
        next_ids[table] += 1
        return value

    def group_row(table):
        existing = [row for row in before[table] if row["name"] == GROUP]
        if existing:
            if existing[0].get("is_active") != 1:
                raise RuntimeError(f"inactive existing group in {table}")
            return existing[0]["id"]
        templates = [row for row in before[table] if not row.get("is_system")]
        if not templates:
            templates = [row for row in before[table] if row.get("is_active") == 1]
        if not templates:
            raise RuntimeError(f"no group template in {table}")
        row = copy.deepcopy(templates[0])
        row.update(
            id=candidate_id(table), name=GROUP, name_en=GROUP_EN,
            sort_order=40, is_active=1, is_system=0,
            created_at=timestamp, updated_at=timestamp,
        )
        if "remark" in row:
            row["remark"] = "Shanhai video backup route"
        additions[table].append(row)
        return row["id"]

    provider_id = group_row("model_providers")
    api_provider_id = group_row("model_api_providers")
    category_id = group_row("channel_categories")
    model_template = next(
        (row for row in before["models"] if row["model_id"] == "seedance-2.5-pro"),
        next(row for row in before["models"] if row.get("type_id") == 4),
    )
    request_template = next(
        row for row in before["billing_rules"]
        if row.get("billing_type") == "requests" and row.get("billing_rule") == "fixed" and not row.get("is_system")
    )
    duration_template = next(
        row for row in before["billing_rules"]
        if row.get("billing_type") == "duration" and row.get("billing_rule") == "video_resolution" and not row.get("is_system")
    )
    channel_template = next(
        (row for row in before["channels"] if row.get("provider_type") == "openai"),
        before["channels"][0],
    )
    forward_template = next(
        row for row in before["forward_rules"]
        if row.get("rule_type") == "openai" and row.get("config_json")
    )

    mids = [str(max(int(row["mid"]) for row in before["models"] if str(row.get("mid", "")).isdigit()) + i)
            for i in range(1, len(MODEL_SPECS) + 1)]
    if len(set(mids)) != len(mids) or any(row.get("mid") in mids for row in before["models"]):
        raise RuntimeError("model mid collision")
    exchange = exchange or 1.0
    rate = lambda price: price / exchange

    forward = copy.deepcopy(forward_template)
    forward.update(
        id=candidate_id("forward_rules"), eid=FORWARD_EID,
        name="Shanhai 视频异步转发", category="视频", rule_type="openai",
        config_json=json.dumps({
            "mode": "passthrough", "target_type": "passthrough", "auth_type": "bearer",
            "path_rewrite": {"old": "/v1/video/generations", "new": "/v1/videos"},
            "poll_path": "/v1/videos/${task_id}",
        }, ensure_ascii=False),
        description="OpenAI 视频入口转发到 Shanhai 适配器；保留原任务 ID",
        is_active=1, is_system=0, created_at=timestamp, updated_at=timestamp,
    )
    additions["forward_rules"].append(forward)

    model_rows = []
    billing_rows = []
    for spec, mid in zip(MODEL_SPECS, mids):
        billing = copy.deepcopy(duration_template if spec["unit"] == "second" else request_template)
        local_rate = rate(spec["price"])
        billing.update(
            id=candidate_id("billing_rules"),
            name=f"{spec['name']} CNY {spec['price']:.2f}/{('秒' if spec['unit'] == 'second' else '次')}",
            pid="", provider_id=None, type_id=4, pricing_type="custom", is_active=1, is_system=0,
            sort_order=0, created_at=timestamp, updated_at=timestamp,
            extended_config=json.dumps({
                "supported_models": [spec["model_id"]],
                "time_multipliers": [], "enable_time_multipliers": False,
            }, ensure_ascii=False),
        )
        if spec["unit"] == "second":
            billing.update(
                billing_type="duration", billing_rule="video_resolution", fixed_rate=0,
                duration_rate=local_rate,
                pricing_tiers=json.dumps([
                    {"resolution": resolution, "rate": local_rate, "enabled": True, "cached_rate": 0}
                    for resolution in ("480p", "720p", "1080p")
                ], ensure_ascii=False),
            )
        else:
            billing.update(
                billing_type="requests", billing_rule="fixed", fixed_rate=local_rate,
                duration_rate=0, pricing_tiers="[]",
            )
        billing_rows.append(billing)
        additions["billing_rules"].append(billing)

        model = copy.deepcopy(model_template)
        model.update(
            id=candidate_id("models"), mid=mid, model_id=spec["model_id"],
            original_id=spec["model_id"], model_id_alias="", name=spec["name"],
            provider_id=provider_id, api_provider_id=api_provider_id,
            billing_rule_id=billing["id"], forward_rule_ids=json.dumps([forward["id"]]),
            pre_deduction=local_rate * spec["pre_seconds"], is_active=1,
            is_system=0, sort_order=spec["sort_order"], site_discount=1,
            site_discount_enabled=0, global_discount=1, global_discount_enabled=0,
            group_ratios="{}", feature_attributes=json.dumps(spec["feature_attributes"], ensure_ascii=False),
            description=spec["description"], remark=spec["remark"],
            created_at=timestamp, updated_at=timestamp,
        )
        model_rows.append(model)
        additions["models"].append(model)

    channel = copy.deepcopy(channel_template)
    channel.update(
        id=candidate_id("channels"), name=CHANNEL, provider_type="openai",
        base_url="http://shanhai-video-adapter:3011", api_key=credential,
        models=json.dumps(mids), model_mapping=json.dumps({spec["model_id"]: spec["model_id"] for spec in MODEL_SPECS}),
        config="{}", category_id=category_id, preset_id=None, status=1,
        balance=None, quota_used=0, daily_quota_used=0, weekly_quota_used=0, monthly_quota_used=0,
        last_reset_day="", last_reset_week="", last_reset_month="", created_at=timestamp, updated_at=timestamp,
    )
    additions["channels"].append(channel)

    expected = {table: [*before[table], *additions[table]] for table in CATALOG_TABLES}
    all_tables = ",".join(CATALOG_TABLES)
    migration = [
        "BEGIN;",
        "SET LOCAL lock_timeout='5s';",
        f"LOCK TABLE {all_tables} IN SHARE ROW EXCLUSIVE MODE;",
        f"DO $$ BEGIN IF EXISTS(SELECT 1 FROM models WHERE model_id IN ({','.join(sql_text(s['model_id']) for s in MODEL_SPECS)})) THEN RAISE EXCEPTION 'Shanhai model added concurrently'; END IF; END $$;",
        f"DO $$ BEGIN IF EXISTS(SELECT 1 FROM channels WHERE base_url='http://shanhai-video-adapter:3011' OR name={sql_text(CHANNEL)}) THEN RAISE EXCEPTION 'Shanhai channel added concurrently'; END IF; END $$;",
        f"DO $$ BEGIN IF EXISTS(SELECT 1 FROM forward_rules WHERE eid={sql_text(FORWARD_EID)}) THEN RAISE EXCEPTION 'Shanhai forward rule added concurrently'; END IF; END $$;",
    ]
    for table in ("model_providers", "model_api_providers", "channel_categories", "billing_rules", "forward_rules", "models", "channels"):
        for row in additions[table]:
            migration.append(
                f"INSERT INTO {table} SELECT * FROM jsonb_populate_record(NULL::{table},{sql_json(row)});"
            )
    for table in CATALOG_TABLES:
        migration.append(
            f"SELECT setval(pg_get_serial_sequence('{table}','id'), (SELECT max(id) FROM {table}), true);"
        )
    migration.append("COMMIT;")
    migration_sql = "\n".join(migration) + "\n"
    snapshot_sql = "SELECT jsonb_build_object(" + ",".join(
        f"'{table}',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM {table} t)"
        for table in CATALOG_TABLES
    ) + ");"

    def verify(actual):
        for table in CATALOG_TABLES:
            current = {row["id"]: row for row in actual[table]}
            if len(current) != len(expected[table]):
                raise AssertionError(f"unexpected row count in {table}")
            for row in expected[table]:
                live = current[row["id"]]
                ignored = {"created_at", "updated_at"} if row in additions[table] else set()
                if table == "channels":
                    ignored |= {key for key in row if key.endswith("_used")}
                left = {key: value for key, value in row.items() if key not in ignored}
                right = {key: value for key, value in live.items() if key not in ignored}
                if left != right:
                    raise AssertionError(f"unexpected mutation in {table} id={row['id']}")
        for spec in MODEL_SPECS:
            live = next(row for row in actual["models"] if row["model_id"] == spec["model_id"])
            if live["is_active"] != 1 or live["name"] != spec["name"]:
                raise AssertionError(f"model verification failed: {spec['model_id']}")
        channel_live = next(row for row in actual["channels"] if row["name"] == CHANNEL)
        if channel_live["base_url"] != "http://shanhai-video-adapter:3011":
            raise AssertionError("channel endpoint verification failed")

    preview = query("\n".join(migration_sql.splitlines()[:-1]) + "\n" + snapshot_sql + "\nROLLBACK;\n")
    preview_json = json.loads(next(line for line in preview.splitlines() if line.startswith("{")))
    verify(preview_json)
    if snapshot() != before:
        raise AssertionError("preview changed catalog")
    if {table: digest(table) for table in PROTECTED_TABLES} != protected_before:
        raise AssertionError("preview changed protected records")
    (backup / "migration.sql").write_text(migration_sql, encoding="utf-8")
    summary = {
        "site": site, "previewPassed": True, "backup": str(backup),
        "group": GROUP, "channel": CHANNEL, "models": [spec["model_id"] for spec in MODEL_SPECS],
        "exchange": exchange, "pricesCny": {spec["model_id"]: spec["price"] for spec in MODEL_SPECS},
    }
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    if not apply:
        return

    # Recheck the catalog after the preview; another process must not be able
    # to slip a model in between the preview and the commit.
    if snapshot() != before:
        raise RuntimeError("catalog changed after preview; refusing to apply")
    query(migration_sql)
    actual = snapshot()
    verify(actual)
    if {table: digest(table) for table in PROTECTED_TABLES} != protected_before:
        raise AssertionError("protected records changed")
    (backup / "after.json").write_text(json.dumps(actual, ensure_ascii=False), encoding="utf-8")
    disable = (
        "BEGIN; SET LOCAL lock_timeout='5s'; "
        f"UPDATE models SET is_active=0,updated_at=now() WHERE model_id IN ({','.join(repr(s['model_id']) for s in MODEL_SPECS)}); "
        f"UPDATE channels SET status=0,updated_at=now() WHERE name={sql_text(CHANNEL)}; COMMIT;\n"
    )
    (backup / "disable.sql").write_text(disable, encoding="utf-8")
    (backup / "verification.json").write_text(json.dumps({**summary, "applied": True, "verified": True}, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({**summary, "applied": True, "verified": True}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
