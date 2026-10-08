/* global process, Buffer, console */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { releasePage } from './view.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PREFIX = '/corvas';
const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*)?$/;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.(?:exe|dmg)$/;
const PLATFORM = new Set(['windows', 'macos', 'windows-portable']);

export function readRelease(dataDir, version) {
    if (!VERSION.test(version || '')) throw new Error('Invalid release');
    const filename = path.join(dataDir, 'releases', version, 'release.json');
    const info = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (info.version !== version || !/^[a-f0-9]{40}$/.test(info.sourceCommit || '')
        || !Number.isFinite(Date.parse(info.publishedAt)) || !Array.isArray(info.assets)
        || info.assets.length < 2 || info.assets.length > 3
        || !Array.isArray(info.notes) || info.notes.some(note => typeof note !== 'string' || note.length > 500)) throw new Error('Invalid release metadata');
    const platforms = new Set();
    const assets = info.assets.map(asset => {
        if (!PLATFORM.has(asset.platform) || platforms.has(asset.platform) || !ASSET_NAME.test(asset.name || '')
            || !asset.name.includes(`.${version}.`) || !/^[a-f0-9]{64}$/.test(asset.sha256 || '')
            || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > 1024 ** 3) throw new Error('Invalid asset');
        platforms.add(asset.platform);
        const full = path.join(dataDir, 'releases', version, asset.name);
        const stat = fs.lstatSync(full);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.bytes) throw new Error('Missing release asset');
        return { platform: asset.platform, name: asset.name, bytes: asset.bytes, sha256: asset.sha256,
            url: `${PREFIX}/releases/${version}/${asset.name}` };
    });
    if (!platforms.has('windows') || !platforms.has('macos')) throw new Error('Both installers required');
    return { product: 'Corvas', version, channel: version.includes('-') ? 'beta' : 'stable',
        sourceCommit: info.sourceCommit, publishedAt: info.publishedAt, notes: info.notes, assets };
}

export function parseRange(header, size) {
    if (!header) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header);
    if (!match || (!match[1] && !match[2])) return false;
    let start, end;
    if (!match[1]) {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
        start = Math.max(0, size - suffix); end = size - 1;
    } else {
        start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return false;
        end = Math.min(end, size - 1);
    }
    return { start, end };
}

export function createReleaseServer({ dataDir = process.env.RELEASE_DATA_DIR || '/var/lib/corvas-releases', staticDir = HERE } = {}) {
    let currentText, currentInfo;
    function current() {
        const text = fs.readFileSync(path.join(dataDir, 'current.json'), 'utf8');
        if (text !== currentText) {
            const info = readRelease(dataDir, JSON.parse(text).version);
            currentInfo = info; currentText = text;
        }
        return currentInfo;
    }
    function respond(req, res, status, body, type, headers = {}) {
        const bytes = Buffer.from(body);
        res.writeHead(status, { 'content-type': type, 'content-length': bytes.length, ...headers });
        res.end(req.method === 'HEAD' ? undefined : bytes);
    }
    return http.createServer((req, res) => {
        res.setHeader('x-content-type-options', 'nosniff');
        res.setHeader('referrer-policy', 'no-referrer');
        res.setHeader('content-security-policy', "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
        if (!['GET', 'HEAD'].includes(req.method)) { req.resume(); return respond(req, res, 405, 'Method not allowed', 'text/plain', { allow: 'GET, HEAD' }); }
        let route;
        try {
            const raw = String(req.url || '').split('?')[0];
            route = decodeURIComponent(raw);
            if (route !== raw || route.includes('..') || route.includes('\\') || route.includes('//')) throw new Error('Invalid path');
        } catch { return respond(req, res, 400, 'Invalid path', 'text/plain'); }
        try {
            if (route === `${PREFIX}/health`) return respond(req, res, 200, JSON.stringify({ ok: true, version: current().version }), 'application/json', { 'cache-control': 'no-store' });
            if (route === PREFIX || route === `${PREFIX}/`) return respond(req, res, 200, releasePage(current()), 'text/html; charset=utf-8', { 'cache-control': 'no-cache' });
            if ([`${PREFIX}/style.css`, `${PREFIX}/icon.png`].includes(route)) {
                const image = route.endsWith('.png');
                return respond(req, res, 200, fs.readFileSync(path.join(staticDir, image ? 'icon.png' : 'style.css')), image ? 'image/png' : 'text/css; charset=utf-8', { 'cache-control': 'public, max-age=3600' });
            }
            if (route === `${PREFIX}/api/latest`) {
                const body = JSON.stringify(current());
                const etag = `"${crypto.createHash('sha256').update(body).digest('hex')}"`;
                if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': 'no-cache' }); return res.end(); }
                return respond(req, res, 200, body, 'application/json; charset=utf-8', { etag, 'cache-control': 'no-cache' });
            }
            if (route === `${PREFIX}/SHA256SUMS.txt`) {
                return respond(req, res, 200, current().assets.map(asset => `${asset.sha256}  ${asset.name}`).join('\n') + '\n', 'text/plain; charset=utf-8', { 'cache-control': 'no-cache' });
            }
            const parts = route.split('/');
            if (parts.length !== 5 || parts[1] !== 'corvas' || parts[2] !== 'releases' || !VERSION.test(parts[3]) || !ASSET_NAME.test(parts[4])) return respond(req, res, 404, 'Not found', 'text/plain');
            let release;
            try { release = readRelease(dataDir, parts[3]); } catch { return respond(req, res, 404, 'Not found', 'text/plain'); }
            const asset = release.assets.find(asset => asset.name === parts[4]);
            if (!asset) return respond(req, res, 404, 'Not found', 'text/plain');
            const etag = `"${asset.sha256}"`;
            if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end(); }
            const range = parseRange(!req.headers['if-range'] || req.headers['if-range'] === etag ? req.headers.range : null, asset.bytes);
            if (range === false) return respond(req, res, 416, 'Invalid range', 'text/plain', { 'content-range': `bytes */${asset.bytes}` });
            const start = range?.start || 0, end = range?.end ?? asset.bytes - 1;
            res.writeHead(range ? 206 : 200, { 'content-type': 'application/octet-stream', 'content-length': end - start + 1,
                'content-disposition': `attachment; filename="${asset.name}"`, 'accept-ranges': 'bytes',
                'cache-control': 'public, max-age=31536000, immutable', etag,
                ...(range ? { 'content-range': `bytes ${start}-${end}/${asset.bytes}` } : {}) });
            if (req.method === 'HEAD') return res.end();
            pipeline(fs.createReadStream(path.join(dataDir, 'releases', release.version, asset.name), { start, end }), res, () => {});
        } catch {
            if (!res.headersSent) respond(req, res, 503, 'Release service temporarily unavailable', 'text/plain', { 'cache-control': 'no-store' });
            else res.destroy();
        }
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const server = createReleaseServer();
    server.listen(Number(process.env.PORT || 18091), '127.0.0.1', () => console.log('Corvas releases listening on loopback'));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
