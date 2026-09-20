const fs = require('fs');
const path = require('path');
const { ReadableStream } = require('stream/web');

const MIME_TYPES = {
    '.aac': 'audio/aac',
    '.avi': 'video/x-msvideo',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.flac': 'audio/flac',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.m4a': 'audio/mp4',
    '.m4v': 'video/x-m4v',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.mpeg': 'video/mpeg',
    '.mpg': 'video/mpeg',
    '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.wav': 'audio/wav',
    '.webm': 'video/webm',
    '.webp': 'image/webp',
    '.wmv': 'video/x-ms-wmv'
};

function decodeLocalResourcePath(url) {
    if (!String(url || '').startsWith('local-res://')) throw new Error('Invalid scheme');
    const encodedPath = String(url || '').slice('local-res://'.length).split(/[?#]/, 1)[0];
    const decoded = decodeURIComponent(encodedPath);
    if (decoded.includes('\0')) throw new Error('Invalid path');
    return decoded;
}

function parseByteRange(value, size) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(String(value || '').trim());
    if (!match || size <= 0 || (!match[1] && !match[2])) return null;

    let start;
    let end;
    if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
        start = Math.max(0, size - suffixLength);
        end = size - 1;
    } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
        if (start < 0 || start >= size || end < start) return null;
        end = Math.min(end, size - 1);
    }

    return { start, end };
}

function baseHeaders(filePath, size) {
    return {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Content-Length': String(size)
    };
}

async function createFileWebStream(filePath, expectedStat, options = {}) {
    const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let fileStream;
    try {
        const actual = await handle.stat();
        if (!actual.isFile() || actual.ino !== expectedStat.ino || actual.dev !== expectedStat.dev || actual.size !== expectedStat.size) {
            throw new Error('Resource changed');
        }
        fileStream = handle.createReadStream(options);
    } catch (error) { await handle.close(); throw error; }
    const iterator = fileStream[Symbol.asyncIterator]();
    let closed = false;

    return new ReadableStream({
        async pull(controller) {
            if (closed) return;
            try {
                const { value, done } = await iterator.next();
                if (closed) return;
                if (done) {
                    closed = true;
                    controller.close();
                    return;
                }
                controller.enqueue(value);
            } catch (error) {
                if (closed || error?.code === 'ERR_INVALID_STATE') return;
                closed = true;
                controller.error(error);
            }
        },
        async cancel() {
            if (closed) return;
            closed = true;
            fileStream.destroy();
            try { await iterator.return?.(); } catch (_) { }
        }
    });
}

async function handleLocalResourceRequest(request, { accessPolicy, allowedOrigins = ['null'] } = {}) {
    if (!['GET', 'HEAD'].includes(request?.method || 'GET')) return new Response(null, { status: 405 });
    const origin = request?.headers?.get?.('origin');
    const destination = request?.headers?.get?.('sec-fetch-dest');
    if ((origin && !allowedOrigins.includes(origin)) || ['document', 'iframe', 'object', 'embed'].includes(destination)) {
        return new Response(null, { status: 403 });
    }
    let filePath;
    try {
        filePath = decodeLocalResourcePath(request?.url);
    } catch (_) {
        return new Response('Invalid local resource path', { status: 400 });
    }

    let stat;
    try {
        if (!accessPolicy) return new Response(null, { status: 403 });
        const resolved = await accessPolicy.resolve(filePath);
        filePath = resolved.filePath;
        stat = resolved.stat;
    } catch (_) {
        return new Response('Local resource unavailable', { status: 404 });
    }

    const corsHeaders = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};

    const rangeValue = request?.headers?.get?.('range');
    const range = rangeValue ? parseByteRange(rangeValue, stat.size) : null;
    if (rangeValue && !range) {
        return new Response(null, {
            status: 416,
            headers: {
                ...baseHeaders(filePath, 0),
                ...corsHeaders,
                'Content-Range': `bytes */${stat.size}`
            }
        });
    }

    if (range) {
        const contentLength = range.end - range.start + 1;
        const headers = {
            ...baseHeaders(filePath, contentLength),
            ...corsHeaders,
            'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`
        };
        if (request?.method === 'HEAD') return new Response(null, { status: 206, headers });
        try {
            return new Response(await createFileWebStream(filePath, stat, { start: range.start, end: range.end }), { status: 206, headers });
        } catch { return new Response(null, { status: 404 }); }
    }

    const headers = { ...baseHeaders(filePath, stat.size), ...corsHeaders };
    if (request?.method === 'HEAD') return new Response(null, { status: 200, headers });
    try { return new Response(await createFileWebStream(filePath, stat), { status: 200, headers }); }
    catch { return new Response(null, { status: 404 }); }
}

module.exports = {
    decodeLocalResourcePath,
    handleLocalResourceRequest,
    parseByteRange
};
