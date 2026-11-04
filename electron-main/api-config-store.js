const fs = require('fs');
const path = require('path');

const STORE_VERSION = 1;
const DEFAULT_BACKUP_LIMIT = 20;
// Operations on one config file run in order across store instances, so async
// encryption cannot interleave a load with a save or two saves with each other.
// Shared per process so a smoke entry's seed and main.js's store (even from an ASAR copy) queue together.
const fileQueues = globalThis[Symbol.for('corvas.apiConfigQueues')] ||= new Map();
function serialized(filePath, work) {
    const key = path.resolve(filePath).toLowerCase();
    const run = (fileQueues.get(key) || Promise.resolve()).then(work);
    const tail = run.catch(() => {});
    fileQueues.set(key, tail);
    void tail.then(() => { if (fileQueues.get(key) === tail) fileQueues.delete(key); });
    return run;
}

function cloneJson(value, fallback) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (_) {
        return fallback;
    }
}

function normalizeConfig(config = {}) {
    const providers = Array.isArray(config.providers)
        ? cloneJson(config.providers.slice(0, 100), [])
        : [];
    const globalConfig = config.globalConfig && typeof config.globalConfig === 'object'
        ? cloneJson(config.globalConfig, {})
        : {};
    return {
        version: STORE_VERSION,
        revision: Math.max(0, Number(config.revision) || 0),
        updatedAt: typeof config.updatedAt === 'string' && config.updatedAt
            ? config.updatedAt
            : new Date().toISOString(),
        providers,
        globalConfig
    };
}

class ApiConfigStore {
    constructor(userDataPath, options = {}) {
        this.dataDir = path.join(userDataPath, 'data');
        this.filePath = path.join(this.dataDir, 'api-config.v1.json');
        this.backupDir = path.join(this.dataDir, 'api-config-backups');
        this.backupLimit = Math.max(1, Number(options.backupLimit) || DEFAULT_BACKUP_LIMIT);
        this.protect = typeof options.protect === 'function' ? options.protect : null;
        this.unprotect = typeof options.unprotect === 'function' ? options.unprotect : null;
        this.now = typeof options.now === 'function' ? options.now : () => new Date();
        this.snapshot = null;
    }

    // Last result of load()/save(); for synchronous readers after startup has awaited load().
    cached() {
        return this.snapshot || { success: false, config: null, recoveredFromBackup: false, code: 'API_CONFIG_NOT_LOADED',
            error: 'API 配置尚未加载' };
    }

    load() {
        return serialized(this.filePath, async () => {
            const result = await this._load();
            // Keep the last good snapshot: a transient Keychain failure must not blank secret redaction.
            if (result.success) this.snapshot = result;
            return result;
        });
    }

    async _load() {
        const candidates = [this.filePath, ...this._backupFiles()];
        for (const candidate of candidates) {
            const config = await this._readConfig(candidate);
            if (!config) continue;
            return {
                success: true,
                config,
                recoveredFromBackup: candidate !== this.filePath
            };
        }
        if (candidates.some(candidate => fs.existsSync(candidate))) {
            return { success: false, config: null, recoveredFromBackup: false, code: 'API_CONFIG_UNREADABLE',
                error: '已有 API 配置暂时无法读取，原文件已保留。请解锁系统钥匙串后重试；不要重新创建空配置。' };
        }
        return { success: true, config: null, recoveredFromBackup: false };
    }

    save(config) {
        return serialized(this.filePath, () => this._save(config));
    }

    async _save(config) {
        try {
            const normalized = normalizeConfig(config);
            const current = await this._readConfig(this.filePath);
            // A locked Keychain or damaged primary must never be treated as a fresh install.
            if (!current && fs.existsSync(this.filePath)) {
                return { success: false, code: 'API_CONFIG_UNREADABLE',
                    error: '原 API 配置无法读取，已阻止覆盖。请先恢复系统钥匙串或配置备份。' };
            }
            const encrypted = current && JSON.parse(fs.readFileSync(this.filePath, 'utf8')).format === 'safe-storage';
            if (encrypted && JSON.stringify(current) === JSON.stringify(normalized)) {
                return { success: true, unchanged: true, revision: normalized.revision };
            }

            const envelope = await this._encode(normalized);
            fs.mkdirSync(this.dataDir, { recursive: true });
            if (current && fs.existsSync(this.filePath)) await this._backupPrimary(current);
            const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
            fs.writeFileSync(tempPath, JSON.stringify(envelope, null, 2), { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(tempPath, this.filePath);
            this._pruneBackups();
            this.snapshot = { success: true, config: normalized, recoveredFromBackup: false };
            return { success: true, unchanged: false, revision: normalized.revision };
        } catch (error) {
            return { success: false, error: error?.message || String(error) };
        }
    }

    async _encode(config) {
        const raw = JSON.stringify(config);
        if (this.protect) {
            const protectedValue = await this.protect(raw);
            if (protectedValue?.length) {
                const buffer = Buffer.isBuffer(protectedValue)
                    ? protectedValue
                    : Buffer.from(protectedValue);
                return {
                    version: STORE_VERSION,
                    format: 'safe-storage',
                    updatedAt: config.updatedAt,
                    payload: buffer.toString('base64')
                };
            }
        }
        throw new Error('系统凭据加密不可用，未保存 API 配置；原有配置已保留。请解锁系统钥匙串或凭据服务后重试。');
    }

    async _decode(envelope) {
        if (!envelope || typeof envelope !== 'object') return null;
        let raw = '';
        if (envelope.format === 'safe-storage') {
            if (!this.unprotect || typeof envelope.payload !== 'string') return null;
            raw = await this.unprotect(Buffer.from(envelope.payload, 'base64'));
        } else if (envelope.format === 'plain-json') {
            raw = envelope.payload;
        } else if (Array.isArray(envelope.providers)) {
            return normalizeConfig(envelope);
        }
        if (typeof raw !== 'string' || !raw) return null;
        return normalizeConfig(JSON.parse(raw));
    }

    async _readConfig(filePath) {
        try {
            if (!fs.existsSync(filePath)) return null;
            return await this._decode(JSON.parse(fs.readFileSync(filePath, 'utf8')));
        } catch (_) {
            return null;
        }
    }

    async _backupPrimary(config) {
        fs.mkdirSync(this.backupDir, { recursive: true });
        const stamp = this.now().toISOString().replace(/[:.]/g, '-');
        let backupPath = path.join(this.backupDir, `api-config-${stamp}.json`);
        let suffix = 1;
        while (fs.existsSync(backupPath)) {
            backupPath = path.join(this.backupDir, `api-config-${stamp}-${suffix++}.json`);
        }
        fs.writeFileSync(backupPath, JSON.stringify(await this._encode(config), null, 2), { encoding: 'utf8', mode: 0o600 });
    }

    _backupFiles() {
        try {
            if (!fs.existsSync(this.backupDir)) return [];
            return fs.readdirSync(this.backupDir)
                .filter(name => /^api-config-.*\.json$/i.test(name))
                .map(name => path.join(this.backupDir, name))
                .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        } catch (_) {
            return [];
        }
    }

    _pruneBackups() {
        this._backupFiles().slice(this.backupLimit).forEach(filePath => {
            try { fs.unlinkSync(filePath); } catch (_) { }
        });
    }
}

module.exports = { ApiConfigStore, normalizeConfig };
