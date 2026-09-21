"""Preserve seller receipts as sales commission changes from 20% to 30%."""
import argparse
import copy
import datetime
from decimal import Decimal, ROUND_CEILING
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

PRO = 'seedance-2.5-pro'
TARGETS = {PRO, 'sd2.5', 'sd2.5-route1', 'seedance_v2.5', 'seedance_v2.0-933',
           'seedance_v2.5-101010', 'seedance_v2.5-301010', 'minimax-h3',
           'artsdance2-0-fast-intl-260701', 'artsdance2-0-mini-intl-260701', 'artsdance2-0-pro-intl-260701'}
MARKER = 'cart commission 20-to-30 2026-09-21'
RATE_FIELDS = ['prompt_rate', 'completion_rate', 'cached_rate', 'fixed_rate', 'duration_rate',
               'claude_cache_read_rate', 'claude_cache_creation_rate']


def adjusted(value, places=2):
    return float((Decimal(str(value)) * Decimal(8) / Decimal(7)).quantize(Decimal(10) ** -places, rounding=ROUND_CEILING))


def replace_price_text(value, price):
    if value is None:
        return None
    value = re.sub(r'(?<![\d.])\d+(?:\.\d+)?(?=\s*元/(?:条|次|秒))', f'{price:.2f}', value)
    return re.sub(r'(?<=CNY )\d+(?:\.\d+)?(?=/(?:request|second|次|秒))', f'{price:.2f}', value)


def make_plan(before, seconds_places=2):
    after = copy.deepcopy(before)
    models = [m for m in after['models'] if m['model_id'] in TARGETS]
    assert len(models) == len(TARGETS) and {m['model_id'] for m in models} == TARGETS
    assert not any(MARKER in (m['remark'] or '') for m in models), 'This pricing migration was already applied'
    rule_ids = {m['billing_rule_id'] for m in models}
    assert not any(m['model_id'] not in TARGETS and m['billing_rule_id'] in rule_ids for m in after['models']), 'A rule is shared with an out-of-scope model'
    rules = {r['id']: r for r in after['billing_rules']}
    pro_rule_id = next(m['billing_rule_id'] for m in models if m['model_id'] == PRO)
    report = []
    for rule_id in sorted(rule_ids):
        rule = rules[rule_id]
        assert rule['is_system'] == 0 and rule['is_active'] == 1
        tiers = json.loads(rule['pricing_tiers'])
        config = json.loads(rule['extended_config'])
        assert not config.get('enable_time_multipliers')
        entry = {'ruleId': rule_id, 'models': [m['model_id'] for m in models if m['billing_rule_id'] == rule_id], 'rates': []}
        if rule_id == pro_rule_id:
            assert rule['billing_type'] == 'duration' and rule['billing_rule'] == 'video_resolution'
            assert {tier['resolution'] for tier in tiers} == {'480p', '720p'}
            entry['rates'].append({'field': 'duration_rate', 'old': rule['duration_rate'], 'new': 1.25})
            rule['duration_rate'] = 1.25
            for tier in tiers:
                entry['rates'].append({'field': tier['resolution'], 'old': tier['rate'], 'new': 1.25})
                tier['rate'] = 1.25
            rule['name'] = replace_price_text(rule['name'], 1.25)
        else:
            def update(container, key, label, places=2):
                old = container[key]
                assert isinstance(old, (int, float)) and not isinstance(old, bool) and old >= 0
                new = adjusted(old, places)
                assert Decimal(str(new)) * Decimal('0.7') >= Decimal(str(old)) * Decimal('0.8')
                container[key] = new
                if old:
                    entry['rates'].append({'field': label, 'old': old, 'new': new})

            for key in RATE_FIELDS:
                update(rule, key, key, seconds_places if rule['billing_type'] == 'duration' else 2)
            for tier in tiers:
                update(tier, 'rate', tier['resolution'], seconds_places)
                if 'cached_rate' in tier:
                    update(tier, 'cached_rate', tier['resolution'] + '.cached', seconds_places)
            for resolution, values in config.get('resolution_rates', {}).items():
                assert set(values) <= {'with_video', 'without_video'}
                for key in values:
                    update(values, key, resolution + '.' + key)
            assert entry['rates'], 'No prices found for target rule'
            if rule['billing_type'] == 'requests':
                rule['name'] = replace_price_text(rule['name'], rule['fixed_rate'])
        rule['pricing_tiers'] = json.dumps(tiers, ensure_ascii=False)
        rule['extended_config'] = json.dumps(config, ensure_ascii=False)
        report.append(entry)
    for model in models:
        is_pro = model['model_id'] == PRO
        rule = rules[model['billing_rule_id']]
        model['pre_deduction'] = 37.5 if is_pro else adjusted(model['pre_deduction'])
        if is_pro or rule['billing_type'] == 'requests':
            price = 1.25 if is_pro else rule['fixed_rate']
            model['description'] = replace_price_text(model['description'], price)
            model['remark'] = replace_price_text(model['remark'], price)
        model['remark'] = ((model['remark'] or '').rstrip() + '; ' + MARKER).lstrip('; ')
    return after, report


def sql_literal(value):
    return "'" + json.dumps(value, ensure_ascii=False).replace("'", "''") + "'::jsonb"


def sql_patch(before, after):
    statements = ['BEGIN;', "SET LOCAL lock_timeout='5s';", 'LOCK TABLE models,billing_rules IN SHARE ROW EXCLUSIVE MODE;']
    for table in ['billing_rules', 'models']:
        prior = {row['id']: row for row in before[table]}
        for row in after[table]:
            old = prior[row['id']]
            fields = [key for key in row if row[key] != old[key] and key != 'updated_at']
            if not fields:
                continue
            statements.append(f"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM {table} t WHERE id={row['id']} AND to_jsonb(t)={sql_literal(old)}) THEN RAISE EXCEPTION 'Concurrent pricing change in {table} ID {row['id']}'; END IF; END $$;")
            assignments = ','.join(f'{key}=next.{key}' for key in fields)
            statements.append(f"UPDATE {table} t SET {assignments},updated_at=now() FROM jsonb_populate_record(NULL::{table},{sql_literal(row)}) next WHERE t.id=next.id;")
    return '\n'.join(statements)


def verify(expected, actual):
    for table in expected:
        assert len(expected[table]) == len(actual[table]), table
        latest = {r['id']: r for r in actual[table]}
        for row in expected[table]:
            current = latest[row['id']]
            assert {k: v for k, v in row.items() if k != 'updated_at'} == {k: v for k, v in current.items() if k != 'updated_at'}, f'Unexpected {table} change: {row["id"]}'


def main():
    args = argparse.ArgumentParser()
    args.add_argument('--apply', action='store_true')
    args.add_argument('--seconds-places', type=int, choices=[2, 6], default=2)
    parsed = args.parse_args()
    os.umask(0o077)
    container = json.loads(subprocess.check_output(['docker', 'inspect', 'tkeapi-postgres'], text=True))[0]
    env = dict(item.split('=', 1) for item in container['Config']['Env'] if '=' in item)
    user = env.get('POSTGRES_USER', 'postgres')
    db = env.get('POSTGRES_DB', user)
    psql = ['docker', 'exec', '-i', 'tkeapi-postgres', 'psql', '-X', '-U', user, '-d', db, '-At', '-v', 'ON_ERROR_STOP=1']

    def query(sql):
        result = subprocess.run(psql, input=sql, text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError(result.stderr.strip())
        return result.stdout.strip()

    snapshot_sql = "SELECT jsonb_build_object('models',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM models t),'billing_rules',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM billing_rules t));"
    def snapshot():
        return json.loads(query(snapshot_sql))

    def stable_state():
        return {table: query(f"SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM {table} t;")
                for table in ['channels', 'channel_configs', 'forward_rules', 'settings', 'model_providers', 'model_api_providers', 'channel_categories', 'plugins', 'plugin_configs']}

    currency = query("SELECT coalesce((SELECT value::jsonb->>'default_currency' FROM settings WHERE key='currency_settings'),'CNY');")
    assert currency == 'CNY', 'This script only applies to the new CNY site'
    before = snapshot()
    guards = stable_state()
    after, report = make_plan(before, parsed.seconds_places)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = Path('/root/tkeapi-backups') / ('commission-pricing-' + stamp)
    backup.mkdir(mode=0o700)
    with (backup / 'before.dump').open('wb') as output:
        subprocess.run(['docker', 'exec', 'tkeapi-postgres', 'pg_dump', '-U', user, '-d', db, '-Fc'], stdout=output, check=True)
    (backup / 'before.json').write_text(json.dumps(before, ensure_ascii=False), encoding='utf-8')
    migration = sql_patch(before, after)
    (backup / 'migration.sql').write_text(migration + '\nCOMMIT;\n', encoding='utf-8')
    preview = query(migration + '\n' + snapshot_sql + '\nROLLBACK;')
    verify(after, json.loads(next(line for line in preview.splitlines() if line.startswith('{'))))
    assert snapshot() == before and stable_state() == guards
    fingerprint = hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest()
    result = {'previewPassed': True, 'backup': str(backup), 'baseline': fingerprint, 'secondsPlaces': parsed.seconds_places, 'rates': report}
    (backup / 'plan.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False), flush=True)
    if parsed.apply:
        query(migration + '\nCOMMIT;')
        actual = snapshot()
        verify(after, actual)
        assert stable_state() == guards
        (backup / 'after.json').write_text(json.dumps(actual, ensure_ascii=False), encoding='utf-8')
        (backup / 'restore.sql').write_text(sql_patch(actual, before) + '\nCOMMIT;\n', encoding='utf-8')
        (backup / 'verification.json').write_text(json.dumps({'verified': True, 'rates': report}, ensure_ascii=False), encoding='utf-8')
        print(json.dumps({'applied': True, 'verified': True, 'backup': str(backup), 'rulesUpdated': len(report), 'modelsUpdated': len(TARGETS)}))


if __name__ == '__main__':
    main()
