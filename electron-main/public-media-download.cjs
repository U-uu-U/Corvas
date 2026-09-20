const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { BlockList, isIP } = require('node:net');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
    blocked.addSubnet(address, prefix, 'ipv4');
}
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) blocked.addSubnet(address, prefix, 'ipv6');

function isPublicAddress(address) {
    const family = isIP(address);
    if (family === 4) return !blocked.check(address, 'ipv4');
    return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

async function lookupPublicMediaHost(hostname, options = {}) {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    // TUN clients can replace public DNS with benchmark-range "fake IPs".
    // Resolve these names independently; never connect to the fake address itself.
    if (addresses.length && addresses.every(entry => /^198\.(?:18|19)\./.test(entry.address))) {
        const endpoint = new URL('https://1.1.1.1/dns-query');
        endpoint.searchParams.set('name', hostname); endpoint.searchParams.set('type', 'A');
        const result = await requestPublicResource(endpoint, { address: '1.1.1.1', family: 4 }, {
            headers: { Accept: 'application/dns-json' }, signal: options.signal, maxBytes: 64 * 1024, resolveProxy: options.resolveProxy
        });
        if (result.status !== 200) throw new Error('无法校验网页素材的公网地址，请稍后重试');
        const answer = JSON.parse(result.buffer.toString('utf8'));
        return (answer.Answer || []).filter(entry => entry.type === 1 && isIP(entry.data) === 4)
            .map(entry => ({ address: entry.data, family: 4 }));
    }
    return addresses;
}

async function resolvePublicUrl(input, lookup = lookupPublicMediaHost, signal, resolveProxy) {
    const url = new URL(input);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('仅支持公开的 HTTP(S) 素材链接');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (/^(?:localhost|.*\.(?:localhost|local|internal))\.?$/i.test(hostname)) throw new Error('网页素材链接不能访问本机或内网地址');
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true, signal, resolveProxy });
    if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) throw new Error('网页素材链接不能访问本机或内网地址');
    return { url, address: addresses[0] };
}

// Pin the validated DNS answer to this socket. A second lookup would allow DNS rebinding.
async function requestPublicResource(url, address, { headers, signal, maxBytes, resolveProxy }) {
    const proxyRule = String(await resolveProxy?.(url.href) || 'DIRECT').split(';')[0].trim();
    let agent = false;
    const endpoint = new URL(url.href);
    if (proxyRule !== 'DIRECT') {
        const match = /^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(\S+)$/i.exec(proxyRule);
        if (!match) throw new Error('无法识别系统代理设置，网页素材未下载');
        const kind = match[1].toUpperCase();
        agent = kind.startsWith('SOCKS')
            ? new SocksProxyAgent(`${kind === 'SOCKS4' ? 'socks4' : 'socks5'}://${match[2]}`)
            : new HttpsProxyAgent(`${kind === 'HTTPS' ? 'https' : 'http'}://${match[2]}`);
        // CONNECT/SOCKS must tunnel to the validated IP, not resolve the name again.
        endpoint.hostname = address.family === 6 ? `[${address.address}]` : address.address;
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    return new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const request = transport.request(endpoint, {
            method: 'GET', headers: { ...headers, Host: url.host }, signal, agent,
            servername: isIP(hostname) ? '' : hostname,
            checkServerIdentity: (_name, certificate) => tls.checkServerIdentity(hostname, certificate),
            lookup: (_host, options, callback) => options?.all
                ? callback(null, [address]) : callback(null, address.address, address.family)
        }, response => {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(name, String(value));
            const status = response.statusCode || 502;
            if ([301, 302, 303, 307, 308].includes(status)) {
                response.destroy();
                resolve({ status, headers: responseHeaders, buffer: Buffer.alloc(0) });
                return;
            }
            const contentType = String(response.headers['content-type'] || '').toLowerCase();
            const limit = contentType.includes('html') ? Math.min(maxBytes, 4 * 1024 * 1024) : maxBytes;
            if (Number(response.headers['content-length']) > limit) {
                response.destroy(); reject(new Error('网页素材超过大小限制')); return;
            }
            const chunks = [];
            let size = 0;
            response.on('data', chunk => {
                size += chunk.length;
                if (size > limit) { response.destroy(new Error('网页素材超过大小限制')); return; }
                chunks.push(chunk);
            });
            response.on('error', reject);
            response.on('end', () => resolve({ status, headers: responseHeaders, buffer: Buffer.concat(chunks) }));
        });
        request.on('close', () => { if (agent) agent.destroy(); });
        request.on('error', reject);
        request.end();
    });
}

async function fetchPublicMedia(input, { headers = {}, maxBytes = 128 * 1024 * 1024, timeoutMs = 45000,
    lookup = lookupPublicMediaHost, request = requestPublicResource, resolveProxy } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('网页素材下载超时')), timeoutMs);
    const work = async () => {
        let current = input;
        for (let redirects = 0; redirects <= 5; redirects++) {
            const { url, address } = await resolvePublicUrl(current, lookup, controller.signal, resolveProxy);
            controller.signal.throwIfAborted();
            const response = await request(url, address, { headers, signal: controller.signal, maxBytes, resolveProxy });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const location = response.headers.get('location');
                if (!location) throw new Error('网页素材跳转地址为空');
                current = new URL(location, url).href;
                continue;
            }
            return { ok: response.status >= 200 && response.status < 300, status: response.status, statusText: '',
                url: url.href, headers: response.headers,
                text: async () => response.buffer.toString('utf8'), arrayBuffer: async () => response.buffer };
        }
        throw new Error('网页素材跳转次数过多');
    };
    try {
        return await Promise.race([work(), new Promise((_, reject) => controller.signal.addEventListener('abort',
            () => reject(controller.signal.reason), { once: true }))]);
    } finally { clearTimeout(timer); }
}

module.exports = { fetchPublicMedia, resolvePublicUrl, isPublicAddress };
