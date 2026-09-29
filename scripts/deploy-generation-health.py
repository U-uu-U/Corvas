"""Deploy only generation-health code. Passwords are supplied through FLOW_TASK_SSH_PASSWORD."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shlex
import paramiko

ROOT = Path(__file__).resolve().parents[1]
TARGETS = {'art': ('45.192.100.246', 24775, '/usr/bin/node'),
           'cart': ('154.12.57.129', 26098, '/root/.nvm/versions/node/v24.21.0/bin/node'),
           'config': ('154.12.57.162', 22, '/srv/flow-config/runtime/node')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('site', choices=TARGETS)
    parser.add_argument('--caddy-file', type=Path)
    parser.add_argument('--deploy', action='store_true')
    parser.add_argument('--code-only', action='store_true', help='Update metrics/schema only; preserve the deployed routes and entry points')
    args = parser.parse_args()
    host, port, node = TARGETS[args.site]
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.load_host_keys(os.path.expanduser('~/.ssh/known_hosts'))
    if client.get_host_keys().lookup(host):
        for kind, key in client.get_host_keys().lookup(host).items():
            client.get_host_keys().add(f'[{host}]:{port}', kind, key)
    client.connect(host, port, username='root', timeout=15,
        key_filename=os.path.expanduser('~/.ssh/neurolimb-server-ed25519') if args.site == 'art' else None,
        password=os.environ.get('FLOW_TASK_SSH_PASSWORD'))

    def run(command):
        _, out, err = client.exec_command(command, timeout=40)
        stdout, stderr = out.read().decode(), err.read().decode()
        if out.channel.recv_exit_status() != 0:
            raise RuntimeError(f'Remote step failed: {command}\n{stderr[:1500]}')
        return stdout

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = f'/var/backups/corvas-generation-health-{stamp}'
    files = []
    if args.site == 'config':
        for name in ['server.mjs', 'lib/catalog-generation-health.mjs', 'schema/model-config.schema.json']:
            if args.code_only and name == 'server.mjs':
                continue
            files.append((ROOT / 'configserver' / name, '/srv/flow-config/' + name))
        service = 'flow-config'
    else:
        base = '/opt/corvas-relay-error-gateway/'
        for name in ['gateway.cjs', 'generation-health.cjs', 'read-generation-records.py']:
            if args.code_only and name != 'generation-health.cjs':
                continue
            relative = 'server/relay-error-gateway/' + name
            files.append((ROOT / relative, base + relative))
        if not args.code_only and (not args.caddy_file or not args.caddy_file.is_file()):
            raise ValueError('Reviewed local Caddyfile required')
        if not args.code_only:
            files.append((args.caddy_file, '/etc/caddy/Caddyfile'))
        service = 'corvas-relay-error-gateway'
    if not args.deploy:
        print(json.dumps({'site': args.site, 'files': [target for _, target in files],
                          'service': run(f'systemctl is-active {service}').strip()}, indent=2))
        client.close()
        return
    if args.site != 'config':
        active = run("ss -Htn state established '( sport = :18089 )'").strip()
        if active:
            raise RuntimeError('Gateway has active connections; retry deployment when idle')
    run(f'mkdir -p {shlex.quote(backup)}')
    sftp = client.open_sftp()
    receipts = []
    for index, (local, target) in enumerate(files):
        candidate = target + '.health-next'
        try:
            sftp.stat(target)
            run(f'cp -p {shlex.quote(target)} {shlex.quote(backup + "/" + str(index))}')
        except FileNotFoundError:
            pass
        sftp.put(str(local), candidate)
        if args.site == 'config':
            run(f'chown flowconfig:flowconfig {shlex.quote(candidate)}')
        if target.endswith(('.cjs', '.mjs')):
            # Node requires a known extension even for --check.
            run(f'{shlex.quote(node)} --check < {shlex.quote(candidate)}' + (' --input-type=module' if target.endswith('.mjs') else ''))
        elif target.endswith('Caddyfile'):
            run(f'caddy validate --config {shlex.quote(candidate)} --adapter caddyfile')
        receipts.append({'path': target, 'sha256': hashlib.sha256(local.read_bytes()).hexdigest(), 'backup': backup + '/' + str(index)})
    try:
        for _, target in files:
            run(f'mv {shlex.quote(target + ".health-next")} {shlex.quote(target)}')
        run(f'systemctl restart {service}')
        run(f'systemctl is-active {service}')
        if args.site != 'config' and not args.code_only:
            run('systemctl reload caddy')
    except Exception:
        for index, (_, target) in enumerate(files):
            run(f'if test -f {shlex.quote(backup + "/" + str(index))}; then cp -p {shlex.quote(backup + "/" + str(index))} {shlex.quote(target)}; fi')
        run(f'systemctl restart {service}')
        raise
    record = {'site': args.site, 'deployedAt': stamp, 'files': receipts, 'service': service}
    output = ROOT / 'output' / f'generation-health-{args.site}-deployed.json'
    output.write_text(json.dumps(record, indent=2), encoding='utf-8')
    print(json.dumps(record, indent=2))
    sftp.close()
    client.close()


if __name__ == '__main__':
    main()
