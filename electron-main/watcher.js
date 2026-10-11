// ============================================================
// Flow Canvas - File Watcher (Auto-Sync)
// ============================================================

const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');
const { isBoardMediaFile, isTemporaryBoardFile } = require('../shared/board-media-policy.cjs');

const WATCH_DEPTH = 5;

class Watcher {
    constructor(store, onChange) {
        this.store = store;
        this.onChange = onChange;
        this.watchers = new Map();
        this.pendingCloses = new Set();
    }

    isSupportedFile(filePath) {
        return isBoardMediaFile(filePath);
    }

    isReadyFile(filePath) {
        if (!this.isSupportedFile(filePath)) return false;

        try {
            const stat = fs.statSync(filePath);
            return stat.isFile() && stat.size > 0;
        } catch (_) {
            return false;
        }
    }

    isTemporaryFile(filePath) {
        return isTemporaryBoardFile(filePath);
    }

    add(folderPath) {
        if (!folderPath) return false;
        if (this.watchers.has(folderPath)) return true;

        try {
            const stats = fs.statSync(folderPath);
            if (!stats.isDirectory()) {
                console.warn('[Watcher] Not a directory, skipped:', folderPath);
                return false;
            }
        } catch (err) {
            console.warn('[Watcher] Folder is not accessible, skipped:', folderPath, err.message);
            return false;
        }

        const watcher = chokidar.watch(folderPath, {
            ignored: /(^|[/\\])\../,
            persistent: true,
            ignoreInitial: true,
            // Avoid the native fsevents teardown crash on Electron/macOS.
            ...(process.platform === 'darwin' ? { useFsEvents: false } : {}),
            depth: WATCH_DEPTH,
            awaitWriteFinish: {
                stabilityThreshold: 2000,
                pollInterval: 500
            }
        });

        watcher.on('add', (filePath) => {
            if (this.watchers.get(folderPath) === watcher && this.isReadyFile(filePath)) {
                this.onChange('add', filePath);
            }
        });

        watcher.on('unlink', (filePath) => {
            if (this.watchers.get(folderPath) === watcher && this.isSupportedFile(filePath)) {
                this.onChange('remove', filePath);
            }
        });

        watcher.on('error', (err) => {
            console.error('[Watcher] Watch error:', folderPath, err.message);
        });

        this.watchers.set(folderPath, watcher);
        console.log('[Watcher] Started:', folderPath);
        return true;
    }

    remove(folderPath) {
        const watcher = this.watchers.get(folderPath);
        if (!watcher) return false;

        this.watchers.delete(folderPath);
        this._closeWatcher(watcher);
        console.log('[Watcher] Stopped:', folderPath);
        return true;
    }

    sync(activeFolders = [], knownFolders = []) {
        const activeSet = new Set(activeFolders.filter(Boolean));
        const managedFolders = new Set([
            ...this.watchers.keys(),
            ...knownFolders.filter(Boolean)
        ]);

        managedFolders.forEach((folderPath) => {
            if (!activeSet.has(folderPath)) {
                this.remove(folderPath);
            }
        });

        let allActiveWatched = true;
        activeSet.forEach((folderPath) => {
            allActiveWatched = this.add(folderPath) && allActiveWatched;
        });

        return allActiveWatched;
    }

    scanFolder(folderPath) {
        const files = [];
        try {
            this._walkDir(folderPath, files, 0, WATCH_DEPTH);
            return { success: true, files };
        } catch (err) {
            console.error('[Watcher] Scan failed:', err.message);
            return { success: false, files: [], error: err.message };
        }
    }

    _walkDir(dir, result, depth, maxDepth) {
        if (depth > maxDepth) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                this._walkDir(fullPath, result, depth + 1, maxDepth);
            } else if (this.isReadyFile(fullPath)) {
                result.push(fullPath);
            }
        }
    }

    _closeWatcher(watcher) {
        const pending = Promise.resolve().then(() => watcher.close()).catch(error => {
            console.error('[Watcher] Close failed:', error.message);
        }).finally(() => this.pendingCloses.delete(pending));
        this.pendingCloses.add(pending);
        return pending;
    }

    closeAll() {
        for (const folder of [...this.watchers.keys()]) this.remove(folder);
        return Promise.all([...this.pendingCloses]);
    }
}

module.exports = Watcher;
