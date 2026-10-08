/* global relayBrowser */
const $ = id => document.getElementById(id);
function run(action, value) {
    void relayBrowser.command(action, value).then(result => {
        if (!result.ok) $('web-status').textContent = result.error;
    }).catch(() => { $('web-status').textContent = '操作未完成，请重试'; });
}
relayBrowser.onState(state => {
    $('picker').hidden = Boolean(state.site);
    $('home').textContent = state.siteName || '中转站';
    $('web-status').textContent = state.status || '';
    $('web-status').title = state.status || '';
    $('clear-task').hidden = !state.taskId;
    $('task-label').textContent = state.taskId || '';
    for (const id of ['back', 'forward', 'reload', 'home', 'logs']) $(id).disabled = !state.site;
});
document.querySelectorAll('[data-site]').forEach(button => button.addEventListener('click', () => run('choose', { site: button.dataset.site })));
for (const id of ['back', 'forward', 'reload', 'home', 'logs', 'switch', 'clear-task']) $(id).addEventListener('click', () => run(id));
run('state');
