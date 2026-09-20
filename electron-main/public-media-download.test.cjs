const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fetchPublicMedia, resolvePublicUrl, isPublicAddress } = require('./public-media-download.cjs');

test('untrusted media URLs reject loopback, private, metadata, mapped IPv6 and reserved addresses', async () => {
    for (const address of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.4.5', '192.168.0.1',
        '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fe80::1', 'fc00::1', '2002:7f00:1::', '2001:db8::1']) {
        assert.equal(isPublicAddress(address), false, address);
    }
    for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
    for (const url of ['file:///etc/passwd', 'http://localhost/a.png', 'http://2130706433/x', 'http://0x7f000001/x', 'http://user:pass@1.1.1.1/x']) await assert.rejects(resolvePublicUrl(url));
});

test('DNS resolution rejects mixed public/private answers before making a request', async () => {
    let requests = 0;
    await assert.rejects(fetchPublicMedia('https://media.test/image.png', {
        lookup: async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }],
        request: async () => { requests++; }
    }), /内网/);
    assert.equal(requests, 0);
});

test('each redirect is revalidated, and requests receive only a pinned public address', async () => {
    let requests = 0;
    const options = {
        lookup: async () => [{ address: '1.1.1.1', family: 4 }],
        request: async (_url, address) => {
            assert.equal(address.address, '1.1.1.1'); requests++;
            return { status: 302, headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }) };
        }
    };
    await assert.rejects(fetchPublicMedia('https://media.test/a.png', options), /内网/);
    assert.equal(requests, 1);
});

test('public image download returns content and the final URL after a relative redirect', async () => {
    const result = await fetchPublicMedia('https://media.test/a', {
        lookup: async () => [{ address: '8.8.8.8', family: 4 }],
        request: async url => url.pathname === '/a'
            ? { status: 302, headers: new Headers({ location: '/image.png' }) }
            : { status: 200, headers: new Headers({ 'content-type': 'image/png' }), buffer: Buffer.from('pixels') }
    });
    assert.equal(result.ok, true); assert.equal(result.url, 'https://media.test/image.png');
    assert.equal((await result.arrayBuffer()).toString(), 'pixels');
});

test('DNS stalls time out before opening a socket', async () => {
    await assert.rejects(fetchPublicMedia('https://media.test/a', { lookup: () => new Promise(() => {}), timeoutMs: 10 }), /超时/);
});

test('configured HTTP proxy tunnels to the validated public IP and retains the logical Host', async t => {
    const proxy = http.createServer();
    const tunnels = [];
    const sockets = new Set();
    proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    proxy.on('connect', (request, socket) => {
        tunnels.push(request.url);
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        let incoming = '';
        socket.on('data', data => {
            incoming += data.toString();
            if (!incoming.includes('\r\n\r\n')) return;
            assert.match(incoming, /Host: media\.test/i);
            socket.end(incoming.includes('/large')
                ? 'HTTP/1.1 200 OK\r\nContent-Length: 99999\r\n\r\n'
                : 'HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\npixels');
        });
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => proxy.close(resolve)); });
    const options = { lookup: async () => [{ address: '1.1.1.1', family: 4 }],
        resolveProxy: async () => `PROXY 127.0.0.1:${proxy.address().port}`, maxBytes: 1024 };
    assert.equal(await (await fetchPublicMedia('http://media.test/image', options)).text(), 'pixels');
    await assert.rejects(fetchPublicMedia('http://media.test/large', options), /大小限制/);
    await assert.rejects(fetchPublicMedia('http://127.0.0.1/private', options), /内网/);
    assert.deepEqual(tunnels, ['1.1.1.1:80', '1.1.1.1:80']);
});
