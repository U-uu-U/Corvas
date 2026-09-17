const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const DEFAULT_RHINO_ENDPOINT = 'http://127.0.0.1:26929/mcp';
const executableKey = value => path.normalize(String(value || '')).replace(/\\/g, '/').toLowerCase();

function normalizeEndpoint(value) {
    const url = new URL(value || DEFAULT_RHINO_ENDPOINT);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Rhino MCP 请使用本机地址');
    return url.href;
}
const endpointKey = value => { try {
    const url = new URL(value);
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) url.hostname = 'localhost';
    return url.href;
} catch { return ''; } };
const listening = endpoint => new Promise(resolve => {
    const url = new URL(endpoint);
    const socket = net.createConnection({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
});

class RhinoWorkbench {
    constructor({ directory, desktop, mcpClient, onChange = () => {}, probe = listening, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), startupAttempts = 60 }) {
        this.file = path.join(directory, 'rhino-workbench.json');
        this.desktop = desktop; this.mcpClient = mcpClient; this.onChange = onChange;
        this.probe = probe; this.wait = wait; this.startupAttempts = startupAttempts;
        this.config = { executablePath: '', endpoint: DEFAULT_RHINO_ENDPOINT, serverId: '' };
        this.applications = []; this.discovered = false; this.state = 'idle'; this.message = '';
        this.loadError = ''; this.pending = null; this.disposed = false;
        try {
            const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (saved.version !== 1 || typeof saved.executablePath !== 'string') throw new Error('Invalid settings');
            this.config = { executablePath: saved.executablePath, endpoint: normalizeEndpoint(saved.endpoint), serverId: String(saved.serverId || '') };
        } catch (error) {
            if (error.code !== 'ENOENT') this.loadError = 'Rhino 设置读取失败，原文件已保留。';
        }
    }
    server() {
        const data = this.mcpClient.list();
        return data.servers.find(server => server.id === this.config.serverId)
            || data.servers.find(server => server.transport === 'http' && endpointKey(server.url) === endpointKey(this.config.endpoint));
    }
    snapshot() {
        const server = this.server();
        const connected = server?.enabled && server.status === 'connected' && server.tools.some(tool => tool.name === 'rhino_scene');
        return { ...this.config, applications: this.applications, state: connected ? 'connected' : this.state === 'connected' ? 'disconnected' : this.state,
            connected: Boolean(connected), busy: Boolean(this.pending), toolCount: connected ? server.tools.length : 0,
            message: this.loadError || this.message || (this.state === 'connected' && !connected ? 'Rhino 连接已断开，请重新连接。' : ''),
            loadError: this.loadError };
    }
    update(state, message = '') { this.state = state; this.message = message; this.onChange(this.snapshot()); }
    async status() {
        if (!this.discovered) {
            const applications = await this.desktop.discover().catch(() => {
                this.message = '未能自动检测 Rhino，请在连接设置中选择程序。';
                return [];
            });
            this.applications = [...new Map(applications.map(app => [executableKey(app.path), app])).values()];
            if (this.config.executablePath && !this.applications.some(app => app.path === this.config.executablePath)) {
                this.applications.unshift({ path: this.config.executablePath, name: '已选择的 Rhino' });
            }
            this.discovered = true;
        }
        if (!this.pending && this.snapshot().connected && !await this.probe(this.config.endpoint)) {
            await this.mcpClient.disconnect(this.server().id);
            this.update('disconnected', 'Rhino 连接已断开，请重新连接。');
        }
        return this.snapshot();
    }
    persist(config) {
        if (this.loadError) throw new Error(this.loadError);
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, ...config }, null, 2));
        fs.renameSync(`${this.file}.tmp`, this.file);
        this.config = config;
    }
    async save(input = {}) {
        if (this.pending) throw new Error('Rhino 正在连接，请稍后修改设置');
        const executablePath = input.executablePath ?? this.config.executablePath;
        if (executablePath && !this.desktop.validPath(executablePath)) throw new Error('请选择本机的 Rhino 程序');
        const endpoint = normalizeEndpoint(input.endpoint ?? this.config.endpoint);
        this.persist({ executablePath, endpoint, serverId: endpoint === this.config.endpoint ? this.config.serverId : '' });
        this.discovered = false; this.update('idle');
        return this.status();
    }
    async ensureServer() {
        if (this.mcpClient.list().error) throw new Error(this.mcpClient.list().error);
        let server = this.server();
        if (!server) {
            const result = await this.mcpClient.save({ name: 'Rhino · Cordyceps', transport: 'http', url: this.config.endpoint,
                enabled: true, timeoutMs: 300000 });
            server = result.servers.find(entry => entry.transport === 'http' && entry.url === this.config.endpoint);
        } else if (!server.enabled) {
            await this.mcpClient.save({ id: server.id, enabled: true });
        }
        if (!server) throw new Error('Rhino MCP 配置保存失败');
        if (this.config.serverId !== server.id) this.persist({ ...this.config, serverId: server.id });
        await this.mcpClient.connect(server.id);
        const connected = this.mcpClient.list().servers.find(entry => entry.id === server.id);
        if (!connected?.tools.some(tool => tool.name === 'rhino_scene')) throw new Error('该服务没有提供 Rhino 场景工具，请检查 MCP 地址');
        this.update('connected', '已连接，可以在 Agent 中预览和编辑模型。');
    }
    open({ connectOnly = false } = {}) {
        if (this.disposed) throw new Error('Rhino 连接服务已关闭');
        if (this.pending) return this.snapshot();
        this.pending = Promise.resolve().then(() => this.start(connectOnly)).catch(error => {
            if (!this.disposed) this.update('error', error.message || 'Rhino 连接失败，请检查软件和插件。');
        }).finally(() => { this.pending = null; if (!this.disposed) this.onChange(this.snapshot()); });
        this.update('connecting', '正在查找 Rhino…');
        return this.snapshot();
    }
    async start(connectOnly) {
        await this.status();
        if (this.loadError) throw new Error(this.loadError);
        const running = await this.desktop.running();
        const executable = this.config.executablePath || (running.length === 1 ? running[0].path : this.applications[0]?.path);
        if (executable && this.config.executablePath !== executable) this.persist({ ...this.config, executablePath: executable });
        if (await this.probe(this.config.endpoint)) {
            await this.ensureServer();
            if (!connectOnly && executable && running.filter(app => executableKey(app.path) === executableKey(executable)).length === 1) {
                await this.desktop.focus(executable).catch(() => {});
            }
            return;
        }
        if (connectOnly) throw new Error('Cordyceps 尚未启动，请打开 Rhino 并运行连接命令。');
        if (!executable || !this.desktop.validPath(executable)) throw new Error('未找到 Rhino，请先选择本机程序路径。');
        const matching = running.filter(app => executableKey(app.path) === executableKey(executable));
        if (matching.length > 1) throw new Error('检测到多个 Rhino 实例，请在目标窗口启动 Cordyceps 后点击“仅连接”。');
        if (matching.length) {
            await this.desktop.focus(executable).catch(() => { throw new Error('Rhino 尚未进入可操作状态，请先处理软件中的启动提示。'); });
            this.update('connecting', '正在启动 Rhino 中的 Cordyceps…');
            await this.desktop.bootstrap(executable, { endpoint: this.config.endpoint }).catch(() => { throw new Error('Rhino 已打开，请复制连接命令到 Rhino 执行，再点击“仅连接”。'); });
        } else {
            this.update('launching', '正在打开 Rhino 并启动 Cordyceps…');
            await this.desktop.launch(executable, { endpoint: this.config.endpoint }).catch(() => { throw new Error('无法启动所选 Rhino，请检查程序路径后重试。'); });
        }
        for (let attempt = 0; attempt < this.startupAttempts && !this.disposed; attempt++) {
            if (await this.probe(this.config.endpoint)) { await this.ensureServer(); return; }
            const report = this.desktop.bootstrapReport();
            if (report?.ok === false) {
                if (report.code === 'SOLVER_DISABLED') throw new Error('Grasshopper 计算已暂停，请启用计算后重新连接。');
                if (report.code === 'PLUGIN_MISSING') throw new Error('Rhino 未加载 Cordyceps，请安装或启用与 Rhino 兼容的插件。');
                throw new Error('Rhino 连接脚本执行失败，请查看 Rhino 命令栏的错误提示后重试。');
            }
            await this.wait(1000);
        }
        if (!this.disposed) throw new Error('Rhino 已打开，但还未连接。请处理软件内的启动提示，再点击“仅连接”，或复制连接命令运行。');
    }
    connectionCommand() { return this.desktop.connectionCommand(this.config.endpoint); }
    close() { this.disposed = true; }
}

module.exports = { RhinoWorkbench, DEFAULT_RHINO_ENDPOINT, normalizeEndpoint };
