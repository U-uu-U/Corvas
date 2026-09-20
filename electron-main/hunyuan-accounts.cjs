const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { keyFor } = require('./hunyuan-model-watcher.cjs');

const HUNYUAN_URL = 'https://3d.hunyuan.tencent.com/studio/creation/geo';
const ACCOUNT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const partitionFor = id => {
    if (!ACCOUNT_ID.test(id || '')) throw new Error('混元账号不存在');
    return `persist:corvas-hunyuan-${id}`;
};

class HunyuanAccounts {
    constructor({ dataDir, launchBrowser, clearLegacySession = async () => {}, onChange = () => {},
        onModelTask = () => {}, onWorkflowAction = () => {}, workflowState = () => ({ mode: 'ask', jobs: [] }) }) {
        this.file = path.join(dataDir, 'hunyuan-accounts.json');
        this.profilesDir = path.join(dataDir, 'hunyuan-browser-profiles');
        this.launchBrowser = launchBrowser;
        this.clearLegacySession = clearLegacySession;
        this.onChange = onChange;
        Object.assign(this, { onModelTask, onWorkflowAction, workflowState });
        this.downloadRequests = new Map();
        this.windows = new Map();
        this.states = new Map();
        this.removing = new Set();
        this.queue = Promise.resolve();
        this.accounts = [];
        this.loadError = '';
        try {
            const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (data.version !== 1 || !Array.isArray(data.accounts) || data.accounts.length > 50) throw new Error('Invalid accounts');
            const seen = new Set();
            this.accounts = data.accounts.map(account => {
                partitionFor(account.id);
                if (seen.has(account.id) || !account.name?.trim()) throw new Error('Invalid account');
                seen.add(account.id);
                return { id: account.id, name: account.name.trim().slice(0, 40),
                    createdAt: account.createdAt, lastOpenedAt: account.lastOpenedAt || null };
            });
        } catch (error) {
            if (error.code !== 'ENOENT') this.loadError = '混元账号配置读取失败，原文件已保留，请重启后重试。';
        }
    }

    list() {
        return { error: this.loadError, accounts: this.accounts.map(account => ({ ...account,
            windowOpen: this.windows.has(account.id),
            status: this.states.get(account.id) || 'closed' })) };
    }

    notify() { this.onChange(this.list()); }

    persist(accounts) {
        if (this.loadError) throw new Error(this.loadError);
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const temporary = `${this.file}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify({ version: 1, accounts }, null, 2), { mode: 0o600 });
        fs.renameSync(temporary, this.file);
        this.accounts = accounts;
    }

    mutate(callback) {
        const result = this.queue.then(callback);
        this.queue = result.catch(() => {});
        return result;
    }

    account(id) {
        if (this.loadError) throw new Error(this.loadError);
        partitionFor(id);
        const account = this.accounts.find(entry => entry.id === id);
        if (!account) throw new Error('混元账号不存在');
        if (this.removing.has(id)) throw new Error('正在移除该账号，请稍后再试');
        return account;
    }

    save({ id, name } = {}) {
        return this.mutate(() => {
            if (typeof name !== 'string' || !name.trim() || name.trim().length > 40) throw new Error('请输入 1 至 40 个字的账号名称');
            const previous = id ? this.account(id) : null;
            if (!previous && this.accounts.length >= 50) throw new Error('最多可添加 50 个混元账号');
            const account = { ...(previous || { id: crypto.randomUUID(), createdAt: new Date().toISOString(), lastOpenedAt: null }), name: name.trim() };
            this.persist(previous ? this.accounts.map(entry => entry.id === id ? account : entry) : [...this.accounts, account]);
            this.send(id, { type: 'rename', name: account.name });
            this.notify();
            return { ...this.list(), account: { ...account } };
        });
    }

    send(id, message) {
        const child = this.windows.get(id)?.child;
        if (!child?.connected) return;
        child.send(message, error => {
            if (error && this.windows.get(id)?.child === child) {
                this.states.set(id, 'error'); this.notify();
            }
        });
    }

    open({ id } = {}) {
        const account = this.account(id);
        if (this.windows.has(id)) {
            this.send(id, { type: 'focus' });
            return this.list();
        }
        this.persist(this.accounts.map(entry => entry.id === id ? { ...entry, lastOpenedAt: new Date().toISOString() } : entry));
        // Each process has its own Chromium window-name registry as well as its own profile.
        const child = this.launchBrowser({ id, name: account.name, profileDir: path.join(this.profilesDir, id) });
        const record = { child, closing: false };
        this.windows.set(id, record);
        record.closed = new Promise(resolve => {
            const finish = code => {
                for (const [requestId, pending] of this.downloadRequests) if (pending.child === child) {
                    clearTimeout(pending.timer); pending.reject(new Error('混元窗口已关闭，请重新打开后重试')); this.downloadRequests.delete(requestId);
                }
                if (this.windows.get(id) === record) {
                    this.windows.delete(id);
                    if (code && !record.closing) this.states.set(id, 'error');
                    else this.states.delete(id);
                    this.notify();
                }
                resolve();
            };
            child.once('close', finish);
            child.once('error', () => finish(1));
        });
        child.on('message', message => {
            if (this.windows.get(id) !== record || record.closing) return;
            if (message?.type === 'model-task') return this.onModelTask(id, message.task);
            if (message?.type === 'workflow-action') return this.onWorkflowAction(id, message);
            if (message?.type === 'current-model-described') {
                const pending = this.downloadRequests.get(message.requestId);
                if (!pending || pending.kind !== 'current' || pending.child !== child) return;
                clearTimeout(pending.timer); this.downloadRequests.delete(message.requestId);
                if (message.error) pending.reject(new Error(message.error));
                else {
                    try { pending.resolve(this.modelSource(id, message.model?.generationId)); }
                    catch (error) { pending.reject(error); }
                }
                return;
            }
            if (message?.type === 'model-downloaded') {
                const pending = this.downloadRequests.get(message.requestId);
                if (!pending || pending.kind === 'current' || pending.accountId !== id) return;
                clearTimeout(pending.timer); this.downloadRequests.delete(message.requestId);
                if (message.error) pending.reject(new Error(message.error));
                else {
                    const root = path.resolve(this.profilesDir, id, 'rhino-models');
                    const filePath = path.resolve(String(message.filePath || ''));
                    const relative = path.relative(root, filePath);
                    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.extname(filePath) !== '.fbx') {
                        pending.reject(new Error('模型文件路径无效'));
                    } else pending.resolve(filePath);
                }
                return;
            }
            if (message?.type !== 'status'
                || !['loading', 'open', 'error'].includes(message.status)) return;
            this.states.set(id, message.status); this.notify();
        });
        this.send(id, { type: 'workflow-state', state: this.workflowState(id) });
        this.states.set(id, 'loading');
        this.notify();
        return this.list();
    }

    syncWorkflow() {
        for (const id of this.windows.keys()) this.send(id, { type: 'workflow-state', state: this.workflowState(id) });
    }

    modelSource(accountId, generationId) {
        this.account(accountId);
        if (!/^[a-f0-9]{32}$/.test(generationId || '')) throw new Error('模型来源标识无效');
        const profile = path.join(this.profilesDir, accountId);
        let source;
        try { source = JSON.parse(fs.readFileSync(path.join(profile, 'rhino-watch.json'), 'utf8')).seen?.[generationId]; }
        catch { /* Completed local downloads can outlive the watch history. */ }
        const cached = path.join(profile, 'rhino-models', keyFor(generationId), 'model.fbx');
        let downloaded = false;
        try { const stat = fs.statSync(cached); downloaded = stat.isFile() && stat.size > 32; } catch { /* Not downloaded. */ }
        if (!downloaded && (source?.status !== 2 || !source.url)) throw new Error('未找到该模型，请先从已打开的混元窗口读取当前模型');
        return { accountId, generationId, worksId: source?.worksId || generationId,
            label: source?.label || '混元模型', downloaded };
    }

    currentModel(accountId) {
        this.account(accountId);
        const child = this.windows.get(accountId)?.child;
        if (!child?.connected) throw new Error('请先打开对应混元账号窗口并选中模型');
        const requestId = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.downloadRequests.delete(requestId); reject(new Error('读取当前模型超时，请保持混元窗口打开')); }, 15000);
            this.downloadRequests.set(requestId, { kind: 'current', accountId, child, resolve, reject, timer });
            this.send(accountId, { type: 'describe-current-model', requestId });
        });
    }

    downloadModel(accountId, worksId) {
        this.account(accountId);
        if (!/^[a-f0-9]{32}$/.test(worksId || '')) throw new Error('模型任务标识无效');
        const cached = path.join(this.profilesDir, accountId, 'rhino-models', keyFor(worksId), 'model.fbx');
        try {
            const stat = fs.statSync(cached);
            if (stat.isFile() && stat.size > 32) return Promise.resolve(cached);
        } catch { /* The account window downloads the model if no completed copy exists. */ }
        if (!this.windows.get(accountId)?.child?.connected) throw new Error('请先打开对应混元账号窗口');
        const requestId = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.downloadRequests.delete(requestId); reject(new Error('模型下载等待超时，请稍后重试')); }, 360000);
            this.downloadRequests.set(requestId, { accountId, child: this.windows.get(accountId).child, resolve, reject, timer });
            this.send(accountId, { type: 'download-model', worksId, requestId });
        });
    }

    async close(id) {
        const record = this.windows.get(id);
        if (!record) return;
        record.closing = true;
        this.send(id, { type: 'close' });
        const timeout = setTimeout(() => record.child.kill(), 5000);
        try { await record.closed; } finally { clearTimeout(timeout); }
    }

    remove({ id } = {}) {
        return this.mutate(async () => {
            this.account(id);
            this.removing.add(id);
            try {
                await this.close(id);
                await fs.promises.rm(path.join(this.profilesDir, id), { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
                await this.clearLegacySession(id);
                this.persist(this.accounts.filter(account => account.id !== id));
                this.states.delete(id);
                this.notify();
                return this.list();
            } finally { this.removing.delete(id); }
        });
    }

    closeAll() {
        return Promise.all([...this.windows.keys()].map(id => this.close(id)));
    }
}

module.exports = { HunyuanAccounts, HUNYUAN_URL, partitionFor };
