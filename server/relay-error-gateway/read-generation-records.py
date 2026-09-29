"""Bounded private task projection; request/media/billing columns are never selected."""
import argparse
import hashlib
import json
import subprocess

WRAPPERS = ('data', 'result', 'output', 'task', 'response', 'Response', 'metadata')
ERROR_KEYS = ('code', 'type', 'message', 'msg', 'reason', 'detail', 'error', 'error_code',
              'failReason', 'fail_reason', 'failure_reason', 'error_message', 'status_msg')


def error_fields(value, depth=0):
    if depth > 4:
        return None
    if isinstance(value, str):
        return value[:2000]
    if isinstance(value, dict):
        return {key: error_fields(value[key], depth + 1) for key in ERROR_KEYS if key in value}
    return value if isinstance(value, (int, bool)) else None


def project_response(text):
    try:
        value = json.loads(text or '{}')
    except (ValueError, TypeError):
        return {}
    nodes = []

    def visit(node, depth=0):
        if depth > 5 or len(nodes) >= 50:
            return
        if isinstance(node, list):
            for item in node[:10]:
                visit(item, depth + 1)
        if isinstance(node, dict):
            nodes.append(node)
            for key in WRAPPERS:
                visit(node.get(key), depth + 1)
    visit(value)
    states = [str(n.get('status') or n.get('task_status') or '').lower() for n in nodes]
    completed = next((n.get(key) for n in nodes for key in ('completed_at', 'completedAt', 'finished_at')
                      if n.get(key)), None)
    output = any(isinstance(n.get(key), str) and bool(n[key]) for n in nodes
                 for key in ('url', 'video_url', 'image_url', 'b64_json'))
    errors = [error_fields(n) for n in nodes if n.get('error') or n.get('fail_reason') or n.get('error_message')
              or str(n.get('status', '')).lower() in ('failed', 'failure', 'error', 'rejected')]
    return {'states': states, 'completedAt': completed, 'hasOutput': output, 'errors': errors}


def read_records(site):
    container = {'art': 'tokensbyte-postgres', 'cart': 'tkeapi-postgres'}[site]
    names = subprocess.check_output(['docker', 'exec', container, 'sh', '-c',
        'printf \'%s\\n%s\\n\' "${POSTGRES_USER:-postgres}" "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"'],
        text=True, timeout=3).splitlines()
    # Created-at index bounds the scan; no per-user joins and no query/poll endpoints.
    sql = """BEGIN READ ONLY; SET LOCAL statement_timeout = '8s';
    SELECT row_to_json(r) FROM (
      SELECT id, log_id, user_id, channel_id, model, task_id, endpoint, created_at,
             status_code, is_completed, latency_ms, left(error_message, 4000) AS error_message,
             CASE WHEN octet_length(response_content) <= 65536 THEN response_content ELSE NULL END AS response_content
      FROM logs WHERE created_at >= now() - interval '7 days'
        AND endpoint IN ('/v1/video/generations', '/v1/videos', '/v1/images/generations', '/v1/images/edits')
        AND model IS NOT NULL AND model <> 'unknown'
      ORDER BY created_at DESC, id DESC LIMIT 5001
    ) r; COMMIT;"""
    result = subprocess.run(['docker', 'exec', '-i', container, 'psql', '-X', '-q', '-At',
        '-U', names[0], '-d', names[1], '-v', 'ON_ERROR_STOP=1'], input=sql, text=True,
        capture_output=True, check=True, timeout=12)
    rows = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
    records = []
    for row in rows[:5000]:
        identity = [row['user_id'], row['channel_id'], row['model'], row['task_id'] or row['log_id'] or row['id']]
        records.append({'key': hashlib.sha256(json.dumps(identity).encode()).hexdigest(),
            'sequence': row['id'], 'model': row['model'], 'createdAt': row['created_at'],
            'statusCode': row['status_code'], 'completed': row['is_completed'] == 1,
            'async': bool(row['task_id']), 'kind': 'image' if '/images/' in row['endpoint'] else 'video',
            'latencyMs': row['latency_ms'], 'error': error_fields(row['error_message']),
            'response': project_response(row['response_content'])})
    return {'records': records, 'truncated': len(rows) > 5000}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--site', choices=['art', 'cart'], required=True)
    args = parser.parse_args()
    print(json.dumps(read_records(args.site), ensure_ascii=True))
