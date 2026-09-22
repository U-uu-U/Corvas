"""Add an already-listed StarFrame model to an existing relay channel.

This variant is intentionally separate from deploy-starframe.py: the provider
channel and credential already exist, so the migration only adds the model and
its billing rule and appends the model mapping to that channel.
"""
import copy
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys

MODEL = 'ch1401-sd-2.5-720p'
LABEL = '2.5pro 备用（卡人脸）'
GROUP = 'Seedance 2.5 备用渠道'
SOURCE_MODEL = 'ch0107-sd-2.5-720p'
SALE_CNY = {'art': 5.0, 'cart': 5.72}
TABLES = ['models', 'billing_rules', 'channels', 'forward_rules', 'model_providers',
          'model_api_providers', 'channel_categories']


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in {'art', 'cart'}:
        raise SystemExit('usage: deploy-starframe-variant.py art|cart [--apply]')
    site = sys.argv[1]
    sale_cny = SALE_CNY[site]
    apply = '--apply' in sys.argv
    container_name = 'tokensbyte-postgres' if site == 'art' else 'tkeapi-postgres'
    container = json.loads(subprocess.check_output(['docker', 'inspect', container_name], text=True))[0]
    env = dict(item.split('=', 1) for item in container['Config']['Env'] if '=' in item)
    user = env.get('POSTGRES_USER', 'postgres')
    database = env.get('POSTGRES_DB', user)
    psql = ['docker', 'exec', '-i', container_name, 'psql', '-X', '-U', user, '-d', database, '-At', '-v', 'ON_ERROR_STOP=1']

    def query(sql):
        result = subprocess.run(psql, input=sql, text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError(result.stderr.strip())
        return result.stdout.strip()

    def rows(table):
        return json.loads(query(f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM {table} t;"))

    def snapshot():
        return {table: rows(table) for table in TABLES}

    before = snapshot()
    assert not any(row['model_id'] == MODEL for row in before['models']), 'CH1401 model already exists'
    source = next(row for row in before['models'] if row['model_id'] == SOURCE_MODEL)
    assert source['is_active'] == 1, 'Source model is inactive'
    channel = next(row for row in before['channels'] if row['base_url'].rstrip('/') == 'https://api.xzapi.vip')
    assert int(channel.get('status', 0)) == 1, 'StarFrame channel is inactive'
    assert str(source['mid']) in json.loads(channel['models']), 'source model is not bound to StarFrame channel'
    source_mapping = json.loads(channel.get('model_mapping') or '{}')
    assert source_mapping.get(SOURCE_MODEL) == SOURCE_MODEL, 'source model mapping is not native'
    column_types = json.loads(query("SELECT jsonb_object_agg(column_name,data_type) FROM information_schema.columns WHERE table_name='channels' AND column_name IN ('models','model_mapping');"))
    assert column_types == {'models': 'text', 'model_mapping': 'text'}, 'Unexpected channel JSON storage'

    currency = json.loads(query("SELECT coalesce((SELECT value::jsonb FROM settings WHERE key='currency_settings'),'{}'::jsonb);"))
    if site == 'cart':
        assert currency.get('default_currency', 'CNY') == 'CNY'
        exchange, fixed_rate, sale_label = 1.0, sale_cny, f'{sale_cny:.2f}'
    else:
        assert currency.get('default_currency') == 'USD'
        exchange = next(item['exchange_rate'] for item in currency['auxiliary_currencies']
                        if item['code'] == 'CNY' and item['enabled'])
        fixed_rate, sale_label = sale_cny / exchange, f'{sale_cny:.2f}'

    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    backup_root = '/opt/tokensbyte-backups' if site == 'art' else '/root/tkeapi-backups'
    backup = Path(backup_root) / ('starframe-ch1401-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(mode=0o700)
    with (backup / 'before.dump').open('wb') as target:
        subprocess.run(['docker', 'exec', container_name, 'pg_dump', '-U', user, '-d', database, '-Fc'], stdout=target, check=True)
    (backup / 'before.json').write_text(json.dumps(before, ensure_ascii=False), encoding='utf-8')

    def next_id(table):
        return int(query(f"SELECT nextval(pg_get_serial_sequence('{table}','id'));"))

    additions = {table: [] for table in TABLES}
    source_billing = next(row for row in before['billing_rules'] if row['id'] == source['billing_rule_id'])
    assert source_billing['is_active'] == 1, 'Source billing rule is inactive'
    billing = copy.deepcopy(source_billing)
    billing.update(id=next_id('billing_rules'), pid='', name=f'{LABEL} CNY {sale_label}/次',
                   billing_type='requests', billing_rule='fixed', pricing_type='custom',
                   fixed_rate=fixed_rate, duration_rate=0, pricing_tiers='[]', is_active=1,
                   extended_config=json.dumps({'supported_models': [MODEL], 'time_multipliers': [],
                                               'enable_time_multipliers': False}, ensure_ascii=False),
                   created_at=timestamp, updated_at=timestamp)
    additions['billing_rules'].append(billing)

    forward_id = json.loads(source['forward_rule_ids'])[0]
    forward = next(row for row in before['forward_rules'] if row['id'] == forward_id)
    assert forward['eid'] == 'starframe-video-backup' and forward['is_active'] == 1
    assert json.loads(forward['config_json']) == {'target_type': 'passthrough', 'auth_type': 'bearer',
        'path_rewrite': {'old': '/v1/video/generations', 'new': '/v1/videos'}, 'poll_path': '/v1/videos/${task_id}'}
    model = copy.deepcopy(source)
    mids = [int(row['mid']) for row in before['models'] if str(row.get('mid', '')).isdigit()]
    model.update(id=next_id('models'), mid=str(max(mids) + 1), model_id=MODEL, original_id=MODEL,
                 model_id_alias='', name=LABEL, billing_rule_id=billing['id'],
                 forward_rule_ids=json.dumps([forward_id]), pre_deduction=fixed_rate,
                 is_active=1, site_discount=1, site_discount_enabled=0,
                 global_discount=1, global_discount_enabled=0, group_ratios='{}',
                 sort_order=int(source.get('sort_order', 0)) + 1,
                 description=f'720p；4-30秒；最多30张参考图片；不支持参考视频/音频；卡人脸；{sale_label}元/次',
                 remark='StarFrame CH1401 backup; fixed per-request billing; card-face route',
                 feature_attributes=json.dumps(['图生视频'], ensure_ascii=False),
                 created_at=timestamp, updated_at=timestamp)
    additions['models'].append(model)

    expected_channel = copy.deepcopy(channel)
    expected_channel['models'] = json.dumps([*json.loads(channel['models']), model['mid']], ensure_ascii=False)
    expected_channel['model_mapping'] = json.dumps({**source_mapping, MODEL: MODEL}, ensure_ascii=False)

    protected = {table: query(f"SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM {table} t;")
                 for table in ['settings', 'channel_configs', 'plugins', 'plugin_configs']}
    model_payload = json.dumps(model, ensure_ascii=False).replace("'", "''")
    billing_payload = json.dumps(billing, ensure_ascii=False).replace("'", "''")

    def sql_text(value):
        return "'" + value.replace("'", "''") + "'"

    def stable_row(table, row, timestamps=False):
        return {key: value for key, value in row.items()
                if not (table == 'channels' and (key.endswith('_used') or key.startswith('last_reset_')))
                and not (timestamps and key in {'created_at', 'updated_at'})}

    guards = []
    for table, row in [('models', source), ('billing_rules', source_billing), ('forward_rules', forward)]:
        payload = sql_text(json.dumps(row, ensure_ascii=False))
        guards.append(f"DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM {table} t WHERE id={row['id']} AND to_jsonb(t)={payload}::jsonb) THEN RAISE EXCEPTION 'Source configuration changed'; END IF; END $$;")

    original_models = sql_text(channel['models'])
    original_mapping = sql_text(channel.get('model_mapping') or '{}')
    updated_models = sql_text(expected_channel['models'])
    updated_mapping = sql_text(expected_channel['model_mapping'])
    migration = '\n'.join([
        'BEGIN;', "SET LOCAL lock_timeout='5s';",
        'LOCK TABLE models,billing_rules,channels,forward_rules IN SHARE ROW EXCLUSIVE MODE;',
        *guards,
        f"DO $$ BEGIN IF EXISTS(SELECT 1 FROM models WHERE model_id='{MODEL}' OR mid='{model['mid']}') THEN RAISE EXCEPTION 'Model added concurrently'; END IF; END $$;",
        f"INSERT INTO billing_rules SELECT * FROM jsonb_populate_record(NULL::billing_rules,'{billing_payload}'::jsonb);",
        f"INSERT INTO models SELECT * FROM jsonb_populate_record(NULL::models,'{model_payload}'::jsonb);",
        f"DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM channels WHERE id={channel['id']} AND status=1 AND base_url='https://api.xzapi.vip' AND models={original_models} AND model_mapping={original_mapping}) THEN RAISE EXCEPTION 'StarFrame channel changed concurrently'; END IF; END $$;",
        f"UPDATE channels SET models={updated_models}, model_mapping={updated_mapping}, updated_at=now() WHERE id={channel['id']};",
    ])
    snapshot_sql = 'SELECT jsonb_build_object(' + ','.join(f"'{table}',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM {table} t)" for table in TABLES) + ');'

    def verify(actual):
        for table in TABLES:
            prior = {row['id']: row for row in before[table]}
            current = {row['id']: row for row in actual[table]}
            assert set(prior) <= set(current), f'{table} rows disappeared'
            for row_id, row in prior.items():
                if table == 'channels' and row_id == channel['id']:
                    expected = expected_channel
                    ignored = {'updated_at'}
                else:
                    expected, ignored = row, set()
                assert {k: v for k, v in stable_row(table, expected).items() if k not in ignored} == {k: v for k, v in stable_row(table, current[row_id]).items() if k not in ignored}, f'Unexpected {table} mutation at ID {row_id}'
            expected_added = additions[table]
            if expected_added:
                for row in expected_added:
                    assert stable_row(table, current[row['id']], timestamps=True) == stable_row(table, row, timestamps=True)
                assert len(current) == len(prior) + len(expected_added), f'Unexpected {table} additions'
            else:
                assert len(current) == len(prior), f'Unexpected {table} additions'
        actual_rule = next(row for row in actual['billing_rules'] if row['id'] == billing['id'])
        assert actual_rule['billing_type'] == 'requests' and abs(actual_rule['fixed_rate'] - fixed_rate) < 1e-9
        actual_model = next(row for row in actual['models'] if row['model_id'] == MODEL)
        assert actual_model['is_active'] == 1 and actual_model['pre_deduction'] == fixed_rate

    preview = query(migration + '\n' + snapshot_sql + '\nROLLBACK;')
    preview_state = json.loads(next(line for line in preview.splitlines() if line.startswith('{')))
    verify(preview_state)
    latest = snapshot()
    assert {table: [stable_row(table, row) for row in rows] for table, rows in latest.items()} == {
        table: [stable_row(table, row) for row in rows] for table, rows in before.items()}
    (backup / 'migration.sql').write_text(migration + '\nCOMMIT;\n', encoding='utf-8')
    restore = '\n'.join(['BEGIN;', f"UPDATE models SET is_active=0,updated_at=now() WHERE id={model['id']};",
                          f"UPDATE billing_rules SET is_active=0,updated_at=now() WHERE id={billing['id']};",
                          f"UPDATE channels SET models=coalesce((SELECT jsonb_agg(value) FROM jsonb_array_elements(models::jsonb) WHERE value<>to_jsonb('{model['mid']}'::text)),'[]'::jsonb)::text,model_mapping=(model_mapping::jsonb-'{MODEL}')::text,updated_at=now() WHERE id={channel['id']};",
                          'COMMIT;', ''])
    (backup / 'disable.sql').write_text(restore, encoding='utf-8')
    summary = {'site': site, 'previewPassed': True, 'backup': str(backup), 'model': MODEL, 'name': LABEL,
               'group': GROUP, 'saleCnyPerRequest': sale_cny, 'siteRate': fixed_rate,
               'modelId': model['id'], 'modelMid': model['mid'], 'billingRuleId': billing['id'],
               'channelId': channel['id'], 'forwardRuleId': forward_id}
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    if apply:
        query(migration + '\nCOMMIT;')
        actual = snapshot()
        verify(actual)
        for table, digest in protected.items():
            assert query(f"SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM {table} t;") == digest
        (backup / 'after.json').write_text(json.dumps(actual, ensure_ascii=False), encoding='utf-8')
        (backup / 'verification.json').write_text(json.dumps({**summary, 'applied': True, 'verified': True}, ensure_ascii=False), encoding='utf-8')
        print(json.dumps({**summary, 'applied': True, 'verified': True}, ensure_ascii=False))


if __name__ == '__main__':
    os.umask(0o077)
    main()
