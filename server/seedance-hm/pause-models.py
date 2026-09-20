"""Reversibly pause the two retired HM models on the old relay."""
import datetime
import json
import os
from pathlib import Path
import subprocess

TARGETS = {'seedance_v2.5-101010', 'seedance_v2.5-301010'}
PSQL = ['docker', 'exec', '-i', 'tokensbyte-postgres', 'psql', '-X', '-U', 'tokensapi', '-d', 'tokensapi', '-At', '-v', 'ON_ERROR_STOP=1']


def query(sql):
    return subprocess.run(PSQL, input=sql, text=True, capture_output=True, check=True).stdout.strip()


def snapshot():
    return json.loads(query("SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM models m;"))


if __name__ == '__main__':
    os.umask(0o077)
    before = snapshot()
    targets = [row for row in before if row['model_id'] in TARGETS]
    assert len(targets) == 2 and {row['model_id'] for row in targets} == TARGETS
    backup = Path('/opt/tokensbyte-backups') / ('pause-hm-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(mode=0o700)
    (backup / 'models-before.json').write_text(json.dumps(before, ensure_ascii=False), encoding='utf-8')
    restore = 'BEGIN;\n' + '\n'.join(
        f"UPDATE models SET is_active = {row['is_active']}, updated_at = now() WHERE id = {row['id']};"
        for row in targets) + '\nCOMMIT;\n'
    (backup / 'restore.sql').write_text(restore, encoding='utf-8')
    ids = ','.join(str(row['id']) for row in targets)
    query(f"BEGIN; SET LOCAL lock_timeout = '5s'; UPDATE models SET is_active = 0, updated_at = now() WHERE id IN ({ids}) AND is_active <> 0; COMMIT;")
    after = snapshot()
    assert len(before) == len(after)
    by_id = {row['id']: row for row in after}
    for row in before:
        current = by_id[row['id']]
        ignored = {'is_active', 'updated_at'} if row['model_id'] in TARGETS else set()
        assert {k: v for k, v in row.items() if k not in ignored} == {k: v for k, v in current.items() if k not in ignored}
        if row['model_id'] in TARGETS:
            assert current['is_active'] == 0
    (backup / 'models-after.json').write_text(json.dumps(after, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({'paused': sorted(TARGETS), 'backup': str(backup)}, ensure_ascii=False))
