"""Read exact gateway log IDs. This tool never submits tasks or changes billing."""

import argparse
import json
import re
import subprocess


REQUEST_ID = re.compile(r"(?:fc|rh)_[a-f0-9]{32}\Z")
FIELDS = (
    "id", "log_id", "request_id", "upstream_request_id", "created_at", "updated_at", "started_at", "completed_at",
    "request_time", "response_time", "duration", "latency", "elapsed_time", "use_time",
    "status", "status_code", "http_status", "user_id", "username", "user_name", "token_id", "group", "user_group",
    "cost", "is_completed", "billing_detail", "billing_status", "pre_deduct_gift", "refund_status", "refund_amount",
    "quota", "quota_used", "pre_deduct_quota", "input_tokens", "output_tokens", "total_tokens", "prompt_tokens", "completion_tokens",
    "channel_id", "channel_name", "model", "model_name", "upstream_model", "original_model",
    "task_id", "error_message", "error", "response_body", "response_data",
)
PRIVATE_KEYS = re.compile(r"authorization|api.?key|secret|password|cookie|token|signature|prompt|messages|image_?urls?|video_?urls?|audio_?urls?|reference|base64|request_body|request_data|payload|content", re.I)
SAFE_NUMERIC_KEYS = {"token_id", "input_tokens", "output_tokens", "total_tokens", "prompt_tokens", "completion_tokens", "cached_tokens"}


def safe_numeric_metadata(key, value):
    return key in SAFE_NUMERIC_KEYS and (isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0
        or isinstance(value, str) and re.fullmatch(r"\d{1,24}", value) is not None)


def sanitize(value, depth=0):
    if depth > 8:
        return "[depth limit]"
    if isinstance(value, dict):
        return {key: "[omitted]" if PRIVATE_KEYS.search(key) and key != "referenceCounts" and not safe_numeric_metadata(key, item) else sanitize(item, depth + 1)
                for key, item in list(value.items())[:100]}
    if isinstance(value, list):
        return [sanitize(item, depth + 1) for item in value[:50]]
    if not isinstance(value, str):
        return value
    text = value[:32768]
    try:
        parsed = json.loads(text)
        if isinstance(parsed, (list, dict)):
            return sanitize(parsed, depth + 1)
    except ValueError:
        pass
    text = re.sub(r'"(?:prompt|negative_prompt|messages|image_urls?|video_urls?|audio_urls?)"\s*:\s*"(?:\\.|[^"\\])*(?:"|$)', '"private_input":"[omitted]"', text, flags=re.I)
    text = re.sub(r"\b(?:prompt|negative_prompt)\s*[=:]\s*[^\r\n]+", "[prompt omitted]", text, flags=re.I)
    text = re.sub(r"\b(?:Bearer|Basic)\s+[^\s,;\"'}]+", "[credential omitted]", text, flags=re.I)
    text = re.sub(r"\b(?:sk-|oc_live_|ghp_|gho_)[A-Za-z0-9_-]+", "[credential omitted]", text)
    text = re.sub(r"\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|signature)\s*[=:]\s*[\"']?[^\s,;\"'}]+", "[credential omitted]", text, flags=re.I)
    text = re.sub(r"https?://[^\s<>\"'\\]+", "[url omitted]", text, flags=re.I)
    text = re.sub(r"data:[^\s\"']+", "[media omitted]", text, flags=re.I)
    return re.sub(r"[A-Za-z0-9+/=]{160,}", "[encoded data omitted]", text)


def read_log(site, request_id, run=subprocess.run):
    if site not in ("art", "cart") or not REQUEST_ID.fullmatch(request_id):
        raise ValueError("Invalid exact log lookup")
    container = "tokensbyte-postgres" if site == "art" else "tkeapi-postgres"
    identity = run(["docker", "exec", container, "sh", "-c",
                    'printf \'%s\\n%s\\n\' "${POSTGRES_USER:-postgres}" "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"'],
                   capture_output=True, text=True, check=True, timeout=3)
    names = identity.stdout.splitlines()
    if len(names) != 2 or not all(names):
        raise ValueError("Invalid database identity")
    user, database = names
    # Read only selected fields; request bodies and media never leave PostgreSQL.
    pairs = ", ".join("'%s', to_jsonb(l)->'%s'" % (field, field)
                      if field not in ("error", "response_body", "response_data", "billing_detail", "error_message")
                      else "'%s', left(to_jsonb(l)->>'%s', 32768)" % (field, field) for field in FIELDS)
    pairs += ", 'original_response_error', left(to_jsonb(l)->>'response_content', 32768)"
    sql = ("BEGIN READ ONLY; SET LOCAL statement_timeout = '3s'; "
           "SELECT coalesce(json_agg(record), '[]') FROM (SELECT jsonb_build_object(" + pairs + ") AS record "
           "FROM logs l WHERE log_id = '" + request_id + "' ORDER BY id DESC LIMIT 5) matched; COMMIT;")
    result = run(["docker", "exec", "-i", container, "psql", "-X", "-q", "-At", "-U", user, "-d", database,
                  "-v", "ON_ERROR_STOP=1"], input=sql, capture_output=True, text=True, check=True, timeout=5)
    rows = json.loads(result.stdout.strip())
    if not isinstance(rows, list):
        raise ValueError("Invalid log query result")
    rows = [row for row in rows if isinstance(row, dict) and row.get("log_id") == request_id][:5]
    if not rows:
        return {"state": "unknown", "reason": "no_matching_log", "billingState": "unknown", "rows": []}
    return {"state": "found", "billingState": "unknown", "rows": sanitize(rows)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", choices=("art", "cart"), required=True)
    parser.add_argument("--request-id", required=True)
    args = parser.parse_args()
    try:
        value = read_log(args.site, args.request_id)
    except (ValueError, KeyError, IndexError, subprocess.SubprocessError):
        value = {"state": "unknown", "reason": "log_reader_unavailable", "billingState": "unknown"}
    print(json.dumps(value, ensure_ascii=False))


if __name__ == "__main__":
    main()
