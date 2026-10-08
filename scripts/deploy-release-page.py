"""Host Corvas releases on cart and mirror the cover on art; credentials remain external."""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import urllib.request
import urllib.error
import uuid
import paramiko

ROOT = Path(__file__).resolve().parents[1]

def connect(site='cart'):
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.load_host_keys(os.path.expanduser('~/.ssh/known_hosts'))
    host, port = ('45.192.100.246', 24775) if site == 'art' else ('154.12.57.129', 26098)
    if client.get_host_keys().lookup(host):
        for kind, key in client.get_host_keys().lookup(host).items():
            client.get_host_keys().add(f'[{host}]:{port}', kind, key)
    client.connect(host, port, username='root', timeout=15,
                   key_filename=os.path.expanduser('~/.ssh/neurolimb-server-ed25519') if site == 'art' else None,
                   password=os.environ.get('FLOW_TASK_SSH_PASSWORD') if site == 'cart' else None)
    return client

def run(client, command, timeout=30):
    _, out, err = client.exec_command(command, timeout=timeout)
    text = out.read().decode('utf-8'); error = err.read().decode('utf-8')
    if out.channel.recv_exit_status(): raise RuntimeError(error[:2000] or 'Remote command failed')
    return text

def digest(file):
    value = hashlib.sha256()
    with file.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''): value.update(block)
    return value.hexdigest()

def digest512(file):
    value = hashlib.sha512()
    with file.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''): value.update(block)
    return base64.b64encode(value.digest()).decode('ascii')

def mirror_legacy(client):
    health = json.loads(run(client, 'curl --fail --silent --show-error --max-time 20 https://cart.ravenhash.org/corvas/health'))
    if health.get('ok') is not True: raise RuntimeError('Release backend is not healthy')
    original = run(client, 'cat /etc/caddy/Caddyfile')
    anchor = 'art.ravenhash.org {'
    if original.count(anchor) != 1: raise ValueError('Legacy vhost is not uniquely identifiable')
    rule = '''    @corvas_release path /corvas /corvas/*
    handle @corvas_release {
        reverse_proxy https://cart.ravenhash.org {
            header_up Host cart.ravenhash.org
            header_up -Authorization
            header_up -Proxy-Authorization
            header_up -Cookie
            header_up -X-Api-Key
            transport http {
                dial_timeout 10s
                response_header_timeout 30s
            }
        }
    }
'''
    marker = '@corvas_release path /corvas /corvas/*'
    if marker in original:
        if rule not in original: raise ValueError('Existing release mirror differs; inspect before replacing')
        print(json.dumps({'changed': False, 'url': 'https://art.ravenhash.org/corvas', 'version': health['version']}))
        return
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = '/var/backups/corvas-release-mirror-' + stamp
    run(client, f'mkdir -p {backup}')
    run(client, f'cp -p /etc/caddy/Caddyfile {backup}/Caddyfile')
    candidate = original.replace(anchor, anchor + chr(10) + rule, 1)
    sftp = client.open_sftp()
    try:
        with sftp.file('/etc/caddy/Caddyfile.corvas-next', 'w') as remote: remote.write(candidate)
        run(client, 'caddy validate --config /etc/caddy/Caddyfile.corvas-next --adapter caddyfile')
        if run(client, 'cat /etc/caddy/Caddyfile') != original: raise RuntimeError('Proxy config changed during validation')
        try:
            run(client, 'mv /etc/caddy/Caddyfile.corvas-next /etc/caddy/Caddyfile && systemctl reload caddy')
            live = json.loads(run(client, 'curl --fail --silent --show-error --max-time 25 --resolve art.ravenhash.org:443:127.0.0.1 https://art.ravenhash.org/corvas/health'))
            if live.get('ok') is not True: raise RuntimeError('Mirror health check failed')
        except Exception:
            run(client, f'cp -p {backup}/Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy')
            raise
        receipt = {'changed': True, 'site': 'art', 'url': 'https://art.ravenhash.org/corvas',
                   'version': live['version'], 'backend': 'https://cart.ravenhash.org/corvas', 'backup': backup}
        (ROOT / 'output/release-page-art-deployed.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
        print(json.dumps(receipt))
    finally: sftp.close()

def github_sources(metadata):
    def gh(*arguments):
        return json.loads(subprocess.check_output(['gh', *arguments], text=True))
    for run_id in [metadata['windowsRunId'], metadata['macosRunId']]:
        build = gh('run', 'view', str(run_id), '--json', 'conclusion,headSha')
        if build['conclusion'] != 'success' or build['headSha'] != metadata['sourceCommit']:
            raise ValueError('Build source does not match this release')
    artifacts = gh('api', f"repos/U-uu-U/Corvas/actions/runs/{metadata['windowsRunId']}/artifacts")['artifacts']
    archive = next(item for item in artifacts if item['name'] == 'corvas-windows-x64' and not item['expired'])
    release = gh('release', 'view', 'v' + metadata['version'], '--json', 'assets,isDraft')
    if release['isDraft']:
        raise ValueError('Release must be published before site deployment')
    tag = gh('api', f"repos/U-uu-U/Corvas/commits/v{metadata['version']}", '--jq', '{sha:.sha}')
    if tag['sha'] != metadata['sourceCommit']:
        raise ValueError('Release tag source does not match')
    for expected in metadata['assets']:
        asset = next((item for item in release['assets'] if item['name'] == expected['name']), None)
        if not asset or asset['size'] != expected['bytes'] or asset.get('digest') != 'sha256:' + expected['sha256']:
            raise ValueError('Published asset differs from build provenance')
    dmg = next(item for item in release['assets'] if item['name'] == f"Corvas.{metadata['version']}.mac.universal.dmg")
    token = subprocess.check_output(['gh', 'auth', 'token'], text=True).strip()
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs): return None
    def signed(api, accept):
        request = urllib.request.Request(api, headers={'Authorization': 'Bearer ' + token, 'Accept': accept})
        try:
            urllib.request.build_opener(NoRedirect()).open(request, timeout=25)
        except urllib.error.HTTPError as error:
            if error.code == 302: return error.headers['Location']
        raise RuntimeError('Could not get official download grant')
    return [
        {'url': signed(f"https://api.github.com/repos/U-uu-U/Corvas/actions/artifacts/{archive['id']}/zip", 'application/vnd.github+json'),
         'format': 'zip', 'size': archive['size_in_bytes'], 'sha256': archive['digest'].removeprefix('sha256:'),
         'names': [f"Corvas.Setup.{metadata['version']}.exe", f"Corvas.{metadata['version']}.exe"]},
        {'url': signed(dmg['apiUrl'], 'application/octet-stream'), 'format': 'dmg', 'size': dmg['size'],
         'sha256': dmg['digest'].removeprefix('sha256:'), 'names': [dmg['name']]}
    ]

def deploy(client, release_dir, notes_file, from_github=False):
    release_dir = release_dir.resolve()
    metadata = json.loads((release_dir / 'build-provenance.json').read_text(encoding='utf-8'))
    version = metadata['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)?', version):
        raise ValueError('Invalid version')
    if not re.fullmatch(r'[a-f0-9]{40}', metadata['sourceCommit']): raise ValueError('Invalid source commit')
    if metadata.get('verification', {}).get('bothBuildsSucceeded') is not True: raise ValueError('Both platform builds must be verified')
    names = {f'Corvas.Setup.{version}.exe': 'windows', f'Corvas.{version}.mac.universal.dmg': 'macos',
             f'Corvas.{version}.exe': 'windows-portable'}
    assets = []
    for name, platform in names.items():
        record = next((item for item in metadata['assets'] if item['name'] == name), None)
        file = release_dir / name
        if (not record or not re.fullmatch(r'[a-f0-9]{64}', record.get('sha256', ''))
                or not isinstance(record.get('bytes'), int) or not 0 < record['bytes'] <= 1024 ** 3):
            raise ValueError('Unverified installer: ' + name)
        if not from_github and (not file.is_file() or file.stat().st_size != record['bytes'] or digest(file) != record['sha256']):
            raise ValueError('Unverified local installer: ' + name)
        assets.append({'platform': platform, 'name': name, 'bytes': record['bytes'], 'sha256': record['sha256'],
                       **({'sha512': digest512(file)} if not from_github else {})})
    notes = json.loads(notes_file.read_text(encoding='utf-8'))
    if not isinstance(notes, list) or not all(isinstance(note, str) and len(note) <= 500 for note in notes):
        raise ValueError('Notes must be a JSON string array')
    manifest = {'version': version, 'sourceCommit': metadata['sourceCommit'],
                'publishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'notes': notes, 'assets': assets}
    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = f'/var/backups/corvas-release-page-{timestamp}'
    base = '/opt/corvas-release-page'
    data = '/var/lib/corvas-releases'
    run(client, f'mkdir -p {backup} {base}/runtime {data}/releases')
    run(client, f'cp -p /etc/caddy/Caddyfile {backup}/Caddyfile')
    run(client, f'if test -f {data}/current.json; then cp -p {data}/current.json {backup}/current.json; fi')
    run(client, 'id -u corvasrelease >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin corvasrelease')
    run(client, f'if ! test -x {base}/runtime/node; then install -m 755 /root/.nvm/versions/node/v24.21.0/bin/node {base}/runtime/node; fi')
    sftp = client.open_sftp(); sftp.get_channel().settimeout(90)
    def put_text(target, content, mode=0o644):
        with sftp.file(target, 'w') as remote: remote.write(content)
        sftp.chmod(target, mode)
    def verify_remote(directory):
        for asset in assets:
            remote_file = shlex.quote(directory + '/' + asset['name'])
            if run(client, f'sha256sum {remote_file}', timeout=40).split()[0] != asset['sha256']:
                raise ValueError('Remote installer checksum mismatch')
            sha512 = bytes.fromhex(run(client, f'sha512sum {remote_file}', timeout=40).split()[0])
            actual = base64.b64encode(sha512).decode('ascii')
            if asset.get('sha512') not in (None, actual): raise ValueError('Remote SHA512 mismatch')
            asset['sha512'] = actual
    target = f'{data}/releases/{version}'
    try:
        with sftp.file(target + '/release.json') as remote: old = json.load(remote)
    except FileNotFoundError: old = None
    if old:
        verify_remote(target)
        prior = [{key: value for key, value in asset.items() if key != 'sha512'} for asset in old['assets']]
        expected = [{key: value for key, value in asset.items() if key != 'sha512'} for asset in assets]
        if prior != expected or old['sourceCommit'] != metadata['sourceCommit'] or old['notes'] != notes:
            raise ValueError('Existing version differs; publish a new version instead')
        if any(before.get('sha512') not in (None, after['sha512']) for before, after in zip(old['assets'], assets)):
            raise ValueError('Existing SHA512 differs')
        manifest = old
        if old['assets'] != assets:
            run(client, f'cp -p {target}/release.json {backup}/release.json')
            manifest = {**old, 'assets': assets}
            put_text(target + '/release.json.next', json.dumps(manifest, ensure_ascii=False, indent=2))
            run(client, f'mv {target}/release.json.next {target}/release.json')
    else:
        stage = f'{data}/releases/.incoming-{uuid.uuid4().hex}'
        run(client, f'mkdir -m 755 {stage}')
        if from_github:
            sources = github_sources(metadata)
            source = (ROOT / 'server/release-page/fetch-artifacts.py').read_text(encoding='utf-8')
            stdin, out, err = client.exec_command('python3 -c ' + shlex.quote(source), timeout=240)
            stdin.write(json.dumps({'stage': stage, 'assets': assets, 'sources': sources})); stdin.channel.shutdown_write()
            result = out.read().decode(); err.read()
            if out.channel.recv_exit_status(): raise RuntimeError('Server-side installer transfer failed')
            print(result, flush=True)
            verify_remote(stage)
        for asset in ([] if from_github else assets):
            last = [0]
            def progress(count, total):
                if count - last[0] >= 32 * 1024 * 1024:
                    print(json.dumps({'upload': asset['platform'], 'mib': round(count / 1024 / 1024)}), flush=True); last[0] = count
            print(json.dumps({'uploading': asset['name']}), flush=True)
            sftp.put(str(release_dir / asset['name']), stage + '/' + asset['name'], callback=progress)
            remote_asset = shlex.quote(stage + '/' + asset['name'])
            actual = run(client, f'sha256sum {remote_asset}', timeout=40).split()[0]
            if actual != asset['sha256']: raise RuntimeError('Remote installer checksum mismatch')
        put_text(stage + '/release.json', json.dumps(manifest, ensure_ascii=False, indent=2))
        run(client, f'mv {stage} {target}')
    for name in ['server.mjs', 'view.mjs', 'style.css', 'icon.png']:
        run(client, f'if test -f {base}/{name}; then cp -p {base}/{name} {backup}/{name}; fi')
        sftp.put(str(ROOT / 'server/release-page' / name), f'{base}/{name}.next')
        if name.endswith('.mjs'): run(client, f'{base}/runtime/node --check --input-type=module < {base}/{name}.next')
        run(client, f'mv {base}/{name}.next {base}/{name}')
    service_path = '/etc/systemd/system/corvas-release-page.service'
    run(client, f'if test -f {service_path}; then cp -p {service_path} {backup}/service; fi')
    put_text(service_path, (ROOT / 'server/release-page/corvas-release-page.service').read_text().replace('\r\n', '\n'))
    put_text(data + '/current.json.next', json.dumps({'version': version}))
    run(client, f'mv {data}/current.json.next {data}/current.json')
    run(client, 'systemctl daemon-reload && systemctl enable --now corvas-release-page && systemctl restart corvas-release-page')
    run(client, 'curl --retry 6 --retry-connrefused --retry-delay 1 --fail --silent http://127.0.0.1:18091/corvas/health')
    original = run(client, 'cat /etc/caddy/Caddyfile')
    anchor = 'cart.ravenhash.org {'
    if original.count(anchor) != 1: raise ValueError('Cart vhost is not uniquely identifiable')
    rule = '    @corvas_release path /corvas /corvas/*\n    handle @corvas_release {\n        reverse_proxy 127.0.0.1:18091\n    }\n'
    if '@corvas_release' not in original:
        candidate = original.replace(anchor, anchor + '\n' + rule, 1)
        put_text('/etc/caddy/Caddyfile.corvas-next', candidate)
        run(client, 'caddy validate --config /etc/caddy/Caddyfile.corvas-next --adapter caddyfile')
        if run(client, 'cat /etc/caddy/Caddyfile') != original: raise RuntimeError('Proxy config changed during deployment')
        try:
            run(client, 'mv /etc/caddy/Caddyfile.corvas-next /etc/caddy/Caddyfile && systemctl reload caddy')
        except Exception:
            run(client, f'cp -p {backup}/Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy')
            raise
    elif 'reverse_proxy 127.0.0.1:18091' not in original:
        raise ValueError('Existing Corvas proxy points elsewhere')
    receipt = {'version': version, 'url': 'https://cart.ravenhash.org/corvas',
               'api': 'https://cart.ravenhash.org/corvas/api/latest', 'backup': backup, 'assets': assets}
    (ROOT / 'output/release-page-deployed.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(receipt), flush=True)
    sftp.close()

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inspect', action='store_true')
    parser.add_argument('--site', choices=['art', 'cart'], default='cart')
    parser.add_argument('--mirror', action='store_true')
    parser.add_argument('--deploy', action='store_true')
    parser.add_argument('--release-dir', type=Path)
    parser.add_argument('--notes-file', type=Path)
    parser.add_argument('--from-github', action='store_true')
    args = parser.parse_args()
    client = connect(args.site)
    try:
        if args.inspect:
            for command in ['cat /etc/caddy/Caddyfile', 'df -h /var/lib',
                            'ls -l /usr/bin/node /root/.nvm/versions/node/v24.21.0/bin/node 2>/dev/null || true',
                            "ss -Hlnpt '( sport = :18091 )'",
                            'systemctl is-active caddy corvas-release-page || true']:
                print(run(client, command))
        elif args.mirror:
            if args.site != 'art': parser.error('--mirror is for the art site only')
            mirror_legacy(client)
        elif args.deploy:
            if args.site != 'cart': parser.error('Release files are hosted on cart; use the mirror operation for art')
            if not args.release_dir or not args.notes_file: parser.error('--release-dir and --notes-file required')
            deploy(client, args.release_dir, args.notes_file, args.from_github)
    finally: client.close()
