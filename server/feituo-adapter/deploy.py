"""Deploy only the Feituo adapter/catalog. Credentials are supplied in environment variables."""
import argparse
import base64
import json
import os
from pathlib import Path
import shlex
import subprocess

import paramiko

HERE = Path(__file__).resolve().parent
RELAY_DIR = '/opt/corvas-feituo/server/feituo-adapter'
CONFIG_DIR = '/srv/flow-config/feituo-add'


class Remote:
    def __init__(self, site):
        self.site = site
        self.client = None
        if site != 'art':
            self.client = paramiko.SSHClient()
            self.client.load_system_host_keys()
            self.client.load_host_keys(os.path.expanduser('~/.ssh/known_hosts'))
            host, port = ('154.12.57.129', 26098) if site == 'cart' else ('154.12.57.162', 22)
            variable = 'FLOW_TASK_SSH_PASSWORD' if site == 'cart' else 'CONFIG_SSH_PASSWORD'
            self.client.connect(host, port=port, username='root', password=os.environ[variable],
                                allow_agent=False, look_for_keys=False, timeout=15, auth_timeout=15)

    def run(self, command, payload='', timeout=120):
        if self.client is None:
            result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'hk-direct', command],
                                    input=payload.encode('utf-8'), capture_output=True, timeout=timeout)
            code, output, error = result.returncode, result.stdout.decode('utf-8'), result.stderr.decode('utf-8')
        else:
            stdin, stdout, stderr = self.client.exec_command(command, timeout=timeout)
            stdin.write(payload.encode('utf-8'))
            stdin.channel.shutdown_write()
            output, error = stdout.read().decode('utf-8'), stderr.read().decode('utf-8')
            code = stdout.channel.recv_exit_status()
        if code:
            raise RuntimeError(f'Remote command failed ({code}): {error[-3000:]}')
        return output

    def close(self):
        if self.client:
            self.client.close()


def upload_sources(remote, directory, names, helper=False):
    files = {name: base64.b64encode((HERE / name).read_bytes()).decode('ascii') for name in names}
    if helper:
        files['../seedance-hm/add-zhubo-september.py'] = base64.b64encode(
            (HERE.parent / 'seedance-hm/add-zhubo-september.py').read_bytes()).decode('ascii')
    data = {'directory': directory, 'files': files, 'config': remote.site == 'config'}
    code = '''import base64, json, os, pathlib, pwd
data = json.loads(base64.b64decode(PAYLOAD))
root = pathlib.Path(data['directory'])
assert not root.exists(), 'Deployment directory already exists; inspect before updating'
root.mkdir(parents=True, mode=0o755)
for name, encoded in data['files'].items():
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(base64.b64decode(encoded))
    path.chmod(0o644)
    if data['config']:
        user = pwd.getpwnam('flowconfig')
        os.chown(path, user.pw_uid, user.pw_gid)
print(json.dumps({'uploaded': list(data['files']), 'directory': str(root)}))
'''.replace('PAYLOAD', repr(base64.b64encode(json.dumps(data).encode()).decode()))
    print(remote.run('python3 -B -', code).strip())


def update_adapter(remote, apply):
    data = {'directory': RELAY_DIR, 'site': remote.site, 'apply': apply,
            'files': {name: base64.b64encode((HERE / name).read_bytes()).decode('ascii')
                      for name in ('adapter.py', 'repair-download.py')}}
    code = '''import base64, datetime, hashlib, json, pathlib, shutil, subprocess, time
data = json.loads(base64.b64decode(PAYLOAD))
root = pathlib.Path(data['directory'])
assert root.is_dir(), 'Adapter must already be deployed'
container = 'tokensbyte-postgres' if data['site'] == 'art' else 'tkeapi-postgres'
info = json.loads(subprocess.check_output(['docker', 'inspect', container], text=True))[0]
env = dict(x.split('=', 1) for x in info['Config']['Env'] if '=' in x)
user = env.get('POSTGRES_USER', 'postgres')
sql = "SELECT count(*) FROM logs WHERE is_completed=0 AND channel_id IN (SELECT id FROM channels WHERE base_url='http://feituo-adapter:3012');"
pending = subprocess.run(['docker', 'exec', '-i', container, 'psql', '-X', '-qAt', '-U', user,
    '-d', env.get('POSTGRES_DB', user)], input=sql, text=True, capture_output=True, check=True)
assert pending.stdout.strip() == '0', 'Pending Feituo jobs; defer adapter restart'
check = "from pathlib import Path; print(sum(1 for f in ('/proc/net/tcp','/proc/net/tcp6') for line in Path(f).read_text().splitlines()[1:] if line.split()[1].endswith(':0BC4') and line.split()[3]=='01'))"
active = subprocess.check_output(['docker', 'exec', 'feituo-adapter', 'python', '-B', '-c', check], text=True)
assert active.strip() == '0', 'Active adapter connections; defer restart'
files = {name: base64.b64decode(raw) for name, raw in data['files'].items()}
for name, raw in files.items(): compile(raw, name, 'exec')
receipt = {'site': data['site'], 'pendingJobs': 0, 'activeConnections': 0, 'applied': False}
if data['apply']:
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = pathlib.Path('/var/backups') / ('corvas-feituo-download-' + data['site'] + '-' + stamp)
    backup.mkdir(mode=0o700)
    for name, raw in files.items():
        target = root / name
        if target.exists(): shutil.copy2(target, backup / name)
        staging = root / (name + '.download-next')
        staging.write_bytes(raw)
        staging.chmod(0o644)
        staging.replace(target)
    subprocess.run(['docker', 'restart', '--time', '10', 'feituo-adapter'], check=True, capture_output=True)
    health = "import json,urllib.request; print(json.loads(urllib.request.urlopen('http://127.0.0.1:3012/health',timeout=3).read())['ok'])"
    healthy = False
    for _ in range(10):
        result = subprocess.run(['docker', 'exec', 'feituo-adapter', 'python', '-B', '-c', health], capture_output=True, text=True)
        if result.returncode == 0 and result.stdout.strip() == 'True':
            healthy = True; break
        time.sleep(1)
    assert healthy, 'Updated adapter not healthy; inspect backup before continuing'
    receipt.update(applied=True, backup=str(backup), adapterHealthy=True,
                   sha256=hashlib.sha256(files['adapter.py']).hexdigest())
print(json.dumps(receipt))
'''.replace('PAYLOAD', repr(base64.b64encode(json.dumps(data).encode()).decode()))
    print(remote.run('python3 -B -', code).strip())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('site', choices=['art', 'cart', 'config'])
    parser.add_argument('action', choices=['stage', 'configure', 'publish', 'update', 'repair'])
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--log-id', type=int)
    parser.add_argument('--task-id')
    args = parser.parse_args()
    remote = Remote(args.site)
    try:
        if args.action == 'stage':
            if args.site == 'config':
                upload_sources(remote, CONFIG_DIR, ['models.json', 'catalog.mjs', 'publish.mjs'])
            else:
                upload_sources(remote, RELAY_DIR, ['adapter.py', 'models.json', 'configure.py', 'compose.yml'], helper=True)
                network = 'tokensbyte-network' if args.site == 'art' else 'tkeapi-network'
                backend = 'tokensbyte-backend' if args.site == 'art' else 'tkeapi-backend'
                code = f'''import json, os, subprocess
network = {network!r}
backend = {backend!r}
info = json.loads(subprocess.check_output(['docker', 'inspect', backend], text=True))[0]
assert network in info['NetworkSettings']['Networks'], 'Relay network mismatch'
env = dict(os.environ, NETWORK_NAME=network)
subprocess.run(['docker', 'compose', '-p', 'corvas-feituo', '-f', {RELAY_DIR + '/compose.yml'!r}, 'up', '-d'], env=env, check=True)
print(json.dumps({{'adapterStarted': True, 'network': network}}))
'''
                print(remote.run('python3 -B -', code).strip())
        elif args.action == 'update':
            assert args.site in ('art', 'cart')
            update_adapter(remote, args.apply)
        elif args.action == 'repair':
            assert args.site in ('art', 'cart') and args.log_id and args.task_id
            command = f'python3 -B {shlex.quote(RELAY_DIR + "/repair-download.py")} {args.site}'
            command += f' --log-id {int(args.log_id)} --task-id {shlex.quote(args.task_id)}'
            print(remote.run(command + (' --apply' if args.apply else '')).strip())
        elif args.action == 'configure':
            assert args.site in ('art', 'cart')
            payload = json.dumps({'apiKey': os.environ['FEITUO_API_KEY']})
            command = f'python3 -B {shlex.quote(RELAY_DIR + "/configure.py")} {args.site}' + (' --apply' if args.apply else '')
            print(remote.run(command, payload).strip())
        else:
            assert args.site == 'config'
            command = 'runuser -u flowconfig -- /srv/flow-config/runtime/node ' + CONFIG_DIR + '/publish.mjs'
            print(remote.run(command + (' --apply' if args.apply else '')).strip())
    finally:
        remote.close()


if __name__ == '__main__':
    main()
