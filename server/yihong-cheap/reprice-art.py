"""Change only the existing art Cheap rule and reservation from CNY 4 to CNY 3."""
import copy
import datetime as dt
import json
import os
from pathlib import Path
import runpy
import subprocess

os.umask(0o077)
helper = runpy.run_path('/opt/corvas-yihong-cheap/server/seedance-hm/add-zhubo-september.py')
command = ['docker', 'exec', '-i', 'tokensbyte-postgres', 'psql', '-X', '-qAt', '-U', 'tokensapi', '-d', 'tokensapi', '-v', 'ON_ERROR_STOP=1']


def query(sql):
    result = subprocess.run(command, input=sql, text=True, capture_output=True, timeout=45)
    if result.returncode:
        raise RuntimeError('Price update failed; database details withheld')
    return result.stdout.strip()


before = json.loads(query(helper['snapshot_sql']()))
assert before['currency'].get('default_currency') == 'CNY'
after = copy.deepcopy(before)
model = helper['one'](after['models'], lambda row: row['model_id'] == 'yh-video-v25-cheap', 'Model missing')
billing = helper['one'](after['billing_rules'], lambda row: row['id'] == model['billing_rule_id'], 'Billing missing')
assert sum(row['billing_rule_id'] == billing['id'] for row in before['models']) == 1, 'Billing rule is shared'
assert billing['billing_type'] == 'requests' and billing['billing_rule'] == 'fixed'
assert billing['fixed_rate'] == model['pre_deduction'] == 4 and billing['duration_rate'] == 0, 'Price changed concurrently'
billing.update(fixed_rate=3, name='Seedance 2.5 Cheap CNY 3/request')
model.update(pre_deduction=3, description='720p; 4-30 seconds; 30 image references; CNY 3/request',
             remark='Yihong Cheap 2026-10-12; user-requested art CNY 3/request')
literal = helper['literal']
statements = ['BEGIN;', "SET LOCAL lock_timeout='5s';", "SET LOCAL statement_timeout='25s';",
              'LOCK TABLE ' + ','.join((*helper['TABLES'], 'settings')) + ' IN SHARE ROW EXCLUSIVE MODE;']
statements.extend(helper['guard_catalog'](before))
statements.extend([
    f"UPDATE billing_rules SET fixed_rate=3,name={literal(billing['name'])},updated_at=now() WHERE id={billing['id']};",
    f"UPDATE models SET pre_deduction=3,description={literal(model['description'])},remark={literal(model['remark'])},updated_at=now() WHERE id={model['id']};"
])
statements.extend(helper['guard_catalog'](after))
helper['verify'](after, json.loads(query('\n'.join(statements + [helper['snapshot_sql'](), 'ROLLBACK;']))))
helper['verify'](before, json.loads(query(helper['snapshot_sql']())))
backup = Path('/root/flow-canvas-operations') / ('yihong-cheap-art-price3-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
backup.mkdir(mode=0o700, parents=True)
(backup / 'before.json').write_text(json.dumps(before), encoding='utf-8')
sql = '\n'.join(statements + ['COMMIT;'])
(backup / 'migration.sql').write_text(sql, encoding='utf-8')
query(sql)
helper['verify'](after, json.loads(query(helper['snapshot_sql']())))
receipt = {'site': 'art', 'model': model['model_id'], 'sale': 3, 'unit': 'request', 'preDeduction': 3,
           'billingRuleId': billing['id'], 'verified': True, 'backup': str(backup)}
(backup / 'receipt.json').write_text(json.dumps(receipt), encoding='utf-8')
print(json.dumps(receipt))
