"""Read signed download grants from stdin; publish only hash-verified named artifacts."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import urllib.request
import zipfile

payload = json.load(sys.stdin)
root = Path(payload['stage']).resolve()
if root.parent != Path('/var/lib/corvas-releases/releases') or not root.name.startswith('.incoming-'):
    raise ValueError('Invalid staging directory')
expected = {asset['name']: asset for asset in payload['assets']}
for number, source in enumerate(payload['sources']):
    archive = root / ('source-' + str(number))
    hasher = hashlib.sha256()
    with urllib.request.urlopen(source['url'], timeout=90) as response, archive.open('wb') as output:
        total = 0
        while True:
            block = response.read(1024 * 1024)
            if not block: break
            total += len(block)
            if total > source['size']: raise RuntimeError('Download exceeds declared size')
            output.write(block); hasher.update(block)
    if total != source['size'] or hasher.hexdigest() != source['sha256']:
        raise RuntimeError('Archive digest mismatch')
    if source['format'] == 'zip':
        with zipfile.ZipFile(archive) as compressed:
            for name in source['names']:
                if name not in expected or compressed.getinfo(name).file_size != expected[name]['bytes']:
                    raise RuntimeError('Invalid archive member')
                with compressed.open(name) as incoming, (root / name).open('wb') as outgoing:
                    shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
        archive.unlink()
    else:
        name = source['names'][0]
        if name not in expected: raise RuntimeError('Unknown asset')
        archive.rename(root / name)
for name, asset in expected.items():
    file = root / name
    hasher = hashlib.sha256()
    with file.open('rb') as content:
        for block in iter(lambda: content.read(1024 * 1024), b''): hasher.update(block)
    if file.stat().st_size != asset['bytes'] or hasher.hexdigest() != asset['sha256']:
        raise RuntimeError('Installer digest mismatch')
print(json.dumps({'verifiedInstallers': len(expected)}))
