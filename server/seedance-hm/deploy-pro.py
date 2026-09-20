"""Apply the scoped Pro migration on the old relay, retaining a private backup."""
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys

PSQL = ['docker', 'exec', '-i', 'tokensbyte-postgres', 'psql', '-X', '-U', 'tokensapi', '-d', 'tokensapi', '-At', '-v', 'ON_ERROR_STOP=1']


def query(sql):
    result = subprocess.run(PSQL, input=sql, text=True, capture_output=True, check=True)
    return result.stdout.strip()


def snapshot():
    return {table: json.loads(query(f'SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),\'[]\'::jsonb) FROM {table} t;'))
            for table in ['models', 'billing_rules', 'channels', 'model_providers', 'model_api_providers', 'channel_categories', 'channel_configs']}


def verify(before, after):
    old_channel = next(c for c in before['channels'] if c['base_url'].rstrip('/') in ['https://video.zhubo.asia', 'https://video.zhubo.asia/v1'])
    grouped = set(json.loads(old_channel['models']))
    for table in ['models', 'billing_rules', 'channels', 'model_providers', 'model_api_providers', 'channel_categories', 'channel_configs']:
        latest = {row['id']: row for row in after[table]}
        for row in before[table]:
            new = latest[row['id']]
            allowed = set()
            if table == 'models' and row['mid'] in grouped:
                allowed = {'provider_id', 'api_provider_id', 'updated_at'}
            if table == 'channels' and row['id'] == old_channel['id']:
                allowed = {'models', 'model_mapping', 'category_id', 'updated_at'}
            if table == 'channel_configs' and row['base_url'].rstrip('/') in ['https://video.zhubo.asia', 'https://video.zhubo.asia/v1']:
                allowed = {'category_id', 'updated_at'}
            # Usage counters may advance while customers are generating media.
            if table in ['channels', 'channel_configs']:
                allowed |= {key for key in row if 'used' in key or key.startswith('last_')}
            assert {k: v for k, v in row.items() if k not in allowed} == {k: v for k, v in new.items() if k not in allowed}, f'Unexpected existing {table} change at ID {row["id"]}'
    pro = next(m for m in after['models'] if m['model_id'] == 'seedance-2.5-pro')
    rule = next(b for b in after['billing_rules'] if b['id'] == pro['billing_rule_id'])
    assert rule['billing_type'] == 'duration'
    assert abs(rule['duration_rate'] * 6.75 - 1.06) < 0.000001
    assert all(abs(t['rate'] * 6.75 - 1.06) < 0.000001 for t in json.loads(rule['pricing_tiers']))
    channel = next(c for c in after['channels'] if c['id'] == old_channel['id'])
    assert set(json.loads(channel['models'])) == grouped | {pro['mid']}
    assert json.loads(channel['model_mapping']) == {**json.loads(old_channel['model_mapping'] or '{}'), 'seedance-2.5-pro': 'seedance-2.5-pro'}
    models = [m for m in after['models'] if m['mid'] in grouped | {pro['mid']}]
    assert len({m['provider_id'] for m in models}) == 1
    assert len({m['api_provider_id'] for m in models}) == 1
    return {'model': pro['model_id'], 'saleCnyPerSecond': 1.06, 'groupedModels': [m['model_id'] for m in models], 'channel': channel['id']}


if __name__ == '__main__':
    os.umask(0o077)
    sql = Path(sys.argv[1]).read_text(encoding='utf-8-sig')
    assert sql.count('COMMIT;') == 1
    before = snapshot()
    assert not any(m['model_id'] == 'seedance-2.5-pro' for m in before['models']), 'Pro already exists'
    backup = Path('/opt/tokensbyte-backups') / ('zhubo-pro-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(mode=0o700)
    with (backup / 'before.dump').open('wb') as target:
        subprocess.run(['docker', 'exec', 'tokensbyte-postgres', 'pg_dump', '-U', 'tokensapi', '-d', 'tokensapi', '-Fc'], stdout=target, check=True)
    (backup / 'before.json').write_text(json.dumps(before, ensure_ascii=False), encoding='utf-8')
    (backup / 'migration.sql').write_text(sql, encoding='utf-8')
    query(sql.replace('COMMIT;', 'ROLLBACK;'))
    assert len(snapshot()['models']) == len(before['models']), 'Dry run did not roll back'
    print('Dry run passed; private backup: ' + str(backup), flush=True)
    if '--apply' in sys.argv:
        query(sql)
        after = snapshot()
        (backup / 'after.json').write_text(json.dumps(after, ensure_ascii=False), encoding='utf-8')
        result = verify(before, after)
        (backup / 'verification.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=False))
