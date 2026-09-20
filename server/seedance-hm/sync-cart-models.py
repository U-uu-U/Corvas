"""Back up, preview and verify the scoped catalog migration on cart.ravenhash.org."""
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys

TABLES = ['models', 'billing_rules', 'channels', 'model_providers', 'model_api_providers',
          'channel_categories', 'channel_configs', 'forward_rules']
PAUSED = {'seedance_v2.5-101010', 'seedance_v2.5-301010', 'doubao-seedance-2-0-260128',
          'doubao-seedance-2-0-fast', 'doubao-seedance-2-5-260628'}
EDITED = {'sd2.5', 'seedance_v2.5', 'seedance_v2.0-933', 'sd2.5-route1',
          'artsdance2-0-fast-intl-260701', 'artsdance2-0-mini-intl-260701', 'artsdance2-0-pro-intl-260701'}
container = json.loads(subprocess.check_output(['docker', 'inspect', 'tkeapi-postgres'], text=True))[0]
env = dict(value.split('=', 1) for value in container['Config']['Env'] if '=' in value)
USER = env.get('POSTGRES_USER', 'postgres')
DB = env.get('POSTGRES_DB', USER)
PSQL = ['docker', 'exec', '-i', 'tkeapi-postgres', 'psql', '-X', '-U', USER, '-d', DB, '-At', '-v', 'ON_ERROR_STOP=1']


def query(sql):
    result = subprocess.run(PSQL, input=sql, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    return result.stdout.strip()


def snapshot():
    return {table: json.loads(query(f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id), '[]') FROM {table} t;")) for table in TABLES}


def protected_state():
    tables = json.loads(query("SELECT jsonb_agg(table_name) FROM information_schema.tables WHERE table_schema='public';"))
    protected = {'settings', 'users', 'api_tokens', 'orders', 'recharge_records', 'user_levels', 'plugins', 'plugin_configs'}
    return {table: query(f"SELECT md5(coalesce(string_agg(to_jsonb(t)::text, '' ORDER BY to_jsonb(t)::text), '')) FROM {table} t;")
            for table in sorted(protected.intersection(tables))}


def containers():
    names = ['tkeapi-frontend', 'tkeapi-backend', 'tkeapi-postgres', 'seedance968-adapter', 'minimax-h3-adapter']
    return {c['Name']: (c['Id'], c['Image']) for c in json.loads(subprocess.check_output(['docker', 'inspect', *names], text=True))}


def changed_fields(table, row):
    if table == 'models':
        if row['model_id'] in PAUSED:
            return {'is_active', 'updated_at'}
        if row['model_id'] in EDITED:
            return {'name', 'sort_order', 'provider_id', 'api_provider_id', 'updated_at'}
    if table in ['model_providers', 'model_api_providers', 'channel_categories'] and row['name'] in ['其他 SD 视频', 'SD2.5 线路一']:
        return {'name', 'name_en', 'sort_order', 'updated_at'}
    if table == 'channels' and row['name'] in ['SD2.5 线路一', '其他 SD 视频 - 主播', '其他 SD 视频 - 海外']:
        fields = {'name', 'category_id', 'updated_at'}
        if row['base_url'].rstrip('/') in ['https://video.zhubo.asia', 'https://video.zhubo.asia/v1']:
            fields |= {'models', 'model_mapping'}
        return fields
    if table == 'channel_configs' and row['base_url'].rstrip('/') in ['https://ai.artsmcp.com', 'https://ai.artsmcp.com/v1']:
        return {'name', 'category_id', 'updated_at'}
    return set()


def verify(before, after):
    for table in TABLES:
        latest = {row['id']: row for row in after[table]}
        for row in before[table]:
            changed = changed_fields(table, row)
            current = latest[row['id']]
            assert {k: v for k, v in row.items() if k not in changed} == {k: v for k, v in current.items() if k not in changed}, f'Unexpected {table} change at ID {row["id"]}'
        added = len(after[table]) - len(before[table])
        assert added == (1 if table in ['models', 'billing_rules', 'model_providers', 'model_api_providers', 'channel_categories'] else 0), f'Unexpected {table} additions'
    pro = next(m for m in after['models'] if m['model_id'] == 'seedance-2.5-pro')
    rate = next(b for b in after['billing_rules'] if b['id'] == pro['billing_rule_id'])
    assert pro['is_active'] == 1 and abs(pro['pre_deduction'] - 31.8) < 0.000001
    assert rate['billing_type'] == 'duration' and rate['billing_rule'] == 'video_resolution'
    assert abs(rate['duration_rate'] - 1.06) < 0.000001
    assert {t['resolution'] for t in json.loads(rate['pricing_tiers'])} == {'480p', '720p'}
    assert all(abs(t['rate'] - 1.06) < 0.000001 and t['enabled'] for t in json.loads(rate['pricing_tiers']))
    channel = next(c for c in after['channels'] if c['base_url'].rstrip('/') == 'https://video.zhubo.asia')
    previous = next(c for c in before['channels'] if c['id'] == channel['id'])
    assert set(json.loads(channel['models'])) == set(json.loads(previous['models'])) | {pro['mid']}
    assert json.loads(channel['model_mapping']) == {**json.loads(previous['model_mapping']), 'seedance-2.5-pro': 'seedance-2.5-pro'}
    assert {m['model_id'] for m in after['models'] if not m['is_active']} == PAUSED
    active = [m for m in after['models'] if m['is_active']]
    assert len(active) == 9
    groups = {g['id']: g for g in after['model_providers']}
    ordered = sorted(active, key=lambda m: (groups[m['provider_id']]['sort_order'], m['sort_order']))
    assert [m['model_id'] for m in ordered] == ['minimax-h3', 'sd2.5', 'seedance-2.5-pro', 'seedance_v2.5',
        'seedance_v2.0-933', 'sd2.5-route1', 'artsdance2-0-fast-intl-260701', 'artsdance2-0-mini-intl-260701', 'artsdance2-0-pro-intl-260701']
    return {'activeModels': [{ 'model': m['model_id'], 'name': m['name'], 'group': groups[m['provider_id']]['name']} for m in ordered],
            'pausedModels': sorted(PAUSED), 'proCnyPerSecond': 1.06}


def restore_sql(before, after):
    statements = ['BEGIN;', "SET LOCAL lock_timeout = '5s';"]
    for table in TABLES:
        for row in before[table]:
            fields = changed_fields(table, row) - {'updated_at'}
            if not fields:
                continue
            payload = json.dumps(row, ensure_ascii=False).replace("'", "''")
            assignments = ','.join(f'{field}=original.{field}' for field in sorted(fields))
            statements.append(f"UPDATE {table} AS target SET {assignments},updated_at=now() FROM jsonb_populate_record(NULL::{table},'{payload}'::jsonb) AS original WHERE target.id=original.id;")
        if table in ['models', 'model_providers', 'model_api_providers', 'channel_categories']:
            ids = {row['id'] for row in before[table]}
            for row in after[table]:
                if row['id'] not in ids:
                    statements.append(f"UPDATE {table} SET is_active=0,updated_at=now() WHERE id={row['id']};")
    return '\n'.join(statements + ['COMMIT;', ''])


if __name__ == '__main__':
    os.umask(0o077)
    sql = Path(sys.argv[1]).read_text(encoding='utf-8-sig')
    assert sql.count('COMMIT;') == 1
    before = snapshot()
    assert not any(m['model_id'] == 'seedance-2.5-pro' for m in before['models'])
    protected_before = protected_state()
    containers_before = containers()
    backup = Path('/root/tkeapi-backups') / ('catalog-sync-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(mode=0o700)
    with (backup / 'before.dump').open('wb') as target:
        subprocess.run(['docker', 'exec', 'tkeapi-postgres', 'pg_dump', '-U', USER, '-d', DB, '-Fc'], stdout=target, check=True)
    (backup / 'before.json').write_text(json.dumps(before, ensure_ascii=False), encoding='utf-8')
    (backup / 'migration.sql').write_text(sql, encoding='utf-8')
    preview = sql.replace('COMMIT;', "SELECT jsonb_build_object(" + ','.join(f"'{table}',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM {table} t)" for table in TABLES) + ");\nROLLBACK;")
    output = query(preview)
    preview_state = json.loads(next(line for line in output.splitlines() if line.startswith('{')))
    result = verify(before, preview_state)
    assert snapshot() == before, 'Preview changed catalog records'
    assert protected_state() == protected_before and containers() == containers_before
    (backup / 'restore.sql').write_text(restore_sql(before, preview_state), encoding='utf-8')
    print(json.dumps({'previewPassed': True, 'backup': str(backup), **result}, ensure_ascii=False), flush=True)
    if '--apply' in sys.argv:
        query(sql)
        after = snapshot()
        result = verify(before, after)
        assert protected_state() == protected_before, 'Protected business records changed during migration'
        assert containers() == containers_before, 'Container identity changed'
        (backup / 'after.json').write_text(json.dumps(after, ensure_ascii=False), encoding='utf-8')
        (backup / 'restore.sql').write_text(restore_sql(before, after), encoding='utf-8')
        (backup / 'verification.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
        print(json.dumps({'applied': True, 'backup': str(backup), **result}, ensure_ascii=False))
