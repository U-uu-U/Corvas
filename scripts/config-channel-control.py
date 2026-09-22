"""Operate CONFIG catalog state over SSH without embedding credentials.

CONFIG_SSH_PASSWORD or CONFIG_SSH_KEY supplies authentication. This affects the
CONFIG directory only, never the art/cart relay databases.
"""

import argparse
import json
import os
import sys
import time
import urllib.request

import paramiko


REMOTE_COMMAND = "runuser -u flowconfig -- /srv/flow-config/runtime/node /srv/flow-config/catalog-control.mjs"


def connect():
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    arguments = dict(
        hostname=os.getenv("CONFIG_SSH_HOST", "154.12.57.162"),
        port=int(os.getenv("CONFIG_SSH_PORT", "22")),
        username=os.getenv("CONFIG_SSH_USER", "root"), timeout=15,
        banner_timeout=15, auth_timeout=15,
    )
    password = os.getenv("CONFIG_SSH_PASSWORD")
    key = os.getenv("CONFIG_SSH_KEY")
    if password:
        arguments.update(password=password, allow_agent=False, look_for_keys=False)
    elif key:
        arguments.update(key_filename=key, allow_agent=False, look_for_keys=False)
    client.connect(**arguments)
    return client


def invoke(client, payload):
    stdin, stdout, stderr = client.exec_command(REMOTE_COMMAND, timeout=25)
    stdin.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    stdin.channel.shutdown_write()
    output = stdout.read().decode("utf-8")
    stderr.read()
    code = stdout.channel.recv_exit_status()
    try:
        result = json.loads(output)
    except ValueError as error:
        raise RuntimeError(f"Remote control did not return JSON (exit {code})") from error
    if code or not result.get("success"):
        raise RuntimeError(f"{result.get('code', 'OPERATION_FAILED')}: {result.get('error', 'Operation failed')}")
    return result


def refresh_canvas(channel, bridge):
    try:
        with urllib.request.urlopen(bridge + "/model-config", timeout=3) as response:
            status = json.load(response)["status"]
        suffix = "/config/preview" if channel == "preview" else "/config"
        if status.get("url") != "https://artconfig.ravenhash.org" + suffix:
            return {"skipped": True, "reason": "Canvas uses another CONFIG source"}
        request = urllib.request.Request(bridge + "/model-config/refresh", data=b"{}",
                                         headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=20) as response:
            result = json.load(response)
        return {"success": result.get("success"), "revision": result.get("status", {}).get("revision"),
                "error": result.get("error")}
    except Exception as error:
        return {"success": False, "error": str(error)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["list", "enable", "disable", "restore"])
    parser.add_argument("--channel", choices=["preview", "stable"], default="preview")
    targets = parser.add_mutually_exclusive_group()
    for target in ["id", "model", "group"]:
        targets.add_argument("--" + target)
    parser.add_argument("--query", default="")
    parser.add_argument("--kind", choices=["video", "image", "text"], default="video")
    parser.add_argument("--receipt")
    parser.add_argument("--expected-revision", type=int)
    parser.add_argument("--no-refresh", action="store_true")
    parser.add_argument("--bridge", default="http://127.0.0.1:18766")
    args = parser.parse_args()
    if args.action in ["enable", "disable"] and not any([args.id, args.model, args.group]):
        parser.error("enable/disable requires --id, --model or --group")
    if args.action == "restore" and not args.receipt:
        parser.error("restore requires --receipt")
    started = time.monotonic()
    client = connect()
    try:
        if args.action == "list":
            result = invoke(client, {"action": "list", "channel": args.channel, "query": args.query, "kind": args.kind})
        elif args.action == "restore":
            result = invoke(client, {"action": "restore", "receiptId": args.receipt})
        else:
            revision = args.expected_revision
            if revision is None:
                revision = invoke(client, {"action": "list", "channel": args.channel})["revision"]
            target = {key: getattr(args, key) for key in ["id", "model", "group"] if getattr(args, key)}
            result = invoke(client, {"action": "set", "channel": args.channel, "target": target,
                                     "kind": args.kind, "enabled": args.action == "enable", "expectedRevision": revision})
        result["elapsedSeconds"] = round(time.monotonic() - started, 2)
        if args.action != "list" and not args.no_refresh:
            result["canvas"] = refresh_canvas(result["channel"], args.bridge.rstrip("/"))
        result["totalElapsedSeconds"] = round(time.monotonic() - started, 2)
        print(json.dumps(result, ensure_ascii=False))
    finally:
        client.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"success": False, "error": str(error)}, ensure_ascii=False))
        sys.exit(1)
