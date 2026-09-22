"""Live preview-only disable/poll/restore test. Never submits a generation."""

import importlib.util
import json
from pathlib import Path
import time
import urllib.request

spec = importlib.util.spec_from_file_location("config_control", Path(__file__).with_name("config-channel-control.py"))
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)
BRIDGE = "http://127.0.0.1:18766"
SOURCE = "https://artconfig.ravenhash.org/config/preview"
GROUP = "seedance20-recommended"
REPORT = Path(__file__).resolve().parent.parent / "output/config-control-live-test.json"


def local(path, body=None):
    request = urllib.request.Request(BRIDGE + path, data=None if body is None else json.dumps(body).encode(),
                                     headers={} if body is None else {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.load(response)


def observe(revision, ids, enabled):
    start = time.monotonic()
    while time.monotonic() - start < 35:
        snapshot = local("/model-config")
        assert snapshot["status"]["url"] == SOURCE, "The lab changed CONFIG source"
        entries = {entry["id"]: entry for entry in snapshot["config"]["models"]}
        if snapshot["status"]["revision"] >= revision and all(
            identity in entries and (entries[identity]["catalog"].get("enabled") is not False) == enabled
            for identity in ids
        ):
            listed = local("/agent/tools/flow_canvas.model.list", {"projectId": "config-lab"})["result"]
            wires = {entries[identity]["catalog"]["model"] for identity in ids}
            listed_wires = {model["model"] for model in listed}
            assert wires <= listed_wires if enabled else not wires.intersection(listed_wires)
            return {"seconds": round(time.monotonic() - start, 2), "revision": snapshot["status"]["revision"],
                    "listedTargetModels": len(wires.intersection(listed_wires))}
        time.sleep(1)
    raise TimeoutError("Canvas did not automatically receive the preview revision")


def main():
    snapshot = local("/model-config")
    assert snapshot["status"]["url"] == SOURCE
    assert snapshot["status"]["catalogMode"] == "remote"
    client = control.connect()
    report = {"channel": "preview", "group": GROUP, "startedAt": time.time()}
    receipt = None
    try:
        before = control.invoke(client, {"action": "list", "channel": "preview", "query": GROUP})
        members = [entry for entry in before["models"] if entry["group"] == GROUP and entry["model"]]
        assert len(members) == 3 and all(entry["enabled"] for entry in members), "Test requires the three enabled 2.0 preview variants"
        ids = [entry["id"] for entry in members]
        stable = control.invoke(client, {"action": "list", "channel": "stable"})["version"]
        started = time.monotonic()
        disabled = control.invoke(client, {"action": "set", "channel": "preview", "target": {"group": GROUP},
                                           "enabled": False, "expectedRevision": before["revision"]})
        receipt = disabled["receiptId"]
        report.update(receiptId=receipt, disabledRevision=disabled["revision"], targetCount=disabled["changed"],
                      disablePublishSeconds=round(time.monotonic() - started, 2))
        REPORT.parent.mkdir(parents=True, exist_ok=True)
        REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"phase": "disabled", "revision": disabled["revision"], "receiptId": receipt}), flush=True)
        report["disableSync"] = observe(disabled["revision"], ids, False)
        print(json.dumps({"phase": "automatically-synced", **report["disableSync"]}), flush=True)
    finally:
        try:
            if receipt:
                started = time.monotonic()
                restored = control.invoke(client, {"action": "restore", "receiptId": receipt})
                report["restorePublishSeconds"] = round(time.monotonic() - started, 2)
                report["restoredRevision"] = restored["revision"]
                report["restored"] = restored["restored"]
                print(json.dumps({"phase": "restored", "revision": restored["revision"]}), flush=True)
                report["restoreSync"] = observe(restored["revision"], ids, True)
                after = control.invoke(client, {"action": "list", "channel": "preview", "query": GROUP})
                assert after["models"] == before["models"], "Original catalog state was not restored"
                report["stableUnchanged"] = control.invoke(client, {"action": "list", "channel": "stable"})["version"] == stable
                assert report["stableUnchanged"]
        finally:
            client.close()
            REPORT.parent.mkdir(parents=True, exist_ok=True)
            REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
