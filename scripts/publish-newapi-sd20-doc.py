"""Publish SD2.0 model documentation through the existing New API admin API."""
import argparse
import hashlib
import json
from pathlib import Path
import runpy
import shlex

ROOT = Path(__file__).resolve().parents[1]
MODEL = 'b_seedance_v2.0'
DOCUMENT = ROOT / 'docs/api/newapi-seedance-2.0.md'

REMOTE = r'''
import datetime, hashlib, json, os, pathlib, subprocess, sys, urllib.request
os.umask(0o077)
payload = json.load(sys.stdin)
model = 'b_seedance_v2.0'
assert hashlib.sha256(payload['description'].encode()).hexdigest() == payload['sha256']
info = json.loads(subprocess.check_output(['docker', 'inspect', 'postgres'], text=True))[0]
env = dict(value.split('=', 1) for value in info['Config']['Env'] if '=' in value)
user = env.get('POSTGRES_USER', 'postgres')
command = ['docker', 'exec', '-i', 'postgres', 'psql', '-X', '-qAt', '-U', user,
           '-d', env.get('POSTGRES_DB', user), '-v', 'ON_ERROR_STOP=1']
def query(sql):
    result = subprocess.run(command, input=sql, text=True, capture_output=True, timeout=20)
    if result.returncode: raise RuntimeError('Database inspection failed')
    return json.loads(result.stdout)
def metadata():
    return query("SELECT coalesce(json_agg(m),'[]') FROM models m WHERE model_name='b_seedance_v2.0' AND deleted_at IS NULL;")
def operational():
    return {
        'channels': query("SELECT coalesce(json_agg(c),'[]') FROM (SELECT id,type,status,models,\"group\" FROM channels WHERE models LIKE '%b_seedance_v2.0%' ORDER BY id) c;"),
        'pricing': query("SELECT coalesce(json_object_agg(key,value),'{}') FROM options WHERE key IN ('ModelPrice','GroupRatio','USDExchangeRate');")
    }
admin = query("SELECT row_to_json(a) FROM (SELECT id,access_token FROM users WHERE id=1 AND role=100) a;")
assert admin and admin['access_token'], 'Existing admin API credential required'
def api(route, method='GET', body=None):
    req = urllib.request.Request('http://127.0.0.1:3000' + route,
        data=None if body is None else json.dumps(body, ensure_ascii=False).encode(), method=method,
        headers={'Authorization': 'Bearer ' + admin['access_token'], 'New-Api-User': str(admin['id']), 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as response: result = json.load(response)
    if result.get('success') is not True: raise RuntimeError('Model metadata API rejected the document')
    return result.get('data')
before = metadata()
assert len(before) <= 1, 'Multiple metadata rows need manual inspection'
plugin = query("SELECT row_to_json(p) FROM (SELECT source_hash,enabled,active FROM task_plugins WHERE key='ravenhash-seedance20') p;")
assert plugin and plugin['enabled'] and plugin['active'], 'Installed video plugin is not active'
assert plugin['source_hash'] == payload['pluginSha256'], 'Installed video contract differs from the documented plugin'
operation_before = operational()
endpoint_info = json.dumps({'openai-video': {'path': '/v1/videos', 'method': 'POST'}}, separators=(',', ':'))
value = {key: item for key, item in before[0].items() if key != 'deleted_at'} if before else {
    'model_name': model, 'status': 1, 'sync_official': 0, 'name_rule': 0
}
value.update(description=payload['description'], endpoints=endpoint_info)
receipt = {'model': model, 'operation': 'update' if before else 'create', 'sha256': payload['sha256'],
           'characters': len(payload['description']), 'applied': False}
if payload['apply']:
    backup = pathlib.Path('/root/flow-canvas-operations') / ('newapi-sd20-doc-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(parents=True, mode=0o700)
    (backup / 'before.json').write_text(json.dumps(before, ensure_ascii=False), encoding='utf-8')
    (backup / 'document.md').write_text(payload['description'], encoding='utf-8')
    assert metadata() == before, 'Model metadata changed before publication'
    api('/api/models/', 'PUT' if before else 'POST', value)
    after = metadata()
    assert len(after) == 1 and after[0]['description'] == payload['description']
    assert json.loads(after[0]['endpoints']) == json.loads(endpoint_info)
    if before:
        for key, item in before[0].items():
            if key not in ['description', 'endpoints', 'updated_time']:
                assert after[0][key] == item, 'Unrelated metadata changed: ' + key
    assert operational() == operation_before, 'Channel or billing settings changed during publication'
    receipt.update(applied=True, modelId=after[0]['id'], backup=str(backup))
    (backup / 'receipt.json').write_text(json.dumps(receipt), encoding='utf-8')
print(json.dumps(receipt))
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    description = DOCUMENT.read_text(encoding='utf-8')
    assert MODEL in description and '/v1/videos' in description
    digest = hashlib.sha256(description.encode()).hexdigest()
    plugin_digest = hashlib.sha256((ROOT / 'server/seedance-direct/newapi-plugin.mjs').read_text(encoding='utf-8').encode()).hexdigest()
    helper = runpy.run_path(str(ROOT / 'scripts/config-channel-control.py'))
    client = helper['connect']()
    try:
        stdin, stdout, stderr = client.exec_command('python3 -c ' + shlex.quote(REMOTE), timeout=60)
        stdin.write(json.dumps({'description': description, 'sha256': digest, 'pluginSha256': plugin_digest, 'apply': args.apply}).encode())
        stdin.channel.shutdown_write()
        output = stdout.read().decode()
        error = stderr.read().decode()
        if stdout.channel.recv_exit_status(): raise RuntimeError(error)
        print(output, end='')
    finally:
        client.close()


if __name__ == '__main__':
    main()
