"""Convert the existing art USD ledger to CNY without changing its real value.

Run on the art host. The default mode executes and verifies the transaction,
then rolls it back. --apply drains the backend before backup and migration.
Private row snapshots and database backups remain on the server.
"""

import argparse
import copy
import datetime as dt
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid


FACTOR = Decimal('6.75')
QUOTAS = ['quota_limit', 'quota_used', 'daily_quota_limit', 'daily_quota_used',
          'weekly_quota_limit', 'weekly_quota_used', 'monthly_quota_limit', 'monthly_quota_used']
RATES = ['prompt_rate', 'completion_rate', 'cached_rate', 'fixed_rate', 'duration_rate',
         'claude_cache_creation_rate', 'claude_cache_read_rate']
FIELDS = {
    'users': ['balance', 'used_quota', 'gift_balance', 'gift_used_quota', 'credit_limit', 'commission_balance'],
    'api_tokens': QUOTAS,
    'channels': QUOTAS,
    'channel_configs': QUOTAS,
    'models': ['pre_deduction'],
    'billing_rules': RATES + ['pricing_tiers', 'extended_config'],
    'logs': ['cost', 'pre_deduct_gift', 'billing_detail'],
    'logs_archive': ['cost', 'pre_deduct_gift', 'billing_detail'],
    'usage_daily_stats': ['total_cost', 'total_pre_deduct_gift'],
    'recharge_records': ['amount'],
    'user_levels': ['invite_reward_inviter', 'invite_reward_invitee'],
    'settings': ['value'],
}
EMPTY_REQUIRED = ['orders', 'commissions', 'redemptions', 'redemption_logs', 'ark_endpoint_bindings',
                  'ark_video_tasks', 'user_invoice_requests', 'user_model_configs', 'user_model_configs_2026',
                  'ha_usage_logs']
DETAIL_PREFIX = '币种迁移前原始USD明细（账面金额已按6.75换算为CNY）：'


def scale(value, precision=6, sentinel=False):
    if value is None:
        return None
    number = Decimal(str(value))
    if sentinel and number < 0:
        assert number == -1, 'Unknown unlimited quota sentinel'
        return value
    return float((number * FACTOR).quantize(Decimal(1).scaleb(-precision), rounding=ROUND_HALF_UP))


def convert_rule_json(value, kind):
    data = json.loads(value or ('[]' if kind == 'pricing_tiers' else '{}'))
    def validate_numbers(node, path=()):
        if isinstance(node, bool):
            return
        if isinstance(node, (float, int)):
            allowed = (kind == 'pricing_tiers' and len(path) == 2 and path[0] == '[]'
                       and path[1] in {'rate', 'cached_rate', 'prompt_rate', 'completion_rate', 'max_tokens', 'min_tokens'})
            if kind == 'extended_config':
                allowed = (len(path) == 3 and path[0] == 'resolution_rates' and path[2] in {'with_video', 'without_video'}
                           or len(path) == 2 and path[0] in {'price_table', 'video_ref_tokens_per_sec'}
                           or path in [('image_prompt_rate',), ('ref_token_rate_per_1k',), ('free_ref_tokens',),
                                       ('image_tokens_default',), ('audio_ref_tokens_per_sec',)]
                           or path == ('time_multipliers', '[]', 'multiplier'))
            assert allowed, 'Unreviewed numeric billing field: ' + '.'.join(path)
        elif isinstance(node, dict):
            for key, item in node.items():
                validate_numbers(item, (*path, key))
        elif isinstance(node, list):
            for item in node:
                validate_numbers(item, (*path, '[]'))
    validate_numbers(data)
    if kind == 'pricing_tiers':
        assert isinstance(data, list)
        for tier in data:
            for key in ['rate', 'cached_rate', 'prompt_rate', 'completion_rate']:
                if key in tier:
                    tier[key] = scale(tier[key], 12)
    else:
        assert isinstance(data, dict)
        for rates in data.get('resolution_rates', {}).values():
            for key in ['with_video', 'without_video']:
                if key in rates:
                    rates[key] = scale(rates[key], 12)
        for key, amount in data.get('price_table', {}).items():
            data['price_table'][key] = scale(amount, 12)
        for key in ['image_prompt_rate', 'ref_token_rate_per_1k']:
            if key in data:
                data[key] = scale(data[key], 12)
    return json.dumps(data, ensure_ascii=False, separators=(',', ':'))


def convert_currency(value):
    currency = json.loads(value)
    assert currency['default_currency'] == 'USD', 'Already migrated or unexpected base currency'
    cny = next(item for item in currency['auxiliary_currencies'] if item['code'] == 'CNY' and item['enabled'])
    assert Decimal(str(cny['exchange_rate'])) == FACTOR, 'Exchange rate changed'
    auxiliaries = []
    for auxiliary in currency['auxiliary_currencies']:
        if auxiliary['code'] in {'CNY', 'USD'}:
            continue
        converted = copy.deepcopy(auxiliary)
        converted['exchange_rate'] = float(Decimal(str(auxiliary['exchange_rate'])) / FACTOR)
        auxiliaries.append(converted)
    currency.update(default_currency='CNY', currency_symbol='¥', currency_unit='元',
                    auxiliary_currencies=auxiliaries,
                    quick_amounts=[scale(amount) for amount in currency['quick_amounts']],
                    min_recharge_amount=scale(currency['min_recharge_amount']))
    return json.dumps(currency, ensure_ascii=False, separators=(',', ':'))


def convert_snapshot(before):
    expected = copy.deepcopy(before)
    for table, rows in expected.items():
        for row in rows:
            for field in FIELDS[table]:
                if table == 'settings':
                    if row['key'] == 'currency_settings':
                        row[field] = convert_currency(row[field])
                elif table == 'billing_rules' and field in {'pricing_tiers', 'extended_config'}:
                    row[field] = convert_rule_json(row[field], field)
                elif field == 'billing_detail':
                    if row[field]:
                        row[field] = DETAIL_PREFIX + row[field]
                else:
                    row[field] = scale(row[field], 12 if table in {'models', 'billing_rules'} else 6,
                                       sentinel=field.endswith('_limit') and table in {'api_tokens', 'channels', 'channel_configs'})
    return expected


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


class Database:
    def __init__(self):
        info = json.loads(subprocess.check_output(['docker', 'inspect', 'tokensbyte-postgres'], text=True))[0]
        env = dict(value.split('=', 1) for value in info['Config']['Env'] if '=' in value)
        self.user = env.get('POSTGRES_USER', 'postgres')
        self.name = env.get('POSTGRES_DB', self.user)
        self.errors = tempfile.TemporaryFile(mode='w+t')
        self.process = subprocess.Popen(['docker', 'exec', '-i', 'tokensbyte-postgres', 'psql', '-X', '-q',
                                         '-U', self.user, '-d', self.name, '-At', '-v', 'ON_ERROR_STOP=1'],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.errors,
                                        text=True, encoding='utf-8', bufsize=1)

    def query(self, sql):
        marker = 'rmb_' + uuid.uuid4().hex
        self.process.stdin.write(sql + '\nSELECT ' + quote(marker) + ';\n')
        self.process.stdin.flush()
        lines = []
        while True:
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError('Database transaction failed; no commit was requested')
            if line.strip() == marker:
                return '\n'.join(lines)
            lines.append(line.rstrip('\n'))

    def json(self, sql):
        return json.loads(self.query(sql))

    def close(self):
        try:
            try:
                self.process.stdin.close()
            except BrokenPipeError:
                pass
            self.process.wait(timeout=10)
        finally:
            self.errors.close()


def read_snapshot(db):
    parts = []
    for table, fields in FIELDS.items():
        primary = 'key' if table == 'settings' else 'id'
        properties = ','.join(quote(field) + ',' + field for field in [primary, *fields])
        parts.append(f"'{table}',(SELECT coalesce(jsonb_agg(jsonb_build_object({properties}) ORDER BY {primary}),'[]') FROM {table})")
    return db.json('SELECT jsonb_build_object(' + ','.join(parts) + ');')


def protected_digests(db, tables):
    result = {}
    for table in tables:
        excludes = 'ARRAY[' + ','.join(quote(field) for field in FIELDS.get(table, [])) + ']::text[]'
        result[table] = db.query(f"SELECT md5(coalesce(string_agg((to_jsonb(t)-{excludes})::text,'' ORDER BY (to_jsonb(t)-{excludes})::text),'')) FROM {table} t;")
    return result


def build_sql(before, expected):
    statements = []
    for table, rows in expected.items():
        primary = 'key' if table == 'settings' else 'id'
        for original, row in zip(before[table], rows):
            assert original[primary] == row[primary]
            changed = [field for field in FIELDS[table] if original[field] != row[field]]
            if not changed:
                continue
            payload = quote(json.dumps(row, ensure_ascii=False))
            assignments = ','.join(f'{field}=expected.{field}' for field in changed)
            statements.append(f"UPDATE {table} target SET {assignments} FROM jsonb_populate_record(NULL::{table},{payload}::jsonb) expected WHERE target.{primary}=expected.{primary};")
    return '\n'.join(statements)


def verify(expected, actual):
    assert expected.keys() == actual.keys()
    for table in expected:
        assert len(expected[table]) == len(actual[table]), f'{table} row count changed'
        for left, right in zip(expected[table], actual[table]):
            assert left.keys() == right.keys()
            for field, value in left.items():
                current = right[field]
                if isinstance(value, (float, int)) and value is not None:
                    assert abs(Decimal(str(value)) - Decimal(str(current))) <= Decimal('0.000000000001'), f'{table}.{field} mismatch'
                else:
                    assert value == current, f'{table}.{field} changed unexpectedly'


def preflight(db):
    assert db.json("SELECT jsonb_agg(key ORDER BY key) FROM settings;") == ['currency_settings', 'registration_settings', 'storage_settings'], 'Settings scope changed'
    assert db.json("SELECT count(*) FROM plugin_configs;") == 39, 'Plugin configuration scope changed'
    assert db.json("SELECT count(*) FROM logs WHERE is_completed=0;") == 0, 'Unsettled tasks must finish before migration'
    assert db.json("SELECT count(*) FROM models m LEFT JOIN billing_rules b ON b.id=m.billing_rule_id WHERE m.is_active=1 AND (b.id IS NULL OR b.is_active<>1);") == 0, 'Active model has no valid billing rule'
    assert db.json("SELECT count(*) FROM channel_configs WHERE upstream_sync_interval_minutes<>0 OR upstream_currency<>'' OR site_currency<>'';") == 0, 'Currency-dependent upstream sync requires separate inspection'
    assert db.json("SELECT count(*) FROM channels WHERE balance IS NOT NULL;") == 0, 'Upstream balance handling requires separate inspection'
    assert db.json("SELECT count(*) FROM usage_daily_stats WHERE ext_json IS NOT NULL;") == 0, 'Usage extension requires inspection'
    assert db.json("SELECT count(*) FROM users WHERE notification_preferences IS NOT NULL;") == 0, 'Notification thresholds require inspection'
    for table in EMPTY_REQUIRED:
        assert db.json(f'SELECT count(*) FROM {table};') == 0, f'{table} is no longer empty'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    db = Database()
    stopped = False
    committed = False
    backup = None
    try:
        preflight(db)
        currency = db.json("SELECT value::jsonb FROM settings WHERE key='currency_settings';")
        assert currency['default_currency'] == 'USD', 'Migration is not repeatable'
        if args.apply:
            # Drain USD billing queues before taking the authoritative balance snapshot.
            state = json.loads(subprocess.check_output(['docker', 'inspect', 'tokensbyte-backend'], text=True))[0]
            assert state['State']['Running'], 'Backend was not running before migration'
            stopped = True
            subprocess.run(['docker', 'stop', '--time', '90', 'tokensbyte-backend'], check=True, stdout=subprocess.DEVNULL)
            state = json.loads(subprocess.check_output(['docker', 'inspect', 'tokensbyte-backend'], text=True))[0]
            assert state['State']['ExitCode'] == 0, 'Backend did not drain cleanly'
            preflight(db)
            stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
            backup = Path('/opt/tokensbyte-backups') / ('art-cny-' + stamp)
            backup.mkdir(mode=0o700)
            with (backup / 'before.dump').open('wb') as target:
                subprocess.run(['docker', 'exec', 'tokensbyte-postgres', 'pg_dump', '-U', db.user,
                                '-d', db.name, '-Fc'], stdout=target, check=True)
        tables = db.json("SELECT jsonb_agg(table_name ORDER BY table_name) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';")
        assert all(table.replace('_', '').isalnum() for table in tables)
        db.query("BEGIN; SET LOCAL lock_timeout='5s'; LOCK TABLE " + ','.join(tables) + ' IN SHARE ROW EXCLUSIVE MODE;')
        preflight(db)
        before = read_snapshot(db)
        expected = convert_snapshot(before)
        protected = protected_digests(db, tables)
        sql = build_sql(before, expected)
        if backup:
            (backup / 'before-ledger.json').write_text(json.dumps(before, ensure_ascii=False), encoding='utf-8')
            (backup / 'expected-ledger.json').write_text(json.dumps(expected, ensure_ascii=False), encoding='utf-8')
            (backup / 'migration.sql').write_text('BEGIN;\n' + sql + '\nCOMMIT;\n', encoding='utf-8')
            (backup / 'protected-digests.json').write_text(json.dumps(protected), encoding='utf-8')
        db.query(sql)
        verify(expected, read_snapshot(db))
        assert protected_digests(db, tables) == protected, 'Unrelated data changed'
        db.query('COMMIT;' if args.apply else 'ROLLBACK;')
        committed = args.apply
        if not args.apply:
            verify(before, read_snapshot(db))
        totals = {}
        for label, data in [('beforeUsd', before), ('afterCny', expected)]:
            totals[label] = {field: str(sum(Decimal(str(row[field] or 0)) for row in data['users']))
                             for field in FIELDS['users']}
        result = {'applied': args.apply, 'verified': True, 'factor': str(FACTOR), 'currency': 'CNY' if args.apply else 'USD',
                  'rows': {table: len(rows) for table, rows in before.items()}, 'userTotals': totals,
                  'backup': str(backup) if backup else None,
                  'protectedTablesVerified': len(protected), 'rounding': 'ledger 6 decimals; rates 12 decimals',
                  'migrationSha256': hashlib.sha256(sql.encode()).hexdigest()}
        if backup:
            (backup / 'receipt.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=False), flush=True)
    finally:
        try:
            db.close()
        finally:
            if stopped:
                subprocess.run(['docker', 'start', 'tokensbyte-backend'], check=True, stdout=subprocess.DEVNULL)
                print(json.dumps({'backendRestarted': True, 'committed': committed}), flush=True)


if __name__ == '__main__':
    os.umask(0o077)
    main()
