import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import contract from './error-report-contract.cjs';

const { normalizeErrorSubmission, sanitizeErrorReport } = contract;
const REPORT_ID = /^er_[a-f0-9]{32}$/;
const REQUEST_ID = /^(?:rh|fc)_[A-Za-z0-9_-]{8,80}$/;
const STATES = new Set(['new', 'investigating', 'resolved']);
const DEFAULT_LIMITS = Object.freeze({ retentionMs: 30 * 86400000, maxReports: 10000,
    maxBytes: 512 * 1024 * 1024, maxReportBytes: 8 * 1024 * 1024,
    rateWindowMs: 3600000, perIp: 12, global: 300, maxRateKeys: 10000 });

function fail(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function summary(report) {
    const submission = report.submission;
    return { reportId: report.reportId, receivedAt: report.receivedAt, updatedAt: report.updatedAt,
        status: report.status, description: submission.description, contact: submission.contact,
        site: submission.site, requestId: submission.requestId,
        model: submission.context?.model || submission.context?.modelId || '',
        evidenceState: report.serverEvidence?.state || 'pending' };
}

function relatedRequests(submission) {
    const candidates = [];
    const seen = new Map();
    const site = ['art', 'cart'].includes(submission.site) ? submission.site : 'unknown';
    const add = (value, inheritedSite = site) => {
        if (typeof value === 'string') value = { requestId: value };
        if (!value || typeof value !== 'object' || typeof value.requestId !== 'string'
            || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value.requestId)) return;
        const candidateSite = ['art', 'cart'].includes(value.site) ? value.site : inheritedSite;
        const previous = seen.get(value.requestId);
        if (previous) {
            if (previous.site === 'unknown' && candidateSite !== 'unknown') previous.site = candidateSite;
            return;
        }
        const candidate = { site: candidateSite, requestId: value.requestId };
        seen.set(value.requestId, candidate);
        if (REQUEST_ID.test(value.requestId) && candidates.length < 6) candidates.push(candidate);
    };
    add(submission.requestId);
    add(submission.context);
    for (const value of Array.isArray(submission.context?.relatedRequests) ? submission.context.relatedRequests : []) add(value);
    for (const value of Array.isArray(submission.context?.requestIds) ? submission.context.requestIds : []) add(value);
    const context = submission.context || {};
    const diagnostic = submission.diagnostic || {};
    const related = item => item && typeof item === 'object' && (
        (context.taskId && [item.taskId, item.id].includes(context.taskId))
        || (context.clientTaskId && [item.clientTaskId, item.id].includes(context.clientTaskId))
        || (!context.taskId && !context.clientTaskId && context.nodeId && item.nodeId === context.nodeId)
        || [item.requestId, item.serverRequestId, item.error?.requestId, item.requestDiagnostic?.requestId].some(id => seen.has(id)));
    const items = [...(Array.isArray(diagnostic.tasks) ? diagnostic.tasks : []),
        ...(Array.isArray(diagnostic.events) ? diagnostic.events : []).map(entry => entry?.data || entry)];
    // Task records connect local IDs to request IDs; response-header events connect those to server IDs.
    for (let pass = 0; pass < 3; pass++) {
        for (const item of items) {
            if (!related(item)) continue;
            const knownSite = [item.requestId, item.serverRequestId].map(id => seen.get(id)?.site).find(value => ['art', 'cart'].includes(value));
            const itemSite = ['art', 'cart'].includes(item.site) ? item.site : knownSite || site;
            add({ requestId: item.serverRequestId, site: itemSite });
            add(item, itemSite);
            add(item.error, itemSite);
            add(item.requestDiagnostic, itemSite);
            for (const value of Array.isArray(item.requestIds) ? item.requestIds : []) add(value, itemSite);
        }
    }
    return candidates;
}

export function createCustomerErrorReports({ dataDir, requestDiagnostics, limits: limitOverrides = {}, now = Date.now } = {}) {
    const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
    const directory = path.join(dataDir, 'customer-error-reports');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const index = new Map();
    const submissions = new Map();
    const ipWindows = new Map();
    let totalBytes = 0;
    let globalWindow = { start: now(), count: 0 };
    let closed = false;
    const jobs = new Map();
    const queue = [];
    let running = 0;

    const filename = id => path.join(directory, `${id}.json`);
    const read = id => {
        if (!REPORT_ID.test(id || '') || !index.has(id)) throw fail(404, '未找到这份错误提交，可能已超过保留时间');
        try { return JSON.parse(fs.readFileSync(filename(id), 'utf8')); }
        catch { throw fail(500, '错误提交文件暂时无法读取'); }
    };
    const put = report => {
        const text = `${JSON.stringify(report, null, 2)}\n`;
        const size = Buffer.byteLength(text);
        const previousSize = index.get(report.reportId)?.size || 0;
        if (size > limits.maxReportBytes || totalBytes - previousSize + size > limits.maxBytes) {
            throw fail(503, '错误提交存储空间不足，请稍后重试');
        }
        const target = filename(report.reportId);
        const temporary = `${target}.${crypto.randomBytes(8).toString('hex')}.tmp`;
        try {
            fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            fs.renameSync(temporary, target);
        } finally {
            if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        }
        totalBytes += size - previousSize;
        index.set(report.reportId, { size, submissionId: report.submission.submissionId, ...summary(report) });
        submissions.set(report.submission.submissionId, report.reportId);
        return report;
    };
    const prune = () => {
        const cutoff = now() - limits.retentionMs;
        for (const [id, entry] of index) {
            if (Date.parse(entry.receivedAt) > cutoff) continue;
            fs.unlinkSync(filename(id));
            totalBytes -= entry.size;
            submissions.delete(entry.submissionId);
            index.delete(id);
        }
        for (const [key, window] of ipWindows) {
            if (now() - window.start >= limits.rateWindowMs) ipWindows.delete(key);
        }
    };
    for (const name of fs.readdirSync(directory)) {
        if (!/^er_[a-f0-9]{32}\.json$/.test(name)) continue;
        const location = path.join(directory, name);
        const size = fs.statSync(location).size;
        if (size > limits.maxReportBytes) throw new Error('Customer error report exceeds configured storage limit');
        const report = JSON.parse(fs.readFileSync(location, 'utf8'));
        if (name !== `${report.reportId}.json` || !report.submission?.submissionId) throw new Error('Invalid customer error report file');
        index.set(report.reportId, { size, submissionId: report.submission.submissionId, ...summary(report) });
        submissions.set(report.submission.submissionId, report.reportId);
        totalBytes += size;
    }
    prune();
    const timer = setInterval(() => { try { prune(); } catch { /* A later write or explicit read will report storage failures. */ } }, Math.min(limits.retentionMs, 3600000));
    timer.unref();

    function consumeRate(ip) {
        const timestamp = now();
        if (timestamp - globalWindow.start >= limits.rateWindowMs) globalWindow = { start: timestamp, count: 0 };
        const hash = crypto.createHash('sha256').update(String(ip || 'unknown')).digest('hex');
        let window = ipWindows.get(hash);
        if (!window || timestamp - window.start >= limits.rateWindowMs) window = { start: timestamp, count: 0 };
        if (window.count >= limits.perIp || globalWindow.count >= limits.global || (!ipWindows.has(hash) && ipWindows.size >= limits.maxRateKeys)) {
            throw fail(429, '提交过于频繁，请稍后重试');
        }
        window.count++;
        globalWindow.count++;
        ipWindows.set(hash, window);
    }

    async function enrich(id) {
        let report;
        try { report = read(id); } catch { return; }
        const candidates = relatedRequests(report.submission);
        const entries = [];
        for (let start = 0; start < candidates.length; start += 3) {
            entries.push(...await Promise.all(candidates.slice(start, start + 3).map(async candidate => {
                const checkedAt = new Date(now()).toISOString();
                if (candidate.site === 'unknown') return { ...candidate, checkedAt, state: 'site_unknown', message: '客户端未提供可确认的站点，未跨站猜测查询' };
                try {
                    const result = await requestDiagnostics.get(candidate.site, candidate.requestId);
                    return { ...candidate, checkedAt, state: result.status === 200 ? 'found' : result.status === 404 ? 'not_found' : 'unavailable',
                        httpStatus: result.status, detail: sanitizeErrorReport(result.body) };
                } catch {
                    return { ...candidate, checkedAt, state: 'unavailable', message: '服务端诊断暂时无法连接' };
                }
            })));
        }
        try { report = read(id); } catch { return; }
        const timestamp = new Date(now()).toISOString();
        report.serverEvidence = { checkedAt: timestamp, state: !entries.length ? 'no_request_id'
            : entries.every(item => item.state === 'found') ? 'complete'
                : entries.some(item => item.state === 'found') ? 'partial' : 'unavailable', entries,
        billingNotice: '缺少记录不代表未扣费或已退款；以中转站账务记录为准' };
        report.updatedAt = timestamp;
        try { put(report); }
        catch {
            report.serverEvidence = { checkedAt: timestamp, state: 'unavailable', entries: [], message: '诊断快照超过存储限制，客户提交已保留' };
            try { put(report); } catch { /* The original client report is already durable. */ }
        }
    }

    function runQueue() {
        while (running < 2 && queue.length) {
            const { id, resolve } = queue.shift();
            running++;
            enrich(id).catch(() => {}).finally(() => {
                running--;
                jobs.delete(id);
                resolve();
                runQueue();
            });
        }
    }
    function schedule(id) {
        if (jobs.has(id)) return jobs.get(id);
        if (closed) return Promise.resolve();
        const promise = new Promise(resolve => queue.push({ id, resolve }));
        jobs.set(id, promise);
        runQueue();
        return promise;
    }

    for (const [id, entry] of index) if (entry.evidenceState === 'pending') schedule(id);

    return {
        admit(ip) { prune(); consumeRate(ip); },
        submit(input, ip = 'unknown', { rateChecked = false } = {}) {
            prune();
            let submission;
            try { submission = normalizeErrorSubmission(input); }
            catch (error) { throw fail(error.status === 413 ? 413 : 400, error.status === 413
                ? '错误提交不能超过 2 MiB' : '错误提交内容无效，请更新客户端或重新提交'); }
            const existing = submissions.get(submission.submissionId);
            if (existing) {
                const entry = index.get(existing);
                return { success: true, reportId: existing, receivedAt: entry.receivedAt };
            }
            if (!rateChecked) consumeRate(ip);
            if (index.size >= limits.maxReports) throw fail(503, '错误提交数量已达上限，请稍后重试');
            const timestamp = new Date(now()).toISOString();
            const report = put({ formatVersion: 1, reportId: `er_${crypto.randomBytes(16).toString('hex')}`,
                receivedAt: timestamp, updatedAt: timestamp, status: 'new', adminNote: '',
                submission, serverEvidence: { state: 'pending', entries: [] } });
            schedule(report.reportId);
            return { success: true, reportId: report.reportId, receivedAt: report.receivedAt };
        },
        list({ status = '', q = '', offset = 0 } = {}) {
            prune();
            if (status && !STATES.has(status)) throw fail(400, '错误提交状态无效');
            const query = String(q).slice(0, 200).toLocaleLowerCase();
            const start = Math.max(0, Math.floor(Number(offset) || 0));
            const entries = [...index.values()].filter(entry => (!status || entry.status === status)
                && (!query || [entry.reportId, entry.requestId, entry.description, entry.contact, entry.model, entry.site]
                    .some(value => String(value || '').toLocaleLowerCase().includes(query))))
                .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
            const counts = { new: 0, investigating: 0, resolved: 0 };
            for (const entry of index.values()) counts[entry.status]++;
            return { reports: entries.slice(start, start + 30).map(({ size: _size, submissionId: _submissionId, ...entry }) => entry),
                total: entries.length, offset: start, limit: 30, counts, retentionDays: limits.retentionMs / 86400000 };
        },
        get(id) { prune(); return read(id); },
        setStatus(id, { status, adminNote = '' } = {}) {
            prune();
            if (!STATES.has(status) || typeof adminNote !== 'string' || adminNote.length > 10000) throw fail(400, '状态或管理员备注无效');
            const report = read(id);
            report.status = status;
            report.adminNote = sanitizeErrorReport({ adminNote }).adminNote || '';
            report.updatedAt = new Date(now()).toISOString();
            return put(report);
        },
        async refresh(id) { prune(); read(id); await schedule(id); return read(id); },
        async waitForIdle() { await Promise.all([...jobs.values()]); },
        async close() { closed = true; clearInterval(timer); await Promise.all([...jobs.values()]); }
    };
}

export { DEFAULT_LIMITS as CUSTOMER_ERROR_REPORT_LIMITS };
