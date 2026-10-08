"""Add the numeric-task Seedance route with a CNY 2 fixed sale on one relay."""
import argparse
import copy
import datetime as dt
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import urllib.request

MODEL = 'b_seedance_v2.0'
LABEL = 'Seedance 2.0 15秒'
UPSTREAM = 'http://38.76.169.86:8080'
ADAPTER = 'http://seedance-direct-adapter:3011'
HELPER = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'seedance-hm' / 'add-zhubo-september.py'))
TABLES = HELPER['TABLES']


def plan(before, key, timestamp):
    one = HELPER['one']
    assert before['currency'].get('default_currency') == 'CNY'
    assert not any(row['model_id'] == MODEL for row in before['models']), 'Model already exists'
    assert not any(row['base_url'].rstrip('/') == ADAPTER for row in before['channels']), 'Channel already exists'
    source = one(before['models'], lambda row: row['model_id'] == 'seedance_v2.0-933', 'Source model missing')
    source_rule = one(before['billing_rules'], lambda row: row['id'] == source['billing_rule_id'], 'Source billing missing')
    source_channel = one(before['channels'], lambda row: row['base_url'].rstrip('/') == 'https://video.zhubo.asia', 'Source channel missing')
    assert source['is_active'] == source_rule['is_active'] == source_channel['status'] == 1
    assert source_channel['rate'] == 1
    for fid in json.loads(source['forward_rule_ids']):
        forward = one(before['forward_rules'], lambda row: row['id'] == fid, 'Forward rule missing')
        cfg = json.loads(forward['config_json'])
        assert forward['is_active'] == 1 and cfg['mode'] == 'passthrough'
        assert cfg['path_rewrite']['new'] == '/v1/videos' and cfg['poll_path'] == '/v1/videos/${task_id}'
    next_id = lambda table: max(row['id'] for row in before[table]) + 1
    after = copy.deepcopy(before)
    billing = copy.deepcopy(source_rule)
    billing.update(id=next_id('billing_rules'), pid='', name=LABEL + ' CNY 2.00/request',
                   billing_type='requests', billing_rule='fixed', fixed_rate=2, duration_rate=0,
                   prompt_rate=0, completion_rate=0, cached_rate=0, claude_cache_creation_rate=0,
                   claude_cache_read_rate=0, pricing_type='custom', pricing_tiers='[]',
                   extended_config=json.dumps({'supported_models': [MODEL], 'enable_time_multipliers': False,
                                               'time_multipliers': []}), created_at=timestamp, updated_at=timestamp)
    model = copy.deepcopy(source)
    model.update(id=next_id('models'), mid=str(max(int(row['mid']) for row in before['models']
                                               if str(row['mid']).isdigit()) + 1),
                 model_id=MODEL, original_id=MODEL, model_id_alias='', name=LABEL, billing_rule_id=billing['id'],
                 pre_deduction=2, is_active=1, site_discount=1, global_discount=1,
                 site_discount_enabled=0, global_discount_enabled=0, group_ratios='{}',
                 sort_order=max(int(row.get('sort_order', 0)) for row in before['models']) + 1,
                 description='Fixed 15 seconds; 16:9 or 9:16; up to 9 images; no video/audio references; CNY 2/request',
                 remark='Numeric-task provider 2026-10-08; task JSON URL resolver; equal art/cart fixed sale',
                 feature_attributes=json.dumps(['文生视频', '图生视频', '多图参考生视频'], ensure_ascii=False),
                 created_at=timestamp, updated_at=timestamp)
    channel = copy.deepcopy(source_channel)
    channel.update(id=next_id('channels'), name=LABEL + ' 备用渠道', base_url=ADAPTER, api_key=key,
                   models=json.dumps([model['mid']]), model_mapping=json.dumps({MODEL: MODEL}),
                   config='{}', preset_id=None, status=1, balance=None, rate=1, priority=0, weight=1,
                   created_at=timestamp, updated_at=timestamp)
    for field in channel:
        if field.endswith('_used'):
            channel[field] = 0
    for table, row in [('billing_rules', billing), ('models', model), ('channels', channel)]:
        after[table].append(row)
    return after, {'model': MODEL, 'modelId': model['id'], 'mid': model['mid'], 'channelId': channel['id'],
                   'billingRuleId': billing['id'], 'saleCny': 2, 'unit': 'request', 'preDeduction': 2}


def migration(before, after, apply=False):
    literal = HELPER['literal']
    sql = ['BEGIN;', "SET LOCAL lock_timeout='5s';", "SET LOCAL statement_timeout='25s';",
           'LOCK TABLE ' + ','.join((*TABLES, 'settings')) + ' IN SHARE ROW EXCLUSIVE MODE;']
    sql.extend(HELPER['guard_catalog'](before))
    for table in ['billing_rules', 'models', 'channels']:
        prior = {row['id'] for row in before[table]}
        for row in after[table]:
            if row['id'] not in prior:
                sql.append(f'INSERT INTO {table} SELECT * FROM jsonb_populate_record(NULL::{table},{literal(json.dumps(row))}::jsonb);')
    sql.extend(HELPER['guard_catalog'](after))
    if apply:
        for table in ['billing_rules', 'models', 'channels']:
            sql.append(f"SELECT setval(pg_get_serial_sequence('{table}','id'),greatest((SELECT max(id) FROM {table}),nextval(pg_get_serial_sequence('{table}','id'))));")
        sql.append('COMMIT;')
    else:
        sql.extend([HELPER['snapshot_sql'](), 'ROLLBACK;'])
    return '\n'.join(sql)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('site', choices=['art', 'cart'])
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    key = json.load(sys.stdin)['apiKey']
    assert isinstance(key, str) and len(key) >= 16
    request = urllib.request.Request(UPSTREAM + '/v1/models', headers={'Authorization': 'Bearer ' + key})
    with urllib.request.urlopen(request, timeout=25) as response:
        available = json.load(response)
    profile = HELPER['one'](available['data'], lambda row: row.get('name') == MODEL, 'Model unavailable upstream')
    assert profile['seconds'] == '15' and profile['max_images'] == 9
    assert set(json.loads(profile['ratio'])) == {'9:16', '16:9'}
    assert profile['audio_enabled'] is False and profile['max_audios'] == 0
    health = subprocess.check_output(['docker', 'exec', 'seedance-direct-adapter', 'python', '-c',
             "import urllib.request; print(urllib.request.urlopen('http://seedance-direct-adapter:3011/health', timeout=5).read().decode())"], text=True)
    assert json.loads(health)['ok'] is True
    container = 'tokensbyte-postgres' if args.site == 'art' else 'tkeapi-postgres'
    info = json.loads(subprocess.check_output(['docker', 'inspect', container], text=True))[0]
    env = dict(value.split('=', 1) for value in info['Config']['Env'] if '=' in value)
    user = env.get('POSTGRES_USER', 'postgres')
    database = env.get('POSTGRES_DB', user)
    command = ['docker', 'exec', '-i', container, 'psql', '-X', '-qAt', '-U', user, '-d', database, '-v', 'ON_ERROR_STOP=1']

    def query(sql):
        result = subprocess.run(command, input=sql, text=True, capture_output=True, timeout=45)
        if result.returncode:
            raise RuntimeError('Video route database operation failed; private SQL details withheld')
        return result.stdout.strip()

    before = json.loads(query(HELPER['snapshot_sql']()))
    after, model = plan(before, key, dt.datetime.now(dt.timezone.utc).isoformat())
    HELPER['verify'](after, json.loads(query(migration(before, after))))
    HELPER['verify'](before, json.loads(query(HELPER['snapshot_sql']())))
    receipt = {'site': args.site, 'previewPassed': True, 'applied': False, 'adapterHealthy': True, **model}
    if args.apply:
        backup = Path('/root/flow-canvas-operations') / ('seedance-direct-' + args.site + '-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
        backup.mkdir(mode=0o700, parents=True)
        (backup / 'before.json').write_text(json.dumps(before), encoding='utf-8')
        sql = migration(before, after, apply=True)
        (backup / 'migration.sql').write_text(sql, encoding='utf-8')
        query(sql)
        HELPER['verify'](after, json.loads(query(HELPER['snapshot_sql']())))
        receipt.update(applied=True, verified=True, backup=str(backup))
        (backup / 'receipt.json').write_text(json.dumps(receipt), encoding='utf-8')
    print(json.dumps(receipt, ensure_ascii=False))


if __name__ == '__main__':
    main()
