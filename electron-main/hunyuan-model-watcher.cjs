const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const ORIGIN = 'https://3d.hunyuan.tencent.com';
const keyFor = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
function modelUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password
        || !/(^|\.)(myqcloud\.com|tencent\.com|qcloud\.com|qcloudcdn\.com|qstatic\.com)$/.test(url.hostname)) {
        throw new Error('混元模型下载地址不受支持');
    }
    return url.href;
}

class HunyuanModelWatcher {
    constructor({ directory, fetch, canPoll, onTask, onError }) {
        Object.assign(this, { directory, fetch, canPoll, onTask, onError });
        this.file = path.join(directory, 'rhino-watch.json');
        this.seen = {}; this.startedAt = Date.now(); this.busy = false; this.closed = false;
        this.downloads = new Map(); this.controllers = new Set();
        try { this.seen = JSON.parse(fs.readFileSync(this.file, 'utf8')).seen || {}; } catch { /* First launch. */ }
    }
    persist() {
        fs.mkdirSync(this.directory, { recursive: true });
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ seen: this.seen }));
        fs.renameSync(`${this.file}.tmp`, this.file);
    }
    async request(url, options = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 300000);
        this.controllers.add(controller);
        try { return await this.fetch(url, { ...options, signal: controller.signal }); }
        finally { clearTimeout(timer); this.controllers.delete(controller); }
    }
    async json(endpoint, body) {
        const response = await this.request(`${ORIGIN}/api${endpoint}`, { method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/json', Origin: ORIGIN, Referer: `${ORIGIN}/studio/creation/geo` },
            body: JSON.stringify({ ...body, requestId: crypto.randomUUID() }) });
        if (!response.ok) throw new Error(response.status === 401 ? '请先登录混元账号' : '混元任务状态暂时无法读取');
        const result = await response.json();
        if (result.errNo !== 0) throw new Error('混元任务接口未返回可用结果，请检查登录状态');
        return result.data;
    }
    start() {
        this.timer = setInterval(() => { void this.poll(); }, 6000);
        void this.poll();
    }
    async poll() {
        if (this.closed || this.busy || !this.canPoll()) return;
        this.busy = true;
        try {
            const data = await this.json('/game3d/general_info/get_works_list', { worksPipeline: 2 });
            if (!Array.isArray(data?.list)) throw new Error('混元任务结构已变化，自动发送已暂停');
            let waitingForUrl = false;
            for (const work of data.list) {
                const id = String(work.worksId || '');
                if (!id || id.length > 200 || Number(work.worksPipeline) !== 2) continue;
                const generationId = keyFor(`${id}:${work.submittedAt || ''}`);
                const status = Number(work.pipelineStatus);
                const previous = this.seen[generationId];
                const submitted = Date.parse(work.submittedAt);
                const tracked = previous?.tracked || status === 0 || status === 1
                    || (Number.isFinite(submitted) && submitted >= this.startedAt);
                const response = work.modelInfo?.geometryGenerationRsp || {};
                const url = response.fbxUrl || response.glbUrl || work.fbxUrl || work.glbUrl;
                // Baseline completed history is remembered without being sent to Rhino.
                this.seen[generationId] = { status, tracked, updatedAt: Date.now(), ...(previous?.url ? { url: previous.url } : {}) };
                if (!tracked) continue;
                if (url) this.seen[generationId].url = modelUrl(url);
                if ((status === 0 || status === 1) && !previous?.tracked) {
                    this.onTask({ worksId: id, generationId, status: 'generating' });
                }
                if (status === 2 && this.seen[generationId].url) {
                    // Repeated delivery is intentional: the parent persists and deduplicates jobs.
                    this.onTask({ worksId: id, generationId, status: 'ready' });
                } else if (status === 3 || status === 4) {
                    this.onTask({ worksId: id, generationId, status: 'generation_failed' });
                } else if (status === 2) waitingForUrl = true;
            }
            this.persist(); this.onError(waitingForUrl ? '混元模型已生成，正在等待可用的模型下载地址' : '');
        } catch (error) {
            if (!this.closed) this.onError(error.message?.startsWith('混元') || error.message?.startsWith('请先')
                ? error.message : '暂时无法读取混元任务，连接恢复后继续');
        } finally { this.busy = false; }
    }
    download(worksId) {
        if (this.downloads.has(worksId)) return this.downloads.get(worksId);
        const pending = this.downloadFile(worksId).finally(() => this.downloads.delete(worksId));
        this.downloads.set(worksId, pending);
        return pending;
    }
    async downloadFile(worksId) {
        let url = this.seen[worksId]?.url;
        if (!url) { await this.poll(); url = this.seen[worksId]?.url; }
        if (!url) throw new Error('模型下载地址尚未就绪，请保持混元窗口打开');
        const directory = path.join(this.directory, 'rhino-models', keyFor(worksId));
        fs.mkdirSync(directory, { recursive: true });
        const file = path.join(directory, 'model.fbx');
        if (fs.existsSync(file) && fs.statSync(file).size > 32) return file;
        if (/\.glb(?:\?|$)/i.test(url)) {
            const converted = await this.json('/game3d/resource/format_conversions', { glbUrl: url, fmt: 'fbx' });
            url = modelUrl(converted?.rspUrl);
        }
        let response;
        const controller = new AbortController();
        this.controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), 300000);
        try {
            for (let redirects = 0; redirects < 5; redirects++) {
                response = await this.fetch(modelUrl(url), { redirect: 'manual', credentials: 'omit', signal: controller.signal });
                if (![301, 302, 303, 307, 308].includes(response.status)) break;
                await response.body?.cancel();
                url = new URL(response.headers.get('location'), url).href;
            }
            if (!response?.ok || !response.body) throw new Error('模型下载失败，请稍后重试');
            let size = 0;
            await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) {
                size += chunk.length;
                callback(size > 1024 * 1024 * 1024 ? new Error('模型文件超过 1 GB') : null, chunk);
            } }), fs.createWriteStream(`${file}.part`), { signal: controller.signal });
            const handle = await fs.promises.open(`${file}.part`, 'r');
            const header = Buffer.alloc(64);
            try { await handle.read(header, 0, 64, 0); } finally { await handle.close(); }
            if (size < 32 || !/Kaydara FBX Binary|^;\s*FBX|FBXHeaderExtension/.test(header.toString('utf8'))) {
                throw new Error('下载结果不是可导入的 FBX 模型');
            }
            await fs.promises.rename(`${file}.part`, file);
            return file;
        } finally { clearTimeout(timer); this.controllers.delete(controller); }
    }
    close() { this.closed = true; clearInterval(this.timer); for (const controller of this.controllers) controller.abort(); }
}
module.exports = { HunyuanModelWatcher, keyFor };
