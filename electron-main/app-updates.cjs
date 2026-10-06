const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const semver = require('semver');

const REPOSITORY = 'https://github.com/U-uu-U/Corvas';
const RELEASES_API = 'https://api.github.com/repos/U-uu-U/Corvas/releases?per_page=30';
const DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const MAX_ASSET_BYTES = 1024 * 1024 * 1024;

function updateChannel(version) { return String(semver.prerelease(version)?.[0] || 'latest'); }
function selectRelease(releases, currentVersion, platform, portable = false) {
    if (!Array.isArray(releases) || !semver.valid(currentVersion)) return null;
    const candidates = releases.flatMap(release => {
        const version = semver.valid(String(release.tag_name || '').replace(/^v/, ''));
        if (!version || release.draft || (!semver.prerelease(currentVersion) && (release.prerelease || semver.prerelease(version)))
            || !semver.gt(version, currentVersion)) return [];
        const assets = Array.isArray(release.assets) ? release.assets : [];
        const names = new Set(assets.map(asset => asset.name));
        // A partially uploaded release must not become the advertised update.
        if (!names.has(`Corvas.Setup.${version}.exe`) || !names.has(`Corvas.${version}.mac.universal.dmg`)) return [];
        const name = platform === 'darwin' ? `Corvas.${version}.mac.universal.dmg`
            : portable ? `Corvas.${version}.exe` : `Corvas.Setup.${version}.exe`;
        const asset = assets.find(asset => asset.name === name);
        if (!asset || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ASSET_BYTES) return [];
        const manual = platform === 'darwin' || portable;
        if (manual && !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) return [];
        if (!manual && !names.has(`${updateChannel(version)}.yml`)) return [];
        return [{ version, tag: release.tag_name, name, size: asset.size, digest: asset.digest,
            notes: typeof release.body === 'string' ? release.body.slice(0, 8000) : '',
            url: `${REPOSITORY}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(name)}` }];
    });
    return candidates.sort((a, b) => semver.rcompare(a.version, b.version))[0] || null;
}

async function fetchReleases(fetchImpl, signal) {
    const response = await fetchImpl(RELEASES_API, { headers: { accept: 'application/vnd.github+json' }, credentials: 'omit', redirect: 'error', signal });
    if (!response.ok) throw new Error('Release lookup failed');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error('Release metadata too large');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks));
}

async function downloadVerifiedAsset({ asset, directory, fetchImpl, signal, onProgress }) {
    let url = asset.url, response;
    for (let redirects = 0; redirects <= 5; redirects++) {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !DOWNLOAD_HOSTS.has(parsed.hostname)) throw new Error('Untrusted update location');
        response = await fetchImpl(url, { redirect: 'manual', credentials: 'omit', signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            url = new URL(response.headers.get('location'), url).href; continue;
        }
        break;
    }
    if (!response?.ok) throw new Error('Installer download failed');
    await fs.mkdir(directory, { recursive: true });
    const temporary = await fs.mkdtemp(path.join(directory, 'download-'));
    const filename = path.join(temporary, asset.name);
    const handle = await fs.open(filename, 'wx');
    const hash = crypto.createHash('sha256'); let bytes = 0;
    try {
        for await (const chunk of response.body) {
            if (signal.aborted) throw new Error('Canceled');
            bytes += chunk.length;
            if (bytes > asset.size || bytes > MAX_ASSET_BYTES) throw new Error('Installer size mismatch');
            hash.update(chunk); await handle.writeFile(chunk);
            onProgress({ transferred: bytes, total: asset.size, percent: bytes / asset.size * 100 });
        }
        if (signal.aborted || bytes !== asset.size || `sha256:${hash.digest('hex')}` !== asset.digest) throw new Error('Installer checksum mismatch');
        await handle.close(); return filename;
    } catch (error) {
        await handle.close(); await fs.unlink(filename).catch(() => {}); await fs.rmdir(temporary).catch(() => {}); throw error;
    }
}

function createAppUpdates({ currentVersion, platform, packaged, portable = false, directory, fetchImpl,
    updaterFactory, prepareInstall = async () => {}, openInstaller = async () => {}, onState = () => {} } = {}) {
    const mode = !packaged ? 'source' : platform === 'win32' && !portable ? 'automatic'
        : platform === 'darwin' || portable ? 'manual' : 'unsupported';
    let state = { phase: 'idle', currentVersion, latestVersion: null, mode, notes: '', percent: 0, error: '' };
    let asset, updater, cancellation, abort, installer;
    const publish = patch => { state = { ...state, ...patch }; onState({ ...state }); return { ...state }; };
    const busy = () => ['checking', 'downloading', 'canceling', 'installing'].includes(state.phase);
    return {
        snapshot: () => ({ ...state }),
        async check() {
            if (busy()) return { ...state };
            publish({ phase: 'checking', error: '' });
            try {
                const releases = await fetchReleases(fetchImpl, AbortSignal.timeout(20000));
                asset = selectRelease(releases, currentVersion, platform, portable);
                installer = null;
                return publish({ phase: asset ? 'available' : 'current', latestVersion: asset?.version || null, notes: asset?.notes || '', percent: 0 });
            } catch { return publish({ phase: 'error', error: '无法检查新版本，请检查网络后重试。' }); }
        },
        async download() {
            if (!asset || busy() || !['automatic', 'manual'].includes(mode)) return { ...state };
            publish({ phase: 'downloading', percent: 0, error: '' });
            abort = new AbortController();
            try {
                const progress = value => { if (state.phase === 'downloading') publish({ percent: Math.max(0, Math.min(100, Number(value.percent) || 0)) }); };
                if (mode === 'automatic') {
                    if (!updater) {
                        updater = updaterFactory();
                        updater.autoDownload = false; updater.autoInstallOnAppQuit = false; updater.allowDowngrade = false;
                        updater.allowPrerelease = Boolean(semver.prerelease(currentVersion));
                        updater.on('error', () => { if (state.phase === 'installing') publish({ phase: 'downloaded', error: '安装程序未能启动，请重试。' }); });
                        updater.on('download-progress', progress);
                    }
                    updater.setFeedURL({ provider: 'generic', url: `${REPOSITORY}/releases/download/${encodeURIComponent(asset.tag)}/`, channel: updateChannel(asset.version) });
                    const checked = await updater.checkForUpdates();
                    cancellation = checked?.cancellationToken;
                    if (abort.signal.aborted) { cancellation?.cancel(); throw new Error('Canceled'); }
                    if (checked?.updateInfo?.version !== asset.version) throw new Error('Update metadata changed');
                    await updater.downloadUpdate(cancellation);
                } else installer = await downloadVerifiedAsset({ asset, directory, fetchImpl, signal: abort.signal, onProgress: progress });
                if (abort.signal.aborted) throw new Error('Canceled');
                return publish({ phase: 'downloaded', percent: 100 });
            } catch {
                return publish(abort.signal.aborted ? { phase: 'available', error: '', percent: 0 }
                    : { phase: 'error', error: '下载或校验失败，请重试。', percent: 0 });
            } finally { cancellation = null; abort = null; }
        },
        cancel() { if (state.phase === 'downloading') { publish({ phase: 'canceling' }); abort?.abort(); cancellation?.cancel(); } return { ...state }; },
        async install() {
            if (state.phase !== 'downloaded') return { ...state };
            publish({ phase: 'installing', error: '' });
            try {
                if (mode === 'automatic') { await prepareInstall(); updater.quitAndInstall(true, true); }
                else if (installer) { await openInstaller(installer); return publish({ phase: 'downloaded' }); }
                else throw new Error('Installer missing');
                return { ...state };
            } catch (error) { return publish({ phase: 'downloaded', error: error.code === 'TASKS_RUNNING' ? '仍有任务正在运行，请等待任务结束后安装。' : '安装程序未能启动，请稍后重试。' }); }
        }
    };
}
module.exports = { createAppUpdates, selectRelease, downloadVerifiedAsset, updateChannel };
