const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { toolId } = require('./mcp-client.cjs');
const STAGES = ['inspect', 'clean', 'quad', 'validate'];
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const unknown = () => Object.assign(new Error('Rhino 整理阶段的结果尚未确定，请先读取 status 检查报告，不会重复重计算。'), { code: 'MCP_RESULT_UNKNOWN' });

class RhinoCleanup {
    constructor(directory) { this.directory = directory; this.pending = new Map(); }
    async execute(job, input, mcp, serverId) {
        if (!/^[a-f0-9]{32}$/.test(job.id)) throw new Error('模型整理任务标识无效');
        const directory = path.join(this.directory, 'rhino-model-results', job.id);
        if (input.stage === 'status') return { jobId: job.id, stages: STAGES.map(stage => {
            const report = read(path.join(directory, `cleanup-${stage}.json`));
            return { stage, status: report?.status || 'not_started', outputs: report?.outputs, error: report?.error };
        }) };
        if (!STAGES.includes(input.stage)) throw new Error('不支持的整理阶段');
        if (input.targetQuads != null && (!Number.isInteger(input.targetQuads) || input.targetQuads < 500 || input.targetQuads > 100000)) throw new Error('四边面目标数量无效');
        if (this.pending.has(job.id)) throw new Error('该模型已有整理阶段正在执行，请等待完成');
        const reportFile = path.join(directory, `cleanup-${input.stage}.json`);
        const stateFile = path.join(directory, 'cleanup-dispatch.json');
        const previous = read(reportFile);
        const dispatch = read(stateFile);
        if (['dispatching', 'unknown'].includes(dispatch?.status) && dispatch.stage !== 'inspect') {
            const last = read(path.join(directory, `cleanup-${dispatch.stage}.json`));
            if (!last || last.invocationId !== dispatch.invocationId || last.status === 'running') throw unknown();
        }
        if (input.stage !== 'inspect' && previous?.ok && previous.jobId === job.id) {
            if (input.stage === 'quad' && input.targetQuads && input.targetQuads !== previous.targetQuads) throw new Error('该任务已有其他密度的结果，请明确创建新一轮整理');
            const expected = (previous.outputs || []).map(entry => entry.mesh?.id).filter(Boolean);
            const response = await mcp.call(toolId(serverId, 'rhino_scene'), { action: 'objects', ids: JSON.stringify(expected), includeHidden: 'true', limit: expected.length });
            const scene = (response.content || []).filter(block => block.type === 'text').map(block => {
                try { return JSON.parse(block.text); } catch { return null; }
            }).find(value => Array.isArray(value?.objects));
            if (response.isError || !expected.length || !scene || scene.success === false || expected.some(id => !scene.objects.some(object => object.id === id))) {
                throw new Error('已有阶段结果不在当前 Rhino 文档中，请打开原文档后继续');
            }
            return { ...previous, reused: true };
        }
        if (previous?.status === 'running' && input.stage !== 'inspect') throw unknown();
        const work = (async () => {
            const imported = read(path.join(directory, 'import-result.json'));
            if (!imported?.ok || imported.jobId !== job.id || !imported.meshIds?.length) throw new Error('缺少此任务的导入记录，不能猜测源模型');
            const scriptDir = path.join(os.tmpdir(), 'corvas-hunyuan-rhino', job.id);
            fs.mkdirSync(scriptDir, { recursive: true });
            const script = path.join(scriptDir, 'cleanup-hunyuan.py');
            const invocationId = randomUUID();
            fs.copyFileSync(path.join(__dirname, 'rhino', 'cleanup-hunyuan.py'), script);
            fs.writeFileSync(path.join(scriptDir, 'cleanup-options.json'), JSON.stringify({ jobId: job.id,
                stage: input.stage, resultDirectory: directory, targetQuads: input.targetQuads, invocationId }));
            // Checkpoint before dispatch. A timeout must not replay a possibly running QuadRemesh.
            fs.writeFileSync(stateFile, JSON.stringify({ stage: input.stage, status: 'dispatching', invocationId, at: Date.now() }));
            let error;
            try { await mcp.call(toolId(serverId, 'rhino_scene'), { action: 'script', cmd: `_-RunPythonScript "${script}"` }); }
            catch (failure) { error = failure; }
            const result = read(reportFile);
            if (!result || result.jobId !== job.id || result.invocationId !== invocationId || result.status === 'running') {
                fs.writeFileSync(stateFile, JSON.stringify({ stage: input.stage, status: 'unknown', invocationId, at: Date.now() }));
                throw unknown();
            }
            fs.writeFileSync(stateFile, JSON.stringify({ stage: input.stage, status: result.status, invocationId, at: Date.now() }));
            if (!result.ok) throw new Error(`Rhino ${input.stage} 阶段失败：${String(result.error || error?.message || '未生成有效结果').slice(-1800)}`);
            return result;
        })();
        this.pending.set(job.id, work);
        try { return await work; } finally { this.pending.delete(job.id); }
    }
}
module.exports = { RhinoCleanup };
