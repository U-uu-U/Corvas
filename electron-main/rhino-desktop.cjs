const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

class RhinoDesktop {
    constructor({ platform = process.platform } = {}) {
        this.platform = platform;
        this.directory = null;
    }
    materialize() {
        if (this.directory) return this.directory;
        this.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'corvas-rhino-'));
        for (const name of ['desktop.ps1', 'connect.py']) {
            fs.copyFileSync(path.join(__dirname, 'rhino', name), path.join(this.directory, name));
        }
        return this.directory;
    }
    writeOptions(endpoint = 'http://127.0.0.1:26929/mcp') {
        const port = Number(new URL(endpoint).port) || 26929;
        fs.writeFileSync(path.join(this.materialize(), 'connect-settings.json'), JSON.stringify({ port }));
    }
    async powershell(action, executable = '', scriptPath = '') {
        const helper = path.join(this.materialize(), 'desktop.ps1');
        const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', helper, '-Action', action, '-Executable', executable, '-ScriptPath', scriptPath],
        { windowsHide: true, timeout: action === 'bootstrap' ? 90000 : 10000, maxBuffer: 1024 * 1024 });
        return JSON.parse(stdout.trim().replace(/^\uFEFF/, '') || 'null');
    }
    async discover() {
        if (this.platform === 'win32') return this.powershell('discover');
        if (this.platform === 'darwin') return ['/Applications/Rhino 8.app', '/Applications/RhinoWIP.app', '/Applications/Rhino 7.app']
            .filter(file => fs.existsSync(file)).map(file => ({ path: file, name: path.basename(file, '.app') }));
        return [];
    }
    async running(executable = '') {
        if (this.platform === 'win32') return this.powershell('running', executable);
        if (this.platform === 'darwin') {
            const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,comm='], { timeout: 5000 });
            return stdout.split('\n').flatMap(line => {
                const match = /^\s*(\d+)\s+(.+\.app\/Contents\/MacOS\/Rhinoceros)$/.exec(line);
                if (!match) return [];
                const appPath = match[2].split('/Contents/')[0];
                return !executable || appPath === executable ? [{ pid: Number(match[1]), path: appPath }] : [];
            });
        }
        return [];
    }
    async focus(executable) {
        if (this.platform === 'win32') return this.powershell('focus', executable);
        if (this.platform === 'darwin') await execute('/usr/bin/open', ['-a', executable]);
    }
    async launch(executable, { endpoint } = {}) {
        const scriptPath = path.join(this.materialize(), 'connect.py');
        this.writeOptions(endpoint);
        fs.rmSync(path.join(this.directory, 'connect.json'), { force: true });
        const command = `_-RunPythonScript "${scriptPath}"`;
        const file = this.platform === 'darwin' ? '/usr/bin/open' : executable;
        // Windows Rhino parses /runscript itself; Node's escaped nested quotes can
        // leave the script undispatched. Bootstrap through COM once its window is ready.
        const args = this.platform === 'darwin' ? ['-a', executable, '--args', `-runscript=${command}`]
            : ['/nosplash'];
        await new Promise((resolve, reject) => {
            const child = spawn(file, args, { windowsHide: false, detached: true, stdio: 'ignore' });
            child.once('error', reject);
            child.once('spawn', () => { child.unref(); resolve(); });
        });
        return { bootstrapOnReady: this.platform === 'win32' };
    }
    async bootstrap(executable, { endpoint } = {}) {
        const scriptPath = path.join(this.materialize(), 'connect.py');
        this.writeOptions(endpoint);
        fs.rmSync(path.join(this.directory, 'connect.json'), { force: true });
        if (this.platform !== 'win32') throw new Error('请在 Rhino 中运行连接命令');
        return this.powershell('bootstrap', executable, scriptPath);
    }
    bootstrapReport() {
        if (!this.directory) return null;
        try { return JSON.parse(fs.readFileSync(path.join(this.directory, 'connect.json'), 'utf8')); } catch { return null; }
    }
    connectionCommand(endpoint) { this.writeOptions(endpoint); return `_-RunPythonScript "${path.join(this.materialize(), 'connect.py')}"`; }
    validPath(file) {
        return typeof file === 'string' && path.isAbsolute(file) && fs.existsSync(file)
            && (this.platform === 'darwin' ? /\.app$/i.test(file) : /^rhino\.exe$/i.test(path.basename(file)));
    }
}
module.exports = { RhinoDesktop };
