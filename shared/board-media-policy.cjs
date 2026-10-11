const BOARD_MEDIA_EXTENSIONS = {
    image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'svg', 'ico'],
    video: ['mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm', 'm4v'],
    audio: ['mp3', 'wav', 'aac', 'flac', 'ogg', 'wma', 'm4a']
};
const types = new Map(Object.entries(BOARD_MEDIA_EXTENSIONS).flatMap(([type, extensions]) => extensions.map(ext => [ext, type])));

function isTemporaryBoardFile(filePath) {
    const name = String(filePath || '').split(/[/\\]/).pop() || '';
    if (!name || name.startsWith('.') || name.startsWith('~') || name.endsWith('~')) return true;
    if (/^(thumbs\.db|desktop\.ini)$/i.test(name)) return true;
    return /\.(tmp|temp|part|partial|crdownload|download|swp|swo)$/i.test(name);
}

function boardMediaType(filePath) {
    const name = String(filePath || '').split(/[/\\]/).pop() || '';
    const dot = name.lastIndexOf('.');
    return dot > 0 ? types.get(name.slice(dot + 1).toLowerCase()) || null : null;
}

function isBoardMediaFile(filePath) {
    return !isTemporaryBoardFile(filePath) && Boolean(boardMediaType(filePath));
}

module.exports = { BOARD_MEDIA_EXTENSIONS, boardMediaType, isBoardMediaFile, isTemporaryBoardFile };
