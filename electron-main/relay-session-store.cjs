const fs = require('node:fs');
const path = require('node:path');

const STORAGE_KEYS = ['token', 'user'];
const COOKIE_FIELDS = ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'expirationDate', 'hostOnly'];
const unavailable = () => new Error('登录状态未能加密保存，请解锁系统凭据服务后重试');

class RelaySessionStore {
    constructor({ directory, safeStorage }) {
        this.file = path.join(directory, 'relay-sessions.v1.json');
        this.safeStorage = safeStorage;
    }

    read() {
        if (!fs.existsSync(this.file)) return {};
        if (!this.safeStorage?.isEncryptionAvailable()) throw unavailable();
        const envelope = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (envelope.version !== 1 || typeof envelope.encrypted !== 'string') throw unavailable();
        const value = JSON.parse(this.safeStorage.decryptString(Buffer.from(envelope.encrypted, 'base64')));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
        return value;
    }

    get(site, origin) {
        const saved = this.read()[site];
        return saved?.origin === origin ? saved : null;
    }

    save(site, origin, { cookies = [], storage = {} }) {
        const values = this.read();
        const selected = Object.fromEntries(STORAGE_KEYS.filter(key => typeof storage[key] === 'string'
            && storage[key].length <= 32768).map(key => [key, storage[key]]));
        values[site] = { origin, storage: selected, cookies: cookies.filter(cookie => !cookie.expirationDate
            || cookie.expirationDate > Date.now() / 1000).slice(0, 100).map(cookie => Object.fromEntries(
            COOKIE_FIELDS.filter(key => cookie[key] !== undefined).map(key => [key, cookie[key]]))) };
        this.write(values);
    }

    clear(site) {
        const values = this.read();
        if (!Object.hasOwn(values, site)) return;
        delete values[site];
        this.write(values);
    }

    write(values) {
        if (!this.safeStorage?.isEncryptionAvailable()) throw unavailable();
        const raw = JSON.stringify(values);
        if (Buffer.byteLength(raw) > 512 * 1024) throw unavailable();
        if (raw === this.lastSaved) return;
        const envelope = { version: 1, encrypted: this.safeStorage.encryptString(raw).toString('base64') };
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const temporary = this.file + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify(envelope), { mode: 0o600 });
        fs.renameSync(temporary, this.file);
        this.lastSaved = raw;
    }
}

function sessionStorageScript(origin) {
    return `(() => { if (location.origin !== ${JSON.stringify(origin)}) return null;
        return Object.fromEntries(${JSON.stringify(STORAGE_KEYS)}.map(key => [key, sessionStorage.getItem(key)])); })()`;
}

async function restoreSessionCookies(browserSession, saved, origin) {
    if (!saved?.cookies?.length) return;
    const hostname = new URL(origin).hostname;
    const current = await browserSession.cookies.get({ url: origin });
    for (const cookie of saved.cookies) {
        if (cookie.expirationDate && cookie.expirationDate <= Date.now() / 1000) continue;
        const domain = String(cookie.domain || '').replace(/^\./, '');
        if (!domain || (hostname !== domain && !hostname.endsWith('.' + domain))) continue;
        if (current.some(value => value.name === cookie.name && value.domain === cookie.domain && value.path === cookie.path)) continue;
        const details = { ...cookie, url: origin + (cookie.path || '/') };
        delete details.hostOnly;
        if (cookie.hostOnly) delete details.domain;
        await browserSession.cookies.set(details);
    }
}

async function restoreSessionStorage(web, saved, origin) {
    if (!saved?.storage?.token) return false;
    const values = Object.fromEntries(STORAGE_KEYS.filter(key => typeof saved.storage[key] === 'string')
        .map(key => [key, saved.storage[key]]));
    return web.executeJavaScript(`(() => {
        if (location.origin !== ${JSON.stringify(origin)} || sessionStorage.getItem('token') || localStorage.getItem('token')) return false;
        for (const [key, value] of Object.entries(${JSON.stringify(values)})) sessionStorage.setItem(key, value);
        return true;
    })()`);
}

module.exports = { RelaySessionStore, sessionStorageScript, restoreSessionCookies, restoreSessionStorage };
