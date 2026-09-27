const { normalizeErrorSubmission, sanitizeErrorReport, classifyErrorReportSite } = require('../shared/error-report-contract.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ERROR_REPORT_URL = 'https://artconfig.ravenhash.org/error-reports';
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 16 * 1024;
const SUBMISSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SUBMISSIONS = 30;

function receiptSummary(data) {
    if (data?.success !== true || !/^er_[a-f0-9]{32}$/.test(data.reportId)
        || typeof data.receivedAt !== 'string' || !Number.isFinite(Date.parse(data.receivedAt))) return null;
    return { success: true, reportId: data.reportId, receivedAt: data.receivedAt };
}

function submissionSummary(submission) {
    const input = JSON.parse(submission.body);
    const context = {};
    for (const key of ['requestId', 'taskId', 'clientTaskId', 'projectId', 'nodeId', 'model', 'site', 'error', 'code', 'category', 'stage', 'submissionState']) {
        if (typeof input.context?.[key] === 'string') context[key] = input.context[key].slice(0, 600);
    }
    return { submissionId: input.submissionId, requestId: input.requestId, site: input.site, context,
        description: input.description, contact: input.contact, createdAt: submission.createdAt,
        state: submission.receipt ? 'received' : 'pending', receipt: submission.receipt || null };
}

function safeRequestParameters(request = {}) {
    const result = {};
    for (const key of ['ratio', 'aspectRatio', 'resolution', 'resolutionTier', 'duration', 'seconds', 'quality', 'n', 'width', 'height']) {
        const value = request[key];
        if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
        else if (typeof value === 'string' && /^[\w.:+-]{1,40}$/.test(value)) result[key] = value;
    }
    const references = request.sourceReferences || request.referenceBindings;
    if (Array.isArray(references)) {
        result.referenceCount = references.length;
        for (const kind of ['image', 'video', 'audio']) {
            result[`${kind}ReferenceCount`] = references.filter(item => (item?.kind || item?.mediaType || item?.type) === kind).length;
        }
    }
    return result;
}

function errorReportContext(entry = {}) {
    const data = entry.data || entry;
    const error = data.error && typeof data.error === 'object' ? data.error : {};
    return {
        requestId: data.requestId || error.requestId,
        taskId: data.taskId || error.taskId,
        clientTaskId: data.clientTaskId,
        projectId: data.projectId,
        nodeId: data.nodeId,
        model: data.model,
        site: ['art', 'cart'].includes(data.site) ? data.site : 'unknown',
        time: entry.time || data.updatedAt,
        event: entry.event,
        error: typeof data.error === 'string' ? data.error : error.message,
        code: data.code || error.code,
        category: data.category || error.category,
        stage: data.stage || error.stage,
        submissionState: data.submissionState || error.submissionState,
        parameterIssues: data.parameterIssues || error.parameterIssues,
        params: data.parameters || data.params,
    };
}

async function readReceipt(response) {
    const advertisedSize = Number(response.headers?.get?.('content-length'));
    if (advertisedSize > MAX_RECEIPT_BYTES) throw new Error('回执格式异常，请稍后重试。');
    const reader = response.body?.getReader?.();
    if (!reader) throw new Error('回执格式异常，请稍后重试。');
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > MAX_RECEIPT_BYTES) throw new Error('回执格式异常，请稍后重试。');
            chunks.push(Buffer.from(next.value));
        }
        const result = receiptSummary(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (!result) throw new Error('回执格式异常，请稍后重试。');
        return result;
    } catch {
        await reader.cancel().catch(() => {});
        throw new Error('回执格式异常，请稍后重试。');
    } finally {
        reader.releaseLock();
    }
}

function createErrorReportClient({ getReport, getSecrets = () => [], fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 30000, directory } = {}) {
    const submissions = new Map();
    let storageError = null;
    const remove = id => {
        if (directory) {
            try { fs.unlinkSync(path.join(directory, `${id}.json`)); }
            catch (error) { if (error.code !== 'ENOENT') throw new Error('提交记录无法更新，请检查本地磁盘后重试。'); }
        }
        submissions.delete(id);
    };
    const persist = (id, submission) => {
        if (!directory) return;
        const temporary = path.join(directory, `.${id}.${crypto.randomUUID()}.tmp`);
        let descriptor;
        try {
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
            fs.chmodSync(directory, 0o700);
            descriptor = fs.openSync(temporary, 'wx', 0o600);
            fs.writeFileSync(descriptor, JSON.stringify({ formatVersion: 1, submissionId: id, body: submission.body,
                createdAt: submission.createdAt, receipt: submission.receipt || null }));
            fs.fsyncSync(descriptor);
            fs.closeSync(descriptor); descriptor = undefined;
            fs.renameSync(temporary, path.join(directory, `${id}.json`));
            fs.chmodSync(path.join(directory, `${id}.json`), 0o600);
        } catch {
            throw new Error('提交记录无法保存，请检查本地磁盘后重试。');
        } finally {
            if (descriptor !== undefined) fs.closeSync(descriptor);
            try { fs.unlinkSync(temporary); } catch { /* Successful rename removes the temporary file. */ }
        }
    };
    if (directory) {
        try {
            const files = fs.readdirSync(directory).filter(name => name.endsWith('.json') && SUBMISSION_ID.test(name.slice(0, -5)));
            for (const name of files) {
                const file = path.join(directory, name);
                const stat = fs.lstatSync(file);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REPORT_BYTES * 2 + MAX_RECEIPT_BYTES) continue;
                const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (saved.formatVersion !== 1 || saved.submissionId !== name.slice(0, -5) || typeof saved.body !== 'string'
                    || Buffer.byteLength(saved.body) > MAX_REPORT_BYTES) continue;
                const parsed = JSON.parse(saved.body);
                normalizeErrorSubmission(parsed);
                if (parsed.submissionId !== saved.submissionId) continue;
                submissions.set(saved.submissionId, { body: saved.body, createdAt: saved.createdAt,
                    receipt: receiptSummary(saved.receipt) });
            }
            while (submissions.size > MAX_SUBMISSIONS) {
                const oldest = [...submissions].filter(([, item]) => item.receipt)
                    .sort((a, b) => String(a[1].createdAt).localeCompare(String(b[1].createdAt)))[0];
                if (!oldest) throw new Error('Too many pending reports');
                remove(oldest[0]);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') storageError = '提交记录读取失败，请保留本地诊断目录并联系管理员。';
        }
    }
    return {
        summary() {
            return { submissions: [...submissions.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(submissionSummary), storageError };
        },
        async submit(input) {
            if (!input || !SUBMISSION_ID.test(input.submissionId || '')) throw new Error('提交编号无效，请重新打开提交窗口。');
            if (storageError) throw new Error(storageError);
            const id = input.submissionId.toLowerCase();
            let submission = submissions.get(id);
            if (!submission) {
                const diagnostic = await getReport();
                const secrets = getSecrets();
                let normalized;
                try {
                    const cleaned = sanitizeErrorReport({
                        formatVersion: 1, submissionId: input.submissionId, description: input.description, contact: input.contact,
                        site: input.site, requestId: input.requestId, context: input.context, diagnostic,
                    }, secrets);
                    for (const key of ['description', 'contact']) {
                        if (cleaned[key] && typeof cleaned[key] !== 'string') cleaned[key] = JSON.stringify(cleaned[key]);
                    }
                    normalized = normalizeErrorSubmission(cleaned);
                } catch (error) {
                    if (error.code === 'ERROR_REPORT_TOO_LARGE') throw new Error('诊断报告过大，请导出报告并联系管理员。');
                    throw new Error('提交信息无效，请重新打开提交窗口。');
                }
                const body = JSON.stringify(normalized);
                if (Buffer.byteLength(body) > MAX_REPORT_BYTES) throw new Error('诊断报告过大，请导出报告并联系管理员。');
                if (!submissions.has(id) && submissions.size >= MAX_SUBMISSIONS) {
                    const removable = [...submissions].filter(([, value]) => value.receipt && !value.pending)
                        .sort((a, b) => String(a[1].createdAt).localeCompare(String(b[1].createdAt)))[0];
                    if (removable) remove(removable[0]);
                    else throw new Error('提交记录已满，请先重试尚未确认的报告。');
                }
                submission = submissions.get(id);
                if (!submission) {
                    submission = { body, createdAt: new Date().toISOString() };
                    persist(id, submission);
                    submissions.set(id, submission);
                }
            }
            if (submission.receipt) return submission.receipt;
            if (submission.pending) return submission.pending;
            submission.pending = (async () => {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeoutMs);
                timer.unref?.();
                try {
                    const response = await fetchImpl(ERROR_REPORT_URL, {
                        method: 'POST', redirect: 'error', signal: controller.signal,
                        headers: { 'content-type': 'application/json', accept: 'application/json' },
                        body: submission.body,
                    });
                    if (!response.ok) {
                        await response.body?.cancel?.().catch(() => {});
                        if (response.status === 429) throw new Error('提交过于频繁，请稍后重试。');
                        if (response.status === 413) throw new Error('诊断报告过大，请导出报告并联系管理员。');
                        throw new Error('提交暂未完成，请稍后重试。');
                    }
                    const received = await readReceipt(response);
                    persist(id, { ...submission, receipt: received });
                    submission.receipt = received;
                    return submission.receipt;
                } catch (error) {
                    if (controller.signal.aborted) throw new Error('提交超时，可再次提交查询结果。');
                    if (/^(提交|回执|诊断报告)/.test(error.message)) throw error;
                    throw new Error('无法连接错误接收服务，请检查网络后重试。');
                } finally {
                    clearTimeout(timer);
                    submission.pending = null;
                }
            })();
            return submission.pending;
        },
    };
}

module.exports = { createErrorReportClient, safeRequestParameters, errorReportContext, classifyErrorReportSite, ERROR_REPORT_URL };
