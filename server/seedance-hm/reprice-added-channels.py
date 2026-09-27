"""Apply the 20%-to-30% commission rule to the seven later-added routes.

art changes only dola to CNY 5/request. cart uses the explicitly approved old
site prices times 8/7, rounded up to cents. Run --apply only after reviewing the
dry-run report. No channel, credential, discount, or commission settings change.
"""
import argparse
import copy
import datetime as dt
from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP
import json
import os
from pathlib import Path
import runpy
import subprocess

helpers = runpy.run_path(str(Path(__file__).with_name('reprice-cart.py')))
sql_patch = helpers['sql_patch']
verify = helpers['verify']
replace_price_text = helpers['replace_price_text']
OLD_CNY = {
    'sd2-fast': Decimal('4'),
    'seedance-2.5-pro': Decimal('9.8'),
    'seedance-2.5-pro-720': Decimal('13'),
    'oc-model-qbdmeb': Decimal('5'),
    'oc-model-1iq31f': Decimal('5'),
    'oc-model-bkb50q': Decimal('7'),
    'oc-model-c6ws7e': Decimal('7'),
}
MARKER = 'commission 20-to-30 added routes 2026-09-23'


def price_for(model, site):
    amount = OLD_CNY[model]
    return amount if site == 'art' else (amount * 8 / 7).quantize(Decimal('.01'), rounding=ROUND_CEILING)


def make_plan(before, site, exchange):
    assert site in {'art', 'cart'}
    exchange = Decimal(str(exchange))
    targets = {'oc-model-qbdmeb'} if site == 'art' else set(OLD_CNY)
    after = copy.deepcopy(before)
    selected = [m for m in after['models'] if m['model_id'] in targets]
    assert len(selected) == len(targets), 'Missing or duplicate target model'
    ids = {m['billing_rule_id'] for m in selected}
    assert len(ids) == len(targets), 'Target rules must not be shared'
    assert not any(m['model_id'] not in targets and m['billing_rule_id'] in ids for m in after['models']), 'Rule shared outside the requested scope'
    rules = {r['id']: r for r in after['billing_rules']}
    report = []
    for model in selected:
        name = model['model_id']
        rule = rules[model['billing_rule_id']]
        assert rule['is_system'] == 0 and rule['is_active'] == 1
        assert not model['site_discount_enabled'] and not model['global_discount_enabled']
        assert json.loads(model['group_ratios'] or '{}') == {}
        config = json.loads(rule['extended_config'] or '{}')
        assert not config.get('enable_time_multipliers')
        assert not config.get('resolution_rates'), 'Unexpected token billing'
        duration = name == 'oc-model-1iq31f'
        assert rule['billing_type'] == ('duration' if duration else 'requests')
        assert rule['billing_rule'] == ('video_resolution' if duration else 'fixed')
        field = 'duration_rate' if duration else 'fixed_rate'
        old_rate = Decimal(str(rule[field]))
        current_cny = (old_rate * exchange).quantize(Decimal('.000001'), rounding=ROUND_HALF_UP)
        target_cny = price_for(name, site)
        prior_cny = Decimal('4') if name == 'oc-model-qbdmeb' else OLD_CNY[name]
        assert current_cny in {prior_cny, target_cny}, f'Unexpected current rate for {name}'
        desired_rate = float(target_cny / exchange)
        tiers = json.loads(rule['pricing_tiers'] or '[]')
        if duration:
            assert {t['resolution'] for t in tiers} == {'480p', '720p', '1080p'}
            assert all(t.get('enabled') and Decimal(str(t['rate'])) == old_rate and t.get('cached_rate', 0) == 0 for t in tiers)
        else:
            assert not tiers
        assert all(rule.get(k, 0) == 0 for k in ['prompt_rate', 'completion_rate', 'cached_rate', 'claude_cache_read_rate', 'claude_cache_creation_rate'])
        assert rule['fixed_rate' if duration else 'duration_rate'] == 0
        multiplier = Decimal(str(model['pre_deduction'])) / old_rate
        assert abs(multiplier - (5 if duration else 1)) < Decimal('.000001'), 'Unexpected pre-deduction contract'
        if current_cny == target_cny:
            continue
        rule[field] = desired_rate
        if duration:
            for tier in tiers:
                tier['rate'] = desired_rate
            rule['pricing_tiers'] = json.dumps(tiers, ensure_ascii=False)
        rule['name'] = replace_price_text(rule['name'], float(target_cny))
        model['pre_deduction'] = float(target_cny * (5 if duration else 1) / exchange)
        for key in ['description', 'remark']:
            model[key] = replace_price_text(model.get(key), float(target_cny))
        if site == 'cart' and MARKER not in (model.get('remark') or ''):
            model['remark'] = ((model.get('remark') or '').rstrip() + '; ' + MARKER).lstrip('; ')
        if site == 'cart':
            assert target_cny * Decimal('.7') >= OLD_CNY[name] * Decimal('.8')
        report.append({'model': name, 'unit': 'second' if duration else 'request', 'beforeCny': float(current_cny),
                       'afterCny': float(target_cny), 'ruleId': rule['id'], 'preDeduction': model['pre_deduction']})
    return after, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('site', choices=['art', 'cart'])
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    pg = 'tokensbyte-postgres' if args.site == 'art' else 'tkeapi-postgres'
    container = json.loads(subprocess.check_output(['docker', 'inspect', pg], text=True))[0]
    env = dict(v.split('=', 1) for v in container['Config']['Env'] if '=' in v)
    user = env.get('POSTGRES_USER', 'postgres'); database = env.get('POSTGRES_DB', user)
    psql = ['docker', 'exec', '-i', pg, 'psql', '-X', '-qAt', '-U', user, '-d', database, '-v', 'ON_ERROR_STOP=1']
    def query(sql):
        result = subprocess.run(psql, input=sql, text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError(result.stderr.strip())
        return result.stdout.strip()
    snapshot_sql = "SELECT jsonb_build_object('models',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM models t),'billing_rules',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM billing_rules t));"
    def snapshot():
        return json.loads(query(snapshot_sql))
    def guards():
        return {table: query(f"SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM {table} t;")
                for table in ['channels', 'channel_configs', 'forward_rules', 'settings', 'model_providers', 'model_api_providers', 'channel_categories', 'plugins', 'plugin_configs']}
    currency = json.loads(query("SELECT value::jsonb FROM settings WHERE key='currency_settings';") or '{}')
    if args.site == 'art':
        assert currency['default_currency'] == 'USD'
        exchange = next(c['exchange_rate'] for c in currency['auxiliary_currencies'] if c['code'] == 'CNY' and c['enabled'])
    else:
        assert currency.get('default_currency', 'CNY') == 'CNY'
        exchange = 1
    before = snapshot(); protected = guards()
    after, report = make_plan(before, args.site, exchange)
    if not report:
        print(json.dumps({'site': args.site, 'alreadyApplied': True, 'changed': 0})); return
    root = '/opt/tokensbyte-backups' if args.site == 'art' else '/root/tkeapi-backups'
    backup = Path(root) / ('added-channel-pricing-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(mode=0o700)
    (backup / 'before.json').write_text(json.dumps(before, ensure_ascii=False), encoding='utf-8')
    migration = sql_patch(before, after)
    (backup / 'migration.sql').write_text(migration + '\nCOMMIT;\n', encoding='utf-8')
    preview = query(migration + '\n' + snapshot_sql + '\nROLLBACK;')
    verify(after, json.loads(next(line for line in preview.splitlines() if line.startswith('{'))))
    assert snapshot() == before and guards() == protected
    result = {'site': args.site, 'previewPassed': True, 'backup': str(backup), 'prices': report}
    (backup / 'plan.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    if args.apply:
        with (backup / 'before.dump').open('wb') as output:
            subprocess.run(['docker', 'exec', pg, 'pg_dump', '-U', user, '-d', database, '-Fc'], stdout=output, check=True)
        query(migration + '\nCOMMIT;')
        actual = snapshot(); verify(after, actual); assert guards() == protected
        (backup / 'after.json').write_text(json.dumps(actual, ensure_ascii=False), encoding='utf-8')
        (backup / 'restore.sql').write_text(sql_patch(actual, before) + '\nCOMMIT;\n', encoding='utf-8')
        result.update(applied=True, verified=True)
        (backup / 'verification.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
