"""Append the Jijiu route at CNY 11/request; preview and rollback by default."""
import argparse
import copy
import datetime as dt
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import urllib.error
import urllib.request

SPEC = json.loads(Path(__file__).with_name('model.json').read_text(encoding='utf-8'))
HELPER = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'seedance-hm/add-zhubo-september.py'))
SOURCE = 'ft-video-v1-bdf45387433ac0a9042ebab3fae0299d'
ADAPTER = 'http://jijiu-video-adapter:3014'


def plan(before, key, timestamp):
    one = HELPER['one']
    model_id, sale = SPEC['model'], SPEC['saleCny']
    assert before['currency'].get('default_currency') == 'CNY', 'Requires CNY accounting'
    assert not any(row['model_id'] == model_id for row in before['models']), 'Model already exists'
    assert not any(row['base_url'].rstrip('/') in (SPEC['origin'], ADAPTER) for row in before['channels']), 'Channel already exists'
    source = one(before['models'], lambda row: row['model_id'] == SOURCE, 'Backup model missing')
    source_rule = one(before['billing_rules'], lambda row: row['id'] == source['billing_rule_id'], 'Billing template missing')
    source_channel = one(before['channels'], lambda row: row['base_url'].rstrip('/') == 'https://video.zhubo.asia', 'Channel template missing')
    assert source_rule['billing_type'] == 'requests' and source_rule['billing_rule'] == 'fixed'
    assert source_channel['rate'] == 1
    for table, field in [('model_providers', 'provider_id'), ('model_api_providers', 'api_provider_id')]:
        assert one(before[table], lambda row: row['id'] == source[field], 'Group missing')['is_active'] == 1
    forward_ids = json.loads(source['forward_rule_ids'])
    assert forward_ids, 'Forward rule missing'
    for fid in forward_ids:
        rule = one(before['forward_rules'], lambda row: row['id'] == fid, 'Forward rule missing')
        cfg = json.loads(rule['config_json'])
        assert rule['is_active'] == 1 and cfg['mode'] == 'passthrough' and cfg['auth_type'] == 'bearer'
        assert cfg['path_rewrite']['new'] == '/v1/videos' and cfg['poll_path'] == '/v1/videos/${task_id}'
    next_id = lambda table: max(row['id'] for row in before[table]) + 1
    billing = copy.deepcopy(source_rule)
    billing.update(id=next_id('billing_rules'), pid='', name=SPEC['label'] + ' CNY 11/request',
                   billing_type='requests', billing_rule='fixed', fixed_rate=sale, duration_rate=0,
                   prompt_rate=0, completion_rate=0, cached_rate=0, claude_cache_creation_rate=0,
                   claude_cache_read_rate=0, pricing_type='custom', pricing_tiers='[]', is_system=0, is_active=1,
                   extended_config=json.dumps({'supported_models': [model_id], 'enable_time_multipliers': False,
                                               'time_multipliers': []}), created_at=timestamp, updated_at=timestamp)
    model = copy.deepcopy(source)
    model.update(id=next_id('models'), mid=str(max(int(row['mid']) for row in before['models'] if str(row['mid']).isdigit()) + 1),
                 model_id=model_id, original_id=model_id, model_id_alias='', name=SPEC['label'], billing_rule_id=billing['id'],
                 pre_deduction=sale, is_active=1, is_system=0, site_discount=1, global_discount=1,
                 site_discount_enabled=0, global_discount_enabled=0, group_ratios='{}',
                 sort_order=max(int(row.get('sort_order', 0)) for row in before['models']) + 1,
                 description='720p; 4-30 seconds; 30 images / 10 videos / 10 audios; CNY 11/request',
                 remark='Jijiu route 3; 2026-10-12; user-specified CNY 11/request on art and cart',
                 feature_attributes=json.dumps(['文生视频', '图生视频', '多模态参考生视频'], ensure_ascii=False),
                 created_at=timestamp, updated_at=timestamp)
    channel = copy.deepcopy(source_channel)
    channel.update(id=next_id('channels'), name='极九 Seedance 2.5 满参线路三', base_url=ADAPTER, api_key=key,
                   models=json.dumps([model['mid']]), model_mapping=json.dumps({model_id: model_id}, ensure_ascii=False),
                   config='{}', preset_id=None, status=1, balance=None, rate=1, priority=0, weight=1,
                   created_at=timestamp, updated_at=timestamp)
    for field in channel:
        if field.endswith('_used'):
            channel[field] = 0
    after = copy.deepcopy(before)
    for table, row in [('billing_rules', billing), ('models', model), ('channels', channel)]:
        after[table].append(row)
    return after, {'model': model_id, 'upstreamModel': SPEC['upstreamModel'], 'modelId': model['id'], 'mid': model['mid'],
                   'channelId': channel['id'], 'billingRuleId': billing['id'], 'saleCny': sale, 'unit': 'request', 'preDeduction': sale}


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


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('site', choices=['art', 'cart'])
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    key = json.load(sys.stdin)['apiKey']
    assert isinstance(key, str) and key.startswith('sk-') and len(key) > 20
    try:
        request = urllib.request.Request(SPEC['origin'] + '/v1/models', headers={'Authorization': 'Bearer '+key})
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
            available = json.loads(response.read(1024 * 1024))['data']
        HELPER['one'](available, lambda row: row['id'] == SPEC['upstreamModel'], 'Model missing upstream')
    except Exception:
        raise RuntimeError('Upstream model discovery failed; no relay changes applied') from None
    health = subprocess.check_output(['docker', 'exec', 'jijiu-video-adapter', 'python', '-B', '-c',
        "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:3014/health',timeout=5).read().decode())"], text=True)
    assert json.loads(health)['ok'] is True, 'Adapter is not ready'
    container = 'tokensbyte-postgres' if args.site == 'art' else 'tkeapi-postgres'
    command = ['docker', 'exec', '-i', container, 'psql', '-X', '-qAt', '-U', 'tokensapi', '-d', 'tokensapi', '-v', 'ON_ERROR_STOP=1']

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
        backup = Path('/root/flow-canvas-operations') / ('jijiu-route3-'+args.site+'-'+dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
        backup.mkdir(mode=0o700, parents=True)
        (backup/'before.json').write_text(json.dumps(before), encoding='utf-8')
        sql = migration(before, after, apply=True)
        (backup/'migration.sql').write_text(sql, encoding='utf-8')
        query(sql)
        HELPER['verify'](after, json.loads(query(HELPER['snapshot_sql']())))
        receipt.update(applied=True, verified=True, backup=str(backup))
        (backup/'receipt.json').write_text(json.dumps(receipt), encoding='utf-8')
    print(json.dumps(receipt, ensure_ascii=False))


if __name__ == '__main__':
    main()
