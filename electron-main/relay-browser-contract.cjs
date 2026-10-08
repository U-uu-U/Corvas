const SITES = Object.freeze({
    art: { name: '个人站', origin: 'https://art.ravenhash.org' },
    cart: { name: '企业站', origin: 'https://cart.ravenhash.org' }
});

function relaySite(value) {
    try {
        const url = new URL(value);
        return Object.keys(SITES).find(site => url.origin === SITES[site].origin) || null;
    } catch { return null; }
}

function identifier(value) {
    const text = String(value || '');
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(text)) throw new Error('任务编号无效');
    return text;
}

function publicTask(row) {
    const failed = Boolean(row.billing_failed || row.error_message) || Number(row.status_code) >= 400;
    const completed = row.is_completed === true || row.is_completed === 1;
    const count = completed && !failed && Array.isArray(row.preview_urls)
        ? row.preview_urls.filter(url => typeof url === 'string' && /^https?:\/\//i.test(url)).length : 0;
    return { logId: identifier(row.log_id), taskId: row.task_id ? identifier(row.task_id) : '',
        model: String(row.model || '').slice(0, 200), createdAt: String(row.created_at || ''),
        status: failed ? 'failed' : completed ? 'completed' : 'running', count };
}

function findLocalTask(records, site, taskId, clientTaskId) {
    const matches = records.filter(record => record.kind === 'video' && record.taskId === taskId
        && relaySite(record.endpoint) === site);
    if (clientTaskId) return matches.find(record => record.clientTaskId === clientTaskId) || null;
    return matches.length === 1 ? matches[0] : null;
}

module.exports = { SITES, relaySite, identifier, publicTask, findLocalTask };
