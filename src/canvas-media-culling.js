export function isMediaOutsideViewport(matrix, width, height, viewportWidth, viewportHeight, padding = 96) {
    if (!matrix?.every(Number.isFinite) || ![width, height, viewportWidth, viewportHeight].every(value => Number.isFinite(value) && value > 0)) return false;
    const [a, b, c, d, x, y] = matrix;
    const xs = [x, x + a * width, x + c * height, x + a * width + c * height];
    const ys = [y, y + b * width, y + d * height, y + b * width + d * height];
    return Math.max(...xs) < -padding || Math.min(...xs) > viewportWidth + padding
        || Math.max(...ys) < -padding || Math.min(...ys) > viewportHeight + padding;
}

export function installMediaViewportCulling(group, data) {
    for (const method of ['drawScene', 'drawHit']) {
        const draw = group[method];
        group[method] = function (canvas, top, ...rest) {
            const stage = this.getStage();
            const layer = this.getLayer();
            const screenCanvas = method === 'drawScene' ? layer?.getCanvas() : layer?.getHitCanvas();
            // Only cull on-screen rendering. Exports and Konva cache builds need the entire node.
            if (!top && stage && (!canvas || canvas === screenCanvas) && !this.isDragging()
                && isMediaOutsideViewport(this.getAbsoluteTransform().getMatrix(), Number(data.width), Number(data.height), stage.width(), stage.height())) {
                return this;
            }
            return draw.call(this, canvas, top, ...rest);
        };
    }
}
