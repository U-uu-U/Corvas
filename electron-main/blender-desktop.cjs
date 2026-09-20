const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

class BlenderDesktop {
    constructor({ platform = process.platform } = {}) { this.platform = platform; this.process = null; }
    async discover() {
        if (this.platform === 'win32') {
            const candidates = [
                'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe',
                'C:\\Program Files\\Blender Foundation\\Blender 4.3\\blender.exe',
                'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe'
            ];
            return candidates.filter(file => fs.existsSync(file)).map(file => ({ path: file, name: path.basename(path.dirname(file)) }));
        }
        if (this.platform === 'darwin') return ['/Applications/Blender.app'].filter(fs.existsSync).map(path => ({ path, name: 'Blender' }));
        return [];
    }
    async running(executable = '') {
        if (this.platform === 'win32') {
            const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
                'Get-Process blender -ErrorAction SilentlyContinue | Select-Object Id,Path | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 5000 });
            const value = stdout.trim(); if (!value) return [];
            const entries = Array.isArray(JSON.parse(value)) ? JSON.parse(value) : [JSON.parse(value)];
            return entries.map(entry => ({ pid: Number(entry.Id), path: entry.Path || '' }))
                .filter(entry => !executable || entry.path.toLowerCase() === executable.toLowerCase());
        }
        if (this.platform === 'darwin') {
            const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,comm='], { timeout: 5000 });
            return stdout.split('\n').flatMap(line => {
                const match = /^\s*(\d+)\s+(.+Blender\.app\/Contents\/MacOS\/Blender)$/.exec(line);
                return match && (!executable || executable === match[2].split('/Contents/')[0])
                    ? [{ pid: Number(match[1]), path: match[2].split('/Contents/')[0] }] : [];
            });
        }
        return [];
    }
    validPath(file) { return typeof file === 'string' && path.isAbsolute(file) && fs.existsSync(file)
        && (this.platform === 'darwin' ? /\.app$/i.test(file) : /^blender\.exe$/i.test(path.basename(file))); }
    async focus() { return true; }
    async launch(executable) {
        const file = this.platform === 'darwin' ? '/usr/bin/open' : executable;
        const args = this.platform === 'darwin' ? ['-a', executable] : [];
        await new Promise((resolve, reject) => {
            const child = spawn(file, args, { detached: true, windowsHide: false, stdio: 'ignore' });
            child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
        });
    }
}
module.exports = { BlenderDesktop };
