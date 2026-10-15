"""Stage and run this independent integration without touching client release files."""
import argparse
import importlib.util
import json
from pathlib import Path
import shlex

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('relay_connection', HERE.parent / 'jijiu-seedance/deploy.py')
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)
RELAY_DIR = '/opt/corvas-yihong-cheap/server/yihong-cheap'
CONFIG_DIR = '/srv/flow-config/yihong-cheap-add'


def stage(client, site):
    directory = CONFIG_DIR if site == 'config' else RELAY_DIR
    names = ['catalog.mjs', 'publish.mjs'] if site == 'config' else ['adapter.py', 'configure.py', 'compose.yml']
    files = {name: HERE / name for name in names}
    if site != 'config':
        files['media.py'] = HERE.parent / 'dola-discount/media.py'
        files['../seedance-hm/add-zhubo-september.py'] = HERE.parent / 'seedance-hm/add-zhubo-september.py'
        files['../seedance-yihong/configure.py'] = HERE.parent / 'seedance-yihong/configure.py'
    sftp = client.open_sftp()
    try:
        for name, source in files.items():
            target = directory + '/' + name
            raw = source.read_bytes()
            remote.run(client, 'mkdir -p ' + shlex.quote(str(Path(target).parent).replace('\\', '/')))
            try:
                with sftp.open(target, 'rb') as existing:
                    assert existing.read() == raw, 'Staged integration differs; review before replacing'
            except FileNotFoundError:
                with sftp.open(target, 'wb') as destination:
                    destination.write(raw)
                sftp.chmod(target, 0o644)
        if site != 'config':
            previous = json.loads(remote.run(client, 'docker inspect dola-discount-adapter'))[0]
            networks = list(previous['NetworkSettings']['Networks'])
            assert len(networks) == 1
            media = next(item['Source'] for item in previous['Mounts'] if item['Destination'] == '/media')
            environment = dict(item.split('=', 1) for item in previous['Config']['Env'] if '=' in item)
            content = '\n'.join(['NETWORK_NAME=' + networks[0], 'MEDIA_HOST_DIR=' + media, 'PUBLIC_MEDIA=' + environment['PUBLIC_MEDIA']]) + '\n'
            with sftp.open(directory + '/.env', 'w') as destination:
                destination.write(content)
            sftp.chmod(directory + '/.env', 0o600)
        print(json.dumps({'site': site, 'staged': list(files)}))
    finally:
        sftp.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('site', choices=['art', 'cart', 'config'])
    parser.add_argument('action', choices=['stage', 'start', 'configure', 'publish'])
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    client, jump = remote.connect(args.site)
    try:
        if args.action == 'stage':
            stage(client, args.site)
        elif args.action == 'start':
            assert args.site != 'config'
            print(remote.run(client, 'cd ' + shlex.quote(RELAY_DIR) + ' && docker compose -f compose.yml up -d'))
            probe = "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:3015/health',timeout=5).read().decode())"
            print(remote.run(client, 'docker exec yihong-cheap-adapter python -B -c ' + shlex.quote(probe)))
        elif args.action == 'configure':
            assert args.site != 'config'
            print(remote.run(client, 'python3 -B ' + shlex.quote(RELAY_DIR + '/configure.py') + ' ' + args.site + (' --apply' if args.apply else '')))
        else:
            assert args.site == 'config'
            print(remote.run(client, 'runuser -u flowconfig -- /srv/flow-config/runtime/node ' + shlex.quote(CONFIG_DIR + '/publish.mjs') + (' --apply' if args.apply else '')))
    finally:
        client.close()
        if jump:
            jump.close()


if __name__ == '__main__':
    main()
