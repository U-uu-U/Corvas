const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { keyFor } = require('./hunyuan-model-watcher.cjs');
const { toolId } = require('./mcp-client.cjs');

const ACTIVE = new Set(['downloading', 'connecting', 'importing', 'processing']);
const TERMINAL = new Set(['completed', 'failed', 'partial_failed', 'canceled', 'interrupted']);
class HunyuanRhinoWorkflow {
    constructor({ directory, getAccounts, getRhino, getRuntime, getProjectId, readMode, onChange }) {
        Object.assign(this, { directory, getAccounts, getRhino, getRuntime, getProjectId, onChange });
        this.file = path.join(directory, 'hunyuan-rhino-jobs.json');
        this.mode = readMode() === 'ask' ? 'ask' : 'auto'; this.context = null; this.jobs = [];
        this.running = false; this.closed = false;
        try {
            const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (saved.version !== 1 || !Array.isArray(saved.jobs) || saved.jobs.some(job =>
                !/^[a-f0-9]{32}$/.test(job?.id || '') || !/^[a-f0-9]{32}$/.test(job?.generationId || '')
                || typeof job.accountId !== 'string' || typeof job.worksId !== 'string')) throw new Error('Invalid workflow records');
            this.jobs = saved.jobs;
            for (const job of this.jobs) if (ACTIVE.has(job.status)) {
                job.status = 'interrupted'; job.error = '应用退出时处理尚未完成，请先检查 Rhino 和 Agent 中的已有结果。';
            }
        } catch (error) {
            if (error.code !== 'ENOENT') this.loadError = '模型传递记录读取失败，原文件已保留，自动处理已暂停';
        }
        const stopOnStorageError = () => {
            this.loadError = '模型传递记录无法保存，自动处理已暂停，请检查磁盘空间后重启';
            this.onChange(this.snapshot());
        };
        this.timer = setInterval(() => {
            if (this.closed || this.loadError) return;
            try { this.syncRuns(); } catch { stopOnStorageError(); return; }
            void this.drain().catch(stopOnStorageError);
        }, 1500);
    }
    snapshot(accountId) {
        return { mode: this.mode, error: this.loadError || '', jobs: this.jobs.filter(job => !accountId || job.accountId === accountId)
            .map(({ worksId, filePath, importResult, ...job }) => job) };
    }
    persist() {
        if (this.loadError) throw new Error(this.loadError);
        fs.mkdirSync(this.directory, { recursive: true });
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, jobs: this.jobs }, null, 2));
        fs.renameSync(`${this.file}.tmp`, this.file);
    }
    changed() { this.persist(); this.onChange(this.snapshot()); }
    update(job, status, extra = {}) { Object.assign(job, extra, { status, updatedAt: Date.now() }); this.changed(); }
    configure({ mode, projectId, conversationId } = {}) {
        this.mode = mode === 'ask' ? 'ask' : 'auto';
        if (typeof conversationId === 'string' && conversationId.length <= 200) {
            this.getRuntime().board.readProject(projectId ?? null);
            this.context = { projectId: projectId ?? null, conversationId };
        }
        if (this.mode === 'ask') {
            for (const job of this.jobs) if (job.status === 'queued' && !job.approved) job.status = 'awaiting_confirmation';
        } else {
            for (const job of this.jobs) if (job.status === 'awaiting_confirmation' && !job.dismissed) job.status = 'queued';
        }
        if (!this.loadError) this.changed();
        return this.snapshot();
    }
    observe(accountId, task) {
        if (this.closed || this.loadError || typeof task?.worksId !== 'string' || task.worksId.length > 200
            || !['generating', 'ready', 'generation_failed'].includes(task.status)) return;
        if (!/^[a-f0-9]{32}$/.test(task.generationId || '')) return;
        const id = keyFor(`${accountId}:${task.generationId}`);
        let job = this.jobs.find(entry => entry.id === id);
        if (!job) {
            job = { id, accountId, worksId: task.worksId, generationId: task.generationId, status: 'generating', createdAt: Date.now(),
                ...(this.context || { projectId: this.getProjectId() ?? null, conversationId: 'hunyuan-rhino' }) };
            this.jobs.push(job); this.changed();
        }
        if (job.status !== 'generating') return;
        if (task.status === 'ready') this.update(job, this.mode === 'auto' ? 'queued' : 'awaiting_confirmation');
        if (task.status === 'generation_failed') this.update(job, 'failed', { error: '混元生成未完成，未发送到 Rhino', dismissed: true });
    }
    action({ id, action }, accountId) {
        const job = this.jobs.find(entry => entry.id === id && (!accountId || entry.accountId === accountId));
        if (!job) throw new Error('模型传递任务不存在');
        if (action === 'dismiss' && !ACTIVE.has(job.status) && job.status !== 'queued') {
            job.dismissed = true; this.changed();
        } else if (action === 'confirm' && !job.dismissed && (job.status === 'awaiting_confirmation'
            || (job.status === 'failed' && !job.runId && !job.importStarted))) {
            this.update(job, 'queued', { approved: true, error: '' });
        }
        return this.snapshot(accountId);
    }
    syncRuns() {
        const runtime = this.getRuntime();
        for (const job of this.jobs) {
            if (!['processing', 'interrupted'].includes(job.status)) continue;
            const run = job.runId ? runtime.runs.get(job.runId) : [...runtime.runs.values()]
                .find(run => run.source?.hunyuanJobId === job.id);
            if (!run) continue;
            if (!job.runId) job.runId = run.id;
            if (!TERMINAL.has(run.status) && job.status === 'interrupted') this.update(job, 'processing', { error: '' });
            if (TERMINAL.has(run.status) && job.runtimeStatus !== run.status) {
                this.update(job, run.status === 'completed' ? 'completed' : 'interrupted',
                    { runtimeStatus: run.status, error: run.status === 'completed' ? '' : '整理任务未完成，请在 Agent 中查看执行过程，检查已有结果后再继续。' });
            }
        }
    }
    async drain() {
        if (this.closed || this.running || this.loadError || this.jobs.some(job => job.status === 'processing'
            || (job.status === 'interrupted' && !job.dismissed))) return;
        const job = this.jobs.find(entry => entry.status === 'queued' && !entry.dismissed);
        if (!job) return;
        if (!job.approved && this.mode !== 'auto') { this.update(job, 'awaiting_confirmation'); return; }
        this.running = true;
        try { await this.process(job); }
        catch (error) {
            if (!this.closed) this.update(job, job.importStarted ? 'interrupted' : 'failed',
                { error: job.importStarted ? 'Rhino 操作未取得完整结果，请检查模型与 Agent 记录，不会自动重复导入。' : error.message });
        } finally { this.running = false; }
    }
    assertProceed(job) {
        if (this.closed) throw new Error('应用正在关闭');
        if (!job.approved && this.mode !== 'auto') {
            this.update(job, 'awaiting_confirmation'); return false;
        }
        return true;
    }
    async process(job) {
        const runtime = this.getRuntime();
        runtime.board.readProject(job.projectId);
        // Fail before touching Rhino when no tool-capable text provider is configured.
        const provider = runtime.resolveProvider({}, 'text');
        this.update(job, 'downloading', { error: '' });
        job.filePath = await this.getAccounts().downloadModel(job.accountId, job.generationId);
        if (!this.assertProceed(job)) return;
        this.update(job, 'connecting');
        const rhino = this.getRhino();
        rhino.open(); await rhino.pending;
        if (!rhino.snapshot().connected) throw new Error(rhino.snapshot().message || 'Rhino 尚未连接');
        if (!this.assertProceed(job)) return;
        const mcp = rhino.mcpClient;
        const sceneTool = toolId(rhino.server().id, 'rhino_scene');
        const scriptDir = path.join(os.tmpdir(), 'corvas-hunyuan-rhino', job.id);
        fs.mkdirSync(scriptDir, { recursive: true });
        const script = path.join(scriptDir, 'import-hunyuan.py');
        const report = path.join(scriptDir, 'import-result.json');
        fs.copyFileSync(path.join(__dirname, 'rhino', 'import-hunyuan.py'), script);
        fs.writeFileSync(path.join(scriptDir, 'import-options.json'), JSON.stringify({ jobId: job.id, filePath: job.filePath }));
        this.update(job, 'importing', { importStarted: true });
        await mcp.call(sceneTool, { action: 'script', cmd: `_-RunPythonScript "${script}"` });
        const imported = JSON.parse(fs.readFileSync(report, 'utf8'));
        if (!imported.ok || imported.jobId !== job.id || !imported.meshIds?.length) throw new Error('Rhino 导入结果不完整');
        job.importResult = imported;
        const { RHINO_EDIT_SKILL } = await import('../shared/rhino-model-skill.mjs');
        const request = {
            projectId: job.projectId, conversationId: job.conversationId, provider, mode: 'auto',
            source: { hunyuanJobId: job.id }, selectedItemIds: [], attachments: [],
            skillInstructions: [RHINO_EDIT_SKILL.instruction],
            toolAllowlist: mcp.definitions().filter(tool => mcp.tools.get(tool.name)?.serverId === rhino.server().id).map(tool => tool.name),
            messages: [{ role: 'user', content: `将刚从混元导入 Rhino 的模型按“Rhino 模型编辑”Skill 整理四边面。此次发送和整理已获授权。\n`
                + `只使用已连接服务 ${rhino.server().name}，先核对当前文档序号 ${imported.documentId}；若文档不同就停止，不切换或覆盖文档。\n`
                + `只处理这些网格对象 ID：${JSON.stringify(imported.meshIds)}。它们已导入，禁止重新导入文件，不要使用当前选择代替这些 ID。\n`
                + '保留原模型和材质，在独立图层的副本上清理、统一法线并执行一次适当密度的 QuadRemesh。根据本模型决定密度与对称轴，不套用固定产品模板。不自动转 NURBS 或清空 Grasshopper。分阶段记录对象 ID 和统计，超时先检查结果，不重复重计算。完成后读取 Rhino 视口截图并总结。' }]
        };
        // Record the launch boundary before starting: recovery searches source.hunyuanJobId.
        this.update(job, 'processing');
        const run = runtime.start(request);
        this.update(job, 'processing', { runId: run.id });
    }
    close() { this.closed = true; clearInterval(this.timer); }
}
module.exports = { HunyuanRhinoWorkflow };
