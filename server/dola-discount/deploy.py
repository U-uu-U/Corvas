"""Stage the Dola adapter, then run guarded relay or CONFIG operations."""
import argparse
import base64
import json
import os
from pathlib import Path
import runpy

HERE = Path(__file__).resolve().parent
Remote = runpy.run_path(str(HERE.parent / 'feituo-adapter/deploy.py'))['Remote']
ROOT = '/opt/corvas-dola-discount/server/dola-discount'
CONFIG_ROOT = '/srv/flow-config/dola-discount-add'


def stage(remote):
    names = ['catalog.mjs', 'publish.mjs'] if remote.site == 'config' else ['adapter.py', 'media.py', 'configure.py', 'compose.yml']
    files = {name: base64.b64encode((HERE / name).read_bytes()).decode() for name in names}
    if remote.site != 'config':
        files['../seedance-hm/add-zhubo-september.py'] = base64.b64encode(
            (HERE.parent / 'seedance-hm/add-zhubo-september.py').read_bytes()).decode()
    data = {'files': files, 'site': remote.site, 'directory': CONFIG_ROOT if remote.site == 'config' else ROOT}
    code = '''import base64,json,os,pathlib,pwd,subprocess
data=json.loads(base64.b64decode(PAYLOAD))
root=pathlib.Path(data['directory'])
assert not root.exists(), 'Deployment exists; inspect before updating'
root.mkdir(parents=True,mode=0o755)
for name,raw in data['files'].items():
    target=root/name
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_bytes(base64.b64decode(raw))
    target.chmod(0o644)
    if data['site']=='config':
        user=pwd.getpwnam('flowconfig');os.chown(target,user.pw_uid,user.pw_gid)
receipt={'site':data['site'],'directory':str(root),'staged':True}
if data['site']!='config':
    info=json.loads(subprocess.check_output(['docker','inspect','seedance968-adapter'],text=True))[0]
    mounts=[m for m in info['Mounts'] if m['Destination']=='/media']
    assert len(mounts)==1 and mounts[0]['Type']=='bind'
    media_dir=mounts[0]['Source']
    assert pathlib.Path(media_dir).is_dir()
    network='tokensbyte-network' if data['site']=='art' else 'tkeapi-network'
    assert network in info['NetworkSettings']['Networks']
    public='https://'+data['site']+'.ravenhash.org/fc-media/files'
    env=dict(os.environ,MEDIA_HOST_DIR=media_dir,PUBLIC_MEDIA=public,NETWORK_NAME=network)
    subprocess.run(['docker','compose','-p','corvas-dola-discount','-f',str(root/'compose.yml'),'up','-d'],env=env,check=True)
    receipt.update(mediaDirectory=media_dir,publicMedia=public,network=network)
print(json.dumps(receipt))
'''.replace('PAYLOAD', repr(base64.b64encode(json.dumps(data).encode()).decode()))
    print(remote.run('python3 -B -', code).strip())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('site', choices=['art', 'cart', 'config'])
    parser.add_argument('action', choices=['stage', 'configure', 'publish', 'media-route'])
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    remote = Remote(args.site)
    try:
        if args.action == 'stage':
            stage(remote)
        elif args.action == 'media-route':
            assert args.site == 'cart' and args.apply, 'This route requires cart --apply'
            fragment = base64.b64encode((HERE / 'cart-media.caddy').read_bytes()).decode()
            code = '''import base64,datetime,json,pathlib,shutil,subprocess
target=pathlib.Path('/etc/caddy/Caddyfile')
fragment=pathlib.Path('/etc/caddy/dola-discount-media.caddy')
before=target.read_bytes()
anchor=b'cart.ravenhash.org {'
assert before.count(anchor)==1 and b'dola-discount-media.caddy' not in before
assert not fragment.exists()
updated=before.replace(anchor,anchor+b'\\n    import /etc/caddy/dola-discount-media.caddy',1)
backup=pathlib.Path('/var/backups')/('corvas-dola-media-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
backup.mkdir(mode=0o700)
shutil.copy2(target,backup/'Caddyfile')
fragment.write_bytes(base64.b64decode(FRAGMENT))
fragment.chmod(0o644)
temporary=target.with_name('Caddyfile.dola-next')
temporary.write_bytes(updated)
try:
    check=subprocess.run(['caddy','validate','--adapter','caddyfile','--config',str(temporary)],capture_output=True)
    assert check.returncode==0, 'Caddy validation failed'
    assert target.read_bytes()==before, 'Caddyfile changed during deployment'
    temporary.replace(target)
    result=subprocess.run(['systemctl','reload','caddy'],capture_output=True)
    if result.returncode:
        target.write_bytes(before)
        subprocess.run(['systemctl','reload','caddy'],check=True,capture_output=True)
        raise RuntimeError('Route reload failed; previous configuration restored')
    print(json.dumps({'site':'cart','mediaRouteAdded':True,'backup':str(backup)}))
finally:
    temporary.unlink(missing_ok=True)
'''.replace('FRAGMENT', repr(fragment))
            print(remote.run('python3 -B -', code).strip())
        elif args.action == 'configure':
            assert args.site in ('art', 'cart')
            command = f'python3 -B {ROOT}/configure.py {args.site}' + (' --apply' if args.apply else '')
            print(remote.run(command, json.dumps({'apiKey': os.environ['DOLA_API_KEY']})).strip())
        else:
            assert args.site == 'config'
            command = f'runuser -u flowconfig -- /srv/flow-config/runtime/node {CONFIG_ROOT}/publish.mjs'
            print(remote.run(command + (' --apply' if args.apply else '')).strip())
    finally:
        remote.close()


if __name__ == '__main__':
    main()
