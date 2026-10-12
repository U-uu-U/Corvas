"""Resolve one completed Feituo task's cached URL without changing its billing or status."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import urllib.parse

from adapter import JOB_ID, MODELS


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('site', choices=['art', 'cart'])
    parser.add_argument('--log-id', type=int, required=True)
    parser.add_argument('--task-id', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    assert args.log_id > 0 and JOB_ID.fullmatch(args.task_id)
    os.umask(0o077)
    container = 'tokensbyte-postgres' if args.site == 'art' else 'tkeapi-postgres'
    info = json.loads(subprocess.check_output(['docker', 'inspect', container], text=True))[0]
    env = dict(value.split('=', 1) for value in info['Config']['Env'] if '=' in value)
    user = env.get('POSTGRES_USER', 'postgres')
    command = ['docker', 'exec', '-i', container, 'psql', '-X', '-qAt', '-U', user,
               '-d', env.get('POSTGRES_DB', user), '-v', 'ON_ERROR_STOP=1']

    def query(sql):
        result = subprocess.run(command, input=sql, text=True, capture_output=True, timeout=25)
        if result.returncode:
            raise RuntimeError('Cache repair failed; private SQL details withheld')
        return result.stdout.strip()

    before = json.loads(query(f'SELECT to_jsonb(l) FROM logs l WHERE id={args.log_id};'))
    assert before['model'] in MODELS and before['task_id'] == args.task_id
    assert before['is_completed'] == 1 and before['status_code'] == 200
    channel = query(f"SELECT base_url FROM channels WHERE id={int(before['channel_id'])};")
    assert channel == 'http://feituo-adapter:3012'
    cached = json.loads(before['response_content'])
    assert cached['status'] == 'completed' and cached['task_id'] == args.task_id
    original = cached['video_url']
    code = "import adapter,json,sys; p=json.load(sys.stdin); print(json.dumps({'url':adapter.resolve_media_url(p['url'],p['job'])}))"
    result = subprocess.run(['docker', 'exec', '-i', 'feituo-adapter', 'python', '-B', '-c', code],
                            input=json.dumps({'url': original, 'job': args.task_id}), text=True,
                            capture_output=True, timeout=110)
    if result.returncode:
        raise RuntimeError('Media URL resolution failed; original cached task preserved')
    resolved = json.loads(result.stdout)['url']
    parsed = urllib.parse.urlsplit(resolved)
    assert parsed.hostname == 'media.feituokuajing.com' and parsed.path.endswith('.mp4')
    assert parsed.path != urllib.parse.urlsplit(original).path
    cached['video_url'] = resolved
    transaction = '\n'.join([
        'BEGIN;', "SET LOCAL lock_timeout='5s';", "SET LOCAL statement_timeout='15s';",
        f'SELECT id FROM logs WHERE id={args.log_id} FOR UPDATE;',
        f"DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM logs l WHERE id={args.log_id} AND to_jsonb(l)={literal(json.dumps(before))}::jsonb) THEN RAISE EXCEPTION 'Task changed'; END IF; END $$;",
        f"UPDATE logs SET response_content={literal(json.dumps(cached))} WHERE id={args.log_id};",
        'COMMIT;' if args.apply else 'ROLLBACK;'
    ])
    receipt = {'site': args.site, 'logId': args.log_id, 'taskId': args.task_id, 'applied': False,
               'resultHost': parsed.hostname, 'resultPath': parsed.path}
    if args.apply:
        backup = Path('/root/flow-canvas-operations') / ('feituo-download-' + args.task_id + '-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
        backup.mkdir(parents=True, mode=0o700)
        (backup / 'before.json').write_text(json.dumps(before), encoding='utf-8')
        query(transaction)
        after = json.loads(query(f'SELECT to_jsonb(l) FROM logs l WHERE id={args.log_id};'))
        assert {key: value for key, value in before.items() if key != 'response_content'} == {
            key: value for key, value in after.items() if key != 'response_content'}
        assert json.loads(after['response_content']) == cached
        receipt.update(applied=True, backup=str(backup), billingUnchanged=True)
        (backup / 'receipt.json').write_text(json.dumps(receipt), encoding='utf-8')
    else:
        query(transaction)
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
