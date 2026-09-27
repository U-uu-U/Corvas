"""Add three yueqi.icu Seedance 2.5 models to one relay site's recommended group.

Run on the relay host. Keeps the supplier key only in the private channel row and
backup, never in source. Refuses to mutate an already-present yueqi catalog.
Usage: deploy-yueqi.py art|cart [--apply]   (reads {"apiKey":"..."} on stdin)
"""
import copy, datetime as dt, json, os, subprocess, sys
from pathlib import Path

SITE = {
    "art":  {"postgres": "tokensbyte-postgres", "backup_root": "/opt/tokensbyte-backups",
             "exchange": 6.75, "category_id": 5, "provider_id": 7, "api_provider_id": 6,
             "forward_id": 37, "currency": "USD"},
    "cart": {"postgres": "tkeapi-postgres", "backup_root": "/root/tkeapi-backups",
             "exchange": 1.0, "category_id": 2, "provider_id": 7, "api_provider_id": 3,
             "forward_id": 48, "currency": "CNY"},
}
CHANNEL = "Yueqi · Seedance 2.5 推荐渠道"
UPSTREAM = "https://yueqi.icu"
MODEL_SPECS = (
    {"model_id": "sd2-fast", "real": "sd2-fast", "name": "sd2-fast（不限人脸）", "price": 4.0,
     "feature": ["文生视频", "图生视频", "多模态参考生视频"],
     "desc": "480p/720p；480p最多15秒、720p最多12秒；最多9图/3视频，不支持音频参考；不限制人脸；按次计费"},
    {"model_id": "seedance-2.5-pro/1", "real": "seedance-2.5-pro", "name": "seedance-2.5-pro", "price": 9.8,
     "feature": ["文生视频", "图生视频", "多模态参考生视频"],
     "desc": "480p/720p/1080p；4-30秒；多图/视频/音频参考；参考视频时长计费；按次计费"},
    {"model_id": "seedance-2.5-pro-720", "real": "seedance-2.5-pro-720", "name": "seedance-2.5-pro-720", "price": 13.0,
     "feature": ["文生视频", "图生视频", "多模态参考生视频"],
     "desc": "720p；1-60秒；多图/视频/音频参考；参考视频时长计费；按次计费"},
)
CATALOG_TABLES = ["billing_rules", "models", "channels"]
PROTECTED_TABLES = ["settings", "users", "api_tokens", "channel_categories", "model_providers", "model_api_providers", "forward_rules"]

def sql_json(v):
    return "'" + json.dumps(v, ensure_ascii=False, separators=(",", ":")).replace("'", "''") + "'::jsonb"
def sql_text(v):
    return "'" + str(v).replace("'", "''") + "'"
def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat()
def scrub(v, secret):
    return v.replace(secret, "[REDACTED]")

def main():
    if len(sys.argv) < 2 or sys.argv[1] not in SITE:
        raise SystemExit("usage: deploy-yueqi.py art|cart [--apply]")
    site = sys.argv[1]
    apply = "--apply" in sys.argv[2:]
    try:
        credential = json.load(sys.stdin)["apiKey"]
    except (ValueError, KeyError) as err:
        raise SystemExit("stdin must be {\"apiKey\": \"...\"}") from err
    if not isinstance(credential, str) or len(credential) < 20 or "\n" in credential:
        raise SystemExit("invalid API key")

    os.umask(0o077)
    st = SITE[site]
    pg = st["postgres"]
    inspected = json.loads(subprocess.check_output(["docker", "inspect", pg], text=True))[0]
    env = dict(x.split("=", 1) for x in inspected["Config"].get("Env", []) if "=" in x)
    user = env.get("POSTGRES_USER", "postgres")
    database = env.get("POSTGRES_DB", user)
    psql = ["docker", "exec", "-i", pg, "psql", "-X", "-U", user, "-d", database, "-At", "-v", "ON_ERROR_STOP=1"]

    def query(sql):
        r = subprocess.run(psql, input=sql, text=True, capture_output=True)
        if r.returncode:
            raise RuntimeError(scrub(r.stderr, credential).strip())
        return r.stdout.strip()
    def rows(table):
        return json.loads(query(f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM {table} t;"))
    def snapshot():
        return {t: rows(t) for t in CATALOG_TABLES}
    def digest(table):
        return query(f"SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM {table} t;")

    before = snapshot()
    for spec in MODEL_SPECS:
        if any(r["model_id"] == spec["model_id"] for r in before["models"]):
            raise RuntimeError(f"model already exists: {spec['model_id']}")
    if any((r.get("base_url") or "").rstrip("/") == UPSTREAM and r.get("name") == CHANNEL for r in before["channels"]):
        raise RuntimeError("yueqi channel already exists")

    # Template rows cloned from the site's existing recommended Seedance 2.5 model.
    model_tpl = next((r for r in before["models"] if r["provider_id"] == st["provider_id"] and r["model_id"] == "seedance-2.5-pro"), None)
    if model_tpl is None:
        model_tpl = next(r for r in before["models"] if r["provider_id"] == st["provider_id"])
    billing_tpl = next(r for r in before["billing_rules"] if r["billing_type"] == "requests" and r["billing_rule"] == "fixed" and not r.get("is_system"))
    channel_tpl = next((r for r in before["channels"] if r.get("category_id") == st["category_id"] and r.get("provider_type") == "openai"), None)
    if channel_tpl is None:
        channel_tpl = next(r for r in before["channels"] if r.get("provider_type") == "openai")

    protected_before = {t: digest(t) for t in PROTECTED_TABLES}
    ts = utc_now()
    backup = Path(st["backup_root"]) / ("yueqi-backup-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    backup.mkdir(mode=0o700, parents=True)
    subprocess.run(["docker", "exec", pg, "pg_dump", "-U", user, "-d", database, "-Fc"],
                   stdout=(backup / "before.dump").open("wb"), check=True)
    (backup / "before.json").write_text(json.dumps(before, ensure_ascii=False), encoding="utf-8")

    additions = {t: [] for t in CATALOG_TABLES}
    next_ids = {}
    def cid(table):
        if table not in next_ids:
            next_ids[table] = int(query(f"SELECT coalesce(max(id),0)+1 FROM {table};"))
        v = next_ids[table]; next_ids[table] += 1; return v
    exchange = float(st["exchange"]) or 1.0
    existing_mids = [int(r["mid"]) for r in before["models"] if str(r.get("mid", "")).isdigit()]
    mid_base = max(existing_mids) + 1 if existing_mids else 400001
    mids = [str(mid_base + i) for i in range(len(MODEL_SPECS))]
    if len(set(mids)) != len(mids) or any(str(r.get("mid")) in mids for r in before["models"]):
        raise RuntimeError("mid collision")

    model_rows, billing_rows = [], []
    for spec, mid in zip(MODEL_SPECS, mids):
        local_rate = spec["price"] / exchange
        billing = copy.deepcopy(billing_tpl)
        billing.update(
            id=cid("billing_rules"),
            name=f"{spec['name']} CNY {spec['price']:.2f}/次",
            billing_type="requests", billing_rule="fixed",
            fixed_rate=local_rate, duration_rate=0, pricing_tiers="[]",
            pricing_type="custom", is_active=1, is_system=0, sort_order=0, type_id=4,
            pid="", provider_id=None, created_at=ts, updated_at=ts,
            extended_config=json.dumps({"supported_models": [spec["model_id"]],
                                        "time_multipliers": [], "enable_time_multipliers": False}, ensure_ascii=False),
        )
        for k in ("prompt_rate", "completion_rate", "cached_rate", "claude_cache_creation_rate", "claude_cache_read_rate"):
            if k in billing:
                billing[k] = 0
        billing_rows.append(billing); additions["billing_rules"].append(billing)

        model = copy.deepcopy(model_tpl)
        model.update(
            id=cid("models"), mid=mid, model_id=spec["model_id"],
            original_id=spec["real"], model_id_alias="", name=spec["name"],
            provider_id=st["provider_id"], api_provider_id=st["api_provider_id"], type_id=4,
            billing_rule_id=billing["id"], forward_rule_ids=json.dumps([st["forward_id"]]),
            pre_deduction=local_rate, is_active=1, is_system=0, sort_order=50,
            site_discount=1, site_discount_enabled=0, global_discount=1, global_discount_enabled=0,
            group_ratios="{}", feature_attributes=json.dumps(spec["feature"], ensure_ascii=False),
            description=spec["desc"], remark=f"yueqi.icu 接入 2026-09-22; sale CNY {spec['price']:.2f}/request",
            created_at=ts, updated_at=ts,
        )
        model_rows.append(model); additions["models"].append(model)

    channel = copy.deepcopy(channel_tpl)
    channel.update(
        id=cid("channels"), name=CHANNEL, provider_type="openai", base_url=UPSTREAM, api_key=credential,
        models=json.dumps(mids), model_mapping=json.dumps({s["model_id"]: s["real"] for s in MODEL_SPECS}, ensure_ascii=False),
        config="{}", category_id=st["category_id"], preset_id=None, status=1, priority=0, weight=1, rate=1,
        balance=None, quota_used=0, daily_quota_used=0, weekly_quota_used=0, monthly_quota_used=0,
        quota_limit=-1, daily_quota_limit=-1, weekly_quota_limit=-1, monthly_quota_limit=-1,
        last_reset_day="", last_reset_week="", last_reset_month="", user_groups=channel_tpl.get("user_groups", "[\"1\"]"),
        exclude_user_groups="[]", sort_order=0, created_at=ts, updated_at=ts,
    )
    additions["channels"].append(channel)

    expected = {t: [*before[t], *additions[t]] for t in CATALOG_TABLES}
    all_tables = ",".join(CATALOG_TABLES)
    migration = [
        "BEGIN;",
        "SET LOCAL lock_timeout='5s';",
        f"LOCK TABLE {all_tables} IN SHARE ROW EXCLUSIVE MODE;",
        f"DO $$ BEGIN IF EXISTS(SELECT 1 FROM models WHERE model_id IN ({','.join(sql_text(s['model_id']) for s in MODEL_SPECS)})) THEN RAISE EXCEPTION 'yueqi model added concurrently'; END IF; END $$;",
        f"DO $$ BEGIN IF EXISTS(SELECT 1 FROM channels WHERE name={sql_text(CHANNEL)}) THEN RAISE EXCEPTION 'yueqi channel added concurrently'; END IF; END $$;",
    ]
    for table in CATALOG_TABLES:
        for row in additions[table]:
            migration.append(f"INSERT INTO {table} SELECT * FROM jsonb_populate_record(NULL::{table},{sql_json(row)});")
    for table in CATALOG_TABLES:
        migration.append(f"SELECT setval(pg_get_serial_sequence('{table}','id'), (SELECT max(id) FROM {table}), true);")
    migration.append("COMMIT;")
    migration_sql = "\n".join(migration) + "\n"
    snapshot_sql = "SELECT jsonb_build_object(" + ",".join(
        f"'{t}',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM {t} x)" for t in CATALOG_TABLES) + ");"

    def verify(actual):
        for table in CATALOG_TABLES:
            cur = {r["id"]: r for r in actual[table]}
            if len(cur) != len(expected[table]):
                raise AssertionError(f"row count changed in {table}")
            for row in expected[table]:
                live = cur[row["id"]]
                ignored = {"created_at", "updated_at"} if row in additions[table] else set()
                if table == "channels":
                    ignored |= {k for k in row if k.endswith("_used") or k.startswith("last_reset")}
                left = {k: v for k, v in row.items() if k not in ignored}
                right = {k: v for k, v in live.items() if k not in ignored}
                if left != right:
                    raise AssertionError(f"unexpected mutation in {table} id={row['id']}")
        for spec in MODEL_SPECS:
            live = next(r for r in actual["models"] if r["model_id"] == spec["model_id"])
            if live["is_active"] != 1 or live["original_id"] != spec["real"]:
                raise AssertionError(f"model verify failed: {spec['model_id']}")
        ch = next(r for r in actual["channels"] if r["name"] == CHANNEL)
        if (ch.get("base_url") or "").rstrip("/") != UPSTREAM:
            raise AssertionError("channel endpoint verify failed")

    preview = query("\n".join(migration_sql.splitlines()[:-1]) + "\n" + snapshot_sql + "\nROLLBACK;\n")
    preview_json = json.loads(next(l for l in preview.splitlines() if l.startswith("{")))
    verify(preview_json)
    if snapshot() != before:
        raise AssertionError("preview changed catalog")
    if {t: digest(t) for t in PROTECTED_TABLES} != protected_before:
        raise AssertionError("preview changed protected records")
    (backup / "migration.sql").write_text(migration_sql, encoding="utf-8")
    summary = {"site": site, "previewPassed": True, "backup": str(backup), "channel": CHANNEL,
               "category_id": st["category_id"], "provider_id": st["provider_id"], "forward_id": st["forward_id"],
               "models": [s["model_id"] for s in MODEL_SPECS], "mids": mids, "exchange": exchange,
               "pricesCny": {s["model_id"]: s["price"] for s in MODEL_SPECS}}
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    if not apply:
        return
    if snapshot() != before:
        raise RuntimeError("catalog changed after preview; refusing to apply")
    query(migration_sql)
    actual = snapshot()
    verify(actual)
    if {t: digest(t) for t in PROTECTED_TABLES} != protected_before:
        raise AssertionError("protected records changed")
    (backup / "after.json").write_text(json.dumps(actual, ensure_ascii=False), encoding="utf-8")
    disable = ("BEGIN; SET LOCAL lock_timeout='5s'; "
               f"UPDATE models SET is_active=0,updated_at=now() WHERE model_id IN ({','.join(sql_text(s['model_id']) for s in MODEL_SPECS)}); "
               f"UPDATE channels SET status=0,updated_at=now() WHERE name={sql_text(CHANNEL)}; COMMIT;\n")
    (backup / "disable.sql").write_text(disable, encoding="utf-8")
    print(json.dumps({**summary, "applied": True, "verified": True}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
