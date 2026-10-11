import mediaPolicy from '../shared/board-media-policy.cjs';

const { isBoardMediaFile } = mediaPolicy;

// Only confirmed absence under an accessible watched folder removes a saved media card.
// Offline drives and permission errors retain the card for reconnection.
export async function findUnavailableBoardItems(items, { folders = [], inspect, platform = '' } = {}) {
    const normalize = value => {
        const text = String(value || '').normalize('NFC').replace(/\\/g, '/').replace(/\/+$/, '');
        return platform === 'win32' ? text.toLowerCase() : text;
    };
    const check = async file => {
        try { return await inspect?.(file); } catch { return null; }
    };
    const availableFolders = [];
    for (const folder of [...new Set(folders)]) {
        const result = await check(folder);
        if (result?.success && result.exists && result.isFile === false) availableFolders.push(normalize(folder));
    }
    const removed = [];
    const files = (items || []).filter(item => item?.kind !== 'op' && item?.filePath);
    for (let index = 0; index < files.length; index += 16) {
        await Promise.all(files.slice(index, index + 16).map(async item => {
            if (!isBoardMediaFile(item.filePath)) { removed.push(item); return; }
            const file = normalize(item.filePath);
            if (!availableFolders.some(folder => file.startsWith(`${folder}/`))) return;
            const result = await check(item.filePath);
            if (!result?.success) return;
            if ((!result.exists && ['ENOENT', 'ENOTDIR'].includes(result.error))
                || (result.exists && (!result.isFile || result.size === 0))) removed.push(item);
        }));
    }
    return removed;
}

export function pruneBoardMedia(data, removed) {
    const ids = new Set(removed.map(item => item.id));
    const paths = new Set(removed.map(item => item.filePath));
    data.items = (data.items || []).filter(item => !ids.has(item.id));
    data.connections = (data.connections || []).filter(edge => !ids.has(edge.from?.nodeId) && !ids.has(edge.to?.nodeId));
    for (const plan of data.plans || []) for (const row of plan.rows || []) {
        if (Array.isArray(row.references)) row.references = row.references.filter(ref => !ids.has(ref.itemId) && !paths.has(ref.filePath));
    }
}
