"""Create Feituo routes on a fresh relay, with a rollback preview by default."""
import argparse
import copy
import datetime as dt
from decimal import Decimal
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys

from adapter import MODELS, request_json

ADAPTER = 'http://feituo-adapter:3012'
HELPER = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'seedance-hm' / 'add-zhubo-september.py'))
TABLES = HELPER['TABLES']


def plan(before, key, timestamp):
    one = HELPER['one']
    assert before['currency'].get('default_currency') == 'CNY'
    assert not any(row['model_id'] in MODELS for row in before['models']), 'Target model already exists'
    assert not any(row['base_url'].rstrip('/') == ADAPTER for row in before['channels']), 'Channel already exists'
    source = one(before['models'], lambda row: row['model_id'] == 'seedance_v2.0-933', 'Source model missing')
    source_rule = one(before['billing_rules'], lambda row: row['id'] == source['billing_rule_id'], 'Billing missing')
    source_channel = one(before['channels'], lambda row: row['base_url'].rstrip('/') == 'https://video.zhubo.asia', 'Source channel missing')
    assert source['is_active'] == source_rule['is_active'] == source_channel['status'] == 1
    assert source_channel['rate'] == 1
    forward_ids = json.loads(source['forward_rule_ids'])
    assert forward_ids
    for fid in forward_ids:
        forward = one(before['forward_rules'], lambda row: row['id'] == fid, 'Forward rule missing')
        cfg = json.loads(forward['config_json'])
        assert forward['is_active'] == 1 and cfg['mode'] == 'passthrough'
        assert cfg['path_rewrite']['new'] == '/v1/videos' and cfg['poll_path'] == '/v1/videos/${task_id}'
    next_id = lambda table: max(row['id'] for row in before[table]) + 1
    next_mid = max(int(row['mid']) for row in before['models'] if str(row['mid']).isdigit()) + 1
    after = copy.deepcopy(before)
    additions = []
    for index, (name, spec) in enumerate(MODELS.items()):
        sale = float(Decimal(str(spec['costCny'])) * 3)
        billing = copy.deepcopy(source_rule)
        billing.update(id=next_id('billing_rules') + index, pid='', name=spec['label'] + f' CNY {sale:.2f}/request',
                       billing_type='requests', billing_rule='fixed', fixed_rate=sale, duration_rate=0,
                       prompt_rate=0, completion_rate=0, cached_rate=0, claude_cache_creation_rate=0,
                       claude_cache_read_rate=0, pricing_type='custom', pricing_tiers='[]', is_system=0, is_active=1,
                       extended_config=json.dumps({'supported_models': [name], 'enable_time_multipliers': False,
                                                   'time_multipliers': []}), created_at=timestamp, updated_at=timestamp)
        model = copy.deepcopy(source)
        model.update(id=next_id('models') + index, mid=str(next_mid + index), model_id=name, original_id=name,
                     model_id_alias='', name=spec['label'], billing_rule_id=billing['id'], pre_deduction=sale,
                     is_active=1, is_system=0, site_discount=1, global_discount=1, site_discount_enabled=0,
                     global_discount_enabled=0, group_ratios='{}',
                     sort_order=max(int(row.get('sort_order', 0)) for row in before['models']) + index + 1,
                     description=f"720p; {spec['minSeconds']}-{spec['maxSeconds']} seconds; "
                                 f"{spec['images']}/{spec['videos']}/{spec['audios']} image/video/audio references",
                     remark='Feituo 2026-10-08; native jobId adapter; equal art/cart CNY cost x3 per request',
                     feature_attributes=json.dumps(['文生视频', '图生视频', '多模态参考生视频'], ensure_ascii=False),
                     created_at=timestamp, updated_at=timestamp)
        after['billing_rules'].append(billing)
        after['models'].append(model)
        additions.append({'model': name, 'modelId': model['id'], 'mid': model['mid'], 'billingRuleId': billing['id'],
                          'saleCny': sale, 'unit': 'request', 'preDeduction': sale})
    channel = copy.deepcopy(source_channel)
    channel.update(id=next_id('channels'), name='飞拓视频', base_url=ADAPTER, api_key=key,
                   models=json.dumps([row['mid'] for row in additions]), model_mapping=json.dumps({name: name for name in MODELS}),
                   config='{}', preset_id=None, status=1, balance=None, rate=1, priority=0, weight=1,
                   created_at=timestamp, updated_at=timestamp)
    for field in channel:
        if field.endswith('_used'):
            channel[field] = 0
    after['channels'].append(channel)
    return after, additions, channel['id']


def migration(before, after, apply=False):
    sql = ['BEGIN;', "SET LOCAL lock_timeout='5s';", "SET LOCAL statement_timeout='25s';",
           'LOCK TABLE ' + ','.join((*TABLES, 'settings')) + ' IN SHARE ROW EXCLUSIVE MODE;']
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
    assert isinstance(key, str) and key.startswith('ftk_')
    available = request_json('/models', 'Bearer ' + key)['data']
    for name, spec in MODELS.items():
        actual = HELPER['one'](available, lambda row: row['id'] == name, 'Upstream model missing')
        assert actual['status'] == 'available'
        assert actual['price'] == {'currency': 'CNY', 'amount': spec['costCny'], 'unit': 'request'}
        assert actual['resolution_durations'][spec['resolution']] == spec.get('durations', list(range(spec['minSeconds'], spec['maxSeconds'] + 1)))
        assert set(actual['aspect_ratios']) == set(spec['ratios'])
        assert [actual['max_' + media + '_refs'] for media in ('image', 'video', 'audio')] == [spec[key] for key in ('images', 'videos', 'audios')]
        assert actual.get('prompt_max_chars') == spec['promptMaxChars']
        assert actual.get('min_image_refs', 0) == 0 and not actual.get('audio_requires_image')
    health = subprocess.check_output(['docker', 'exec', 'feituo-adapter', 'python', '-c',
             "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:3012/health', timeout=5).read().decode())"], text=True)
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
            raise RuntimeError('Database operation failed; private SQL details withheld')
        return result.stdout.strip()

    before = json.loads(query(HELPER['snapshot_sql']()))
    after, additions, channel = plan(before, key, dt.datetime.now(dt.timezone.utc).isoformat())
    HELPER['verify'](after, json.loads(query(migration(before, after))))
    HELPER['verify'](before, json.loads(query(HELPER['snapshot_sql']())))
    receipt = {'site': args.site, 'previewPassed': True, 'applied': False, 'channelId': channel, 'models': additions}
    if args.apply:
        backup = Path('/root/flow-canvas-operations') / ('feituo-' + args.site + '-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
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
