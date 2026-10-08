"""Align the four HM routes with published CONFIG and authenticated upstream IDs.

Run on an art/cart relay host beside add-zhubo-september.py. The default
is a rollback preview. --apply backs up privately and changes only HM model
enablement, upstream IDs, and the associated channel mapping.
"""
import argparse
import copy
import datetime as dt
import json
import os
from pathlib import Path
import runpy
import subprocess
import urllib.request


TARGETS = {
    "seedance_v2.5": "HM-Seedance V2.5",
    "seedance_v2.0-933": "HM-Seedance V2.0 933",
    "seedance_v2.5-101010": "HM-Seedance V2.5 101010",
    "seedance_v2.5-301010": "HM-Seedance V2.5 301010",
}
CONFIG_URL = "https://artconfig.ravenhash.org/config"


def fetch(url, key=None):
    request = urllib.request.Request(url, headers={"Authorization": "Bearer " + key} if key else {})
    with urllib.request.urlopen(request, timeout=25) as response:
        return json.load(response)


def config_targets(site, one):
    config = fetch(CONFIG_URL)
    result = {}
    for name in TARGETS:
        model = one(config["models"], lambda m: m.get("catalog", {}).get("model") == name
                    and site + ".ravenhash.org" in m["catalog"].get("hosts", []),
                    "Missing or duplicate CONFIG model")
        assert model["catalog"]["enabled"] is True, "CONFIG does not authorize calling this HM model"
        result[name] = model["catalog"]
    return config["revision"], result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site", choices=("art", "cart"))
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    helper = runpy.run_path(str(Path(__file__).with_name("add-zhubo-september.py")))
    one, literal = helper["one"], helper["literal"]
    container = "tokensbyte-postgres" if args.site == "art" else "tkeapi-postgres"
    user, database = subprocess.check_output([
        "docker", "exec", container, "sh", "-c",
        'printf "%s\n%s\n" "${POSTGRES_USER:-postgres}" "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"',
    ], text=True).splitlines()
    command = ["docker", "exec", "-i", container, "psql", "-X", "-qAt", "-U", user,
               "-d", database, "-v", "ON_ERROR_STOP=1"]

    def query(sql):
        result = subprocess.run(command, input=sql, text=True, capture_output=True, timeout=45)
        if result.returncode:
            raise RuntimeError("HM transaction failed; inspect the private backup")
        return result.stdout.strip()

    before = json.loads(query(helper["snapshot_sql"]()))
    assert before["currency"]["default_currency"] == "CNY"
    channel = one(before["channels"], lambda c: c["base_url"].rstrip("/") == helper["UPSTREAM"],
                  "Missing or ambiguous HM channel")
    assert channel["status"] == 1
    key = channel["api_key"]
    live_ids = {m["id"] for m in fetch(helper["UPSTREAM"] + "/v1/models", key)["data"]}
    pricing = fetch(helper["UPSTREAM"] + "/v1/pricing", key)["data"]
    revision, published = config_targets(args.site, one)
    expected = copy.deepcopy(before)
    updated_channel = one(expected["channels"], lambda c: c["id"] == channel["id"], "Missing channel")
    mapping = helper["decode_json"](channel["model_mapping"], dict)
    members = helper["decode_json"](channel["models"], list)
    changes, report = [], []
    for public_id, upstream_id in TARGETS.items():
        assert upstream_id in live_ids, "HM model missing from the authenticated upstream list"
        price = one(pricing, lambda p: p.get("canonical_id") == public_id and p.get("model") == upstream_id,
                    "Upstream has not confirmed this canonical-to-request mapping")
        assert price["currency"] == "CNY" and price["billing_type"] == "per_call"
        model = one(expected["models"], lambda m: m["model_id"] == public_id, "Missing HM model")
        assert str(model["mid"]) in members and model["is_active"] in (0, 1)
        assert model["original_id"] in (public_id, upstream_id)
        assert mapping.get(public_id) in (public_id, upstream_id)
        for table, field in (("model_providers", "provider_id"), ("model_api_providers", "api_provider_id"),
                             ("billing_rules", "billing_rule_id")):
            assert one(before[table], lambda r: r["id"] == model[field], "Missing HM dependency")["is_active"] == 1
        for fid in json.loads(model["forward_rule_ids"]):
            forward = one(before["forward_rules"], lambda f: f["id"] == fid, "Missing HM forward rule")
            spec = json.loads(forward["config_json"])
            assert forward["is_active"] == 1 and spec["mode"] == "passthrough"
            assert spec["path_rewrite"]["new"] == "/v1/videos"
        billing = one(before["billing_rules"], lambda b: b["id"] == model["billing_rule_id"], "Missing billing")
        report.append({"publicId": public_id, "upstreamId": upstream_id,
                       "previousEnabled": model["is_active"], "enabled": 1,
                       "saleCny": billing["fixed_rate"], "upstreamCny": price["unit_price"]})
        if model["original_id"] != upstream_id or model["is_active"] != 1:
            changes.append(f"UPDATE models SET original_id={literal(upstream_id)}, is_active=1, updated_at=now() WHERE id={model['id']};")
        model.update(original_id=upstream_id, is_active=1)
        mapping[public_id] = upstream_id
    updated_channel["model_mapping"] = json.dumps(mapping, ensure_ascii=False)
    if updated_channel["model_mapping"] != channel["model_mapping"]:
        changes.append(f"UPDATE channels SET model_mapping={literal(updated_channel['model_mapping'])}, updated_at=now() WHERE id={channel['id']};")
    sql = ["BEGIN;", "SET LOCAL lock_timeout='5s';", "SET LOCAL statement_timeout='20s';",
           "LOCK TABLE " + ",".join((*helper["TABLES"], "settings")) + " IN SHARE ROW EXCLUSIVE MODE;"]
    sql.extend(helper["guard_catalog"](before))
    sql.extend(changes)
    sql.extend(helper["guard_catalog"](expected))
    transaction = "\n".join(sql)
    query(transaction + "\nROLLBACK;")
    helper["verify"](before, json.loads(query(helper["snapshot_sql"]())))
    receipt = {"site": args.site, "channelId": channel["id"], "configRevision": revision,
               "previewPassed": True, "applied": False, "changed": bool(changes), "models": report}
    if args.apply and changes:
        assert config_targets(args.site, one)[1] == published, "CONFIG call switches changed during preview"
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        backup = Path("/root/flow-canvas-operations") / ("hm-availability-" + args.site + "-" + stamp)
        backup.mkdir(mode=0o700, parents=True)
        (backup / "before.json").write_text(json.dumps(before), encoding="utf-8")
        (backup / "migration.sql").write_text(transaction + "\nCOMMIT;", encoding="utf-8")
        query(transaction + "\nCOMMIT;")
        actual = json.loads(query(helper["snapshot_sql"]()))
        helper["verify"](expected, actual)
        (backup / "after.json").write_text(json.dumps(actual), encoding="utf-8")
        receipt.update(applied=True, verified=True, backup=str(backup))
        (backup / "receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
    print(json.dumps(receipt, ensure_ascii=False))


if __name__ == "__main__":
    main()
