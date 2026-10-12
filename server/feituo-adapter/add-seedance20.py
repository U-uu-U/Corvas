"""Reuse the existing Feituo account; restore 933 and append the long-term route."""
import argparse
import copy
import datetime as dt
from decimal import Decimal
import json
import os
from pathlib import Path
import runpy
import subprocess

from adapter import MODELS, request_json

ADAPTER = 'http://feituo-adapter:3012'
EXISTING = 'ft-video-v1-b92bdf13b031fea6d7e80431def22584'
NEW = 'ft-video-v1-a4e45199f67ed84790ec03dfc2768a01'
HELPER = runpy.run_path(str(Path(__file__).resolve().parents[1]/'seedance-hm/add-zhubo-september.py'))


def plan(before, timestamp):
    one = HELPER['one']
    assert before['currency']['default_currency'] == 'CNY'
    assert not any(row['model_id'] == NEW for row in before['models']), 'New model already exists'
    channel = one(before['channels'], lambda row: row['base_url'].rstrip('/') == ADAPTER, 'Existing Feituo channel missing')
    assert channel['status'] == 1 and channel['rate'] == 1
    source = one(before['models'], lambda row: row['model_id'] == EXISTING, 'Existing 933 model missing')
    rule = one(before['billing_rules'], lambda row: row['id'] == source['billing_rule_id'], '933 billing rule missing')
    assert rule['billing_type'] == 'requests' and rule['billing_rule'] == 'fixed'
    assert rule['fixed_rate'] == source['pre_deduction'] == 3.6, 'Existing 933 price differs'
    members = HELPER['decode_json'](channel['models'], list)
    mapping = HELPER['decode_json'](channel['model_mapping'], dict)
    assert source['mid'] in members and mapping[EXISTING] == EXISTING and NEW not in mapping
    for fid in json.loads(source['forward_rule_ids']):
        forward = one(before['forward_rules'], lambda row: row['id'] == fid, 'Forward rule missing')
        cfg = json.loads(forward['config_json'])
        assert forward['is_active'] == 1 and cfg['mode'] == 'passthrough'
        assert cfg['path_rewrite']['new'] == '/v1/videos' and cfg['poll_path'] == '/v1/videos/${task_id}'
    after = copy.deepcopy(before)
    one(after['models'], lambda row: row['id'] == source['id'], '933 model missing')['is_active'] = 1
    one(after['billing_rules'], lambda row: row['id'] == rule['id'], '933 rule missing')['is_active'] = 1
    spec = MODELS[NEW]
    sale = float(Decimal(str(spec['costCny']))*3)
    next_id = lambda table: max(row['id'] for row in before[table])+1
    billing = copy.deepcopy(rule)
    billing.update(id=next_id('billing_rules'), pid='', name=spec['label']+' CNY 7.50/request',
                   fixed_rate=sale, duration_rate=0, prompt_rate=0, completion_rate=0, cached_rate=0,
                   claude_cache_creation_rate=0, claude_cache_read_rate=0, pricing_tiers='[]', pricing_type='custom',
                   is_active=1, is_system=0, extended_config=json.dumps({'supported_models': [NEW],
                   'enable_time_multipliers': False, 'time_multipliers': []}), created_at=timestamp, updated_at=timestamp)
    model = copy.deepcopy(source)
    model.update(id=next_id('models'), mid=str(max(int(row['mid']) for row in before['models'] if str(row['mid']).isdigit())+1),
                 model_id=NEW, original_id=NEW, model_id_alias='', name=spec['label'], billing_rule_id=billing['id'],
                 pre_deduction=sale, is_active=1, is_system=0, site_discount=1, global_discount=1,
                 site_discount_enabled=0, global_discount_enabled=0, group_ratios='{}',
                 sort_order=max(int(row.get('sort_order', 0)) for row in before['models'])+1,
                 description='720p; 5/10/15 seconds; 9 images / 3 videos / 3 audios; CNY 7.50/request',
                 remark='Feituo Seedance 2.0 long-term 2026-10-12; user-specified cost x3',
                 created_at=timestamp, updated_at=timestamp)
    after['models'].append(model)
    after['billing_rules'].append(billing)
    members.append(model['mid'])
    mapping[NEW] = NEW
    target = one(after['channels'], lambda row: row['id'] == channel['id'], 'Channel missing')
    target.update(models=json.dumps(members), model_mapping=json.dumps(mapping), updated_at=timestamp)
    receipt = {'channelId': channel['id'], 'existingModelId': source['id'], 'existingRuleId': rule['id'],
               'existingSaleCny': 3.6, 'model': NEW, 'modelId': model['id'], 'mid': model['mid'],
               'billingRuleId': billing['id'], 'saleCny': sale, 'unit': 'request', 'preDeduction': sale}
    return after, receipt


def migration(before, after, receipt, apply=False):
    literal = HELPER['literal']
    sql = ['BEGIN;', "SET LOCAL lock_timeout='5s';", "SET LOCAL statement_timeout='25s';",
           'LOCK TABLE '+','.join((*HELPER['TABLES'], 'settings'))+' IN SHARE ROW EXCLUSIVE MODE;']
    sql.extend(HELPER['guard_catalog'](before))
    sql.append(f"UPDATE models SET is_active=1 WHERE id={receipt['existingModelId']};")
    sql.append(f"UPDATE billing_rules SET is_active=1 WHERE id={receipt['existingRuleId']};")
    for table in ('billing_rules', 'models'):
        row = after[table][-1]
        sql.append(f"INSERT INTO {table} SELECT * FROM jsonb_populate_record(NULL::{table},{literal(json.dumps(row))}::jsonb);")
    channel = HELPER['one'](after['channels'], lambda row: row['id'] == receipt['channelId'], 'Channel missing')
    sql.append(f"UPDATE channels SET models={literal(channel['models'])},model_mapping={literal(channel['model_mapping'])},updated_at=now() WHERE id={channel['id']};")
    sql.extend(HELPER['guard_catalog'](after))
    if apply:
        for table in ('models', 'billing_rules'):
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
    container = 'tokensbyte-postgres' if args.site == 'art' else 'tkeapi-postgres'
    command = ['docker', 'exec', '-i', container, 'psql', '-X', '-qAt', '-U', 'tokensapi', '-d', 'tokensapi', '-v', 'ON_ERROR_STOP=1']

    def query(sql):
        result = subprocess.run(command, input=sql, text=True, capture_output=True, timeout=45)
        if result.returncode:
            raise RuntimeError('Database operation failed; private SQL withheld')
        return result.stdout.strip()

    before = json.loads(query(HELPER['snapshot_sql']()))
    channel = HELPER['one'](before['channels'], lambda row: row['base_url'].rstrip('/') == ADAPTER, 'Channel missing')
    available = request_json('/models', 'Bearer '+channel['api_key'])['data']
    for model_id in (EXISTING, NEW):
        spec = MODELS[model_id]
        actual = HELPER['one'](available, lambda row: row['id'] == model_id, 'Upstream model missing')
        assert actual['status'] == 'available'
        assert actual['price'] == {'currency': 'CNY', 'amount': spec['costCny'], 'unit': 'request'}
        assert actual['resolution_durations']['720p'] == spec.get('durations', list(range(spec['minSeconds'], spec['maxSeconds']+1)))
        assert set(actual['aspect_ratios']) == set(spec['ratios'])
        assert [actual['max_'+media+'_refs'] for media in ('image', 'video', 'audio')] == [9, 3, 3]
        assert actual.get('prompt_max_chars') == spec['promptMaxChars']
        assert actual.get('min_image_refs', 0) == 0 and not actual.get('audio_requires_image')
    after, receipt = plan(before, dt.datetime.now(dt.timezone.utc).isoformat())
    HELPER['verify'](after, json.loads(query(migration(before, after, receipt))))
    HELPER['verify'](before, json.loads(query(HELPER['snapshot_sql']())))
    receipt.update(site=args.site, previewPassed=True, applied=False)
    if args.apply:
        backup = Path('/root/flow-canvas-operations')/('feituo20-'+args.site+'-'+dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
        backup.mkdir(parents=True, mode=0o700)
        (backup/'before.json').write_text(json.dumps(before), encoding='utf-8')
        sql = migration(before, after, receipt, True)
        (backup/'migration.sql').write_text(sql, encoding='utf-8')
        query(sql)
        HELPER['verify'](after, json.loads(query(HELPER['snapshot_sql']())))
        receipt.update(applied=True, verified=True, backup=str(backup))
        (backup/'receipt.json').write_text(json.dumps(receipt), encoding='utf-8')
    print(json.dumps(receipt, ensure_ascii=False))


if __name__ == '__main__':
    main()
