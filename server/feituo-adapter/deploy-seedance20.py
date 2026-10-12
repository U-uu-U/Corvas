"""Update only Feituo's two Seedance 2.0 routes; credentials stay on the relays."""
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
import shlex
import time

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('relay_connection', HERE.parent/'jijiu-seedance/deploy.py')
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)
RELAY_DIR = '/opt/corvas-feituo/server/feituo-adapter'
CONFIG_DIR = '/srv/flow-config/feituo20-add'
BASELINES = {'adapter.py': '1b38282a3e17ecf3a7003ad9bf400703714f8b69313e11175563c7472d2867fd',
             'models.json': '073046500a4d1f8ae50451ca3d99ee404500ef801f054f43bf83d917d71ed2f9'}


def stage(client, site):
    directory = CONFIG_DIR if site == 'config' else RELAY_DIR
    names = ['models.json', 'catalog.mjs', 'seedance20-catalog.mjs', 'publish-seedance20.mjs'] if site == 'config' else ['add-seedance20.py']
    sftp = client.open_sftp()
    try:
        remote.run(client, 'mkdir -p '+shlex.quote(directory))
        for name in names:
            target = directory+'/'+name
            raw = (HERE/name).read_bytes()
            try:
                with sftp.open(target, 'rb') as source:
                    assert source.read() == raw, 'Staged source differs; review before updating'
            except FileNotFoundError:
                with sftp.open(target, 'wb') as output:
                    output.write(raw)
                sftp.chmod(target, 0o644)
        print(json.dumps({'site': site, 'staged': names}))
    finally:
        sftp.close()


def update(client, site, apply):
    assert site in ('art', 'cart')
    container = 'tokensbyte-postgres' if site == 'art' else 'tkeapi-postgres'
    sql = "SELECT count(*) FROM logs WHERE is_completed=0 AND channel_id IN (SELECT id FROM channels WHERE base_url='http://feituo-adapter:3012');"
    assert remote.run(client, 'docker exec '+container+' psql -X -qAt -U tokensapi -d tokensapi -c '+shlex.quote(sql)).strip() == '0', 'Pending Feituo jobs; defer adapter update'
    check = "from pathlib import Path; print(sum(1 for f in ('/proc/net/tcp','/proc/net/tcp6') for line in Path(f).read_text().splitlines()[1:] if line.split()[1].endswith(':0BC4') and line.split()[3]=='01'))"
    def idle():
        return remote.run(client, 'docker exec feituo-adapter python -B -c '+shlex.quote(check)).strip() == '0'
    assert idle(), 'Active adapter requests; retry when idle'
    sftp = client.open_sftp()
    try:
        before = {}
        desired = {name: (HERE/name).read_bytes() for name in BASELINES}
        for name, digest in BASELINES.items():
            with sftp.open(RELAY_DIR+'/'+name, 'rb') as source:
                before[name] = source.read()
            assert hashlib.sha256(before[name]).hexdigest() == digest or before[name] == desired[name], 'Live adapter differs from reviewed baseline'
        if before == desired:
            print(json.dumps({'site': site, 'unchanged': True}))
            return
        assert json.loads(before['models.json']) == json.loads(desired['models.json'])[:3], 'Existing model specifications changed'
        if not apply:
            print(json.dumps({'site': site, 'ready': True, 'applied': False}))
            return
        backup = '/var/backups/corvas-feituo20-'+site+'-'+dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        remote.run(client, 'mkdir -p '+shlex.quote(backup))
        for name, raw in desired.items():
            target = RELAY_DIR+'/'+name
            remote.run(client, 'cp -p '+shlex.quote(target)+' '+shlex.quote(backup+'/'+name))
            with sftp.open(target+'.next', 'wb') as output:
                output.write(raw)
            sftp.chmod(target+'.next', 0o644)
        assert idle(), 'Active adapter requests; retry when idle'
        for name, raw in before.items():
            with sftp.open(RELAY_DIR+'/'+name, 'rb') as source:
                assert source.read() == raw, 'Live adapter changed concurrently'
        try:
            for name in desired:
                sftp.posix_rename(RELAY_DIR+'/'+name+'.next', RELAY_DIR+'/'+name)
            remote.run(client, 'docker restart --time 15 feituo-adapter')
            probe = "import json,urllib.request; p=json.load(urllib.request.urlopen('http://127.0.0.1:3012/health',timeout=3)); assert p['ok'] and p['models']==4; print('ok')"
            healthy = False
            for _ in range(5):
                try:
                    healthy = remote.run(client, 'docker exec feituo-adapter python -B -c '+shlex.quote(probe)).strip() == 'ok'
                except RuntimeError:
                    pass
                if healthy:
                    break
                time.sleep(1)
            assert healthy, 'Adapter health check failed'
        except Exception:
            for name in desired:
                remote.run(client, 'cp -p '+shlex.quote(backup+'/'+name)+' '+shlex.quote(RELAY_DIR+'/'+name))
            remote.run(client, 'docker restart --time 15 feituo-adapter')
            raise
        print(json.dumps({'site': site, 'applied': True, 'healthy': True, 'backup': backup,
                          'files': {name: hashlib.sha256(raw).hexdigest() for name, raw in desired.items()}}))
    finally:
        sftp.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('site', choices=['art', 'cart', 'config'])
    parser.add_argument('action', choices=['stage', 'update', 'configure', 'publish'])
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    client, jump = remote.connect(args.site)
    try:
        if args.action == 'stage':
            stage(client, args.site)
        elif args.action == 'update':
            update(client, args.site, args.apply)
        elif args.action == 'configure':
            assert args.site in ('art', 'cart')
            print(remote.run(client, 'python3 -B '+RELAY_DIR+'/add-seedance20.py '+args.site+(' --apply' if args.apply else '')))
        else:
            assert args.site == 'config'
            print(remote.run(client, 'runuser -u flowconfig -- /srv/flow-config/runtime/node '+CONFIG_DIR+'/publish-seedance20.mjs'+(' --apply' if args.apply else '')))
    finally:
        client.close()
        if jump:
            jump.close()


if __name__ == '__main__':
    main()
