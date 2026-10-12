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
    $('connect').disabled = !state.site || ['connecting', 'selecting'].includes(account.state);
    $('connect').dataset.state = account.state || 'signed-out';
    $('connect').querySelector('span').textContent = ['connected', 'signed-in'].includes(account.state) ? '选择 API Key'
        : account.state === 'connecting' ? '读取中…' : account.state === 'selecting' ? '等待选择' : '连接画布';
    $('connect').title = [account.username, account.message].filter(Boolean).join(' · ') || '登录后选择 API Key';
    if (account.state === 'error' && !state.status) {
        $('web-status').textContent = account.message;
        $('web-status').title = account.message;
    }
    for (const id of ['back', 'forward', 'reload', 'home', 'logs']) $(id).disabled = !state.site;
});
document.querySelectorAll('[data-site]').forEach(button => button.addEventListener('click', () => run('choose', { site: button.dataset.site })));
for (const id of ['back', 'forward', 'reload', 'home', 'logs', 'switch', 'clear-task', 'connect']) $(id).addEventListener('click', () => run(id));
run('state');
