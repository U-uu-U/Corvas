import Konva from 'konva';
import { getThemeColor } from './theme.js';
import { VIDEO_CONTROL_HEIGHT } from './video-control-layout.js';

const time = seconds => Number.isFinite(seconds) && seconds >= 0
    ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '--:--';

export function createAudioPlayer(manager, item) {
    const root = new Konva.Group({ name: 'audioControls' });
    const background = new Konva.Rect({ name: 'videoControlBg', listening: false,
        fill: getThemeColor('canvas-node-bg', '#202123'), cornerRadius: [0, 0, 8, 8] });
    const track = new Konva.Rect({ name: 'videoProgressBg', width: 1,
        fill: getThemeColor('canvas-node-muted', '#6f7580'), listening: false });
    const progress = new Konva.Rect({ name: 'videoProgressFg', width: 0,
        fill: getThemeColor('canvas-node-text', '#d0d3d9'), listening: false });
    const play = manager._createVideoPlayPauseGlyph(false);
    const volume = manager._createVideoVolumeGlyph(item.audioMuted === true);
    const elapsed = new Konva.Text({ name: 'audioTime', text: '0:00 / --:--', fontSize: 8, height: 14,
        align: 'right', listening: false, fill: getThemeColor('canvas-node-muted', '#8e949f') });
    const playHit = new Konva.Rect({ name: 'videoControlHotspot videoPlayPauseHotspot', fill: 'transparent' });
    const volumeHit = new Konva.Rect({ name: 'videoControlHotspot videoVolumeHotspot', fill: 'transparent' });
    const seekHit = new Konva.Rect({ name: 'videoProgressHotspot', fill: 'transparent' });
    root.add(background, track, progress, play, volume, playHit, volumeHit, seekHit, elapsed);
    item.group.add(root);
    let audio = null;
    let disposed = false;
    let stopSeeking = null;
    const draw = () => root.getLayer()?.batchDraw();
    const refresh = () => {
        if (disposed || !audio) return;
        manager._setVideoPlayPauseGlyph(play, !audio.paused && !audio.ended);
        manager._setVideoVolumeGlyph(volume, audio.muted);
        elapsed.text(`${time(audio.currentTime)} / ${time(audio.duration)}`);
        progress.width(Number.isFinite(audio.duration) && audio.duration > 0
            ? Math.min(1, audio.currentTime / audio.duration) * track.width() : 0);
        draw();
    };
    const fail = () => {
        if (!disposed) manager._showCanvasStatus(`音频无法播放，请检查文件或编码：${manager._fileNameFromPath(item.data.filePath)}`, 0, 'error');
    };
    const ensureAudio = () => {
        if (audio) return audio;
        const product = manager._getMediaProduct(item.data);
        if (!product?.filePath && !product?.url) return null;
        audio = document.createElement('audio');
        audio.dataset.canvasAudioId = item.data.id;
        audio.preload = 'metadata';
        audio.hidden = true;
        audio.muted = item.audioMuted === true;
        for (const event of ['play', 'pause', 'ended', 'timeupdate', 'loadedmetadata', 'volumechange']) audio.addEventListener(event, refresh);
        audio.addEventListener('error', fail);
        audio.src = product.filePath ? `local-res://${encodeURIComponent(product.filePath)}` : product.url;
        document.body.append(audio);
        return audio;
    };
    const toggle = () => {
        if (disposed) return;
        const media = ensureAudio();
        if (!media) return;
        if (!media.paused) { media.pause(); return; }
        if (media.ended) media.currentTime = 0;
        void media.play().catch(error => {
            if (!disposed && error.name !== 'AbortError') fail();
        });
    };
    const intercept = event => {
        if (event.evt?.button != null && event.evt.button !== 0) return false;
        if (manager._pickMediaReferenceFromControl(item, event)) return false;
        event.cancelBubble = true;
        event.evt?.stopPropagation();
        event.evt?.preventDefault();
        if (manager._activePlanReferencePick) { manager._finishPlanReferencePick(item); return false; }
        return true;
    };
    root.on('click tap dblclick dbltap', event => { event.cancelBubble = true; });
    playHit.on('mousedown touchstart', event => { if (intercept(event)) toggle(); });
    volumeHit.on('mousedown touchstart', event => {
        if (!intercept(event)) return;
        item.audioMuted = !item.audioMuted;
        if (audio) audio.muted = item.audioMuted;
        manager._setVideoVolumeGlyph(volume, item.audioMuted);
        draw();
    });
    seekHit.on('mousedown touchstart', event => {
        if (!intercept(event)) return;
        const media = ensureAudio();
        if (!media) return;
        stopSeeking?.();
        const seek = pointerEvent => {
            manager.stage.setPointersPositions(pointerEvent);
            const pointer = seekHit.getRelativePointerPosition();
            if (pointer && Number.isFinite(media.duration) && media.duration > 0) {
                media.currentTime = Math.max(0, Math.min(1, pointer.x / Math.max(1, seekHit.width()))) * media.duration;
                refresh();
            }
        };
        const move = pointerEvent => { pointerEvent.preventDefault(); seek(pointerEvent); };
        stopSeeking = () => {
            for (const name of ['mousemove', 'touchmove']) document.removeEventListener(name, move);
            for (const name of ['mouseup', 'touchend', 'touchcancel']) document.removeEventListener(name, stopSeeking);
            window.removeEventListener('blur', stopSeeking);
            stopSeeking = null;
        };
        for (const name of ['mousemove', 'touchmove']) document.addEventListener(name, move, { passive: false });
        for (const name of ['mouseup', 'touchend', 'touchcancel']) document.addEventListener(name, stopSeeking);
        window.addEventListener('blur', stopSeeking);
        seek(event.evt);
    });
    return {
        root, toggle,
        layout(width, height) {
            const scale = Math.max(manager.stage?.scaleX?.() || 1, VIDEO_CONTROL_HEIGHT / Math.max(VIDEO_CONTROL_HEIGHT, height - 48));
            manager._layoutVideoControlGroup(root, width, height, scale);
            // Cover the decorative waveform at low zoom, where controls grow to
            // stay clickable. The filename area remains available for dragging.
            background.y(0);
            background.height(playHit.height());
            elapsed.setAttrs({ x: Math.max(80, width - 106), y: 29 - root.y(), width: Math.max(1, Math.min(92, width - 94)) });
            root.moveToTop();
            refresh();
        },
        dispose() {
            disposed = true;
            stopSeeking?.();
            if (audio) {
                audio.removeEventListener('error', fail);
                audio.pause();
                audio.removeAttribute('src');
                audio.load();
                audio.remove();
            }
            root.destroy();
        }
    };
}
