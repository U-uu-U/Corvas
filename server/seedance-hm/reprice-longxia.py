"""Apply the confirmed LongXia price override on one CNY relay."""
import copy
import datetime as dt
from decimal import Decimal, ROUND_CEILING
import json
import os
from pathlib import Path
import subprocess
import sys


site = sys.argv[1]
assert site in {'art', 'cart'}
apply = '--apply' in sys.argv
container = 'tokensbyte-postgres' if site == 'art' else 'tkeapi-postgres'
info = json.loads(subprocess.check_output(['docker', 'inspect', container], text=True))[0]
env = dict(item.split('=', 1) for item in info['Config']['Env'] if '=' in item)
user = env.get('POSTGRES_USER', 'postgres')
database = env.get('POSTGRES_DB', user)
command = ['docker', 'exec', '-i', container, 'psql', '-X', '-qAt', '-U', user, '-d', database, '-v', 'ON_ERROR_STOP=1']
os.umask(0o077)

def query(sql):
    result = subprocess.run(command, input=sql, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError('LongXia price transaction failed before commit')
    return result.stdout.strip()

def literal(value):
    return "'" + str(value).replace("'", "''") + "'"

snapshot_sql = "SELECT jsonb_build_object('models',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM models t),'billing_rules',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM billing_rules t));"
currency_sql = "SELECT coalesce((SELECT value::jsonb->>'default_currency' FROM settings WHERE key='currency_settings'),'CNY');"
assert query(currency_sql) == 'CNY', 'This adjustment requires CNY accounting'
before = json.loads(query(snapshot_sql))
expected = copy.deepcopy(before)
sql = ['BEGIN;', "SET LOCAL lock_timeout='5s';", 'LOCK TABLE models,billing_rules,settings IN SHARE ROW EXCLUSIVE MODE;']
report = []
for resolution, art_old, art_new in [('480p', '.84', '.80'), ('720p', '1.12', '1.06')]:
    model_id = f'LongXia-video-seedance2_5-standard-{resolution}-express-PerSecond'
    model = next(row for row in expected['models'] if row['model_id'] == model_id)
    rule = next(row for row in expected['billing_rules'] if row['id'] == model['billing_rule_id'])
    old = Decimal(art_old)
    new = Decimal(art_new)
    if site == 'cart':
        old = (old * 8 / 7).quantize(Decimal('.01'), rounding=ROUND_CEILING)
        new = (new * 8 / 7).quantize(Decimal('.01'), rounding=ROUND_CEILING)
    assert len([row for row in expected['models'] if row['billing_rule_id'] == rule['id']]) == 1
    assert rule['billing_type'] == 'duration' and rule['billing_rule'] == 'video_resolution'
    assert Decimal(str(rule['duration_rate'])) == old and Decimal(str(model['pre_deduction'])) == old * 4
    tiers = json.loads(rule['pricing_tiers'])
    assert len(tiers) == 1 and tiers[0]['resolution'] == resolution and Decimal(str(tiers[0]['rate'])) == old
    for table, row in [('models', model), ('billing_rules', rule)]:
        payload = literal(json.dumps(row, ensure_ascii=False))
        sql.append(f"DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM {table} t WHERE id={row['id']} AND to_jsonb(t)={payload}::jsonb) THEN RAISE EXCEPTION 'Price configuration changed'; END IF; END $$;")
    tiers[0]['rate'] = float(new)
    rule['duration_rate'] = float(new)
    rule['pricing_tiers'] = json.dumps(tiers, ensure_ascii=False)
    rule['name'] = rule['name'].replace(f'CNY {old:.2f}/second', f'CNY {new:.2f}/second')
    model['pre_deduction'] = float(new * 4)
    for key in ['description', 'remark']:
        model[key] = model[key].replace(f'CNY {old:.2f}/second', f'CNY {new:.2f}/second')
    for table, row, fields in [('models', model, ['pre_deduction', 'description', 'remark']),
                               ('billing_rules', rule, ['duration_rate', 'pricing_tiers', 'name'])]:
        payload = literal(json.dumps(row, ensure_ascii=False))
        sql.append(f"UPDATE {table} t SET " + ','.join(f'{field}=v.{field}' for field in fields)
                   + f" FROM jsonb_populate_record(NULL::{table},{payload}::jsonb) v WHERE t.id=v.id;")
    report.append({'model': model_id, 'oldPerSecond': float(old), 'perSecond': float(new),
                   'preDeduction': model['pre_deduction'], 'billingRuleId': rule['id']})
sql.append("DO $$ BEGIN IF coalesce((SELECT value::jsonb->>'default_currency' FROM settings WHERE key='currency_settings'),'CNY')<>'CNY' THEN RAISE EXCEPTION 'Currency changed'; END IF; END $$;")
sql.append(f"DO $$ BEGIN IF ({snapshot_sql.removeprefix('SELECT ').removesuffix(';')}) IS DISTINCT FROM {literal(json.dumps(expected, ensure_ascii=False))}::jsonb THEN RAISE EXCEPTION 'Unexpected catalog change'; END IF; END $$;")
transaction = '\n'.join(sql)
query(transaction + '\nROLLBACK;')
assert json.loads(query(snapshot_sql)) == before
receipt = {'site': site, 'previewPassed': True, 'applied': False, 'models': report}
if apply:
    backup = Path('/root/flow-canvas-operations') / ('longxia-price-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(mode=0o700, parents=True)
    (backup / 'before.json').write_text(json.dumps(before, ensure_ascii=False), encoding='utf-8')
    (backup / 'migration.sql').write_text(transaction + '\nCOMMIT;\n', encoding='utf-8')
    query(transaction + '\nCOMMIT;')
    assert json.loads(query(snapshot_sql)) == expected
    receipt.update(applied=True, verified=True, backup=str(backup))
    (backup / 'receipt.json').write_text(json.dumps(receipt, ensure_ascii=False), encoding='utf-8')
print(json.dumps(receipt, ensure_ascii=False))
