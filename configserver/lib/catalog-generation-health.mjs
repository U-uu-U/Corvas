import fs from 'node:fs';
import path from 'node:path';

const HOSTS = { art: 'art.ravenhash.org', cart: 'cart.ravenhash.org' };
const STATES = new Set(['available', 'degraded', 'unknown']);
const REASONS = new Set(['recent', 'no_data', 'insufficient', 'stale', 'unavailable']);
const count = value => Number.isInteger(value) && value >= 0 && value <= 5000;

// Explicit projection is the public boundary. Raw records and private connector fields never pass through.
export function projectHealth(entry, checkedAt, now = Date.now()) {
    const unknown = { state: 'unknown', reason: 'unavailable', samples: [], successCount: 0, failureCount: 0,
        excludedCount: 0, durationSamples: 0, averageSeconds: null, checkedAt: new Date(0).toISOString(),
        validUntil: new Date(0).toISOString(), lastCompletedAt: null };
    if (!entry || !STATES.has(entry.state) || !REASONS.has(entry.reason)
        || !Array.isArray(entry.samples) || entry.samples.length > 50
        || !entry.samples.every(state => ['success', 'failure', 'unknown'].includes(state))
        || !['successCount', 'failureCount', 'excludedCount', 'durationSamples'].every(key => count(entry[key]))
        || (entry.averageSeconds !== null && (!Number.isFinite(entry.averageSeconds) || entry.averageSeconds < 0 || entry.averageSeconds > 604800))
        || !Number.isFinite(Date.parse(checkedAt)) || Date.parse(checkedAt) > now + 60000
        || !Number.isFinite(Date.parse(entry.validUntil))
        || (entry.lastCompletedAt !== null && !Number.isFinite(Date.parse(entry.lastCompletedAt)))) return unknown;
    const expired = now > Math.min(Date.parse(checkedAt) + 180000, Date.parse(entry.validUntil));
    const durations = Array.isArray(entry.sampleDurationsSeconds)
        && entry.sampleDurationsSeconds.length === entry.samples.length
        && entry.sampleDurationsSeconds.every(value => value === null || (Number.isFinite(value) && value >= 0 && value <= 604800))
        ? entry.sampleDurationsSeconds.slice() : entry.samples.map(() => null);
    return { state: expired ? 'unknown' : entry.state, reason: expired ? 'stale' : entry.reason,
        sampleDurationsSeconds: durations,
        samples: entry.samples.slice(), successCount: entry.successCount, failureCount: entry.failureCount,
        excludedCount: entry.excludedCount, durationSamples: entry.durationSamples, averageSeconds: entry.averageSeconds,
        checkedAt, validUntil: new Date(Math.min(Date.parse(checkedAt) + 180000, Date.parse(entry.validUntil))).toISOString(),
        lastCompletedAt: entry.lastCompletedAt };
}

export function withCatalogGenerationHealth(config, snapshots = {}, now = Date.now()) {
    return { ...config, models: config.models.map(entry => {
        const result = { ...entry };
        delete result.generationHealth;
        delete result.generationHealthTimings;
        if (!['image', 'video'].includes(entry.kind) || !entry.catalog?.model) return result;
        result.generationHealth = [...new Set(entry.catalog.hosts || [])].filter(host => Object.values(HOSTS).includes(host)).map(host => {
            const snapshot = snapshots[host];
            const metric = snapshot?.models?.find(model => model.model === entry.catalog.model);
            if (!metric && Number.isFinite(Date.parse(snapshot?.checkedAt)) && now - Date.parse(snapshot.checkedAt) < 180000) {
                return { host, ...projectHealth(null), reason: 'no_data', checkedAt: snapshot.checkedAt,
                    validUntil: new Date(Date.parse(snapshot.checkedAt) + 180000).toISOString() };
            }
            return { host, ...projectHealth(metric, snapshot?.checkedAt, now) };
        });
        // Keep the original strict health envelope compatible with clients that already validate it.
        result.generationHealthTimings = result.generationHealth.map(({ host, samples, sampleDurationsSeconds }) => ({
            host, seconds: sampleDurationsSeconds || samples.map(() => null)
        }));
        result.generationHealth = result.generationHealth.map(({ sampleDurationsSeconds: _durations, ...health }) => health);
        return result;
    }) };
}

export function createCatalogGenerationHealth({ dataDir, fetchImpl = fetch } = {}) {
    const snapshots = {};
    let pending, timer;
    async function refresh() {
        if (pending) return pending;
        pending = (async () => {
            let accounts;
            try { accounts = JSON.parse(fs.readFileSync(path.join(dataDir, 'admin-diagnostics-credentials.json'), 'utf8')); }
            catch { return; }
            await Promise.all(Object.entries(HOSTS).map(async ([site, host]) => {
                if (typeof accounts[site]?.key !== 'string' || accounts[site].key.length < 32) return;
                try {
                    const response = await fetchImpl(`https://${host}/internal/generation-health`, {
                        headers: { 'x-corvas-diagnostics-key': accounts[site].key },
                        redirect: 'error', signal: AbortSignal.timeout(20000) });
                    if (!response.ok) return;
                    const chunks = [];
                    let size = 0;
                    for await (const chunk of response.body) {
                        size += chunk.length;
                        if (size > 1024 * 1024) throw new Error('Statistics too large');
                        chunks.push(chunk);
                    }
                    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (!Array.isArray(value.models) || value.models.length > 5000) return;
                    snapshots[host] = { checkedAt: value.checkedAt, models: value.models.map(entry => ({
                        model: typeof entry.model === 'string' ? entry.model.slice(0, 200) : '',
                        ...projectHealth(entry, value.checkedAt)
                    })) };
                } catch { /* Last snapshot expires automatically; never block catalog reads. */ }
            }));
        })().finally(() => { pending = null; });
        return pending;
    }
    return { snapshots, refresh,
        start() { void refresh(); timer = setInterval(() => { void refresh(); }, 60000); timer.unref?.(); },
        close() { clearInterval(timer); }
    };
}
