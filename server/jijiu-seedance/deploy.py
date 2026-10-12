"""Deploy the Jijiu catalog integration using private environment credentials."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shlex
import sys
import time
import paramiko

HERE = Path(__file__).resolve().parent
RELAY_DIR = '/opt/corvas-jijiu/server/jijiu-seedance'
CONFIG_DIR = '/srv/flow-config/jijiu-add'
sys.stdout.reconfigure(encoding='utf-8')


def connect(site):
    host, port = {'art': ('45.192.100.246', 24775), 'cart': ('154.12.57.129', 26098), 'config': ('154.12.57.162', 22)}[site]
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.load_host_keys(os.path.expanduser('~/.ssh/known_hosts'))
    for kind, key in (client.get_host_keys().lookup(host) or {}).items():
        client.get_host_keys().add(f'[{host}]:{port}', kind, key)
    options = dict(hostname=host, port=port, username='root', timeout=15, auth_timeout=15)
    jump = None
    if site == 'art':
        options['key_filename'] = os.path.expanduser('~/.ssh/neurolimb-server-ed25519')
        if os.environ.get('JIJIU_ART_VIA_CART') == '1':
            jump, _ = connect('cart')
            options['sock'] = jump.get_transport().open_channel('direct-tcpip', (host, port), ('127.0.0.1', 0), timeout=15)
    else:
        options['password'] = os.environ['CONFIG_SSH_PASSWORD' if site == 'config' else 'FLOW_TASK_SSH_PASSWORD']
    if site == 'config':
        jump, _ = connect('art')
        options['sock'] = jump.get_transport().open_channel('direct-tcpip', (host, port), ('127.0.0.1', 0), timeout=15)
    client.connect(**options)
    client.get_transport().set_keepalive(5)
    return client, jump


def run(client, command, payload=''):
    stdin, stdout, stderr = client.exec_command(command, timeout=90)
    if payload:
        stdin.write(payload.encode('utf-8'))
        stdin.flush()
        stdin.channel.shutdown_write()
    output, error = stdout.read().decode('utf-8'), stderr.read().decode('utf-8')
    if stdout.channel.recv_exit_status():
        secret = os.environ.get('JIJIU_API_KEY', '')
        raise RuntimeError(error.replace(secret, '[redacted]')[-2000:] if secret else error[-2000:])
    return output


def update_adapter(client, site, apply):
    assert site in ('art', 'cart')
    target = RELAY_DIR+'/adapter.py'
    raw = (HERE/'adapter.py').read_bytes()
    compile(raw, 'adapter.py', 'exec')
    sftp = client.open_sftp()
    try:
        with sftp.open(target, 'rb') as source:
            before = source.read()
        if before == raw:
            print(json.dumps({'site': site, 'unchanged': True}))
            return
        check = "from pathlib import Path; print(sum(1 for f in ('/proc/net/tcp','/proc/net/tcp6') for line in Path(f).read_text().splitlines()[1:] if line.split()[1].endswith(':0BC6') and line.split()[3]=='01'))"
        def active():
            return int(run(client, 'docker exec jijiu-video-adapter python -B -c '+shlex.quote(check)).strip())
        assert active() == 0, 'Adapter has active requests; retry when idle'
        if not apply:
            print(json.dumps({'site': site, 'ready': True, 'applied': False}))
            return
        backup = '/var/backups/corvas-jijiu-'+site+'-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        run(client, 'mkdir -p '+shlex.quote(backup))
        run(client, 'cp -p '+shlex.quote(target)+' '+shlex.quote(backup+'/adapter.py'))
        with sftp.open(target+'.next', 'wb') as destination:
            destination.write(raw)
        sftp.chmod(target+'.next', 0o644)
        with sftp.open(target, 'rb') as source:
            assert source.read() == before, 'Adapter changed concurrently'
        assert active() == 0, 'Adapter has active requests; retry when idle'
        try:
            sftp.posix_rename(target+'.next', target)
            run(client, 'docker restart --time 15 jijiu-video-adapter')
            healthy = False
            probe = "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:3014/health',timeout=3).read().decode())"
            for _ in range(5):
                try:
                    healthy = json.loads(run(client, 'docker exec jijiu-video-adapter python -B -c '+shlex.quote(probe)))['ok'] is True
                except RuntimeError:
                    pass
                if healthy:
                    break
                time.sleep(1)
            assert healthy, 'Updated adapter failed its health check'
        except Exception:
            run(client, 'cp -p '+shlex.quote(backup+'/adapter.py')+' '+shlex.quote(target))
            run(client, 'docker restart --time 15 jijiu-video-adapter')
            raise
        print(json.dumps({'site': site, 'applied': True, 'healthy': healthy, 'backup': backup, 'sha256': hashlib.sha256(raw).hexdigest()}))
    finally:
        sftp.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('site', choices=['art', 'cart', 'config'])
    parser.add_argument('action', choices=['stage', 'configure', 'publish', 'update'])
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    client, jump = connect(args.site)
    try:
        if args.action == 'stage':
            directory = CONFIG_DIR if args.site == 'config' else RELAY_DIR
            files = {'model.json': HERE/'model.json'}
            if args.site == 'config':
                files.update({name: HERE/name for name in ['catalog.mjs', 'publish.mjs']})
            else:
                files['configure.py'] = HERE/'configure.py'
                files.update({name: HERE/name for name in ['adapter.py', 'compose.yml']})
                files['../seedance-hm/add-zhubo-september.py'] = HERE.parent/'seedance-hm/add-zhubo-september.py'
            sftp = client.open_sftp()
            try:
                for name, local in files.items():
                    target = directory+'/'+name
                    raw = local.read_bytes()
                    try:
                        with sftp.open(target, 'rb') as source:
                            assert source.read() == raw, 'Existing deployment differs; review before overwriting'
                    except FileNotFoundError:
                        run(client, 'mkdir -p '+shlex.quote(target.rsplit('/', 1)[0]))
                        with sftp.open(target, 'wb') as output:
                            output.write(raw)
                        sftp.chmod(target, 0o644)
                print(json.dumps({'site': args.site, 'staged': list(files)}))
            finally:
                sftp.close()
            if args.site in ('art', 'cart'):
                network = 'tokensbyte-network' if args.site == 'art' else 'tkeapi-network'
                print(run(client, 'NETWORK_NAME='+network+' docker compose -p corvas-jijiu -f '+RELAY_DIR+'/compose.yml up -d'))
        elif args.action == 'update':
            update_adapter(client, args.site, args.apply)
        elif args.action == 'configure':
            assert args.site in ('art', 'cart')
            payload = json.dumps({'apiKey': os.environ['JIJIU_API_KEY']})
            command = 'python3 -B '+RELAY_DIR+'/configure.py '+args.site+(' --apply' if args.apply else '')
            print(run(client, command, payload))
        else:
            assert args.site == 'config'
            command = 'runuser -u flowconfig -- /srv/flow-config/runtime/node '+CONFIG_DIR+'/publish.mjs'
            print(run(client, command+(' --apply' if args.apply else '')))
    finally:
        client.close()
        if jump:
            jump.close()


if __name__ == '__main__':
    main()
