const fs = require('node:fs');
const path = require('node:path');
const DEFAULT = Object.freeze({ executablePath: '', serverId: '' });

class BlenderWorkbench {
    constructor({ directory, desktop, mcpClient, onChange = () => {} }) {
        this.file = path.join(directory, 'blender-workbench.json'); this.desktop = desktop; this.mcpClient = mcpClient; this.onChange = onChange;
        this.config = { ...DEFAULT }; this.apps = []; this.state = 'idle'; this.message = ''; this.busy = false; this.discovered = false;
        try { const value = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (value.version !== 1) throw new Error(); this.config = { ...DEFAULT, ...value }; }
        catch (error) { if (error.code !== 'ENOENT') this.message = 'Blender 设置读取失败。'; }
    }
    snapshot() {
        const server = this.server(); const connected = Boolean(server?.enabled && server.status === 'connected');
        return { ...this.config, applications: this.apps, connected, toolCount: connected ? server.tools.length : 0,
            state: connected ? 'connected' : this.state, busy: this.busy, message: this.message };
    }
    server() {
        const data = this.mcpClient.list();
        return data.servers.find(server => server.id === this.config.serverId)
            || data.servers.find(server => /blender/i.test(`${server.name} ${server.tools.map(tool => tool.name).join(' ')}`));
    }
    async status() {
        if (!this.discovered) { this.apps = await this.desktop.discover().catch(() => []); this.discovered = true; }
        return this.snapshot();
    }
    persist() {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, ...this.config }, null, 2)); fs.renameSync(`${this.file}.tmp`, this.file);
    }
    async open() {
        if (this.busy) return this.snapshot();
        this.busy = true; this.state = 'connecting'; this.message = '正在打开 Blender…'; this.onChange(this.snapshot());
        try {
            await this.status();
            const executable = this.config.executablePath || this.apps[0]?.path;
            if (!executable || !this.desktop.validPath(executable)) throw new Error('未找到 Blender，请在连接设置中选择程序。');
            const running = await this.desktop.running(executable);
            if (!running.length) await this.desktop.launch(executable);
            const server = this.server();
            if (!server) throw new Error('未找到 Blender MCP。请先在设置 > API > MCP 外部工具中添加 Blender 服务。');
            if (!server.enabled) await this.mcpClient.save({ id: server.id, enabled: true });
            await this.mcpClient.test({ id: server.id });
            const refreshed = this.mcpClient.list().servers.find(entry => entry.id === server.id);
            if (!refreshed?.tools.length) throw new Error('Blender MCP 已连接，但没有发现工具。');
            this.config.serverId = server.id; this.config.executablePath = executable; this.persist();
            this.state = 'connected'; this.message = `已连接 Blender MCP，发现 ${refreshed.tools.length} 个工具。`;
        } catch (error) { this.state = 'error'; this.message = error.message || 'Blender 连接失败。'; }
        finally { this.busy = false; this.onChange(this.snapshot()); }
        return this.snapshot();
    }
    async save(input = {}) {
        if (input.executablePath && !this.desktop.validPath(input.executablePath)) throw new Error('请选择本机的 Blender 程序');
        this.config.executablePath = input.executablePath || this.config.executablePath; this.persist(); this.discovered = false; this.onChange(await this.status()); return this.snapshot();
    }
    close() {}
}
module.exports = { BlenderWorkbench };
