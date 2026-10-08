const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

if (process.env.FLOW_LIVE_UPDATE_ENTRY === '1' && process.versions.electron) {
    const { app, net, BrowserWindow } = require('electron');
    const { NsisUpdater } = require('electron-updater');
    const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
    const { createAppUpdates, UPDATE_ORIGINS } = require(process.env.FLOW_LIVE_UPDATE_ASAR
        ? path.join(process.env.FLOW_LIVE_UPDATE_ASAR, 'electron-main/app-updates.cjs') : '../electron-main/app-updates.cjs');
    const profile = process.env.FLOW_LIVE_UPDATE_PROFILE;
    if (!profile) throw new Error('Isolated updater profile required');
    app.setPath('userData', profile);
    app.commandLine.appendSwitch('disable-http2');
    app.whenReady().then(() => new BrowserWindow({ show: false,
        webPreferences: { sandbox: true, nodeIntegration: false } }).loadURL('about:blank'));
    globalThis.liveUpdateRun = async () => {
        await app.whenReady();
        const configuration = path.join(profile, 'app-update.yml');
        await fs.writeFile(configuration, 'updaterCacheDirName: corvas-test-updater\n');
        const version = process.env.FLOW_LIVE_UPDATE_CURRENT || '1.6.0-beta.16';
        const adapter = { version, name: 'Corvas update verification', isPackaged: true, appUpdateConfigPath: configuration,
            userDataPath: profile, baseCachePath: profile, whenReady: () => app.whenReady(), onQuit() {},
            quit: () => assert.fail('Never install in verification'), relaunch: () => assert.fail('Never relaunch') };
        const native = new NsisUpdater(null, adapter);
        native.httpExecutor = new ElectronHttpExecutor(() => {});
        native.logger = { info() {}, warn() {}, error() {}, debug() {} };
        native.quitAndInstall = () => assert.fail('Never install in verification');
        const sources = new Set();
        const request = native.httpExecutor.createRequest.bind(native.httpExecutor);
        native.httpExecutor.createRequest = (options, callback) => {
            const origin = `${options.protocol}//${options.hostname || options.host}`;
            assert.ok(UPDATE_ORIGINS.includes(origin), 'Native download must stay on an owned origin');
            sources.add(origin);
            return request(options, callback);
        };
        let lastProgress = -1;
        const updates = createAppUpdates({ currentVersion: version, platform: 'win32', packaged: true,
            directory: path.join(profile, 'updates'), updaterFactory: () => native,
            onState: state => {
                const progress = Math.floor((state.percent || 0) / 20) * 20;
                if (state.phase === 'downloading' && progress !== lastProgress) {
                    lastProgress = progress; console.log(`CORVAS_UPDATE_PROGRESS ${progress}%`);
                }
            },
            fetchImpl: (url, options) => {
                assert.ok(UPDATE_ORIGINS.includes(new URL(url).origin));
                sources.add(new URL(url).origin); return net.fetch(url, options);
            } });
        const checked = await updates.check(); assert.equal(checked.phase, 'available', checked.error);
        const result = await updates.download(); assert.equal(result.phase, 'downloaded', result.error);
        const file = native.installerPath;
        const bytes = await fs.readFile(file);
        assert.equal(bytes.toString('ascii', 0, 2), 'MZ');
        const meta = await (await net.fetch(UPDATE_ORIGINS[0] + '/corvas/api/updates', { credentials: 'omit' })).json();
        const asset = meta.releases.find(release => release.version === result.latestVersion).assets.find(asset => asset.platform === 'windows');
        assert.equal(bytes.length, asset.bytes);
        assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), asset.sha256);
        assert.equal(crypto.createHash('sha512').update(bytes).digest('base64'), asset.sha512);
        assert.equal(native.autoInstallOnAppQuit, false);
        return { installerPath: file, version: result.latestVersion, bytes: bytes.length, sources: [...sources], nativeUpdater: true,
            sha256: asset.sha256, sha512Verified: true, installed: false };
    };
} else {
    if (!process.argv.includes('--live')) throw new Error('Use --live for an explicit real installer download');
    const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
    (async () => {
        const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-live-update-'));
        let app;
        try {
            const env = { ...process.env, FLOW_LIVE_UPDATE_ENTRY: '1', FLOW_LIVE_UPDATE_PROFILE: profile };
            delete env.ELECTRON_RUN_AS_NODE;
            app = await electron.launch({ executablePath: require('electron'), args: [__filename], env });
            app.process().stdout.on('data', chunk => {
                for (const line of String(chunk).split('\n')) if (line.startsWith('CORVAS_UPDATE_PROGRESS ')) console.log(line.trim());
            });
            const { installerPath, ...result } = await app.evaluate(async () => {
                let timer;
                try { return await Promise.race([globalThis.liveUpdateRun(),
                    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Live updater exceeded 10 minutes')), 600000); })]); }
                finally { clearTimeout(timer); }
            });
            if (process.env.FLOW_LIVE_UPDATE_SAVE_DIR) {
                const directory = path.resolve(process.env.FLOW_LIVE_UPDATE_SAVE_DIR);
                await fs.mkdir(directory, { recursive: true });
                await fs.copyFile(installerPath, path.join(directory, `Corvas.Setup.${result.version}.exe`));
            }
            await fs.mkdir(path.join(__dirname, '../output'), { recursive: true });
            await fs.writeFile(path.join(__dirname, '../output/live-update-verified.json'), JSON.stringify(result, null, 2));
            console.log(JSON.stringify(result));
        } finally { await app?.close(); await fs.rm(profile, { recursive: true, force: true }); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
}
