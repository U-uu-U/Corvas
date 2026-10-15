"""Append the Cheap route with a fixed CNY 4 sale; credentials remain on each relay."""
import argparse
import copy
import datetime as dt
import json
import os
from pathlib import Path
import runpy
import subprocess
import urllib.request

HERE = Path(__file__).resolve().parent
HELPER = runpy.run_path(str(HERE.parent / 'seedance-hm/add-zhubo-september.py'))
MIGRATION = runpy.run_path(str(HERE.parent / 'seedance-yihong/configure.py'))['migration']
MODEL = 'yh-video-v25-cheap'
UPSTREAM_MODEL = 'seedance2.5 cheap'
HOST = 'https://yihongapi.com'
ADAPTER = 'http://yihong-cheap-adapter:3015'


def plan(before, timestamp):
    assert before['currency'].get('default_currency') == 'CNY'
    assert not any(row['model_id'] == MODEL for row in before['models']), 'Model already exists'
    assert not any(row['base_url'].rstrip('/') == ADAPTER for row in before['channels']), 'Channel already exists'
    one = HELPER['one']
    source = one(before['models'], lambda row: row['model_id'] == 'seedance-2.5-super', 'Source model missing')
    rule = one(before['billing_rules'], lambda row: row['id'] == source['billing_rule_id'], 'Source billing missing')
    channel = one(before['channels'], lambda row: row['base_url'].rstrip('/') == HOST
                  and str(source['mid']) in HELPER['decode_json'](row['models'], list), 'Source channel missing')
    assert channel['status'] == 1 and channel['rate'] == 1
    for fid in json.loads(source['forward_rule_ids']):
        forward = one(before['forward_rules'], lambda row: row['id'] == fid, 'Source forward missing')
        config = json.loads(forward['config_json'])
        assert forward['is_active'] == 1 and config['mode'] == 'passthrough'
        assert config['poll_path'] == '/v1/videos/${task_id}' and config['path_rewrite']['new'] == '/v1/videos'
    after = copy.deepcopy(before)
    next_id = lambda table: max(row['id'] for row in before[table]) + 1
    billing = copy.deepcopy(rule)
    billing.update(id=next_id('billing_rules'), pid='', name='Seedance 2.5 Cheap CNY 4/request',
                   billing_type='requests', billing_rule='fixed', fixed_rate=4, duration_rate=0,
                   prompt_rate=0, completion_rate=0, cached_rate=0, claude_cache_creation_rate=0,
                   claude_cache_read_rate=0, pricing_type='custom', pricing_tiers='[]', is_system=0, is_active=1,
                   extended_config=json.dumps({'supported_models': [MODEL], 'enable_time_multipliers': False,
                                               'time_multipliers': []}), created_at=timestamp, updated_at=timestamp)
    model = copy.deepcopy(source)
    model.update(id=next_id('models'), mid=str(max(int(row['mid']) for row in before['models'] if str(row['mid']).isdigit()) + 1),
                 model_id=MODEL, original_id=UPSTREAM_MODEL, model_id_alias='', name='Seedance 2.5 Cheap',
                 billing_rule_id=billing['id'], pre_deduction=4, is_active=1, is_system=0,
                 site_discount=1, global_discount=1, site_discount_enabled=0, global_discount_enabled=0, group_ratios='{}',
                 sort_order=max(int(row.get('sort_order', 0)) for row in before['models']) + 1,
                 description='720p; 4-30 seconds; 30 image references; CNY 4/request',
                 remark='Yihong Cheap 2026-10-12; fixed CNY 4/request on art and cart',
                 feature_attributes=json.dumps(['Text to video', 'Image references']),
                 created_at=timestamp, updated_at=timestamp)
    added = copy.deepcopy(channel)
    added.update(id=next_id('channels'), name='Yihong Seedance 2.5 Cheap', base_url=ADAPTER,
                 models=json.dumps([model['mid']]), model_mapping=json.dumps({MODEL: UPSTREAM_MODEL}),
                 config='{}', preset_id=None, status=1, balance=None, rate=1, priority=0, weight=1,
                 created_at=timestamp, updated_at=timestamp)
    for field in added:
        if field.endswith('_used'):
            added[field] = 0
    for table, row in [('billing_rules', billing), ('models', model), ('channels', added)]:
        after[table].append(row)
    return after, {'model': MODEL, 'upstreamModel': UPSTREAM_MODEL, 'modelId': model['id'], 'mid': model['mid'],
                   'channelId': added['id'], 'billingRuleId': billing['id'], 'currency': 'CNY', 'sale': 4, 'unit': 'request'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('site', choices=['art', 'cart'])
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    container = 'tokensbyte-postgres' if args.site == 'art' else 'tkeapi-postgres'
    command = ['docker', 'exec', '-i', container, 'psql', '-X', '-qAt', '-U', 'tokensapi', '-d', 'tokensapi', '-v', 'ON_ERROR_STOP=1']
    def query(sql):
        result = subprocess.run(command, input=sql, text=True, capture_output=True, timeout=45)
        if result.returncode:
            raise RuntimeError('Database operation failed; private details withheld')
        return result.stdout.strip()
    before = json.loads(query(HELPER['snapshot_sql']()))
    after, report = plan(before, dt.datetime.now(dt.timezone.utc).isoformat())
    key = after['channels'][-1]['api_key']
    request = urllib.request.Request(HOST + '/v1/models', headers={'Authorization': 'Bearer ' + key})
    with urllib.request.urlopen(request, timeout=25) as response:
        upstream = json.load(response)
    assert any(row.get('id') == UPSTREAM_MODEL for row in upstream['data']), 'Upstream model unavailable for this key'
    probe = "import urllib.request,json; assert json.load(urllib.request.urlopen('http://127.0.0.1:3015/health'))['ok']"
    subprocess.run(['docker', 'exec', 'yihong-cheap-adapter', 'python', '-B', '-c', probe], check=True)
    HELPER['verify'](after, json.loads(query(MIGRATION(before, after))))
    HELPER['verify'](before, json.loads(query(HELPER['snapshot_sql']())))
    receipt = {'site': args.site, 'previewPassed': True, 'upstreamModelVisible': True, 'applied': False, **report}
    if args.apply:
        backup = Path('/root/flow-canvas-operations') / ('yihong-cheap-' + args.site + '-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
        backup.mkdir(mode=0o700, parents=True)
        with (backup / 'before.dump').open('wb') as destination:
            subprocess.run(['docker', 'exec', container, 'pg_dump', '-U', 'tokensapi', '-d', 'tokensapi', '-Fc'],
                           stdout=destination, stderr=subprocess.PIPE, check=True)
        (backup / 'before.json').write_text(json.dumps(before), encoding='utf-8')
        sql = MIGRATION(before, after, apply=True)
        (backup / 'migration.sql').write_text(sql, encoding='utf-8')
        query(sql)
        actual = json.loads(query(HELPER['snapshot_sql']()))
        HELPER['verify'](after, actual)
        receipt.update(applied=True, verified=True, backup=str(backup))
        (backup / 'receipt.json').write_text(json.dumps(receipt), encoding='utf-8')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
