"""Restore one proven-completed task's false failure cache, preserving its refund."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import subprocess


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('site', choices=['art', 'cart'])
    parser.add_argument('--log-id', type=int, required=True)
    parser.add_argument('--task-id', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    assert args.log_id > 0 and args.task_id.isdigit()
    os.umask(0o077)
    container = 'tokensbyte-postgres' if args.site == 'art' else 'tkeapi-postgres'
    info = json.loads(subprocess.check_output(['docker', 'inspect', container], text=True))[0]
    env = dict(value.split('=', 1) for value in info['Config']['Env'] if '=' in value)
    user = env.get('POSTGRES_USER', 'postgres')
    database = env.get('POSTGRES_DB', user)
    command = ['docker', 'exec', '-i', container, 'psql', '-X', '-qAt', '-U', user, '-d', database, '-v', 'ON_ERROR_STOP=1']

    def query(sql):
        result = subprocess.run(command, input=sql, text=True, capture_output=True, timeout=30)
        if result.returncode:
            raise RuntimeError('Recovery database operation failed; private details withheld')
        return result.stdout.strip()

    before = json.loads(query(f'SELECT to_jsonb(l) FROM logs l WHERE id={args.log_id};'))
    assert before['model'] == 'b_seedance_v2.0' and str(before['task_id']) == args.task_id
    assert before['is_completed'] == 1 and before['status_code'] == 400
    assert before['error_message'] == 'Task not found' and before['cost'] == 0
    assert '退费' in before['billing_detail'] or '退回' in before['billing_detail']
    channel = json.loads(query(f"SELECT jsonb_build_object('api_key',api_key,'base_url',base_url) FROM channels WHERE id={before['channel_id']};"))
    assert channel['base_url'] == 'http://seedance-direct-adapter:3011'
    code = """
import json,sys,urllib.request
body=json.load(sys.stdin)
request=urllib.request.Request('http://127.0.0.1:3011/v1/videos/'+body['task'],headers={'Authorization':'Bearer '+body['key']})
with urllib.request.urlopen(request,timeout=50) as response:print(json.dumps(json.load(response)))
"""
    result = subprocess.run(['docker', 'exec', '-i', 'seedance-direct-adapter', 'python', '-c', code],
                            input=json.dumps({'task': args.task_id, 'key': channel['api_key']}),
                            text=True, capture_output=True, check=True, timeout=55)
    completed = json.loads(result.stdout)
    assert completed['status'] == 'completed' and str(completed['task_id']) == args.task_id
    assert completed.get('video_url') and completed.get('completed_at')
    elapsed = (dt.datetime.fromisoformat(completed['completed_at'].replace('Z', '+00:00'))
               - dt.datetime.fromisoformat(before['created_at'].replace('Z', '+00:00'))).total_seconds()
    assert 0 <= elapsed <= 7 * 86400
    detail = before['billing_detail'] + '；任务查询误判后恢复原产物，原退费保留'
    guard = literal(json.dumps(before))
    transaction = '\n'.join([
        'BEGIN;', "SET LOCAL lock_timeout='5s';",
        f'SELECT id FROM logs WHERE id={args.log_id} FOR UPDATE;',
        f"DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM logs l WHERE id={args.log_id} AND to_jsonb(l)={guard}::jsonb) THEN RAISE EXCEPTION 'Task changed during recovery'; END IF; END $$;",
        f"UPDATE logs SET response_content={literal(json.dumps(completed))}, status_code=200, is_completed=1, error_message=NULL, billing_detail={literal(detail)}, latency_ms={round(elapsed * 1000)} WHERE id={args.log_id};",
        'COMMIT;' if args.apply else 'ROLLBACK;'
    ])
    receipt = {'site': args.site, 'logId': args.log_id, 'taskId': args.task_id,
               'upstreamCompleted': True, 'applied': False, 'refundPreserved': True, 'cost': 0}
    if args.apply:
        backup = Path('/root/flow-canvas-operations') / ('recover-query-' + args.task_id + '-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
        backup.mkdir(mode=0o700, parents=True)
        (backup / 'before.json').write_text(json.dumps(before), encoding='utf-8')
        (backup / 'migration.sql').write_text(transaction, encoding='utf-8')
        query(transaction)
        after = json.loads(query(f'SELECT to_jsonb(l) FROM logs l WHERE id={args.log_id};'))
        changed = {'response_content', 'status_code', 'is_completed', 'error_message', 'billing_detail', 'latency_ms'}
        assert {k: v for k, v in before.items() if k not in changed} == {k: v for k, v in after.items() if k not in changed}
        assert after['cost'] == before['cost'] == 0
        assert after['status_code'] == 200 and json.loads(after['response_content'])['status'] == 'completed'
        receipt.update(applied=True, backup=str(backup))
        (backup / 'receipt.json').write_text(json.dumps(receipt), encoding='utf-8')
    else:
        query(transaction)
    print(json.dumps(receipt, ensure_ascii=False))


if __name__ == '__main__':
    main()
