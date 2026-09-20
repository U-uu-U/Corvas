const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Ajv = require('ajv');
const { keyFor } = require('./hunyuan-model-watcher.cjs');
const { WORKFLOW_TOOL_DEFINITIONS, HUNYUAN_RHINO_WORKFLOW } = require('../shared/workflow-tools.cjs');

const STAGES = ['inspect', 'clean', 'quad', 'validate'];
const ACTIVE = new Set(['generating', 'awaiting_confirmation', 'queued', 'downloading', 'connecting', 'waiting_rhino', 'importing', 'processing']);
const fail = (code, message) => Object.assign(new Error(message), { code, status: code === 'INVALID_ARGUMENTS' ? 400 : 409 });
const clone = value => JSON.parse(JSON.stringify(value));
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

class WorkflowService {
    constructor({ directory, getWorkflow, getAccounts, getRuntime }) {
        Object.assign(this, { directory, getWorkflow, getAccounts, getRuntime });
        const validator = new Ajv({ allErrors: true });
        this.validators = new Map(WORKFLOW_TOOL_DEFINITIONS.map(tool => [tool.name, validator.compile(tool.inputSchema)]));
    }
    execute(name, input = {}) {
        const validate = this.validators.get(name);
        if (!validate) throw fail('TOOL_NOT_FOUND', '工作流工具不存在');
        if (!validate(input)) throw fail('INVALID_ARGUMENTS', `工作流参数无效：${validate.errors.map(error => `${error.dataPath} ${error.message}`).join('; ')}`);
        const action = name.slice('flow_canvas.workflow.'.length);
        if (['run', 'status', 'history', 'resume', 'cancel'].includes(action)) this.getRuntime().board.readProject(input.projectId);
        return this[action](input);
    }
    list() { return { workflows: [clone(HUNYUAN_RHINO_WORKFLOW)], execution: 'local-script', requiresTextProvider: false }; }
    get({ workflowId }) {
        if (workflowId !== HUNYUAN_RHINO_WORKFLOW.id) throw fail('WORKFLOW_NOT_FOUND', '工作流不存在，请先读取 workflow.list');
        return clone(HUNYUAN_RHINO_WORKFLOW);
    }
    async sources({ accountId } = {}) {
        const accounts = this.getAccounts();
        if (accountId) accounts.account(accountId);
        const listed = accounts.list();
        if (listed.error) throw fail('SOURCE_UNAVAILABLE', listed.error);
        const candidates = listed.accounts.filter(account => !accountId || account.id === accountId);
        const sources = new Map(); const errors = [];
        const settled = await Promise.allSettled(candidates.filter(account => account.windowOpen).map(async account => {
            const source = await accounts.currentModel(account.id);
            sources.set(`${source.accountId}:${source.generationId}`, { ...source, origin: 'current' });
        }));
        settled.forEach((result, index) => {
            if (result.status === 'rejected') errors.push({ accountId: candidates.filter(account => account.windowOpen)[index].id, message: result.reason.message });
        });
        for (const job of this.getWorkflow().jobs) {
            if (!candidates.some(account => account.id === job.accountId)) continue;
            const key = `${job.accountId}:${job.generationId}`;
            if (sources.has(key)) continue;
            try { sources.set(key, { ...accounts.modelSource(job.accountId, job.generationId), origin: 'saved' }); }
            catch { /* Missing sources stay discoverable through task history. */ }
        }
        return { accounts: candidates.map(({ id, name, windowOpen, status }) => ({ id, name, windowOpen, status })),
            sources: [...sources.values()], errors };
    }
    run(input) {
        this.get({ workflowId: input.workflowId });
        if (input.version !== HUNYUAN_RHINO_WORKFLOW.version) throw fail('WORKFLOW_VERSION_CHANGED', '工作流版本已变化，请重新读取定义');
        const workflow = this.getWorkflow();
        if (workflow.closed || workflow.loadError) throw fail('WORKFLOW_UNAVAILABLE', workflow.loadError || '工作流执行器已关闭');
        const parameters = input.parameters?.targetQuads ? { targetQuads: input.parameters.targetQuads } : {};
        const fingerprint = JSON.stringify({ workflowId: input.workflowId, version: input.version,
            source: { accountId: input.source.accountId, generationId: input.source.generationId }, parameters });
        // A durable receipt lives in the same atomic record as its task. Check it
        // before accessing the browser so a lost response can be retried offline.
        const existing = workflow.jobs.find(job => job.projectId === input.projectId
            && job.workflowRequests?.some(request => request.requestId === input.requestId));
        if (existing) {
            const receipt = existing.workflowRequests.find(request => request.requestId === input.requestId);
            if (receipt.fingerprint !== fingerprint) throw fail('IDEMPOTENCY_CONFLICT', '同一 requestId 已用于不同输入或参数，请勿修改后重发');
            return { ...this.describe(existing), reused: true };
        }
        const source = this.getAccounts().modelSource(input.source.accountId, input.source.generationId);
        const sameSource = workflow.jobs.findLast(job => job.projectId === input.projectId && job.accountId === source.accountId
            && job.generationId === source.generationId && !job.dismissed && ACTIVE.has(job.status));
        const receipt = { requestId: input.requestId, fingerprint };
        if (sameSource) {
            if (JSON.stringify(sameSource.workflowParameters || {}) !== JSON.stringify(parameters)) throw fail('SOURCE_BUSY', '该模型已有不同参数的任务正在执行，请等待或取消后再开始');
            const previous = { ...sameSource };
            sameSource.workflowRequests = [...(sameSource.workflowRequests || []), receipt];
            sameSource.workflowId = input.workflowId; sameSource.workflowVersion = input.version;
            sameSource.workflowParameters = parameters; sameSource.approved = true; sameSource.updatedAt = Date.now();
            if (['generating', 'awaiting_confirmation'].includes(sameSource.status)) sameSource.status = 'queued';
            try { workflow.changed(); } catch (error) {
                for (const key of Object.keys(sameSource)) delete sameSource[key];
                Object.assign(sameSource, previous); throw error;
            }
            return { ...this.describe(sameSource), reused: true };
        }
        const job = { id: keyFor(randomUUID()), ...source, status: 'queued', approved: true, createdAt: Date.now(), updatedAt: Date.now(),
            projectId: input.projectId, conversationId: 'external-workflows', workflowId: input.workflowId,
            workflowVersion: input.version, workflowParameters: parameters, workflowRequests: [receipt] };
        workflow.jobs.push(job);
        try { workflow.changed(); } catch (error) { workflow.jobs.splice(workflow.jobs.indexOf(job), 1); throw error; }
        return { ...this.describe(job), reused: false };
    }
    find({ jobId, projectId }) {
        const workflow = this.getWorkflow();
        if (workflow.loadError) throw fail('WORKFLOW_UNAVAILABLE', workflow.loadError);
        workflow.syncRuns();
        const job = workflow.jobs.find(entry => entry.id === jobId);
        if (!job) throw fail('JOB_NOT_FOUND', '工作流任务不存在，请查看 history');
        if (job.projectId !== projectId) throw fail('PROJECT_MISMATCH', '该工作流任务属于其他项目');
        return job;
    }
    status(input) { return this.describe(this.find(input)); }
    history({ projectId, offset = 0, limit = 20 }) {
        const workflow = this.getWorkflow(); workflow.syncRuns();
        const jobs = workflow.jobs.filter(job => job.projectId === projectId)
            .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
        return { total: jobs.length, offset, nextOffset: offset + limit < jobs.length ? offset + limit : null,
            jobs: jobs.slice(offset, offset + limit).map(job => this.describe(job)) };
    }
    resume(input) {
        const job = this.find(input);
        const current = this.describe(job);
        if (ACTIVE.has(job.status) || job.status === 'completed') return { ...current, reused: true };
        if (!current.canResume) throw fail('RECOVERY_BLOCKED', current.recoveryReason || '当前任务不能恢复，请先检查已有结果');
        this.getWorkflow().update(job, 'queued', { approved: true, dismissed: false, error: '', resumeRequested: Boolean(job.runId || job.importStarted) });
        return this.describe(job);
    }
    cancel(input) {
        const job = this.find(input);
        if (job.status === 'completed' || job.status === 'canceled') return this.describe(job);
        const runtime = this.getRuntime();
        if (job.runId && runtime.runs.has(job.runId)) runtime.cancel({ runId: job.runId, projectId: job.projectId });
        this.getWorkflow().update(job, 'canceled', { cancelRequested: true, dismissed: true, error: '' });
        return { ...this.describe(job), cancellation: 'stops-following-stages',
            message: '已停止后续阶段；已派发的 Rhino 命令可能仍在运行，已生成文件和对象会保留。' };
    }
    describe(job) {
        const directory = path.join(this.directory, 'rhino-model-results', job.id);
        const dispatch = read(path.join(directory, 'cleanup-dispatch.json'));
        const reports = STAGES.map(stage => ({ stage, report: read(path.join(directory, `cleanup-${stage}.json`)) }));
        const pendingReport = reports.find(entry => entry.stage === dispatch?.stage)?.report;
        const unknown = ['dispatching', 'unknown'].includes(dispatch?.status) && dispatch.stage !== 'inspect'
            && (!pendingReport || pendingReport.jobId !== job.id || pendingReport.invocationId !== dispatch.invocationId
                || !['completed', 'failed'].includes(pendingReport.status));
        const runtime = this.getRuntime();
        const run = job.runId ? runtime.runs.get(job.runId) : null;
        const mutationUnknown = Object.values(run?.externalCalls || {}).some(call => !call.readOnly && ['dispatching', 'unknown'].includes(call.status));
        const busy = this.getWorkflow().runningJobId === job.id || (job.runId && runtime.controllers?.has(job.runId));
        const imported = read(path.join(directory, 'import-result.json'));
        const missingImport = job.importStarted && !job.runId && (!imported?.ok || imported.jobId !== job.id
            || !imported.meshIds?.length || (job.importInvocationId && imported.invocationId !== job.importInvocationId));
        const canResume = ['failed', 'interrupted'].includes(job.status) && !busy && !unknown && !mutationUnknown && !missingImport;
        const validated = reports.find(entry => entry.stage === 'validate')?.report;
        return { id: job.id, jobId: job.id, workflowId: job.workflowId || HUNYUAN_RHINO_WORKFLOW.id,
            version: job.workflowVersion || 1, projectId: job.projectId, runId: job.runId || null,
            source: { accountId: job.accountId, generationId: job.generationId }, parameters: job.workflowParameters || {},
            status: job.status, error: job.error || null, createdAt: job.createdAt, updatedAt: job.updatedAt || job.createdAt,
            stages: reports.map(({ stage, report }) => ({ stage, status: report?.status || 'not_started', elapsedSeconds: report?.elapsedSeconds,
                error: report?.error ? String(report.error).slice(-1800) : undefined })),
            outputs: validated?.ok ? (validated.outputs || []).map(entry => ({ objectId: entry.mesh?.id, sourceId: entry.source?.id,
                faces: entry.mesh?.faces, quads: entry.mesh?.quads, valid: entry.mesh?.valid, closed: entry.mesh?.closed })) : [],
            reportDirectory: fs.existsSync(directory) ? directory : null,
            canResume, recoveryReason: unknown || mutationUnknown || missingImport ? '外部操作结果尚未确定，请先核对 Rhino 场景和报告，不能盲目重新提交' : null,
            nextAction: job.status === 'completed' ? 'done' : job.status === 'canceled' ? 'stopped'
                : canResume ? 'resume' : ACTIVE.has(job.status) ? 'poll' : 'inspect',
            pollAfterMs: ACTIVE.has(job.status) ? 3000 : null };
    }
}
module.exports = { WorkflowService };
