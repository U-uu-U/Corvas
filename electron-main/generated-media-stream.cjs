function downloadProgressReporter(onProgress, attempt = 1) {
    const startedAt = Date.now();
    let lastReportedAt = 0;
    return (downloadedBytes, totalBytes, complete = false) => {
        if (typeof onProgress !== 'function') return;
        const now = Date.now();
        if (downloadedBytes > 0 && !complete && now - lastReportedAt < 750) return;
        lastReportedAt = now;
        onProgress({ stage: 'download', remoteCompleted: true, downloadedBytes,
            totalBytes: totalBytes > 0 ? totalBytes : null, downloadAttempt: attempt,
            bytesPerSecond: downloadedBytes > 0 ? Math.round(downloadedBytes * 1000 / Math.max(1, now - startedAt)) : 0 });
    };
}

async function readGeneratedMediaBody(response, { maxBytes, signal, onChunk, onProgress } = {}) {
    const length = Number(response.headers?.get?.('content-length'));
    const encoding = response.headers?.get?.('content-encoding');
    const totalBytes = Number.isFinite(length) && length > 0 && (!encoding || encoding === 'identity') ? length : null;
    const oversized = () => Object.assign(new Error('生成产物超过 512 MB 下载限制'), { retryable: false });
    if (Number.isFinite(length) && length > maxBytes) {
        await response.body?.cancel();
        throw oversized();
    }
    signal?.throwIfAborted();
    onChunk?.();
    onProgress?.(0, totalBytes);
    const reader = response.body?.getReader?.();
    if (!reader) {
        const buffer = Buffer.from(await response.arrayBuffer());
        signal?.throwIfAborted();
        if (buffer.length > maxBytes) throw oversized();
        onProgress?.(buffer.length, totalBytes, true);
        return buffer;
    }
    const chunks = [];
    let bytes = 0;
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const abort = () => {
        const reason = signal.reason || new Error('Media download aborted');
        void reader.cancel(reason).catch(() => {});
        rejectAbort(reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
        while (true) {
            signal?.throwIfAborted();
            const { done, value } = await Promise.race([reader.read(), aborted]);
            signal?.throwIfAborted();
            if (done) break;
            if (!value?.byteLength) continue;
            bytes += value.byteLength;
            if (bytes > maxBytes) throw oversized();
            chunks.push(Buffer.from(value));
            onChunk?.();
            onProgress?.(bytes, totalBytes);
        }
        if (totalBytes !== null && bytes !== totalBytes) throw new Error('生成产物下载不完整');
        onProgress?.(bytes, totalBytes, true);
        return Buffer.concat(chunks, bytes);
    } catch (error) {
        void reader.cancel(error).catch(() => {});
        throw error;
    } finally {
        signal?.removeEventListener('abort', abort);
        reader.releaseLock();
    }
}

module.exports = { readGeneratedMediaBody, downloadProgressReporter };
