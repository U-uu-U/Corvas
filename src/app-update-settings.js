import './app-update-settings.css';
import { modelConfigStore } from './model-config.js';

function mountConfigSync(pane) {
    const button = pane.querySelector('#configUpdateAction');
    if (!button) return;
    const render = (_config, state) => {
        pane.querySelector('#configUpdateVersion').textContent = state.fetchedAt !== null
            ? `已生效 r${state.revision}` : '尚未同步';
        const seconds = Math.round(state.refreshIntervalMs / 1000);
        const interval = seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
        pane.querySelector('#configUpdateAuto').textContent = state.urlConfigured
            ? `启动自动同步 · 每 ${interval} 检查` : 'CONFIG 自动同步已关闭';
        const status = pane.querySelector('#configUpdateStatus');
        status.textContent = state.refreshing ? '正在同步模型配置…'
            : !state.urlConfigured ? '未配置 CONFIG 更新地址'
                : state.lastError ? `${state.fetchedAt !== null ? `继续使用 r${state.revision}，同步将自动重试。` : '尚未取得远程配置，将自动重试。'} ${state.lastError}`
                    : state.fetchedAt !== null ? `模型配置已同步 · ${state.modelCount} 个模型` : '等待同步模型配置';
        pane.querySelector('#configUpdateCheckedAt').textContent = state.fetchedAt !== null
            ? `最近成功同步：${new Date(state.fetchedAt).toLocaleString('zh-CN', { hour12: false })}` : '';
        button.disabled = state.refreshing || !state.urlConfigured;
        button.querySelector('span').textContent = state.refreshing ? '正在同步' : '立即同步';
    };
    render(null, modelConfigStore.getStatus());
    const unsubscribe = modelConfigStore.subscribe(render);
    window.addEventListener('pagehide', unsubscribe, { once: true });
    button.addEventListener('click', async () => {
        await modelConfigStore.refresh({ reason: 'manual', force: true });
    });
}

function mount() {
    const pane = document.getElementById('agentUpdateSettingsPane');
    const api = window.flowCanvas?.appUpdates;
    if (!pane) return;
    mountConfigSync(pane);
    const button = pane.querySelector('#appUpdateAction'), cancel = pane.querySelector('#appUpdateCancel');
    const status = pane.querySelector('#appUpdateStatus'), progress = pane.querySelector('progress');
    let state = { phase: 'idle', mode: 'source' };
    function render(next) {
        state = next;
        pane.querySelector('#appUpdateVersion').textContent = `当前版本 ${next.currentVersion || '--'}`;
        const modes = { source: '源码运行，安装版提供在线更新。', manual: window.flowCanvas.platform === 'darwin'
            ? '下载完成后打开 DMG，将新版拖入应用程序。' : '下载完成后退出旧版，再打开新版便携程序。',
        unsupported: '当前平台暂不支持在线更新。' };
        pane.querySelector('#appUpdateMode').textContent = modes[next.mode] || '';
        const text = { idle: '尚未检查新版本', checking: '正在检查新版本…', current: '暂无可安装的新版本',
            available: `发现新版本 ${next.latestVersion}`, downloading: `正在下载 ${next.latestVersion} · ${Math.round(next.percent || 0)}%`,
            canceling: '正在取消下载…', downloaded: `新版本 ${next.latestVersion} 已下载并校验`, installing: '正在启动安装…' };
        status.textContent = next.error || text[next.phase] || '';
        const downloading = ['downloading', 'canceling'].includes(next.phase);
        progress.hidden = !downloading; progress.value = next.percent || 0;
        cancel.hidden = !downloading; cancel.disabled = next.phase === 'canceling';
        const labels = { checking: '正在检查', downloading: '正在下载', canceling: '正在取消', installing: '正在安装',
            available: '下载新版本', downloaded: next.mode === 'automatic' ? '重启并安装'
                : window.flowCanvas.platform === 'darwin' ? '打开安装文件' : '打开下载位置' };
        button.querySelector('span').textContent = labels[next.phase] || '获取新版本';
        button.querySelector('use').setAttribute('href', `./icons/flow-icons.svg#${next.phase === 'downloaded'
            ? next.mode === 'automatic' ? 'icon-replace' : 'icon-expand' : 'icon-download'}`);
        button.disabled = ['checking', 'downloading', 'canceling', 'installing'].includes(next.phase)
            || next.mode === 'unsupported' || (next.mode === 'source' && next.phase === 'available');
        const notes = pane.querySelector('#appUpdateNotes'); notes.hidden = !next.notes; notes.querySelector('pre').textContent = next.notes || '';
    }
    if (!api) { button.disabled = true; status.textContent = '更新接口尚未加载，请重启软件。'; return; }
    button.addEventListener('click', async () => {
        try {
            if (state.phase === 'downloaded') {
                if (state.mode === 'automatic' && !document.dispatchEvent(new CustomEvent('app-update:prepare-install', { cancelable: true }))) {
                    status.textContent = '画布尚未保存成功，请保存后再安装。'; return;
                }
                render(await api.install());
            } else if (state.phase === 'available') render(await api.download());
            else {
                const checked = await api.check(); render(checked);
                if (checked.phase === 'available' && ['automatic', 'manual'].includes(checked.mode)) render(await api.download());
            }
        } catch { status.textContent = '更新操作失败，请重试。'; button.disabled = false; }
    });
    cancel.addEventListener('click', () => { api.cancel().then(render).catch(() => {}); });
    const unsubscribe = api.onState(render);
    window.addEventListener('pagehide', unsubscribe, { once: true });
    api.snapshot().then(render).catch(() => { status.textContent = '无法读取版本信息'; });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
