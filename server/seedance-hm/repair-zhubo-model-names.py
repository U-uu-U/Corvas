"""Repair Zhubo upstream names while preserving public IDs and CNY billing.

Run on a relay host with add-zhubo-september.py beside this file.
Defaults to a rollback preview; --apply writes a private backup first.
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


RENAMES = {f"seedance-2.5-{resolution}": f"y-seedance-2.5-{resolution}"
           for resolution in ("480p", "720p", "1080p")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site", choices=("art", "cart"))
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    helper = runpy.run_path(str(Path(__file__).with_name("add-zhubo-september.py")))
    container = "tokensbyte-postgres" if args.site == "art" else "tkeapi-postgres"
    identity = subprocess.check_output([
        "docker", "exec", container, "sh", "-c",
        'printf "%s\\n%s\\n" "${POSTGRES_USER:-postgres}" "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"',
    ], text=True).splitlines()
    user, database = identity
    command = ["docker", "exec", "-i", container, "psql", "-X", "-qAt", "-U", user,
               "-d", database, "-v", "ON_ERROR_STOP=1"]

    def query(sql):
        result = subprocess.run(command, input=sql, text=True, capture_output=True, timeout=45)
        if result.returncode:
            raise RuntimeError("Model-name transaction failed; inspect the private backup")
        return result.stdout.strip()

    before = json.loads(query(helper["snapshot_sql"]()))
    assert before["currency"]["default_currency"] == "CNY"
    channel = helper["one"](before["channels"],
                            lambda row: row["base_url"].rstrip("/") == helper["UPSTREAM"],
                            "Missing or ambiguous Zhubo channel")
    assert channel["status"] == 1
    request = urllib.request.Request(helper["UPSTREAM"] + "/v1/models",
                                    headers={"Authorization": "Bearer " + channel["api_key"]})
    with urllib.request.urlopen(request, timeout=25) as response:
        upstream_ids = {row["id"] for row in json.load(response)["data"]}
    with urllib.request.urlopen(helper["PRICE_SOURCE"], timeout=25) as response:
        catalog = {row["id"]: row for row in json.load(response)}
    assert set(RENAMES.values()) <= upstream_ids, "Replacement models are not available to this account"
    assert not set(RENAMES) & upstream_ids, "Old names still exist; reassess the migration"
    expected = copy.deepcopy(before)
    target_channel = next(row for row in expected["channels"] if row["id"] == channel["id"])
    mapping = helper["decode_json"](channel["model_mapping"], dict)
    members = helper["decode_json"](channel["models"], list)
    literal = helper["literal"]
    changes = []
    report = []
    for public_id, upstream_id in RENAMES.items():
        model = helper["one"](expected["models"], lambda row: row["model_id"] == public_id,
                              "Missing or duplicate public model")
        assert str(model["mid"]) in members
        assert model["original_id"] in (public_id, upstream_id)
        assert mapping.get(public_id) in (public_id, upstream_id)
        info = catalog[upstream_id]
        resolution = public_id.rsplit("-", 1)[1]
        assert info["available"] and info["billingType"] == "per_call"
        assert set(info["rates"]) == {resolution} and info["allowedSeconds"] == list(range(4, 31))
        assert all(term in info["description"] for term in ("30张图片", "0个视频", "10段音频"))
        if model["original_id"] != upstream_id:
            changes.append(f"UPDATE models SET original_id={literal(upstream_id)}, updated_at=now() WHERE id={model['id']};")
        model["original_id"] = upstream_id
        mapping[public_id] = upstream_id
        billing = next(row for row in before["billing_rules"] if row["id"] == model["billing_rule_id"])
        report.append({"publicId": public_id, "upstreamId": upstream_id, "enabled": model["is_active"],
                       "saleCny": billing["fixed_rate"], "upstreamCny": info["rates"][resolution]})
    target_channel["model_mapping"] = json.dumps(mapping, ensure_ascii=False)
    if target_channel["model_mapping"] != channel["model_mapping"]:
        changes.append(f"UPDATE channels SET model_mapping={literal(target_channel['model_mapping'])}, updated_at=now() WHERE id={channel['id']};")
    sql = ["BEGIN;", "SET LOCAL lock_timeout='5s';", "SET LOCAL statement_timeout='20s';",
           "LOCK TABLE " + ",".join((*helper["TABLES"], "settings")) + " IN SHARE ROW EXCLUSIVE MODE;"]
    sql.extend(helper["guard_catalog"](before))
    sql.extend(changes)
    sql.extend(helper["guard_catalog"](expected))
    transaction = "\n".join(sql)
    query(transaction + "\nROLLBACK;")
    helper["verify"](before, json.loads(query(helper["snapshot_sql"]())))
    receipt = {"site": args.site, "channelId": channel["id"], "previewPassed": True,
               "applied": False, "changed": bool(changes), "models": report,
               "otherBindings": [{"publicId": model["model_id"], "enabled": model["is_active"],
                                   "upstreamAvailable": mapping.get(model["model_id"]) in upstream_ids}
                                  for model in before["models"]
                                  if str(model["mid"]) in members and model["model_id"] not in RENAMES]}
    if args.apply and changes:
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        backup = Path("/root/flow-canvas-operations") / ("zhubo-rename-" + args.site + "-" + stamp)
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
