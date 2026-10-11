/* global relayBrowser */
const $ = id => document.getElementById(id);
function run(action, value) {
    void relayBrowser.command(action, value).then(result => {
        if (!result.ok) $('web-status').textContent = result.error;
    }).catch(() => { $('web-status').textContent = '操作未完成，请重试'; });
}
relayBrowser.onState(state => {
    $('picker').hidden = Boolean(state.site);
    $('home').textContent = state.siteName || '站点后台';
    $('web-status').textContent = state.status || '';
    $('web-status').title = state.status || '';
    $('clear-task').hidden = !state.taskId;
    $('task-label').textContent = state.taskId || '';
    const account = state.account || {};
    $('connect').disabled = !state.site || account.state === 'connecting';
    $('connect').dataset.state = account.state || 'signed-out';
    $('connect').querySelector('span').textContent = account.state === 'connected' ? '已连接画布'
        : account.state === 'connecting' ? '连接中…' : '连接画布';
    $('connect').title = [account.username, account.message].filter(Boolean).join(' · ') || '登录后自动连接画布';
    if (account.state === 'error' && !state.status) {
        $('web-status').textContent = account.message;
        $('web-status').title = account.message;
    }
    for (const id of ['back', 'forward', 'reload', 'home', 'logs']) $(id).disabled = !state.site;
});
document.querySelectorAll('[data-site]').forEach(button => button.addEventListener('click', () => run('choose', { site: button.dataset.site })));
for (const id of ['back', 'forward', 'reload', 'home', 'logs', 'switch', 'clear-task', 'connect']) $(id).addEventListener('click', () => run(id));
run('state');
