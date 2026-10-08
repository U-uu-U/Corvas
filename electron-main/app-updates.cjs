const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const semver = require('semver');

const UPDATE_ORIGINS = Object.freeze(['https://cart.ravenhash.org', 'https://art.ravenhash.org']);
const MAX_ASSET_BYTES = 1024 * 1024 * 1024;
const SHA512 = /^[A-Za-z0-9+/]{86}==$/;
const updateError = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

function updateChannel(version) { return String(semver.prerelease(version)?.[0] || 'latest'); }
function selectRelease(releases, currentVersion, platform, portable = false, origin = UPDATE_ORIGINS[0]) {
    if (!UPDATE_ORIGINS.includes(origin)) throw updateError('UPDATE_SOURCE_INVALID', 'Untrusted update origin');
    if (!Array.isArray(releases) || !semver.valid(currentVersion)) return null;
    const candidates = releases.flatMap(release => {
        const version = semver.valid(release?.version);
        if (!version || release.draft || release.product !== 'Corvas' || release.version !== version
            || !/^[a-f0-9]{40}$/.test(release.sourceCommit || '')
            || (!semver.prerelease(currentVersion) && semver.prerelease(version))
            || !semver.gt(version, currentVersion)) return [];
        const assets = Array.isArray(release.assets) ? release.assets : [];
        const names = { windows: `Corvas.Setup.${version}.exe`, macos: `Corvas.${version}.mac.universal.dmg`,
            'windows-portable': `Corvas.${version}.exe` };
        const valid = assets.filter(asset => asset && asset.name === names[asset.platform]
            && asset.url === `/corvas/releases/${version}/${asset.name}` && /^[a-f0-9]{64}$/.test(asset.sha256 || '')
            && Number.isSafeInteger(asset.bytes) && asset.bytes > 0 && asset.bytes <= MAX_ASSET_BYTES);
        if (valid.length !== assets.length || new Set(valid.map(asset => asset.platform)).size !== valid.length
            || !valid.some(asset => asset.platform === 'windows') || !valid.some(asset => asset.platform === 'macos')) return [];
        const target = platform === 'darwin' ? 'macos' : portable ? 'windows-portable' : 'windows';
        const asset = valid.find(asset => asset.platform === target);
        if (!asset || (target === 'windows' && !SHA512.test(asset.sha512 || ''))) return [];
        return [{ version, name: asset.name, size: asset.bytes, digest: `sha256:${asset.sha256}`, sha512: asset.sha512,
            notes: Array.isArray(release.notes) ? release.notes.filter(note => typeof note === 'string').join('\n').slice(0, 8000) : '',
            origin, url: origin + asset.url }];
    });
    return candidates.sort((a, b) => semver.rcompare(a.version, b.version))[0] || null;
}

function describeUpdateError(error) {
    const status = Number(error?.statusCode || error?.status) || null;
    const code = String(error?.code || error?.cause?.code || '');
    if (status === 429) return { code: 'UPDATE_RATE_LIMITED', status, retryable: true, message: '更新服务器请求过多（HTTP 429），请稍后重试。' };
    if (status === 404 || code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') return { code: 'UPDATE_NOT_READY', status: 404, retryable: true, message: '更新文件尚未就绪（HTTP 404），请稍后重试。' };
    if (status >= 500) return { code: 'UPDATE_SERVER_UNAVAILABLE', status, retryable: true, message: `更新服务器暂不可用（HTTP ${status}），请稍后重试。` };
    if (/CHECKSUM|SIGNATURE|INTEGRITY/.test(code)) return { code: 'UPDATE_INTEGRITY_FAILED', status, retryable: false, message: '安装包校验未通过，已停止更新，请重新下载。' };
    if (/METADATA|SOURCE|INVALID_UPDATE_INFO/.test(code)) return { code: 'UPDATE_METADATA_INVALID', status, retryable: false, message: '更新信息不完整或不匹配，已停止更新，请稍后重试。' };
    if (code === 'ENOSPC') return { code, status, retryable: false, message: '磁盘空间不足，无法保存安装包。' };
    if (['EACCES', 'EPERM'].includes(code)) return { code, status, retryable: false, message: '无法写入更新目录，请检查目录权限。' };
    if (error?.name === 'TimeoutError' || /TIMED?OUT|TIMEOUT/.test(code)) return { code: 'UPDATE_TIMEOUT', status, retryable: true, message: '更新连接超时，请检查网络后重试。' };
    if (!status || status === 408) return { code: 'UPDATE_NETWORK_FAILED', status, retryable: true, message: '无法连接更新服务器，请检查网络后重试。' };
    return { code: 'UPDATE_HTTP_FAILED', status, retryable: false, message: `更新请求失败（HTTP ${status}），请稍后重试。` };
}

async function fetchReleases(fetchImpl, origin, signal) {
    const response = await fetchImpl(`${origin}/corvas/api/updates`, { headers: { accept: 'application/json' }, credentials: 'omit', redirect: 'error', signal });
    if (!response.ok) throw updateError('UPDATE_HTTP_FAILED', 'Release lookup failed', { status: response.status });
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw updateError('UPDATE_METADATA_INVALID', 'Release metadata too large');
        chunks.push(chunk);
    }
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks)); }
    catch { throw updateError('UPDATE_METADATA_INVALID', 'Invalid release JSON'); }
    if (payload?.schemaVersion !== 1 || !Array.isArray(payload.releases) || payload.releases.length > 50) {
        throw updateError('UPDATE_METADATA_INVALID', 'Invalid release catalog');
    }
    return payload.releases;
}

function validateNativeUpdateInfo(info, asset) {
    const file = info?.files?.[0];
    if (info?.version !== asset.version || info.files?.length !== 1 || file?.url !== asset.name
        || file.sha512 !== asset.sha512 || file.size !== asset.size || info.path !== asset.name || info.sha512 !== asset.sha512) {
        throw updateError('UPDATE_METADATA_INVALID', 'Native updater metadata does not match the release catalog');
    }
}

async function downloadVerifiedAsset({ asset, directory, fetchImpl, signal, onProgress }) {
    let url = asset.url, response;
    for (let redirects = 0; redirects <= 5; redirects++) {
        const parsed = new URL(url);
        if (!UPDATE_ORIGINS.includes(parsed.origin) || parsed.username || parsed.password || parsed.search || parsed.hash
            || parsed.pathname !== `/corvas/releases/${asset.version}/${asset.name}`) throw updateError('UPDATE_SOURCE_INVALID', 'Untrusted update location');
        response = await fetchImpl(url, { redirect: 'manual', credentials: 'omit', signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            url = new URL(response.headers.get('location'), url).href; continue;
        }
        break;
    }
    if (!response?.ok) throw updateError('UPDATE_HTTP_FAILED', 'Installer download failed', { status: response?.status });
    await fs.mkdir(directory, { recursive: true });
    const temporary = await fs.mkdtemp(path.join(directory, 'download-'));
    const filename = path.join(temporary, asset.name);
    const handle = await fs.open(filename, 'wx');
    const hash = crypto.createHash('sha256'); let bytes = 0;
    try {
        for await (const chunk of response.body) {
            if (signal.aborted) throw new Error('Canceled');
            bytes += chunk.length;
            if (bytes > asset.size || bytes > MAX_ASSET_BYTES) throw updateError('UPDATE_INTEGRITY_FAILED', 'Installer size mismatch');
            hash.update(chunk); await handle.writeFile(chunk);
            onProgress({ transferred: bytes, total: asset.size, percent: bytes / asset.size * 100 });
        }
        if (signal.aborted) throw new Error('Canceled');
        if (bytes !== asset.size || `sha256:${hash.digest('hex')}` !== asset.digest) throw updateError('UPDATE_INTEGRITY_FAILED', 'Installer checksum mismatch');
        await handle.close(); return filename;
    } catch (error) {
        await handle.close(); await fs.unlink(filename).catch(() => {}); await fs.rmdir(temporary).catch(() => {}); throw error;
    }
}

function createAppUpdates({ currentVersion, platform, packaged, portable = false, directory, fetchImpl,
    updaterFactory, prepareInstall = async () => {}, openInstaller = async () => {}, onState = () => {}, onDiagnostic = () => {} } = {}) {
    const mode = !packaged ? 'source' : platform === 'win32' && !portable ? 'automatic'
        : platform === 'darwin' || portable ? 'manual' : 'unsupported';
    let state = { phase: 'idle', currentVersion, latestVersion: null, mode, notes: '', percent: 0, error: '' };
    let asset, updater, cancellation, abort, installer;
    const publish = patch => { state = { ...state, ...patch }; onState({ ...state }); return { ...state }; };
    const busy = () => ['checking', 'downloading', 'canceling', 'installing'].includes(state.phase);
    const report = (error, stage, origin) => {
        const detail = describeUpdateError(error);
        onDiagnostic({ stage, source: origin === UPDATE_ORIGINS[0] ? 'cart' : 'art', code: detail.code, httpStatus: detail.status });
        return detail;
    };
    return {
        snapshot: () => ({ ...state }),
        async check() {
            if (busy()) return { ...state };
            publish({ phase: 'checking', error: '', errorCode: '' });
            try {
                asset = null;
                for (const [index, origin] of UPDATE_ORIGINS.entries()) {
                    try {
                        const releases = await fetchReleases(fetchImpl, origin, AbortSignal.timeout(15000));
                        asset = selectRelease(releases, currentVersion, platform, portable, origin);
                        break;
                    } catch (error) {
                        if (!report(error, 'check', origin).retryable || index === UPDATE_ORIGINS.length - 1) throw error;
                    }
                }
                installer = null;
                return publish({ phase: asset ? 'available' : 'current', latestVersion: asset?.version || null, notes: asset?.notes || '', percent: 0 });
            } catch (error) { const detail = describeUpdateError(error); return publish({ phase: 'error', error: detail.message, errorCode: detail.code }); }
        },
        async download() {
            if (!asset || busy() || !['automatic', 'manual'].includes(mode)) return { ...state };
            publish({ phase: 'downloading', percent: 0, error: '', errorCode: '' });
            abort = new AbortController();
            try {
                const progress = value => { if (state.phase === 'downloading') publish({ percent: Math.max(0, Math.min(100, Number(value.percent) || 0)) }); };
                const origins = [asset.origin, ...UPDATE_ORIGINS.filter(origin => origin !== asset.origin)];
                for (const [index, origin] of origins.entries()) {
                    try {
                        if (mode === 'automatic') {
                            if (!updater) {
                                updater = updaterFactory();
                                updater.autoDownload = false; updater.autoInstallOnAppQuit = false; updater.allowDowngrade = false;
                                updater.disableDifferentialDownload = true;
                                updater.disableWebInstaller = true;
                                updater.allowPrerelease = Boolean(semver.prerelease(currentVersion));
                                updater.on('error', () => { if (state.phase === 'installing') publish({ phase: 'downloaded', error: '安装程序未能启动，请重试。' }); });
                                updater.on('download-progress', progress);
                            }
                            updater.setFeedURL({ provider: 'generic', url: `${origin}/corvas/releases/${asset.version}/`, channel: updateChannel(asset.version), useMultipleRangeRequest: false });
                            const checked = await updater.checkForUpdates();
                            cancellation = checked?.cancellationToken;
                            if (abort.signal.aborted) { cancellation?.cancel(); throw new Error('Canceled'); }
                            validateNativeUpdateInfo(checked?.updateInfo, asset);
                            await updater.downloadUpdate(cancellation);
                        } else installer = await downloadVerifiedAsset({ asset: { ...asset, url: `${origin}/corvas/releases/${asset.version}/${asset.name}` }, directory, fetchImpl, signal: abort.signal, onProgress: progress });
                        break;
                    } catch (error) {
                        if (abort.signal.aborted || !report(error, 'download', origin).retryable || index === origins.length - 1) throw error;
                        publish({ percent: 0 });
                    }
                }
                if (abort.signal.aborted) throw new Error('Canceled');
                return publish({ phase: 'downloaded', percent: 100 });
            } catch (error) {
                const detail = describeUpdateError(error);
                return publish(abort.signal.aborted ? { phase: 'available', error: '', percent: 0 }
                    : { phase: 'error', error: detail.message, errorCode: detail.code, percent: 0 });
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
module.exports = { createAppUpdates, selectRelease, downloadVerifiedAsset, updateChannel, describeUpdateError, validateNativeUpdateInfo, UPDATE_ORIGINS };
