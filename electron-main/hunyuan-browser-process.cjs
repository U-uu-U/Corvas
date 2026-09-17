const path = require('node:path');
const { spawn } = require('node:child_process');

function launchHunyuanBrowser({ id, name, profileDir }) {
    const args = process.defaultApp ? [path.join(__dirname, 'entry.cjs')] : [];
    args.push('--corvas-hunyuan-worker', '--account-id', id, '--account-name', name, '--account-profile', profileDir);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    return spawn(process.execPath, args, { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
}

module.exports = { launchHunyuanBrowser };
