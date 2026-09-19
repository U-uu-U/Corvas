const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { keyFor } = require('./hunyuan-model-watcher.cjs');
const { toolId } = require('./mcp-client.cjs');
const { RhinoCleanup } = require('./rhino-cleanup.cjs');
const CLEANUP_TOOL = 'flow_canvas.rhino.cleanup';

const ACTIVE = new Set(['downloading', 'connecting', 'importing', 'processing']);
const TERMINAL = new Set(['completed', 'failed', 'partial_failed', 'canceled', 'interrupted']);
class HunyuanRhinoWorkflow {
    constructor({ directory, getAccounts, getRhino, getRuntime, getProjectId, readMode, onChange }) {
        Object.assign(this, { directory, getAccounts, getRhino, getRuntime, getProjectId, onChange });
        this.file = path.join(directory, 'hunyuan-rhino-jobs.json');
        this.mode = readMode() === 'ask' ? 'ask' : 'auto'; this.context = null; this.jobs = [];
        this.running = false; this.closed = false;
        this.cleanup = new RhinoCleanup(directory);
        getRuntime().rhinoCleanup = (run, input) => this.executeCleanup(run, input);
        getRuntime().prepareRhinoResume = run => this.prepareResume(run);
        try {
            const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (saved.version !== 1 || !Array.isArray(saved.jobs) || saved.jobs.some(job =>
                !/^[a-f0-9]{32}$/.test(job?.id || '') || !/^[a-f0-9]{32}$/.test(job?.generationId || '')
                || typeof job.accountId !== 'string' || typeof job.worksId !== 'string')) throw new Error('Invalid workflow records');
            this.jobs = saved.jobs;
            for (const job of this.jobs) if (ACTIVE.has(job.status)) {
                job.status = 'interrupted'; job.error = '应用退出时处理尚未完成，请先检查 Rhino 和 Agent 中的已有结果。';
            }
            for (const job of this.jobs) if (job.status === 'failed' && !job.importStarted && !job.runId
                && /Rhino 已打开，但还未连接/.test(job.error || '')) {
                job.status = 'waiting_rhino'; job.error = '等待 Rhino 连接；关闭启动提示后会自动继续。';
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
            for (const job of this.jobs) if (['queued', 'waiting_rhino'].includes(job.status) && !job.approved) job.status = 'awaiting_confirmation';
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
        let id = keyFor(`${accountId}:${task.generationId}`);
        let job = task.explicitImport === true
            ? this.jobs.findLast(entry => entry.accountId === accountId && entry.generationId === task.generationId)
            : this.jobs.find(entry => entry.id === id);
        if (task.explicitImport === true && job?.status === 'completed') {
            // A later explicit click is a new requested pass; keep the earlier
            // result and automatic-delivery key, while coalescing clicks during a run.
            id = keyFor(`${id}:${randomUUID()}`); job = null;
        }
        if (!job) {
            job = { id, accountId, worksId: task.worksId, generationId: task.generationId, status: 'generating', createdAt: Date.now(),
                ...(this.context || { projectId: this.getProjectId() ?? null, conversationId: 'hunyuan-rhino' }) };
            this.jobs.push(job); this.changed();
        }
        if (task.explicitImport === true && task.status === 'ready') {
            // The persistent import button is itself the user's confirmation,
            // including for old results that are outside automatic tracking.
            job.dismissed = false;
            if (['generating', 'awaiting_confirmation', 'queued', 'waiting_rhino'].includes(job.status)
                || (job.status === 'failed' && !job.importStarted && !job.runId)) {
                const context = this.context || { projectId: this.getProjectId() ?? null, conversationId: 'hunyuan-rhino' };
                this.update(job, 'queued', { ...context, approved: true, error: '' });
            } else this.changed();
            return;
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
        } else if (action === 'confirm' && !job.dismissed && (['awaiting_confirmation', 'waiting_rhino'].includes(job.status)
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
        const job = this.jobs.find(entry => ['queued', 'waiting_rhino'].includes(entry.status) && !entry.dismissed);
        if (!job) return;
        if (!job.approved && this.mode !== 'auto') { this.update(job, 'awaiting_confirmation'); return; }
        this.running = true;
        try {
            if (job.status === 'waiting_rhino') {
                const rhino = this.getRhino();
                let state = await rhino.status();
                if (!state.connected && await rhino.probe(rhino.config.endpoint)) {
                    rhino.open({ connectOnly: true }); await rhino.pending; state = rhino.snapshot();
                }
                if (!state.connected) {
                    if (state.state === 'error') this.update(job, 'failed', { error: state.message });
                    return;
                }
            }
            await this.process(job);
        }
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
    jobForRun(run) {
        const job = this.jobs.find(entry => entry.id === run.source?.hunyuanJobId && entry.projectId === run.projectId);
        if (!job) throw new Error('找不到这条 Rhino 整理任务的绑定模型');
        return job;
    }
    async connectedRhino() {
        const rhino = this.getRhino();
        await rhino.status();
        if (!rhino.snapshot().connected) { rhino.open(); await rhino.pending; }
        if (!rhino.snapshot().connected) throw new Error(rhino.snapshot().message || 'Rhino 尚未连接，请等待启动完成再继续');
        return rhino;
    }
    async executeCleanup(run, input) {
        const job = this.jobForRun(run);
        const rhino = await this.connectedRhino();
        return this.cleanup.execute(job, input, rhino.mcpClient, rhino.server().id);
    }
    async prepareResume(run) {
        const job = this.jobForRun(run);
        const rhino = await this.connectedRhino();
        await this.restoreSourceIfEmpty(job, rhino);
        const { RHINO_EDIT_SKILL } = await import('../shared/rhino-model-skill.mjs');
        run.skillInstructions = [RHINO_EDIT_SKILL.instruction];
        run.source.rhinoSkillVersion = RHINO_EDIT_SKILL.version;
        run.execution = 'rhino_cleanup';
        run.toolAllowlist = [CLEANUP_TOOL, ...rhino.mcpClient.definitions()
            .filter(tool => rhino.mcpClient.tools.get(tool.name)?.serverId === rhino.server().id).map(tool => tool.name)];
        run.messages.push({ role: 'user', content: '继续这条 Rhino 整理任务。先用 flow_canvas.rhino.cleanup 的 status 查看阶段报告，再按 inspect、clean、quad、validate 执行缺少的阶段。该工具会写入真实脚本文件并复用已完成结果。不要重新导入模型，也不要把 Python 源码放进 RunPythonScript 命令字符串。' });
        this.getRuntime().runStore?.save(run);
        this.update(job, 'processing', { runId: run.id, dismissed: false, error: '' });
    }
    async restoreSourceIfEmpty(job, rhino) {
        const directory = path.join(this.directory, 'rhino-model-results', job.id);
        const imported = JSON.parse(fs.readFileSync(path.join(directory, 'import-result.json'), 'utf8'));
        const scene = async input => {
            const result = await rhino.mcpClient.call(toolId(rhino.server().id, 'rhino_scene'), { action: 'objects', includeHidden: 'true', ...input });
            const data = (result.content || []).flatMap(block => { try { return [JSON.parse(block.text)]; } catch { return []; } })
                .find(value => Array.isArray(value?.objects));
            if (result.isError || !data || data.success === false) throw new Error('无法核对 Rhino 当前文档，请检查连接后继续');
            return data.objects;
        };
        const objects = await scene({ ids: JSON.stringify(imported.meshIds), limit: imported.meshIds.length });
        if (imported.meshIds.every(id => objects.some(object => object.id === id))) return;
        if ((await scene({ limit: 1 })).length) throw new Error('当前 Rhino 文档里找不到此任务的原模型。请打开原文档，或新建空白文档后继续，不会覆盖其他模型。');
        const archive = path.join(directory, `previous-session-${Date.now()}`);
        fs.mkdirSync(archive, { recursive: true });
        for (const file of ['cleanup-inspect.json', 'cleanup-clean.json', 'cleanup-quad.json', 'cleanup-validate.json', 'cleanup-dispatch.json']) {
            if (fs.existsSync(path.join(directory, file))) fs.renameSync(path.join(directory, file), path.join(archive, file));
        }
        job.filePath = await this.getAccounts().downloadModel(job.accountId, job.generationId);
        await this.importModel(job, rhino);
    }
    async importModel(job, rhino) {
        const scriptDir = path.join(os.tmpdir(), 'corvas-hunyuan-rhino', job.id);
        const resultDirectory = path.join(this.directory, 'rhino-model-results', job.id);
        fs.mkdirSync(scriptDir, { recursive: true }); fs.mkdirSync(resultDirectory, { recursive: true });
        const script = path.join(scriptDir, 'import-hunyuan.py');
        const report = path.join(resultDirectory, 'import-result.json');
        const invocationId = randomUUID();
        fs.copyFileSync(path.join(__dirname, 'rhino', 'import-hunyuan.py'), script);
        fs.writeFileSync(path.join(scriptDir, 'import-options.json'), JSON.stringify({ jobId: job.id, filePath: job.filePath, resultDirectory, invocationId }));
        this.update(job, 'importing', { importStarted: true });
        await rhino.mcpClient.call(toolId(rhino.server().id, 'rhino_scene'), { action: 'script', cmd: `_-RunPythonScript "${script}"` });
        const imported = JSON.parse(fs.readFileSync(report, 'utf8'));
        if (!imported.ok || imported.jobId !== job.id || imported.invocationId !== invocationId || !imported.meshIds?.length) throw new Error('Rhino 导入结果不完整');
        job.importResult = imported;
        return { imported, resultDirectory, report };
    }
    async process(job) {
        const runtime = this.getRuntime();
        runtime.board.readProject(job.projectId);
        this.update(job, 'downloading', { error: '' });
        job.filePath = await this.getAccounts().downloadModel(job.accountId, job.generationId);
        if (!this.assertProceed(job)) return;
        this.update(job, 'connecting');
        const rhino = this.getRhino();
        rhino.open(); await rhino.pending;
        if (!rhino.snapshot().connected && rhino.snapshot().state === 'waiting') {
            this.update(job, 'waiting_rhino', { error: 'Rhino 正在等待启动完成。关闭插件提示后会自动继续，也可以点击“重试连接”。' });
            return;
        }
        if (!rhino.snapshot().connected) throw new Error(rhino.snapshot().message || 'Rhino 尚未连接');
        if (!this.assertProceed(job)) return;
        const mcp = rhino.mcpClient;
        const { imported, resultDirectory, report } = await this.importModel(job, rhino);
        const { RHINO_EDIT_SKILL } = await import('../shared/rhino-model-skill.mjs');
        const sourceDescription = imported.meshIds.length <= 128 ? JSON.stringify(imported.meshIds)
            : `共有 ${imported.meshIds.length} 个网格，完整 meshIds 数组见 ${JSON.stringify(report)}，请通过 Rhino 脚本读取该数组后按批处理，不要枚举整个场景代替它`;
        const importSummary = { totalMeshes: imported.meshIds.length, totalFaces: imported.faceCount,
            meshes: (imported.meshStats || []).slice(0, 80), omittedMeshes: Math.max(0, imported.meshIds.length - 80) };
        const request = {
            projectId: job.projectId, conversationId: job.conversationId, mode: 'auto', execution: 'rhino_cleanup',
            source: { hunyuanJobId: job.id, rhinoSkillVersion: RHINO_EDIT_SKILL.version }, selectedItemIds: [], attachments: [],
            skillInstructions: [RHINO_EDIT_SKILL.instruction],
            toolAllowlist: [CLEANUP_TOOL, ...mcp.definitions().filter(tool => mcp.tools.get(tool.name)?.serverId === rhino.server().id).map(tool => tool.name)],
            messages: [{ role: 'user', content: `将刚从混元导入 Rhino 的模型按“Rhino 模型编辑”Skill 整理四边面。此次发送和整理已获授权。\n`
                + `只使用已连接服务 ${rhino.server().name}，先核对当前文档序号 ${imported.documentId}；若文档不同就停止，不切换或覆盖文档。\n`
                + `只处理这些网格对象 ID：${sourceDescription}。它们已导入，禁止重新导入文件，不要使用当前选择代替这些 ID。\n`
                + `任务标签：${job.id}。阶段报告目录：${JSON.stringify(resultDirectory)}。导入统计摘要：${JSON.stringify(importSummary)}。完整统计见 import-result.json。\n`
                + '必须调用 flow_canvas.rhino.cleanup，依次完成 inspect、clean、quad、validate；status 用于检查已有报告。该工具已绑定本次源模型并自动保存实际脚本，不要自行拼接 Python 命令或尝试写入脚本文件。\n'
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
