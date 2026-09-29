"""Deploy the customer-error pipeline without changing CONFIG catalogs or relay billing."""
import argparse
import datetime
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
    parser.add_argument('--deploy', action='store_true')
    parser.add_argument('--replay', action='store_true')
    parser.add_argument('--verify', action='store_true')
    parser.add_argument('--configure-analysis', action='store_true')
    parser.add_argument('--analysis-model')
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

    def run(command, source=None):
        stdin, out, err = client.exec_command(command, timeout=65)
        if source:
            stdin.write(source); stdin.channel.shutdown_write()
        stdout, stderr = out.read().decode(), err.read().decode()
        if out.channel.recv_exit_status():
            raise RuntimeError(f'Remote step failed: {command}\n{stderr[:1000]}')
        return stdout

    if args.analysis_model and not args.configure_analysis:
        if args.site != 'config':
            raise ValueError('Analysis model updates require the CONFIG target')
        source = """import fs from 'node:fs';
import {createErrorAnalysis,callAnalysisApi,validateAnalysis} from '/srv/flow-config/lib/error-analysis.mjs';
const {model}=JSON.parse(fs.readFileSync(0,'utf8'));
const settings=JSON.parse(fs.readFileSync('/var/lib/flow-config/error-analysis-settings.json','utf8'));
const input='Image pixel format YUV422 is not supported; expected RGB.';
const result=validateAnalysis(await callAnalysisApi({...settings,model},input),input);
if(!result) throw new Error('Model probe did not pass output validation');
const service=createErrorAnalysis({dataDir:'/var/lib/flow-config'});
console.log(JSON.stringify({probe:'passed',settings:service.configure({...service.viewSettings(),model,apiKey:''})}));
"""
        print(run(f'runuser -u flowconfig -- {shlex.quote(node)} --input-type=module -e {shlex.quote(source)}', json.dumps({'model': args.analysis_model})))
        run('systemctl restart flow-config')
        run('systemctl is-active flow-config')
        client.close(); return
    if args.configure_analysis:
        if args.site != 'config' or not os.environ.get('FLOW_ERROR_ANALYSIS_KEY'):
            raise ValueError('CONFIG target and FLOW_ERROR_ANALYSIS_KEY required')
        source = "import fs from 'node:fs'; import {createErrorAnalysis} from '/srv/flow-config/lib/error-analysis.mjs'; const service=createErrorAnalysis({dataDir:'/var/lib/flow-config'}); console.log(JSON.stringify(service.configure(JSON.parse(fs.readFileSync(0,'utf8')))));"
        config = {'enabled': True, 'endpoint': 'https://ai.ravenhash.org/v1', 'model': args.analysis_model or 'gpt-5.6-sol',
                  'protocol': 'responses', 'dailyLimit': 50, 'apiKey': os.environ['FLOW_ERROR_ANALYSIS_KEY']}
        print(run(f'runuser -u flowconfig -- {shlex.quote(node)} --input-type=module -e {shlex.quote(source)}', json.dumps(config)))
        run('systemctl restart flow-config')
        run('systemctl is-active flow-config')
        client.close(); return
    if args.verify:
        if args.site != 'config':
            raise ValueError('Verify the connectors from the CONFIG host')
        source = """import {createAdminRequestDiagnostics} from '/srv/flow-config/lib/admin-request-diagnostics.mjs';
const connector=createAdminRequestDiagnostics({dataDir:'/var/lib/flow-config'});
for(const site of ['art','cart']) {const r=await connector.get(site,null,{review:true});
console.log(JSON.stringify({site,status:r.status,reviewCount:r.body.record?.records?.length}));if(r.status!==200)process.exitCode=1;}
const {createErrorAnalysis}=await import('/srv/flow-config/lib/error-analysis.mjs');
console.log(JSON.stringify({analysisSettings:createErrorAnalysis({dataDir:'/var/lib/flow-config'}).viewSettings()}));
"""
        print(run(f'{shlex.quote(node)} --input-type=module -', source)); client.close(); return
    if args.replay:
        if args.site != 'art':
            raise ValueError('The recorded MiniMax fixture belongs to art')
        source = """const fs=require('node:fs');
const {normalizeRelayFailure}=require('/opt/corvas-relay-error-gateway/shared/public-api-error.cjs');
const record=JSON.parse(fs.readFileSync('/var/lib/relay-error-gateway/rh_9611fe3a197b99a70bb3b25cbd91cf48.json','utf8'));
let audit; const result=normalizeRelayFailure(record.upstreamStatus,record.error,{query:true,terminal:true,requestId:record.requestId,onCustomerMessage:a=>audit=a});
console.log(JSON.stringify({historicalReplay:true,error:result.body.error,audit}));"""
        print(run(f'{shlex.quote(node)} -', source)); client.close(); return
    if args.site == 'config':
        service = 'flow-config'
        names = ['server.mjs', 'lib/pages.mjs', 'lib/admin-request-diagnostics.mjs', 'lib/admin-request-diagnostics-client.mjs',
                 'lib/error-analysis.mjs', 'lib/error-analysis-client.mjs', 'lib/customer-error-message.cjs']
        files = [(ROOT / 'configserver' / name, '/srv/flow-config/' + name) for name in names]
    else:
        service = 'corvas-relay-error-gateway'
        names = ['server/relay-error-gateway/gateway.cjs', 'server/relay-error-gateway/diagnostics-store.cjs',
                 'server/relay-error-gateway/update-customer-error-terms.py',
                 'shared/public-api-error.cjs', 'shared/public-error-detail.cjs', 'shared/customer-error-message.cjs']
        files = [(ROOT / name, '/opt/corvas-relay-error-gateway/' + name) for name in names]
    if not args.deploy:
        print(json.dumps({'site': args.site, 'files': [target for _, target in files]})); client.close(); return
    if args.site != 'config' and run("ss -Htn state established '( sport = :18089 )'").strip():
        raise RuntimeError('Gateway has active connections; deploy when idle')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = '/var/backups/corvas-customer-errors-' + stamp
    run(f'mkdir -p {backup}')
    sftp = client.open_sftp()
    for index, (local, target) in enumerate(files):
        run(f'if test -f {shlex.quote(target)}; then cp -p {shlex.quote(target)} {backup}/{index}; fi')
        candidate = target + '.errors-next'
        sftp.put(str(local), candidate)
        if args.site == 'config': run(f'chown flowconfig:flowconfig {shlex.quote(candidate)}')
        if not target.endswith('.py'):
            run(f'{shlex.quote(node)} --check' + (' --input-type=module' if target.endswith('.mjs') else '') + f' < {shlex.quote(candidate)}')
    try:
        for _, target in files: run(f'mv {shlex.quote(target + ".errors-next")} {shlex.quote(target)}')
        if args.site != 'config':
            run(f'if test -f /etc/corvas-customer-error-policy.json; then cp -p /etc/corvas-customer-error-policy.json {backup}/policy.json; fi')
            run(f'python3 /opt/corvas-relay-error-gateway/server/relay-error-gateway/update-customer-error-terms.py --site {args.site}')
            user = run(f'systemctl show -p User --value {service}').strip() or 'root'
            run(f'chown {shlex.quote(user)} /etc/corvas-customer-error-policy.json')
        run(f'systemctl restart {service}')
        run(f'systemctl is-active {service}')
    except Exception:
        for index, (_, target) in enumerate(files):
            run(f'if test -f {backup}/{index}; then cp -p {backup}/{index} {shlex.quote(target)}; fi')
        run(f'systemctl restart {service}')
        raise
    receipt = {'site': args.site, 'deployedAt': stamp, 'backup': backup, 'files': [target for _, target in files]}
    (ROOT / 'output' / f'customer-errors-{args.site}-deployed.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    print(json.dumps(receipt)); sftp.close(); client.close()


if __name__ == '__main__':
    main()
