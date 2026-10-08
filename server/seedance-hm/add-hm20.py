"""Add HM Fast 813/Mini 503 and reprice existing 933; default to transaction preview."""
import argparse
import copy
import datetime as dt
from decimal import Decimal, ROUND_CEILING
import json
import os
from pathlib import Path
import runpy
import subprocess
import urllib.request

HELPER = runpy.run_path(str(Path(__file__).with_name('add-zhubo-september.py')))
TABLES = HELPER['TABLES']
SOURCE = 'seedance_v2.0-933'
UPSTREAM = 'https://video.zhubo.asia'
TARGETS = [
    {'model': 'SD2.0FAST813', 'upstream': 'HM-Seedance V2.0 Fast 813', 'label': 'HM-Seedance 2.0 Fast 813',
     'costs': {'720p': '1.30', '1080p': '1.50', '2k': '1.70'}, 'references': [8, 1, 3]},
    {'model': 'SD2.0MINI503', 'upstream': 'HM-Seedance V2.0 Mini 503', 'label': 'HM-Seedance 2.0 Mini 503',
     'costs': {'720p': '0.90'}, 'references': [5, 0, 3]},
    {'model': SOURCE, 'upstream': 'HM-Seedance V2.0 933', 'label': 'HM-Seedance 2.0 933',
     'costs': {'720p': '1.00'}, 'references': [9, 3, 3]}
]


def prices(spec, site):
    result = {}
    for resolution, value in spec['costs'].items():
        price = Decimal(value) * 3
        if site == 'cart':
            price = (price * 8 / 7).quantize(Decimal('.01'), rounding=ROUND_CEILING)
        result[resolution] = float(price)
    return result


def plan(before, site, timestamp):
    one = HELPER['one']
    assert before['currency'].get('default_currency') == 'CNY'
    source = one(before['models'], lambda row: row['model_id'] == SOURCE, 'Existing 933 missing')
    source_rule = one(before['billing_rules'], lambda row: row['id'] == source['billing_rule_id'], '933 billing missing')
    assert sum(row['billing_rule_id'] == source_rule['id'] for row in before['models']) == 1, '933 shares billing'
    channel = one(before['channels'], lambda row: row['base_url'].rstrip('/') == UPSTREAM, 'HM channel missing')
    assert source['is_active'] == source_rule['is_active'] == channel['status'] == 1
    assert source_rule['billing_type'] == 'requests' and source_rule['billing_rule'] == 'fixed'
    assert channel['rate'] == 1
    assert not source['site_discount_enabled'] and not source['global_discount_enabled']
    assert json.loads(source['group_ratios']) == {}
    for fid in json.loads(source['forward_rule_ids']):
        forward = one(before['forward_rules'], lambda row: row['id'] == fid, 'Missing forward rule')
        cfg = json.loads(forward['config_json'])
        assert forward['is_active'] == 1 and cfg['mode'] == 'passthrough'
        assert cfg['path_rewrite']['new'] == '/v1/videos' and cfg['poll_path'] == '/v1/videos/${task_id}'
    after = copy.deepcopy(before)
    members = HELPER['decode_json'](channel['models'], list)
    mapping = HELPER['decode_json'](channel['model_mapping'], dict)
    assert source['mid'] in members
    next_model = max(row['id'] for row in before['models']) + 1
    next_rule = max(row['id'] for row in before['billing_rules']) + 1
    next_mid = max(int(row['mid']) for row in before['models'] if str(row['mid']).isdigit()) + 1
    report = []
    for index, spec in enumerate(TARGETS):
        public_id = spec['model']
        existing = public_id == SOURCE
        sale = prices(spec, site)
        base_price = sale['720p']
        if existing:
            model = one(after['models'], lambda row: row['model_id'] == SOURCE, '933 not unique')
            rule = one(after['billing_rules'], lambda row: row['id'] == source_rule['id'], '933 billing not unique')
        else:
            assert not any(row['model_id'] == public_id for row in before['models']), 'Target already exists'
            assert public_id not in mapping
            model = copy.deepcopy(source)
            rule = copy.deepcopy(source_rule)
            model.update(id=next_model + index, mid=str(next_mid + index), model_id=public_id,
                         model_id_alias='', created_at=timestamp)
            rule.update(id=next_rule + index, pid='', created_at=timestamp)
            after['models'].append(model)
            after['billing_rules'].append(rule)
            members.append(model['mid'])
        tiers = [{'resolution': resolution, 'rate': value, 'enabled': True, 'cached_rate': 0}
                 for resolution, value in sale.items()] if len(sale) > 1 else []
        if tiers:
            # The existing per-request resolution calculator uses 1k when resolution is omitted.
            tiers.append({'resolution': '1k', 'rate': base_price, 'enabled': True, 'cached_rate': 0})
        rule.update(name=f"{spec['label']} CNY per request", billing_type='requests',
                    billing_rule='image_resolution' if tiers else 'fixed', fixed_rate=base_price,
                    duration_rate=0, prompt_rate=0, completion_rate=0, cached_rate=0,
                    claude_cache_creation_rate=0, claude_cache_read_rate=0, pricing_type='custom',
                    pricing_tiers=json.dumps(tiers),
                    extended_config=json.dumps({'supported_models': [public_id], 'enable_time_multipliers': False,
                                                'time_multipliers': []}), updated_at=timestamp)
        ref = '/'.join(map(str, spec['references']))
        model.update(name=spec['label'], original_id=spec['upstream'], billing_rule_id=rule['id'],
                     pre_deduction=base_price, is_active=1,
                     description=f"4-15s; {','.join(sale)}; references {ref}; CNY per request {json.dumps(sale)}",
                     remark='HM 2.0 2026-10-07; art upstream x3; cart art x8/7 ceil 2 decimals; per request',
                     updated_at=timestamp)
        mapping[public_id] = spec['upstream']
        report.append({'model': public_id, 'upstreamModel': spec['upstream'], 'modelId': model['id'],
                       'mid': model['mid'], 'billingRuleId': rule['id'], 'prices': sale,
                       'unit': 'request', 'existing': existing, 'preDeduction': base_price})
    updated = one(after['channels'], lambda row: row['id'] == channel['id'], 'Channel missing')
    updated.update(models=json.dumps(members), model_mapping=json.dumps(mapping), updated_at=timestamp)
    return after, report, channel['id']


def migration(before, after, apply=False):
    literal = HELPER['literal']
    statements = ['BEGIN;', "SET LOCAL lock_timeout='5s';", "SET LOCAL statement_timeout='25s';",
                  'LOCK TABLE ' + ','.join((*TABLES, 'settings')) + ' IN SHARE ROW EXCLUSIVE MODE;']
    statements.extend(HELPER['guard_catalog'](before))
    for table in ['billing_rules', 'models', 'channels']:
        old = {row['id']: row for row in before[table]}
        for row in after[table]:
            if row['id'] not in old:
                statements.append(f'INSERT INTO {table} SELECT * FROM jsonb_populate_record(NULL::{table},{literal(json.dumps(row))}::jsonb);')
            else:
                fields = [field for field in row if row[field] != old[row['id']][field]]
                if fields:
                    columns = ','.join(fields)
                    statements.append(f'UPDATE {table} SET ({columns})=(SELECT {columns} FROM jsonb_populate_record(NULL::{table},{literal(json.dumps(row))}::jsonb)) WHERE id={row["id"]};')
    statements.extend(HELPER['guard_catalog'](after))
    if apply:
        for table in ['models', 'billing_rules']:
            statements.append(f"SELECT setval(pg_get_serial_sequence('{table}','id'),greatest((SELECT max(id) FROM {table}),nextval(pg_get_serial_sequence('{table}','id'))));")
        statements.append('COMMIT;')
    else:
        statements.extend([HELPER['snapshot_sql'](), 'ROLLBACK;'])
    return '\n'.join(statements)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('site', choices=['art', 'cart'])
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    container = 'tokensbyte-postgres' if args.site == 'art' else 'tkeapi-postgres'
    info = json.loads(subprocess.check_output(['docker', 'inspect', container], text=True))[0]
    env = dict(value.split('=', 1) for value in info['Config']['Env'] if '=' in value)
    user = env.get('POSTGRES_USER', 'postgres')
    database = env.get('POSTGRES_DB', user)
    command = ['docker', 'exec', '-i', container, 'psql', '-X', '-qAt', '-U', user, '-d', database, '-v', 'ON_ERROR_STOP=1']

    def query(sql):
        result = subprocess.run(command, input=sql, text=True, capture_output=True, timeout=45)
        if result.returncode:
            raise RuntimeError('HM database operation failed; private details withheld')
        return result.stdout.strip()

    before = json.loads(query(HELPER['snapshot_sql']()))
    channel = HELPER['one'](before['channels'], lambda row: row['base_url'].rstrip('/') == UPSTREAM, 'HM channel missing')

    def fetch(route):
        request = urllib.request.Request(UPSTREAM + route, headers={'Authorization': 'Bearer ' + channel['api_key']})
        with urllib.request.urlopen(request, timeout=25) as response:
            return json.load(response)

    live = {row['id'] for row in fetch('/v1/models')['data']}
    quotes = fetch('/v1/pricing')['data']
    for spec in TARGETS:
        assert spec['upstream'] in live, 'Upstream model missing'
        quote = HELPER['one'](quotes, lambda row: row.get('canonical_id') == spec['model']
                             and row.get('model') == spec['upstream'], 'Upstream mapping not confirmed')
        assert quote['currency'] == 'CNY' and quote['billing_type'] == 'per_call'
        actual = quote['resolution_prices'] or {'720p': quote['unit_price']}
        assert {k: Decimal(str(v)) for k, v in actual.items()} == {k: Decimal(v) for k, v in spec['costs'].items()}, 'Upstream price changed'
    after, report, channel_id = plan(before, args.site, dt.datetime.now(dt.timezone.utc).isoformat())
    HELPER['verify'](after, json.loads(query(migration(before, after))))
    HELPER['verify'](before, json.loads(query(HELPER['snapshot_sql']())))
    receipt = {'site': args.site, 'previewPassed': True, 'applied': False, 'channelId': channel_id, 'models': report}
    if args.apply:
        backup = Path('/root/flow-canvas-operations') / ('hm20-' + args.site + '-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
        backup.mkdir(mode=0o700, parents=True)
        (backup / 'before.json').write_text(json.dumps(before), encoding='utf-8')
        sql = migration(before, after, apply=True)
        (backup / 'migration.sql').write_text(sql, encoding='utf-8')
        query(sql)
        actual = json.loads(query(HELPER['snapshot_sql']()))
        HELPER['verify'](after, actual)
        (backup / 'after.json').write_text(json.dumps(actual), encoding='utf-8')
        receipt.update(applied=True, verified=True, backup=str(backup))
        (backup / 'receipt.json').write_text(json.dumps(receipt), encoding='utf-8')
    print(json.dumps(receipt, ensure_ascii=False))


if __name__ == '__main__':
    main()
