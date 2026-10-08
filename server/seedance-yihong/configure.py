"""Add Yihong Super to one relay. Credentials arrive on stdin; preview is default."""
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

MODEL = 'seedance-2.5-super'
UPSTREAM_MODEL = 'seedance2.5 super'
LABEL = 'Seedance 2.5 Super'
HOST = 'https://yihongapi.com'
SALE = 0.78
SOURCE = 'LongXia-video-seedance2_5-standard-720p-express-PerSecond'
HELPERS = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'seedance-hm' / 'add-zhubo-september.py'))
TABLES = HELPERS['TABLES']
literal = HELPERS['literal']
json_text = HELPERS['json_text']
one = HELPERS['one']
decode_json = HELPERS['decode_json']


def plan(before, credential, timestamp):
    assert before['currency'].get('default_currency') == 'CNY', 'Requires CNY accounting'
    assert not any(row['model_id'] == MODEL for row in before['models']), 'Model already exists'
    assert not any(row['base_url'].rstrip('/') == HOST for row in before['channels']), 'Channel already exists'
    source = one(before['models'], lambda row: row['model_id'] == SOURCE, 'Source model missing')
    source_rule = one(before['billing_rules'], lambda row: row['id'] == source['billing_rule_id'], 'Source rule missing')
    source_channel = one(before['channels'], lambda row: str(source['mid']) in decode_json(row['models'], list)
                         and row['base_url'].rstrip('/') == 'https://video.zhubo.asia', 'Source channel missing')
    assert source['is_active'] == source_rule['is_active'] == source_channel['status'] == 1
    assert source_channel['rate'] == 1
    assert source_rule['billing_type'] == 'duration' and source_rule['billing_rule'] == 'video_resolution'
    for fid in json.loads(source['forward_rule_ids']):
        forward = one(before['forward_rules'], lambda row: row['id'] == fid, 'Forward rule missing')
        config = json.loads(forward['config_json'])
        assert forward['is_active'] == 1 and config['mode'] == 'passthrough'
        assert config['poll_path'] == '/v1/videos/${task_id}'
        assert config['path_rewrite']['new'] == '/v1/videos' and config['auth_type'] == 'bearer'
    after = copy.deepcopy(before)
    next_id = lambda table: max(row['id'] for row in before[table]) + 1
    billing = copy.deepcopy(source_rule)
    billing.update(id=next_id('billing_rules'), pid='', name=LABEL + ' CNY 0.78/second',
                   duration_rate=SALE, fixed_rate=0, prompt_rate=0, completion_rate=0, cached_rate=0,
                   claude_cache_creation_rate=0, claude_cache_read_rate=0, is_active=1, is_system=0,
                   pricing_type='custom', pricing_tiers=json_text([{'resolution': '720p', 'rate': SALE,
                                                                  'cached_rate': 0, 'enabled': True}]),
                   extended_config=json_text({'supported_models': [MODEL], 'enable_time_multipliers': False,
                                              'time_multipliers': []}), created_at=timestamp, updated_at=timestamp)
    model = copy.deepcopy(source)
    model.update(id=next_id('models'), mid=str(max(int(row['mid']) for row in before['models']
                                               if str(row['mid']).isdigit()) + 1),
                 model_id=MODEL, original_id=UPSTREAM_MODEL, model_id_alias='', name=LABEL, billing_rule_id=billing['id'],
                 pre_deduction=3.9, site_discount=1, global_discount=1,
                 site_discount_enabled=0, global_discount_enabled=0, group_ratios='{}',
                 sort_order=max(int(row.get('sort_order', 0)) for row in before['models']) + 1,
                 description='720p; 5-30 seconds; 30 images / 10 videos / 10 audios; CNY 0.78/second',
                 remark='Yihong Super 2026-10-07; user-specified equal CNY price on art/cart; 5-second reservation',
                 feature_attributes=json_text(['文生视频', '图生视频', '多模态参考生视频']),
                 created_at=timestamp, updated_at=timestamp)
    channel = copy.deepcopy(source_channel)
    channel.update(id=next_id('channels'), name='Yihong Seedance 2.5 Super', base_url=HOST, api_key=credential,
                   models=json_text([model['mid']]), model_mapping=json_text({MODEL: UPSTREAM_MODEL}), config='{}',
                   preset_id=None, status=1, balance=None, rate=1, priority=0, weight=1,
                   created_at=timestamp, updated_at=timestamp)
    for key in channel:
        if key.endswith('_used'):
            channel[key] = 0
    for table, row in [('billing_rules', billing), ('models', model), ('channels', channel)]:
        after[table].append(row)
    return after, {'model': MODEL, 'modelId': model['id'], 'mid': model['mid'], 'channelId': channel['id'],
                   'billingRuleId': billing['id'], 'currency': 'CNY', 'salePerSecond': SALE,
                   'minimumReservation': 3.9, 'duration': [5, 30], 'references': [30, 10, 10]}


def migration(before, after, apply=False):
    statements = ['BEGIN;', "SET LOCAL lock_timeout='5s';",
                  'LOCK TABLE ' + ','.join((*TABLES, 'settings')) + ' IN SHARE ROW EXCLUSIVE MODE;']
    statements.extend(HELPERS['guard_catalog'](before))
    for table in ['billing_rules', 'models', 'channels']:
        old_ids = {row['id'] for row in before[table]}
        for row in after[table]:
            if row['id'] not in old_ids:
                statements.append(f'INSERT INTO {table} SELECT * FROM jsonb_populate_record(NULL::{table},{literal(json_text(row))}::jsonb);')
    statements.extend(HELPERS['guard_catalog'](after))
    if apply:
        for table in ['billing_rules', 'models', 'channels']:
            statements.append(f"SELECT setval(pg_get_serial_sequence('{table}','id'),greatest((SELECT max(id) FROM {table}),nextval(pg_get_serial_sequence('{table}','id'))));")
        statements.append('COMMIT;')
    else:
        statements.extend([HELPERS['snapshot_sql'](), 'ROLLBACK;'])
    return '\n'.join(statements)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('site', choices=['art', 'cart'])
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    credential = json.load(sys.stdin)['apiKey']
    assert isinstance(credential, str) and credential.startswith('sk-')
    request = urllib.request.Request(HOST + '/v1/models', headers={'Authorization': 'Bearer ' + credential})
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            upstream = json.load(response)
        assert any(row.get('id') == UPSTREAM_MODEL for row in upstream['data']), 'Model unavailable upstream'
    except Exception:
        raise RuntimeError('Upstream model discovery failed; no relay changes applied') from None
    container = 'tokensbyte-postgres' if args.site == 'art' else 'tkeapi-postgres'
    info = json.loads(subprocess.check_output(['docker', 'inspect', container], text=True))[0]
    env = dict(value.split('=', 1) for value in info['Config']['Env'] if '=' in value)
    user = env.get('POSTGRES_USER', 'postgres')
    database = env.get('POSTGRES_DB', user)
    command = ['docker', 'exec', '-i', container, 'psql', '-X', '-qAt', '-U', user, '-d', database,
               '-v', 'ON_ERROR_STOP=1']

    def query(sql):
        result = subprocess.run(command, input=sql, text=True, capture_output=True)
        if result.returncode:
            reason = next((line for line in result.stderr.splitlines() if line.startswith('ERROR:')), 'Database operation failed')
            raise RuntimeError(reason.replace(credential, '[redacted]'))
        return result.stdout.strip()

    before = json.loads(query(HELPERS['snapshot_sql']()))
    after, report = plan(before, credential, dt.datetime.now(dt.timezone.utc).isoformat())
    HELPERS['verify'](after, json.loads(query(migration(before, after))))
    HELPERS['verify'](before, json.loads(query(HELPERS['snapshot_sql']())))
    receipt = dict(site=args.site, previewPassed=True, applied=False, upstreamModelVisible=True, **report)
    if args.apply:
        backup = Path('/root/flow-canvas-operations') / ('yihong-super-' + args.site + '-' +
                 dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
        backup.mkdir(mode=0o700, parents=True)
        with (backup / 'before.dump').open('wb') as target:
            subprocess.run(['docker', 'exec', container, 'pg_dump', '-U', user, '-d', database, '-Fc'],
                           stdout=target, stderr=subprocess.PIPE, check=True)
        (backup / 'before.json').write_text(json_text(before), encoding='utf-8')
        sql = migration(before, after, apply=True)
        (backup / 'migration.sql').write_text(sql, encoding='utf-8')
        query(sql)
        actual = json.loads(query(HELPERS['snapshot_sql']()))
        HELPERS['verify'](after, actual)
        (backup / 'after.json').write_text(json_text(actual), encoding='utf-8')
        receipt.update(applied=True, verified=True, backup=str(backup))
        (backup / 'receipt.json').write_text(json_text(receipt), encoding='utf-8')
    print(json_text(receipt))


if __name__ == '__main__':
    main()
