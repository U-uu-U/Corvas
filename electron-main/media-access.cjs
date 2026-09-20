const fs = require('node:fs');
const path = require('node:path');

const MEDIA_EXTENSIONS = new Set(('.aac .avi .avif .bmp .flac .flv .gif .heic .heif .ico .jpeg .jpg .m4a .m4v .mkv .mov .mp3 .mp4 .mpeg .mpg .ogg .pdf .png .svg .tif .tiff .wav .webm .webp .wma .wmv').split(' '));
const OPEN_EXTENSIONS = new Set([...MEDIA_EXTENSIONS, ...('.doc .docx .txt .md .ppt .pptx .xls .xlsx .psd .ai .eps .raw .cr2 .nef .arw .obj .fbx .gltf .glb .3dm .stl .step .stp .iges .igs .sketch .fig').split(' ')]);
const ASSET_EXTENSIONS = new Set([...OPEN_EXTENSIONS, '.blend', '.gh']);

function within(root, file) {
    const relative = path.relative(root, file);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

const pathKey = file => process.platform === 'win32' ? file.toLowerCase() : file;

function absolutePath(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)
        || /^[\\/]{2}/.test(value) || (process.platform === 'win32' && value.slice(2).includes(':'))) {
        throw new Error('无效的本地素材路径');
    }
    return path.resolve(value);
}

function collectBoardMediaScope(board = {}) {
    const roots = [...(board.watchFolders || []), ...(board.assetLibrary?.folders || []),
        board.assetLibrary?.defaultFolder, board.defaultSaveFolder, board.activeGroupDefaultSaveFolder];
    const files = [];
    const visit = value => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { value.forEach(visit); return; }
        for (const [key, child] of Object.entries(value)) {
            if (['filePath', '_resultFilePath', 'posterPath', 'thumbnailPath'].includes(key) && typeof child === 'string') files.push(child);
            else if (['filePaths', 'resultFilePaths'].includes(key) && Array.isArray(child)) files.push(...child.filter(file => typeof file === 'string'));
            else if (typeof child === 'object') visit(child);
        }
    };
    visit(board.items);
    for (const group of board.folderGroups || []) {
        roots.push(...(group.folders || []), group.defaultSaveFolder);
        visit(group.savedItems);
    }
    return { roots: roots.filter(value => typeof value === 'string' && value), files };
}

class MediaAccessPolicy {
    constructor({ getScope = () => ({}), userData, managedRoots = [], registryFile, legacyScope = {} } = {}) {
        this.getScope = getScope;
        const canonical = value => { try { return fs.realpathSync.native(value); } catch { return path.resolve(value); } };
        const savedCanonical = value => {
            const stored = absolutePath(value);
            try {
                // Expand OS aliases only; a replaced symlink must not transfer a grant.
                return pathKey(fs.realpathSync(stored)) === pathKey(stored) ? fs.realpathSync.native(stored) : stored;
            } catch { return stored; }
        };
        this.userData = userData ? canonical(userData) : null;
        this.managedRoots = managedRoots.map(canonical);
        this.files = new Set();
        this.roots = new Set();
        this.scope = null;
        this.scopeFiles = new Set();
        this.registryFile = registryFile;
        if (registryFile) {
            try {
                const saved = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
                if (saved.version !== 1 || !Array.isArray(saved.files) || !Array.isArray(saved.roots)) throw new Error('Invalid media registry');
                this.files = new Set(saved.files.map(savedCanonical).map(pathKey));
                this.roots = new Set(saved.roots.map(savedCanonical));
            } catch (error) {
                // Only the first upgrade imports legacy references. Corruption must not
                // turn a renderer-written board into a fresh source of permissions.
                if (error.code !== 'ENOENT') throw new Error('素材授权记录无法读取，请恢复备份后重试');
                for (const root of legacyScope.roots || []) {
                    try { this.grant(root, { directory: true, persist: false }); } catch { /* Skip stale legacy folders. */ }
                }
                for (const file of legacyScope.files || []) {
                    try { this.grant(file, { persist: false }); } catch { /* Skip stale or unsupported legacy files. */ }
                }
                this.persist();
            }
        }
    }

    _checkSensitive(file) {
        if (/(?:^|[\\/])(?:\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.codex)(?:[\\/]|$)/i.test(file)) {
            throw new Error('此文件不是可访问的素材');
        }
        if (this.userData && within(this.userData, file) && !this.managedRoots.some(root => within(root, file))) {
            throw new Error('应用配置文件不可作为素材访问');
        }
    }

    persist() {
        if (!this.registryFile) return;
        fs.mkdirSync(path.dirname(this.registryFile), { recursive: true });
        const temporary = `${this.registryFile}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify({ version: 1, roots: [...this.roots], files: [...this.files] }), { mode: 0o600 });
        fs.renameSync(temporary, this.registryFile);
    }

    grant(file, { directory = false, persist = true } = {}) {
        const requested = absolutePath(file);
        const real = fs.realpathSync.native(requested);
        this._checkSensitive(requested);
        this._checkSensitive(real);
        const stat = fs.statSync(real);
        if (directory ? !stat.isDirectory() : !stat.isFile() || !ASSET_EXTENSIONS.has(path.extname(real).toLowerCase())) {
            throw new Error('不支持此素材类型');
        }
        if (directory) this.roots.add(real);
        else this.files.add(pathKey(real));
        if (persist) this.persist();
        return real;
    }

    async resolve(file, { purpose = 'preview' } = {}) {
        const requested = absolutePath(file);
        const extensions = purpose === 'preview' ? MEDIA_EXTENSIONS : purpose === 'asset' ? ASSET_EXTENSIONS : OPEN_EXTENSIONS;
        if (!extensions.has(path.extname(requested).toLowerCase())) throw new Error('不允许打开此文件类型');
        const real = await fs.promises.realpath(requested);
        this._checkSensitive(requested);
        this._checkSensitive(real);
        if (!extensions.has(path.extname(real).toLowerCase())) throw new Error('不允许打开此文件类型');
        const scope = this.getScope() || {};
        if (scope !== this.scope) {
            this.scope = scope;
            this.scopeFiles = new Set((scope.files || []).flatMap(candidate => {
                try { return [pathKey(absolutePath(candidate))]; } catch { return []; }
            }));
        }
        let allowed = this.files.has(pathKey(real)) || this.scopeFiles.has(pathKey(requested));
        if (!allowed) allowed = [...this.managedRoots, ...this.roots].some(root => within(root, real));
        if (!allowed) {
            for (const candidate of scope.roots || []) {
                try {
                    const root = absolutePath(candidate);
                    if (!within(root, requested)) continue;
                    const realRoot = await fs.promises.realpath(root);
                    if (within(realRoot, real)) { allowed = true; break; }
                } catch { /* Missing or disconnected folders do not grant access. */ }
            }
        }
        if (!allowed) throw new Error('素材不在已授权的画布或素材库目录中');
        const stat = await fs.promises.stat(real);
        if (!stat.isFile()) throw new Error('素材文件不存在');
        return { filePath: real, stat };
    }
}

module.exports = { MediaAccessPolicy, collectBoardMediaScope, MEDIA_EXTENSIONS, OPEN_EXTENSIONS };
