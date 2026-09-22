"""Install a distinct StarFrame backup model on an existing art/cart relay."""
import copy
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys

MODEL = 'ch0107-sd-2.5-720p'
LABEL = '2.5pro 备用（满参）'
GROUP = 'Seedance 2.5 备用渠道'
TABLES = ['models', 'billing_rules', 'channels', 'forward_rules', 'model_providers', 'model_api_providers', 'channel_categories']


def main():
    site = sys.argv[1]
    assert site in ['art', 'cart']
    apply = '--apply' in sys.argv
    credential = json.load(sys.stdin)['apiKey']
    assert isinstance(credential, str) and len(credential) > 20
    os.umask(0o077)
    container_name = 'tokensbyte-postgres' if site == 'art' else 'tkeapi-postgres'
    container = json.loads(subprocess.check_output(['docker', 'inspect', container_name], text=True))[0]
    env = dict(item.split('=', 1) for item in container['Config']['Env'] if '=' in item)
    user = env.get('POSTGRES_USER', 'postgres')
    database = env.get('POSTGRES_DB', user)
    psql = ['docker', 'exec', '-i', container_name, 'psql', '-X', '-U', user, '-d', database, '-At', '-v', 'ON_ERROR_STOP=1']

    def query(sql):
        result = subprocess.run(psql, input=sql, text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError(result.stderr.replace(credential, '[REDACTED]'))
        return result.stdout.strip()

    def rows(table):
        return json.loads(query(f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM {table} t;"))

    def snapshot():
        return {table: rows(table) for table in TABLES}

    before = snapshot()
    assert not any(m['model_id'] == MODEL for m in before['models']), 'Model already exists; inspect before changing it'
    assert not any(c['base_url'].rstrip('/') == 'https://api.xzapi.vip' for c in before['channels']), 'StarFrame channel already exists'
    currency = json.loads(query("SELECT coalesce((SELECT value::jsonb FROM settings WHERE key='currency_settings'),'{\"default_currency\":\"CNY\"}'::jsonb);"))
    if site == 'cart':
        assert currency['default_currency'] == 'CNY'
        exchange, sale = 1, 1.25
    else:
        assert currency['default_currency'] == 'USD'
        exchange = next(c['exchange_rate'] for c in currency['auxiliary_currencies'] if c['code'] == 'CNY' and c['enabled'])
        sale = 1.06
    rate = sale / exchange
    protected = {table: query(f"SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM {table} t;")
                 for table in ['settings', 'channel_configs', 'plugins', 'plugin_configs']}
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    backup_root = '/opt/tokensbyte-backups' if site == 'art' else '/root/tkeapi-backups'
    backup = Path(backup_root) / ('starframe-backup-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(mode=0o700)
    with (backup / 'before.dump').open('wb') as target:
        subprocess.run(['docker', 'exec', container_name, 'pg_dump', '-U', user, '-d', database, '-Fc'], stdout=target, check=True)
    (backup / 'before.json').write_text(json.dumps(before, ensure_ascii=False), encoding='utf-8')
    additions = {table: [] for table in TABLES}

    def next_id(table):
        return int(query(f"SELECT nextval(pg_get_serial_sequence('{table}','id'));"))

    def group_id(table):
        existing = [r for r in before[table] if r['name'] == GROUP]
        assert len(existing) <= 1
        if existing:
            assert existing[0]['is_active'] == 1
            return existing[0]['id']
        template = copy.deepcopy(next(r for r in before[table] if not r.get('is_system')))
        template.update(id=next_id(table), name=GROUP, name_en='Seedance 2.5 Backup', sort_order=30,
                        is_active=1, is_system=0, created_at=timestamp, updated_at=timestamp)
        if 'remark' in template:
            template['remark'] = 'StarFrame backup video route'
        additions[table].append(template)
        return template['id']

    public_group = group_id('model_providers')
    api_group = group_id('model_api_providers')
    category_group = group_id('channel_categories')
    template = next(m for m in before['models'] if m['model_id'] == 'seedance-2.5-pro')
    billing = copy.deepcopy(next(r for r in before['billing_rules'] if r['id'] == template['billing_rule_id']))
    billing.update(id=next_id('billing_rules'), pid='', name=f'{LABEL} CNY {sale:.2f}/秒',
                   billing_type='duration', billing_rule='video_resolution', fixed_rate=0, duration_rate=rate,
                   pricing_tiers=json.dumps([{'resolution':'720p','rate':rate,'enabled':True,'cached_rate':0}]),
                   extended_config=json.dumps({'supported_models':[MODEL],'enable_time_multipliers':False,'time_multipliers':[]}),
                   created_at=timestamp, updated_at=timestamp)
    additions['billing_rules'].append(billing)
    forward = copy.deepcopy(next(r for r in before['forward_rules'] if r['id'] == json.loads(template['forward_rule_ids'])[0]))
    forward.update(id=next_id('forward_rules'), eid='starframe-video-backup', name='StarFrame OpenAI 异步视频',
                   config_json=json.dumps({'target_type':'passthrough','auth_type':'bearer',
                      'path_rewrite':{'old':'/v1/video/generations','new':'/v1/videos'},'poll_path':'/v1/videos/${task_id}'}),
                   is_active=1, is_system=0, description='StarFrame references protocol; native task identity',
                   created_at=timestamp, updated_at=timestamp)
    assert not any(r['eid'] == forward['eid'] for r in before['forward_rules'])
    additions['forward_rules'].append(forward)
    model = copy.deepcopy(template)
    model.update(id=next_id('models'), mid=str(max(int(m['mid']) for m in before['models'] if str(m['mid']).isdigit()) + 1),
                 model_id=MODEL, original_id=MODEL, model_id_alias='', name=LABEL, provider_id=public_group,
                 api_provider_id=api_group, billing_rule_id=billing['id'], forward_rule_ids=json.dumps([forward['id']]),
                 pre_deduction=rate * 4, is_active=1, sort_order=2, site_discount=1, site_discount_enabled=0,
                 global_discount=1, global_discount_enabled=0, group_ratios='{}',
                 description=f'720p；4-30秒；最多30图、10视频、10音频参考；{sale:.2f}元/秒',
                 remark='StarFrame backup 2026-09-21; minimum four-second reservation; settle actual duration',
                 created_at=timestamp, updated_at=timestamp)
    additions['models'].append(model)
    channel = copy.deepcopy(next(c for c in before['channels'] if c['base_url'].rstrip('/') == 'https://video.zhubo.asia'))
    channel.update(id=next_id('channels'), name=LABEL, base_url='https://api.xzapi.vip', api_key=credential,
                   category_id=category_group, models=json.dumps([model['mid']]), model_mapping=json.dumps({MODEL:MODEL}),
                   config='{}', preset_id=None, status=1, balance=None, quota_used=0, daily_quota_used=0,
                   weekly_quota_used=0, monthly_quota_used=0, created_at=timestamp, updated_at=timestamp)
    additions['channels'].append(channel)
    expected = {table: [*before[table], *additions[table]] for table in TABLES}
    sql = ['BEGIN;', "SET LOCAL lock_timeout='5s';", 'LOCK TABLE ' + ','.join(TABLES) + ' IN SHARE ROW EXCLUSIVE MODE;']
    sql.append(f"DO $$ BEGIN IF EXISTS(SELECT 1 FROM models WHERE model_id='{MODEL}' OR mid='{model['mid']}') THEN RAISE EXCEPTION 'Model added concurrently'; END IF; END $$;")
    for table in ['model_providers','model_api_providers','channel_categories','billing_rules','forward_rules','models','channels']:
        for row in additions[table]:
            payload = json.dumps(row, ensure_ascii=False).replace("'", "''")
            sql.append(f"INSERT INTO {table} SELECT * FROM jsonb_populate_record(NULL::{table},'{payload}'::jsonb);")
    migration = '\n'.join(sql)
    snapshot_sql = 'SELECT jsonb_build_object(' + ','.join(f"'{table}',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM {table} t)" for table in TABLES) + ');'

    def verify(actual):
        for table in TABLES:
            assert len(expected[table]) == len(actual[table]), table
            actual_rows = {r['id']:r for r in actual[table]}
            for row in expected[table]:
                omit = {'created_at','updated_at'} if row in additions[table] else set()
                # Live request usage may advance independently of the catalog change.
                if table == 'channels':
                    omit |= {key for key in row if key.endswith('_used') or key.startswith('last_reset_')}
                assert {k:v for k,v in row.items() if k not in omit} == {k:v for k,v in actual_rows[row['id']].items() if k not in omit}, f'Unexpected {table} mutation at ID {row["id"]}'
        actual_billing = next(r for r in actual['billing_rules'] if r['id'] == billing['id'])
        assert abs(actual_billing['duration_rate'] * exchange - sale) < 0.000001
        assert abs(json.loads(actual_billing['pricing_tiers'])[0]['rate'] * exchange - sale) < 0.000001

    preview = query(migration + '\n' + snapshot_sql + '\nROLLBACK;')
    verify(json.loads(next(line for line in preview.splitlines() if line.startswith('{'))))
    assert not any(m['model_id'] == MODEL for m in snapshot()['models'])
    (backup / 'migration.sql').write_text(migration + '\nCOMMIT;\n', encoding='utf-8')
    restore = f"BEGIN; UPDATE models SET is_active=0,updated_at=now() WHERE id={model['id']}; UPDATE channels SET status=0,updated_at=now() WHERE id={channel['id']}; COMMIT;\n"
    (backup / 'disable.sql').write_text(restore, encoding='utf-8')
    summary = {'site':site,'previewPassed':True,'backup':str(backup),'model':MODEL,'name':LABEL,'group':GROUP,
               'saleCnyPerSecond':sale,'minimumReservationCny':sale*4,'modelId':model['id'],'channelId':channel['id'],
               'billingRuleId':billing['id'],'forwardRuleId':forward['id']}
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    if apply:
        query(migration + '\nCOMMIT;')
        actual = snapshot()
        verify(actual)
        for table, digest in protected.items():
            assert query(f"SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM {table} t;") == digest
        (backup / 'after.json').write_text(json.dumps(actual, ensure_ascii=False), encoding='utf-8')
        (backup / 'verification.json').write_text(json.dumps(summary, ensure_ascii=False), encoding='utf-8')
        print(json.dumps({**summary,'applied':True,'verified':True}, ensure_ascii=False))


if __name__ == '__main__':
    main()
