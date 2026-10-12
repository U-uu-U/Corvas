"""Install the scoped Seedance task plugin and fixed-price channel on the ai station."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.error
import urllib.request

MODEL = 'b_seedance_v2.0'
GROUP = 'Seedance 2.0'
PLUGIN = 'ravenhash-seedance20'
BASE = 'http://seedance-direct-adapter:3011'


def main():
    os.umask(0o077)
    incoming = json.load(sys.stdin)
    upstream_key = incoming['apiKey']
    assert isinstance(upstream_key, str) and len(upstream_key) >= 16
    info = json.loads(subprocess.check_output(['docker', 'inspect', 'postgres'], text=True))[0]
    env = dict(value.split('=', 1) for value in info['Config']['Env'] if '=' in value)
    user = env.get('POSTGRES_USER', 'postgres')
    command = ['docker', 'exec', '-i', 'postgres', 'psql', '-X', '-qAt', '-U', user,
               '-d', env.get('POSTGRES_DB', user), '-v', 'ON_ERROR_STOP=1']

    def query(sql):
        result = subprocess.run(command, input=sql, text=True, capture_output=True, timeout=30)
        if result.returncode:
            raise RuntimeError('Database inspection failed; private SQL withheld')
        return json.loads(result.stdout)

    admin = query("SELECT row_to_json(u) FROM (SELECT id,access_token FROM users WHERE id=1 AND role=100) u;")
    assert admin and admin['access_token'], 'Existing admin API credential required'

    def api(route, method='GET', value=None):
        data = None if value is None else json.dumps(value).encode('utf-8')
        request = urllib.request.Request('http://127.0.0.1:3000' + route, data=data, method=method,
                  headers={'Authorization': 'Bearer ' + admin['access_token'], 'New-Api-User': str(admin['id']),
                           'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=35) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError('Admin API HTTP ' + str(error.code) + ' at ' + route) from None
        if result.get('success') is not True:
            message = str(result.get('message', 'Operation failed')).replace(upstream_key, '[redacted]').replace(admin['access_token'], '[redacted]')
            raise RuntimeError(route + ': ' + message[:1000])
        return result.get('data')

    channels = query("SELECT coalesce(json_agg(c),'[]'::json) FROM (SELECT id,type,name,status,models,\"group\",base_url,setting FROM channels ORDER BY id) c;")
    assert not any(MODEL in row['models'].split(',') for row in channels), 'Model already configured; inspect before changing'
    options = query("SELECT json_object_agg(key,value) FROM options WHERE key IN ('GroupRatio','UserUsableGroups','AutoGroups','USDExchangeRate');")
    assert float(options['USDExchangeRate']) == 1, 'Currency display conversion changed'
    assert GROUP not in json.loads(options['GroupRatio']), 'Group already exists'
    pricing = api('/api/option/model_pricing?model=' + MODEL)['entries'][0]
    assert not pricing['configured'], 'Model pricing already exists'
    source = Path(__file__).with_name('newapi-plugin.mjs').read_text(encoding='utf-8')
    backup = Path('/root/flow-canvas-operations') / ('ai-seedance20-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(parents=True, mode=0o700)
    (backup / 'before.json').write_text(json.dumps({'channels': channels, 'options': options, 'pricing': pricing}), encoding='utf-8')

    api('/api/plugin/task', 'POST', {'source': source, 'sourceSha256': hashlib.sha256(source.encode()).hexdigest(),
                                   'enabled': True, 'remark': 'Corvas fixed 15s / 9 image route; private adapter keeps query failures nonterminal'})
    dryrun = api('/api/plugin/task/' + PLUGIN + '/dryrun', 'POST', {'hook': 'buildSubmitRequest', 'args': [{
        'baseUrl': BASE, 'apiKey': 'fixture-only', 'model': MODEL, 'upstreamModel': MODEL,
        'requestBody': {'prompt': 'fixture', 'duration': 15, 'ratio': '16:9', 'images': [{'url': 'https://example.com/reference.png'}]}}]})
    assert dryrun['body']['seconds'] == 15 and dryrun['body']['reference_images'] == ['https://example.com/reference.png']
    dryrun = api('/api/plugin/task/' + PLUGIN + '/dryrun', 'POST', {'hook': 'parseTaskResult', 'args': [
        {'taskId': '123'}, {'id': '123', 'status': 'in_progress', 'corvas_query_state': 'unavailable'}]})
    assert dryrun['status'] == 'IN_PROGRESS'

    updated = {key: json.loads(options[key]) for key in ('GroupRatio', 'UserUsableGroups', 'AutoGroups')}
    updated['GroupRatio'][GROUP] = 1
    updated['UserUsableGroups'][GROUP] = 'Seedance 2.0 15秒，最多9图，2元/次'
    updated['AutoGroups'].append(GROUP)
    for key, value in updated.items():
        current = query("SELECT to_json(value) FROM options WHERE key='" + key + "';")
        assert current == options[key], 'Option changed during deployment: ' + key
        api('/api/option/', 'PUT', {'key': key, 'value': json.dumps(value, ensure_ascii=False)})
        verified = query("SELECT to_json(value) FROM options WHERE key='" + key + "';")
        assert json.loads(verified) == value

    api('/api/option/model_pricing', 'PATCH', {'changes': [{
        'model_name': MODEL, 'expected_version': pricing['version'], 'pricing': {'ModelPrice': 2}}]})
    verified_price = api('/api/option/model_pricing?model=' + MODEL)['entries'][0]
    assert verified_price['configured']['ModelPrice'] == 2

    channel = {'type': 61, 'name': 'Seedance 2.0 15秒', 'status': 1, 'base_url': BASE, 'key': upstream_key,
               'models': MODEL, 'group': GROUP, 'priority': 0, 'weight': 1, 'auto_ban': 0,
               'setting': json.dumps({'task_plugin_key': PLUGIN}), 'model_mapping': '{}',
               'remark': 'Fixed CNY 2/request; 15s; images<=9; scoped plugin and private adapter'}
    api('/api/channel/', 'POST', {'mode': 'single', 'channel': channel})
    after = query("SELECT coalesce(json_agg(c),'[]'::json) FROM (SELECT id,type,name,status,models,\"group\",base_url,setting FROM channels ORDER BY id) c;")
    additions = [row for row in after if row['id'] not in {item['id'] for item in channels}]
    assert len(additions) == 1 and additions[0]['models'] == MODEL and additions[0]['status'] == 1
    assert [row for row in after if row['id'] in {item['id'] for item in channels}] == channels
    receipt = {'site': 'ai.ravenhash.org', 'model': MODEL, 'channelId': additions[0]['id'],
               'plugin': PLUGIN, 'group': GROUP, 'saleCny': 2, 'unit': 'request', 'backup': str(backup), 'dryrunPassed': True}
    (backup / 'receipt.json').write_text(json.dumps(receipt), encoding='utf-8')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
