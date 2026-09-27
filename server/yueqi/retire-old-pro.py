"""Retire the old zhubo seedance-2.5-pro model and let the yueqi model reclaim
the plain name. Runs on the relay host. Transactional with pg_dump backup.
Usage: retire-old-pro.py art|cart [--apply]
Frees the name by: detaching old mid from any channel, deleting the old model
row, renaming model_id 'seedance-2.5-pro/1' -> 'seedance-2.5-pro', and fixing
the yueqi channel model_mapping + billing supported_models. Other zhubo models
and the channel itself are untouched.
"""
import copy, datetime as dt, json, os, subprocess, sys
from pathlib import Path

SITE = {
    "art":  {"postgres": "tokensbyte-postgres", "backup_root": "/opt/tokensbyte-backups"},
    "cart": {"postgres": "tkeapi-postgres", "backup_root": "/root/tkeapi-backups"},
}
OLD_MODEL_ID = "seedance-2.5-pro"
NEW_MODEL_ID = "seedance-2.5-pro/1"
YUEQI_UPSTREAM = "https://yueqi.icu"
CATALOG_TABLES = ["models", "channels", "billing_rules"]
PROTECTED_TABLES = ["settings", "users", "api_tokens", "channel_categories", "model_providers", "model_api_providers", "forward_rules"]

def sql_text(v):
    return "'" + str(v).replace("'", "''") + "'"
def sql_json(v):
    return "'" + json.dumps(v, ensure_ascii=False, separators=(",", ":")).replace("'", "''") + "'"

def main():
    if len(sys.argv) < 2 or sys.argv[1] not in SITE:
        raise SystemExit("usage: retire-old-pro.py art|cart [--apply]")
    site = sys.argv[1]
    apply = "--apply" in sys.argv[2:]
    st = SITE[site]
    pg = st["postgres"]
    inspected = json.loads(subprocess.check_output(["docker", "inspect", pg], text=True))[0]
    env = dict(x.split("=", 1) for x in inspected["Config"].get("Env", []) if "=" in x)
    user = env.get("POSTGRES_USER", "postgres")
    database = env.get("POSTGRES_DB", user)
    psql = ["docker", "exec", "-i", pg, "psql", "-X", "-U", user, "-d", database, "-At", "-v", "ON_ERROR_STOP=1"]
    os.umask(0o077)

    def query(sql):
        r = subprocess.run(psql, input=sql, text=True, capture_output=True)
        if r.returncode:
            raise RuntimeError(r.stderr.strip())
        return r.stdout.strip()
    def rows(table):
        return json.loads(query(f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM {table} t;"))
    def digest(table):
        return query(f"SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM {table} t;")

    models = rows("models")
    channels = rows("channels")
    old = next((m for m in models if m["model_id"] == OLD_MODEL_ID and m["original_id"] == OLD_MODEL_ID), None)
    new = next((m for m in models if m["model_id"] == NEW_MODEL_ID), None)
    if new is None:
        raise RuntimeError("yueqi model seedance-2.5-pro/1 not found; nothing to reclaim")
    if any(m["model_id"] == OLD_MODEL_ID and m["id"] != (old or {}).get("id") for m in models):
        raise RuntimeError("unexpected extra model with plain id")
    old_mid = str(old["mid"]) if old else None
    old_id = old["id"] if old else None
    # channels that reference the old mid in their models list
    ref_channels = []
    if old_mid:
        for ch in channels:
            try:
                mids = json.loads(ch.get("models") or "[]")
            except ValueError:
                mids = []
            if old_mid in [str(x) for x in mids]:
                ref_channels.append((ch["id"], ch["name"]))
    summary = {"site": site, "oldFound": bool(old), "oldModelRowId": old_id, "oldMid": old_mid,
               "refChannels": ref_channels, "newRowId": new["id"], "newMid": str(new["mid"])}
    print(json.dumps(summary, ensure_ascii=False), flush=True)

    protected_before = {t: digest(t) for t in PROTECTED_TABLES}
    ts = dt.datetime.now(dt.timezone.utc).isoformat()
    backup = Path(st["backup_root"]) / ("retire-pro-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    backup.mkdir(mode=0o700, parents=True)
    subprocess.run(["docker", "exec", pg, "pg_dump", "-U", user, "-d", database, "-Fc"],
                   stdout=(backup / "before.dump").open("wb"), check=True)
    (backup / "before.json").write_text(json.dumps({"models": models, "channels": channels}, ensure_ascii=False), encoding="utf-8")

    stmts = ["BEGIN;", "SET LOCAL lock_timeout='5s';",
             "LOCK TABLE models,channels,billing_rules IN SHARE ROW EXCLUSIVE MODE;"]
    # guard: the new model must still exist and old (if any) unchanged
    stmts.append(f"DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM models WHERE model_id={sql_text(NEW_MODEL_ID)}) THEN RAISE EXCEPTION 'yueqi model vanished'; END IF; END $$;")
    stmts.append(f"DO $$ BEGIN IF EXISTS(SELECT 1 FROM models WHERE model_id={sql_text(OLD_MODEL_ID)} AND original_id={sql_text(OLD_MODEL_ID)} AND id<>{old_id if old_id else 0}) THEN RAISE EXCEPTION 'duplicate plain-id model'; END IF; END $$;")
    if old:
        # detach old mid from any channel models list + model_mapping
        for ch_id, _ in ref_channels:
            ch = next(c for c in channels if c["id"] == ch_id)
            mids = [str(x) for x in json.loads(ch.get("models") or "[]") if str(x) != old_mid]
            try:
                mapping = json.loads(ch.get("model_mapping") or "{}")
            except ValueError:
                mapping = {}
            mapping.pop(OLD_MODEL_ID, None)
            stmts.append(f"UPDATE channels SET models={sql_json(json.dumps(mids))}::text, model_mapping={sql_json(json.dumps(mapping, ensure_ascii=False))}::text, updated_at=now() WHERE id={ch_id};")
        stmts.append(f"DELETE FROM models WHERE id={old_id};")
        old_brule = old.get("billing_rule_id")
        if old_brule:
            stmts.append(f"DELETE FROM billing_rules b WHERE b.id={old_brule} AND NOT EXISTS(SELECT 1 FROM models m WHERE m.billing_rule_id=b.id AND m.id<>{old_id});")
    # rename yueqi model to plain id; keep original_id already = seedance-2.5-pro
    stmts.append(f"UPDATE models SET model_id={sql_text(OLD_MODEL_ID)}, updated_at=now() WHERE id={new['id']};")
    # fix yueqi channel model_mapping key and billing supported_models
    yq = next((c for c in channels if (c.get('base_url') or '').rstrip('/') == YUEQI_UPSTREAM), None)
    if yq:
        try:
            ymap = json.loads(yq.get("model_mapping") or "{}")
        except ValueError:
            ymap = {}
        if NEW_MODEL_ID in ymap:
            ymap[OLD_MODEL_ID] = ymap.pop(NEW_MODEL_ID)
        stmts.append(f"UPDATE channels SET model_mapping={sql_json(json.dumps(ymap, ensure_ascii=False))}::text, updated_at=now() WHERE id={yq['id']};")
    nb = new.get("billing_rule_id")
    if nb:
        stmts.append(f"UPDATE billing_rules SET extended_config=jsonb_set(coalesce(extended_config,'{{}}')::jsonb,'{{supported_models}}',{sql_json(json.dumps([OLD_MODEL_ID]))}::jsonb,true)::text, updated_at=now() WHERE id={nb};")
    stmts.append("COMMIT;")
    migration_sql = "\n".join(stmts) + "\n"
    (backup / "migration.sql").write_text(migration_sql, encoding="utf-8")

    # preview: run inside a rolled-back transaction body (swap COMMIT->ROLLBACK)
    preview_sql = migration_sql.replace("\nCOMMIT;\n", "\nROLLBACK;\n")
    query(preview_sql)
    if {t: digest(t) for t in PROTECTED_TABLES} != protected_before:
        raise AssertionError("preview touched protected tables")
    print(json.dumps({**summary, "previewPassed": True, "backup": str(backup)}, ensure_ascii=False), flush=True)
    if not apply:
        return
    query(migration_sql)
    after_models = rows("models")
    if not any(m["model_id"] == OLD_MODEL_ID and m["id"] == new["id"] for m in after_models):
        raise AssertionError("rename did not take effect")
    if any(m["model_id"] == NEW_MODEL_ID for m in after_models):
        raise AssertionError("slash id still present")
    if old_id and any(m["id"] == old_id for m in after_models):
        raise AssertionError("old model still present")
    if {t: digest(t) for t in PROTECTED_TABLES} != protected_before:
        raise AssertionError("protected tables changed")
    (backup / "after.json").write_text(json.dumps({"models": after_models, "channels": rows("channels")}, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({**summary, "applied": True, "verified": True, "backup": str(backup)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
