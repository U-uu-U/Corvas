const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Ajv = require('ajv');
const { toolId } = require('./mcp-client.cjs');
const { HANDOFF_INPUT_SCHEMAS, HANDOFF_TOOL_DEFINITIONS } = require('../shared/handoff-tools.cjs');

const clone = value => JSON.parse(JSON.stringify(value));
const fail = (code, message, details) => Object.assign(new Error(message), { code, status: code === 'INVALID_ARGUMENTS' ? 400 : 409,
    ...(details ? { details, ...details } : {}) });
const terminal = new Set(['completed', 'failed', 'canceled']);
const callStates = new Set(['pending', 'dispatching', 'completed', 'failed', 'unknown']);
const taskStates = new Set(['queued', 'running', 'awaiting_user', ...terminal]);
const stable = value => JSON.stringify(value, (_, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
const hash = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
const maxResultBytes = 4 * 1024 * 1024;

class ExternalHandoffService {
    constructor({ directory, board, mcpClient, onChange = () => {} }) {
        Object.assign(this, { board, mcpClient, onChange });
        this.file = path.join(directory, 'external-handoffs.json');
        this.tasks = [];
        this.closed = false;
        this.loadError = '';
        const ajv = new Ajv({ allErrors: true });
        this.validators = new Map(Object.entries(HANDOFF_INPUT_SCHEMAS).map(([name, schema]) => [name, ajv.compile(schema)]));
        try {
            const stat = fs.statSync(this.file);
            if (stat.size > 64 * 1024 * 1024) throw new Error('File too large');
            const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (data.version !== 1 || !Array.isArray(data.tasks) || data.tasks.length > 1000
                || new Set(data.tasks.map(task => task?.id)).size !== data.tasks.length
                || data.tasks.some(task => !task || typeof task.id !== 'string' || !task.id
                    || !taskStates.has(task.status) || !Array.isArray(task.references) || !Array.isArray(task.calls)
                    || typeof task.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(task.fingerprint)
                    || task.calls.length > 100 || !Array.isArray(task.resultNodeIds)
                    || task.owner && (typeof task.owner.clientId !== 'string' || !task.owner.clientId
                        || task.owner.conversationUrl && !this.validators.get('claim')({ projectId: task.projectId, taskId: task.id,
                            clientId: task.owner.clientId, conversationUrl: task.owner.conversationUrl }))
                    || !this.validators.get('create')({ projectId: task.projectId, target: task.target, instruction: task.instruction,
                        referenceNodeIds: task.referenceNodeIds, requestId: task.requestId })
                    || task.references.length !== task.referenceNodeIds.length
                    || task.references.some((reference, index) => !reference || reference.nodeId !== task.referenceNodeIds[index] || typeof reference.fingerprint !== 'string')
                    || new Set(task.calls.map(call => call?.requestId)).size !== task.calls.length
                    || task.calls.some(call => !call || !callStates.has(call.status) || typeof call.requestId !== 'string'
                        || typeof call.fingerprint !== 'string' || typeof call.readOnly !== 'boolean'))) throw new Error('Invalid handoff data');
            if (new Set(data.tasks.map(task => stable([task.projectId, task.requestId]))).size !== data.tasks.length) throw new Error('Duplicate handoff requests');
            this.tasks = data.tasks;
            let recovered = false;
            for (const task of this.tasks) for (const call of task.calls) {
                if (call.status === 'dispatching') {
                    call.status = 'unknown'; call.error = '应用重启前调用已派发，请核对外部软件状态'; recovered = true;
                } else if (call.status === 'pending') {
                    call.status = 'failed'; call.error = '应用重启前调用尚未派发'; recovered = true;
                }
            }
            if (recovered) this.persist();
        } catch (error) {
            if (error.code !== 'ENOENT') this.loadError = '外部交接记录已损坏或无法读取，原文件已保留';
        }
    }
    validate(action, input) {
        const validate = this.validators.get(action);
        if (!validate || !validate(input)) throw fail('INVALID_ARGUMENTS', `交接参数无效${validate ? `：${validate.errors.map(error => `${error.dataPath} ${error.message}`).join('; ')}` : ''}`);
        if (this.loadError) throw fail('HANDOFF_UNAVAILABLE', this.loadError);
        this.board.readProject(input.projectId);
    }
    execute(name, input = {}) {
        if (!HANDOFF_TOOL_DEFINITIONS.some(tool => tool.name === name)) throw fail('TOOL_NOT_FOUND', '交接工具不存在');
        return this[name.slice('flow_canvas.handoff.'.length)](input);
    }
    redactText(value) {
        let text = String(value ?? '');
        for (const secret of this.mcpClient?.secrets?.() || []) if (secret) text = text.split(secret).join('[redacted]');
        return text.length <= 2000 && this.mcpClient?.redact ? this.mcpClient.redact(text) : text;
    }
    safe(value, depth = 0) {
        if (depth > 40) throw fail('RESULT_TOO_LARGE', 'MCP 返回结构超过限制');
        if (typeof value === 'string') return this.redactText(value);
        if (value === null || typeof value !== 'object') return value;
        if (Array.isArray(value)) return value.map(entry => this.safe(entry, depth + 1));
        if (value.type === 'image') {
            if (!/^image\/(png|jpeg|webp|gif)$/.test(value.mimeType || '') || typeof value.data !== 'string'
                || !value.data.length || value.data.length % 4 !== 0 || value.data.length > maxResultBytes
                || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) return { type: 'text', text: '[Image omitted: unsupported format or size]' };
            return { type: 'image', mimeType: value.mimeType, data: value.data };
        }
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, this.safe(entry, depth + 1)]));
    }
    persist() {
        if (this.loadError) throw fail('HANDOFF_UNAVAILABLE', this.loadError);
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const data = JSON.stringify({ version: 1, tasks: this.safe(this.tasks) });
        if (Buffer.byteLength(data) > 64 * 1024 * 1024) throw fail('STORAGE_LIMIT', '交接记录存储已达到上限');
        const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
        try {
            fs.writeFileSync(temporary, data, { mode: 0o600 });
            fs.renameSync(temporary, this.file);
        } finally { try { fs.unlinkSync(temporary); } catch { /* Atomic rename consumed the temporary file. */ } }
    }
    change(task, mutate) {
        const previous = clone(task);
        mutate(task); task.updatedAt = Date.now();
        try { this.persist(); } catch (error) {
            for (const key of Object.keys(task)) delete task[key];
            Object.assign(task, previous); throw error;
        }
        try { Promise.resolve(this.onChange({ projectId: task.projectId, taskId: task.id })).catch(() => {}); } catch { /* Notifications do not undo persisted changes. */ }
    }
    assertOpen() { if (this.closed) throw fail('HANDOFF_UNAVAILABLE', '外部交接服务已关闭'); }
    find(input) {
        const task = this.tasks.find(entry => entry.id === input.taskId && entry.projectId === input.projectId);
        if (!task) throw fail('TASK_NOT_FOUND', '当前项目中没有该交接任务');
        return task;
    }
    owned(input) {
        const task = this.find(input);
        if (!task.owner || task.owner.clientId !== input.clientId) throw fail('OWNER_MISMATCH', '该任务未由当前外部助手接手');
        return task;
    }
    snapshot(node) {
        const filePath = node.filePath || node.runResult?.filePaths?.[0] || node.runResult?.items?.[0]?.filePath || null;
        let file = null;
        if (filePath) {
            try { const stat = fs.statSync(filePath); file = { size: stat.size, mtimeMs: stat.mtimeMs, isFile: stat.isFile() }; }
            catch { file = { missing: true }; }
        }
        const snapshot = this.safe({ nodeId: node.id, title: String(node.title || node.name || '').slice(0, 2000),
            kind: node.kind || null, nodeType: node.nodeType || null, mediaType: node.mediaType || null,
            filePath, file, text: String(node.text || node.config?.text || '').slice(0, 12000),
            prompt: String(node.config?.prompt || '').slice(0, 12000) });
        return { ...snapshot, fingerprint: hash(snapshot) };
    }
    describe(task) {
        const project = this.board.readProject(task.projectId);
        const referenceIssues = task.references.flatMap(reference => {
            const node = project.items.find(item => item.id === reference.nodeId);
            if (!node) return [{ nodeId: reference.nodeId, type: 'missing_node', message: '原素材节点已删除' }];
            const current = this.snapshot(node);
            if (current.file?.missing) return [{ nodeId: reference.nodeId, type: 'missing_file', message: '原素材文件当前不可用' }];
            if (current.fingerprint !== reference.fingerprint) return [{ nodeId: reference.nodeId, type: 'changed', message: '素材在交接后发生变化', current }];
            return [];
        });
        const visible = { ...task };
        delete visible.fingerprint;
        // Large MCP media remain in the durable call receipt, not every task-list refresh.
        visible.calls = task.calls.map(call => {
            const receipt = { ...call };
            delete receipt.result; delete receipt.fingerprint;
            return receipt;
        });
        return this.safe({ ...visible, referenceIssues });
    }
    create(input) {
        this.validate('create', input); this.assertOpen();
        if (!input.instruction.trim()) throw fail('INVALID_ARGUMENTS', '请填写任务说明');
        const fingerprint = hash({ target: input.target, instruction: input.instruction, referenceNodeIds: input.referenceNodeIds });
        const existing = this.tasks.find(task => task.projectId === input.projectId && task.requestId === input.requestId);
        if (existing) {
            if (existing.fingerprint !== fingerprint) throw fail('IDEMPOTENCY_CONFLICT', '同一 requestId 已用于不同的任务内容');
            return this.describe(existing);
        }
        if (this.tasks.length >= 1000) throw fail('STORAGE_LIMIT', '交接任务数量已达到上限');
        const project = this.board.readProject(input.projectId);
        const references = input.referenceNodeIds.map(nodeId => {
            const node = project.items.find(item => item.id === nodeId);
            if (!node) throw fail('REFERENCE_NOT_FOUND', '所选素材不属于当前项目或已删除');
            return this.snapshot(node);
        });
        const task = this.safe({ id: crypto.randomUUID(), projectId: input.projectId, target: input.target,
            requestId: input.requestId, fingerprint, instruction: input.instruction, referenceNodeIds: [...input.referenceNodeIds],
            references, sourceRevision: project.revision ?? null, status: 'queued', summary: '', owner: null,
            resultNodeIds: [], calls: [], createdAt: Date.now(), updatedAt: Date.now() });
        this.tasks.push(task);
        try { this.change(task, () => {}); } catch (error) { this.tasks.pop(); throw error; }
        return this.describe(task);
    }
    list(input) {
        this.validate('list', input);
        return { tasks: this.tasks.filter(task => task.projectId === input.projectId && (!input.target || task.target === input.target))
            .sort((a, b) => b.createdAt - a.createdAt).map(task => this.describe(task)) };
    }
    get(input) { this.validate('get', input); return this.describe(this.find(input)); }
    cancel(input) {
        this.validate('cancel', input); this.assertOpen();
        const task = this.find(input);
        if (!terminal.has(task.status)) this.change(task, task => { task.status = 'canceled'; task.finishedAt = Date.now(); });
        return this.describe(task);
    }
    claim(input) {
        this.validate('claim', input); this.assertOpen();
        const task = this.find(input);
        if (task.owner && task.owner.clientId !== input.clientId) throw fail('OWNER_MISMATCH', '该任务已由其他外部助手接手');
        if (terminal.has(task.status)) throw fail('TASK_FINISHED', '该任务已经结束');
        this.change(task, task => {
            task.owner = { clientId: input.clientId, claimedAt: task.owner?.claimedAt || Date.now(),
                ...(input.conversationUrl || task.owner?.conversationUrl ? { conversationUrl: input.conversationUrl || task.owner.conversationUrl } : {}) };
            if (task.status === 'queued') task.status = 'running';
        });
        return this.describe(task);
    }
    update(input) {
        this.validate('update', input); this.assertOpen();
        const task = this.owned(input);
        if (terminal.has(task.status) && (input.status !== undefined || input.resultNodeIds !== undefined
            || !input.resolvedCalls?.length && input.summary === undefined)) throw fail('TASK_FINISHED', '已结束任务只能记录核验结果和解决未知调用');
        const project = this.board.readProject(task.projectId);
        if (input.resultNodeIds?.some(id => !project.items.some(item => item.id === id))) throw fail('RESULT_NOT_FOUND', '返回素材必须已加入任务原项目');
        const resolved = new Set();
        for (const resolution of input.resolvedCalls || []) {
            const call = task.calls.find(call => call.requestId === resolution.requestId);
            if (!call || call.status !== 'unknown' || resolved.has(call.requestId) || !resolution.summary.trim()) throw fail('INVALID_RESOLUTION', '只能在核验外部状态后解决结果不明的调用');
            resolved.add(call.requestId);
        }
        if (input.status === 'completed' && task.calls.some(call => !call.readOnly && ['pending', 'dispatching', 'unknown'].includes(call.status) && !resolved.has(call.requestId))) throw fail('CALL_UNRESOLVED', '外部操作尚未取得确定结果');
        this.change(task, task => {
            for (const resolution of input.resolvedCalls || []) {
                const call = task.calls.find(call => call.requestId === resolution.requestId);
                Object.assign(call, { status: resolution.status, resolution: this.redactText(resolution.summary), resolvedAt: Date.now() });
            }
            if (input.status) task.status = input.status;
            if (input.summary !== undefined) task.summary = this.redactText(input.summary);
            if (input.resultNodeIds) task.resultNodeIds = [...input.resultNodeIds];
            if (input.status && terminal.has(task.status)) task.finishedAt = Date.now();
        });
        return this.describe(task);
    }
    matches(server, target) {
        return server.enabled === true && (target === 'blender' ? /blender/i.test(server.name)
            : /rhino|cordyceps/i.test(server.name) || server.tools?.some(tool => /^rhino_scene(?:$|[._-])/i.test(tool.name)));
    }
    discovered(task) {
        const listing = this.mcpClient.list();
        if (listing.error) throw fail('MCP_UNAVAILABLE', this.redactText(listing.error));
        return listing.servers.filter(server => this.matches(server, task.target));
    }
    async tools(input) {
        this.validate('tools', input); this.assertOpen();
        const task = this.find(input);
        for (const server of this.discovered(task)) if (server.status !== 'connected') {
            try { await this.mcpClient.connect(server.id); } catch { /* Report connection status without exposing configuration. */ }
        }
        const servers = this.discovered(task);
        return this.safe({ taskId: task.id, target: task.target,
            servers: servers.map(({ id, name, status }) => ({ id, name, status })),
            tools: servers.flatMap(server => server.status === 'connected' ? (server.tools || []).flatMap(tool => {
                const binding = this.mcpClient.binding(toolId(server.id, tool.name));
                return binding ? [{ serverId: server.id, name: tool.name, description: tool.description || tool.name,
                    inputSchema: tool.inputSchema, readOnly: tool.readOnly === true, binding }] : [];
            }) : []) });
    }
    receipt(task, call, reused = false) {
        return this.safe({ taskId: task.id, requestId: call.requestId, status: call.status, reused,
            ...(call.result ? { result: call.result } : {}), ...(call.error ? { error: call.error } : {}),
            ...(call.blocking ? { blocking: call.blocking } : {}),
            ...(call.resolution ? { resolution: call.resolution } : {}) });
    }
    changeCall(task, requestId, fields) {
        this.change(task, task => Object.assign(task.calls.find(call => call.requestId === requestId), fields));
    }
    assertWriteAvailable(task, serverId, requestId, beforeDispatch = false) {
        for (const candidate of this.tasks) {
            const blockingCall = candidate.calls.find(call => !call.readOnly && !(candidate.id === task.id && call.requestId === requestId)
                && (candidate.id === task.id && ['pending', 'dispatching', 'unknown'].includes(call.status)
                    || call.serverId === serverId && (call.status === 'unknown' || beforeDispatch && call.status === 'dispatching')));
            if (blockingCall) throw fail('CALL_UNRESOLVED', '已有外部写操作结果未确定，请先查询并核对状态', {
                blocking: { taskId: candidate.id, projectId: candidate.projectId, requestId: blockingCall.requestId }
            });
        }
    }
    async call(input) {
        this.validate('call', input); this.assertOpen();
        const task = this.owned(input);
        const args = clone(input.arguments);
        if (Buffer.byteLength(JSON.stringify(args)) > 256 * 1024) throw fail('INVALID_ARGUMENTS', 'MCP 调用参数超过限制');
        const fingerprint = hash({ serverId: input.serverId, toolName: input.toolName, binding: input.binding, arguments: args });
        const existing = task.calls.find(call => call.requestId === input.requestId);
        if (existing) {
            if (existing.fingerprint !== fingerprint) throw fail('IDEMPOTENCY_CONFLICT', '同一 requestId 已用于不同的外部调用');
            return this.receipt(task, existing, true);
        }
        if (task.calls.length >= 100) throw fail('STORAGE_LIMIT', '该任务调用数量已达到上限');
        const server = this.discovered(task).find(server => server.id === input.serverId && server.status === 'connected');
        const tool = server?.tools?.find(tool => tool.name === input.toolName);
        const name = toolId(input.serverId, input.toolName);
        if (!tool || this.mcpClient.binding(name) !== input.binding) throw fail('TOOL_CHANGED', '连接或工具已变更，请重新读取 handoff.tools');
        const readOnly = this.mcpClient.isReadOnly(name) === true;
        const canInspect = () => readOnly && task.calls.some(call => !call.readOnly && call.status === 'unknown');
        if (terminal.has(task.status) && !canInspect()) throw fail('TASK_FINISHED', '该任务已经结束');
        if (!readOnly) this.assertWriteAvailable(task, input.serverId, input.requestId);
        const call = { requestId: input.requestId, fingerprint, serverId: input.serverId, toolName: input.toolName,
            binding: input.binding, readOnly, status: 'pending', createdAt: Date.now() };
        this.change(task, task => { task.calls.push(call); });
        let dispatched = false;
        try {
            const result = await this.mcpClient.call(name, args, { onDispatch: () => {
                this.assertOpen();
                if (terminal.has(task.status) && !canInspect()) throw fail('TASK_FINISHED', '该任务已经结束');
                if (this.mcpClient.binding(name) !== input.binding) throw fail('TOOL_CHANGED', '连接或工具已变更');
                if (!readOnly) this.assertWriteAvailable(task, input.serverId, input.requestId, true);
                this.changeCall(task, call.requestId, { status: 'dispatching', dispatchedAt: Date.now() });
                dispatched = true;
            } });
            let safeResult = this.safe(result);
            if (Buffer.byteLength(JSON.stringify(safeResult)) > maxResultBytes) safeResult = {
                isError: Boolean(result?.isError), content: [{ type: 'text', text: 'MCP 已返回确定结果，但内容超过保存上限。请用只读工具检查产物。' }]
            };
            this.changeCall(task, call.requestId, { status: result?.isError ? 'failed' : 'completed', result: safeResult, finishedAt: Date.now() });
        } catch (error) {
            this.changeCall(task, call.requestId, { status: dispatched || error.code === 'MCP_RESULT_UNKNOWN' ? 'unknown' : 'failed',
                error: this.redactText(error.message), ...(error.blocking ? { blocking: error.blocking } : {}), finishedAt: Date.now() });
        }
        return this.receipt(task, task.calls.find(entry => entry.requestId === call.requestId));
    }
    close() { this.closed = true; }
}

module.exports = { ExternalHandoffService };
