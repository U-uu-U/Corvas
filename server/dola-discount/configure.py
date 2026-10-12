"""Append Dola 2.5 discount at CNY 10/request; default to a rollback preview."""
import argparse
import copy
import datetime as dt
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys

from adapter import MODEL, request_json

ADAPTER = 'http://dola-discount-adapter:3013'
HELPER = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'seedance-hm/add-zhubo-september.py'))


def plan(before, key, timestamp):
    one = HELPER['one']
    assert before['currency'].get('default_currency') == 'CNY'
    assert not any(row['model_id'] == MODEL for row in before['models']), 'Model already exists'
    assert not any(row['base_url'].rstrip('/') == ADAPTER for row in before['channels']), 'Channel already exists'
    source = one(before['models'], lambda row: row['model_id'] == 'seedance_v2.0-933', 'Source model missing')
    source_rule = one(before['billing_rules'], lambda row: row['id'] == source['billing_rule_id'], 'Source rule missing')
    source_channel = one(before['channels'], lambda row: row['base_url'].rstrip('/') == 'https://video.zhubo.asia', 'Source channel missing')
    assert source['is_active'] == source_rule['is_active'] == source_channel['status'] == 1
    assert source_channel['rate'] == 1
    forward_ids = json.loads(source['forward_rule_ids'])
    assert forward_ids
    for fid in forward_ids:
        rule = one(before['forward_rules'], lambda row: row['id'] == fid, 'Forward rule missing')
        cfg = json.loads(rule['config_json'])
        assert rule['is_active'] == 1 and cfg['mode'] == 'passthrough'
        assert cfg['path_rewrite']['new'] == '/v1/videos' and cfg['poll_path'] == '/v1/videos/${task_id}'
    next_id = lambda table: max(row['id'] for row in before[table]) + 1
    billing = copy.deepcopy(source_rule)
    billing.update(id=next_id('billing_rules'), pid='', name=MODEL + ' CNY 10.00/request',
                   billing_type='requests', billing_rule='fixed', fixed_rate=10, duration_rate=0,
                   prompt_rate=0, completion_rate=0, cached_rate=0, claude_cache_creation_rate=0,
                   claude_cache_read_rate=0, pricing_type='custom', pricing_tiers='[]', is_system=0, is_active=1,
                   extended_config=json.dumps({'supported_models': [MODEL], 'enable_time_multipliers': False,
                                               'time_multipliers': []}), created_at=timestamp, updated_at=timestamp)
    model = copy.deepcopy(source)
    model.update(id=next_id('models'), mid=str(max(int(row['mid']) for row in before['models'] if str(row['mid']).isdigit()) + 1),
                 model_id=MODEL, original_id=MODEL, model_id_alias='', name=MODEL, billing_rule_id=billing['id'],
                 pre_deduction=10, is_active=1, is_system=0, site_discount=1, global_discount=1,
                 site_discount_enabled=0, global_discount_enabled=0, group_ratios='{}',
                 sort_order=max(int(row.get('sort_order', 0)) for row in before['models']) + 1,
                 description='4-30 integer seconds; 10 image references; fixed CNY 10/request',
                 remark='Dola discount 2026-10-08; user quoted CNY 4/request; sale x2.5; authenticated media cache',
                 feature_attributes=json.dumps(['文生视频', '图生视频', '多图参考生视频'], ensure_ascii=False),
                 created_at=timestamp, updated_at=timestamp)
    channel = copy.deepcopy(source_channel)
    channel.update(id=next_id('channels'), name='Dola 2.5 discount', base_url=ADAPTER, api_key=key,
                   models=json.dumps([model['mid']]), model_mapping=json.dumps({MODEL: MODEL}), config='{}',
                   preset_id=None, status=1, balance=None, rate=1, priority=0, weight=1,
                   created_at=timestamp, updated_at=timestamp)
    for field in channel:
        if field.endswith('_used'):
            channel[field] = 0
    after = copy.deepcopy(before)
    for table, row in [('billing_rules', billing), ('models', model), ('channels', channel)]:
        after[table].append(row)
    return after, {'model': MODEL, 'modelId': model['id'], 'mid': model['mid'], 'channelId': channel['id'],
                   'billingRuleId': billing['id'], 'saleCny': 10, 'unit': 'request', 'preDeduction': 10}


def migration(before, after, apply=False):
    sql = ['BEGIN;', "SET LOCAL lock_timeout='5s';", "SET LOCAL statement_timeout='25s';",
           'LOCK TABLE ' + ','.join((*HELPER['TABLES'], 'settings')) + ' IN SHARE ROW EXCLUSIVE MODE;']
    sql.extend(HELPER['guard_catalog'](before))
    for table in ('billing_rules', 'models', 'channels'):
        prior = {row['id'] for row in before[table]}
        for row in after[table]:
            if row['id'] not in prior:
                sql.append(f"INSERT INTO {table} SELECT * FROM jsonb_populate_record(NULL::{table},{HELPER['literal'](json.dumps(row))}::jsonb);")
    sql.extend(HELPER['guard_catalog'](after))
    if apply:
        for table in ('billing_rules', 'models', 'channels'):
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
    assert isinstance(key, str) and key.startswith('sk-')
    available = request_json('/v1/models', 'Bearer ' + key)['data']
    HELPER['one'](available, lambda row: row['id'] == MODEL, 'Requested model missing upstream')
    health = subprocess.check_output(['docker', 'exec', 'dola-discount-adapter', 'python', '-B', '-c',
             "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:3013/health',timeout=5).read().decode())"], text=True)
    assert json.loads(health)['ok'] is True
    container = 'tokensbyte-postgres' if args.site == 'art' else 'tkeapi-postgres'
    info = json.loads(subprocess.check_output(['docker', 'inspect', container], text=True))[0]
    env = dict(value.split('=', 1) for value in info['Config']['Env'] if '=' in value)
    user = env.get('POSTGRES_USER', 'postgres')
    command = ['docker', 'exec', '-i', container, 'psql', '-X', '-qAt', '-U', user,
               '-d', env.get('POSTGRES_DB', user), '-v', 'ON_ERROR_STOP=1']

    def query(sql):
        result = subprocess.run(command, input=sql, text=True, capture_output=True, timeout=45)
        if result.returncode:
            raise RuntimeError('Database operation failed; private SQL withheld')
        return result.stdout.strip()

    before = json.loads(query(HELPER['snapshot_sql']()))
    after, model = plan(before, key, dt.datetime.now(dt.timezone.utc).isoformat())
    HELPER['verify'](after, json.loads(query(migration(before, after))))
    HELPER['verify'](before, json.loads(query(HELPER['snapshot_sql']())))
    receipt = {'site': args.site, 'previewPassed': True, 'applied': False, **model}
    if args.apply:
        backup = Path('/root/flow-canvas-operations') / ('dola-discount-' + args.site + '-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
        backup.mkdir(mode=0o700, parents=True)
        (backup / 'before.json').write_text(json.dumps(before), encoding='utf-8')
        sql = migration(before, after, apply=True)
        (backup / 'migration.sql').write_text(sql, encoding='utf-8')
        query(sql)
        HELPER['verify'](after, json.loads(query(HELPER['snapshot_sql']())))
        receipt.update(applied=True, verified=True, backup=str(backup))
        (backup / 'receipt.json').write_text(json.dumps(receipt), encoding='utf-8')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
