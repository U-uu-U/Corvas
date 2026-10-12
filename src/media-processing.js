import './media-processing.css';

const icon = name => `<svg class="flow-icon flow-icon-sm" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-${name}"></use></svg>`;
const bytes = value => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(2)} MB` : `${Math.ceil(value / 1024)} KB`;
const seconds = value => Math.round(value * 1000) / 1000;
const fileName = value => String(value || '').split(/[/\\]/).pop();

export class MediaProcessingPanel {
    constructor({ getSelection, getProjectId, applyResult }) {
        this.api = window.flowCanvas?.mediaProcess;
        this.getSelection = getSelection;
        this.getProjectId = getProjectId;
        this.applyResult = applyResult;
        this.info = null;
        this.source = null;
        this.result = null;
        this.busy = false;
        this.loading = 0;
        this.el = document.createElement('section');
        this.el.id = 'mediaProcessingPanel';
        this.el.className = 'media-processing-panel';
        this.el.hidden = true;
        this.el.setAttribute('role', 'dialog');
        this.el.setAttribute('aria-label', '素材处理');
        this.el.setAttribute('aria-modal', 'false');
        this.el.innerHTML = `<header class="media-process-head">
            <strong>${icon('filter')}素材处理</strong>
            <button type="button" data-close title="关闭" aria-label="关闭素材处理">${icon('close')}</button>
          </header>
          <div class="media-process-body">
            <div class="media-process-source-actions">
              <select data-sources aria-label="画布素材" hidden></select>
              <button type="button" data-selection title="使用选中素材" aria-label="使用选中素材">${icon('connections')}</button>
              <button type="button" data-choose>${icon('folder')}选择文件</button>
            </div>
            <div class="media-process-file"><strong data-name>未选择素材</strong><span data-meta></span></div>
            <div class="media-process-preview-tabs" role="tablist" aria-label="预览">
              <button type="button" role="tab" data-preview="source" aria-selected="true">原素材</button>
              <button type="button" role="tab" data-preview="result" aria-selected="false" disabled>处理结果</button>
            </div>
            <div class="media-process-preview" data-preview-host></div>
            <form data-form hidden>
              <label class="media-process-format">输出格式<select name="format" aria-label="输出格式"></select></label>
              <div data-image-options hidden>
                <div class="media-process-pair">
                  <label>宽度<input name="width" type="number" min="1" max="16384" step="1" aria-label="输出宽度"></label>
                  <label>高度<input name="height" type="number" min="1" max="16384" step="1" aria-label="输出高度"></label>
                </div>
                <label class="media-process-check"><input name="keepAspect" type="checkbox" checked>保持比例</label>
                <label data-quality-row class="media-process-slider">质量 <output data-quality-value>90</output>
                  <input name="imageQuality" type="range" min="1" max="100" value="90" aria-label="图片质量"></label>
              </div>
              <div data-time-options hidden>
                <div class="media-process-pair">
                  <label>开始（秒）<span class="media-process-time"><input name="start" type="number" min="0" step="0.001" aria-label="开始时间">
                    <button type="button" data-mark="start" title="用当前播放位置设为开始" aria-label="用当前播放位置设为开始">${icon('arrow-up')}</button></span></label>
                  <label>结束（秒）<span class="media-process-time"><input name="end" type="number" min="0" step="0.001" aria-label="结束时间">
                    <button type="button" data-mark="end" title="用当前播放位置设为结束" aria-label="用当前播放位置设为结束">${icon('arrow-up')}</button></span></label>
                </div>
                <div class="media-process-duration"><span data-duration></span><button type="button" data-full>完整片段</button></div>
              </div>
              <label data-audio-options hidden>音频质量<select name="bitrate" aria-label="音频质量">
                <option value="128">128 kbps</option><option value="192" selected>192 kbps</option><option value="320">320 kbps</option></select></label>
              <div data-video-options hidden>
                <div class="media-process-pair"><label>输出尺寸<select name="maxEdge" aria-label="视频尺寸">
                  <option value="0">原始尺寸</option><option value="1920">1080p</option><option value="1280" selected>720p</option><option value="854">480p</option>
                </select></label><label>画质<select name="videoQuality" aria-label="视频画质">
                  <option value="high">高质量</option><option value="standard" selected>标准</option><option value="small">小文件</option>
                </select></label></div>
                <label class="media-process-check"><input name="keepAudio" type="checkbox" checked>保留原音频</label>
              </div>
              <fieldset class="media-process-placement"><legend>处理后</legend>
                <label><input type="radio" name="placement" value="add" checked>添加副本</label>
                <label><input type="radio" name="placement" value="replace">替换当前素材</label>
              </fieldset>
              <button class="media-process-run" type="submit">${icon('replace')}开始处理</button>
            </form>
            <div class="media-process-progress" data-progress hidden><progress max="100" value="0"></progress>
              <button type="button" data-cancel title="取消处理" aria-label="取消处理">${icon('close')}</button></div>
            <p class="media-process-status" role="status" aria-live="polite"></p>
            <div class="media-process-result-actions" data-result-actions hidden>
              <button type="button" data-add-current hidden>${icon('add')}添加到当前画布</button>
              <button type="button" data-reveal>${icon('folder')}打开文件夹</button>
              <button type="button" data-save>${icon('download')}另存为</button>
            </div>
          </div>`;
        document.body.append(this.el);
        this.form = this.el.querySelector('[data-form]');
        this.fields = this.form.elements;
        this.button = document.getElementById('canvasToolMediaProcess');
        this.button?.addEventListener('click', () => this.open());
        this.el.querySelector('[data-close]').addEventListener('click', () => this.hide());
        this.el.querySelector('[data-selection]').addEventListener('click', () => this.useSelection());
        this.el.querySelector('[data-choose]').addEventListener('click', () => this.choose());
        this.el.querySelector('[data-sources]').addEventListener('change', event => this.selectSource(this.sources[Number(event.target.value)]));
        this.form.addEventListener('submit', event => { event.preventDefault(); void this.convert(); });
        this.form.addEventListener('input', event => this.optionsChanged(event));
        this.form.addEventListener('change', () => this.syncOptions());
        this.el.querySelector('[data-full]').addEventListener('click', () => {
            this.fields.start.value = '0'; this.fields.end.value = this.fields.end.max; this.syncDuration();
        });
        this.el.querySelectorAll('[data-mark]').forEach(button => button.addEventListener('click', () => {
            const media = this.el.querySelector('[data-preview-host] video, [data-preview-host] audio');
            if (this.previewMode !== 'source' || !media) return;
            this.fields[button.dataset.mark].value = String(seconds(media.currentTime)); this.syncDuration();
        }));
        this.el.querySelectorAll('[data-preview]').forEach(button => button.addEventListener('click', () => this.preview(button.dataset.preview)));
        this.el.querySelector('[data-cancel]').addEventListener('click', async () => {
            if (!this.jobId) return;
            this.status('正在取消'); await this.api.cancel(this.jobId);
        });
        this.el.querySelector('[data-reveal]').addEventListener('click', () => window.flowCanvas.shell.showInExplorer(this.result.filePath));
        this.el.querySelector('[data-save]').addEventListener('click', () => window.flowCanvas.file.saveCopy(this.result.filePath));
        this.el.querySelector('[data-add-current]').addEventListener('click', async () => {
            try {
                const result = await this.applyResult(this.result, { projectId: this.getProjectId() }, 'add');
                if (result.applied) { this.el.querySelector('[data-add-current]').hidden = true; this.status('已添加到当前画布'); }
            } catch (error) { this.status(error.message, true); }
        });
        this.el.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') this.hide(); });
        this.el.addEventListener('pointerdown', event => event.stopPropagation());
        this.el.addEventListener('wheel', event => event.stopPropagation());
        this.unsubscribeProgress = this.api?.onProgress(progress => {
            if (progress.jobId !== this.jobId) return;
            this.el.querySelector('progress').value = progress.percent;
            this.status(progress.stage === 'prepare' ? '正在读取素材' : progress.stage === 'complete' ? '正在添加结果' : `正在处理 ${Math.floor(progress.percent)}%`);
        });
        window.addEventListener('pagehide', () => this.unsubscribeProgress?.(), { once: true });
        this.bindDrag();
    }

    status(text, error = false) {
        const host = this.el.querySelector('[role="status"]');
        host.textContent = text || ''; host.classList.toggle('is-error', error);
    }

    async open(sources) {
        this.el.hidden = false;
        if (!this.positioned) {
            const anchor = this.button?.getBoundingClientRect();
            if (anchor) this.el.style.left = `${anchor.right + 12}px`;
            this.positioned = true;
        }
        this.button?.setAttribute('aria-expanded', 'true');
        this.clampPosition();
        if (!this.api) return this.status('素材处理尚未加载，请重启画布', true);
        const selected = sources || this.getSelection();
        const first = selected?.find(source => source.filePath);
        const current = first && first.itemId === this.source?.itemId
            && [this.source?.filePath, this.source?.targetPath].includes(first.filePath);
        if (!this.busy && (sources?.length || !this.info || (first && !current))) await this.useSelection(selected);
    }

    hide() {
        this.el.hidden = true;
        this.button?.setAttribute('aria-expanded', 'false');
        this.el.querySelector('video, audio')?.pause();
    }

    async useSelection(sources = this.getSelection()) {
        if (this.busy) return;
        this.sources = (sources || []).filter(source => source.filePath);
        const select = this.el.querySelector('[data-sources]');
        select.replaceChildren(...this.sources.map((source, index) => new Option(fileName(source.filePath), String(index))));
        select.hidden = this.sources.length < 2;
        if (this.sources.length) await this.selectSource(this.sources[0]);
        else if (!this.info) this.status('未选择素材');
    }

    async choose() {
        if (this.busy || !this.api) return;
        try {
            const selected = await this.api.choose();
            if (selected.filePath) await this.useSelection([{ filePath: selected.filePath }]);
        } catch (error) { this.status(error.message, true); }
    }

    async selectSource(source) {
        if (this.busy || !source) return;
        const revision = ++this.loading;
        this.info = null; this.result = null;
        this.source = { ...source, projectId: source.projectId ?? this.getProjectId() };
        this.form.hidden = true;
        this.el.querySelector('[data-name]').textContent = fileName(source.filePath);
        this.el.querySelector('[data-meta]').textContent = '';
        this.el.querySelector('[data-preview-host]').replaceChildren();
        this.el.querySelector('[data-preview="result"]').disabled = true;
        this.el.querySelector('[data-result-actions]').hidden = true;
        this.status('正在读取素材');
        try {
            const info = await this.api.inspect(source.filePath);
            if (revision !== this.loading) return;
            if (!info.success) throw new Error(info.error);
            this.info = info;
            this.form.hidden = false;
            this.el.querySelector('[data-meta]').textContent = this.describe(info);
            const formats = { image: [['png', 'PNG'], ['jpg', 'JPG'], ['webp', 'WebP']], audio: [['mp3', 'MP3'], ['wav', 'WAV (PCM)']], video: [['mp4', 'MP4 (H.264)']] }[info.kind];
            this.fields.format.replaceChildren(...formats.map(([value, label]) => new Option(label, value)));
            this.fields.width.value = String(info.width || 1); this.fields.height.value = String(info.height || 1);
            this.fields.keepAspect.checked = true;
            this.fields.start.max = this.fields.end.max = String(Math.ceil((info.duration || 0)*1000)/1000);
            this.fields.start.value = '0'; this.fields.end.value = this.fields.end.max;
            this.fields.keepAudio.checked = info.hasAudio;
            this.fields.keepAudio.disabled = !info.hasAudio;
            this.fields.placement.value = 'add';
            this.form.querySelector('[value="replace"]').disabled = !source.itemId;
            this.syncOptions(); this.preview('source'); this.status(''); this.clampPosition();
        } catch (error) { if (revision === this.loading) this.status(error.message, true); }
    }

    describe(info) {
        return [String(info.format || '').toUpperCase(), info.width ? `${info.width} × ${info.height}` : '',
            info.duration ? `${seconds(info.duration)} 秒` : '', bytes(info.bytes)].filter(Boolean).join(' · ');
    }

    syncOptions() {
        if (!this.info) return;
        const kind = this.info.kind;
        this.el.querySelector('[data-image-options]').hidden = kind !== 'image';
        this.el.querySelector('[data-time-options]').hidden = kind === 'image';
        this.el.querySelector('[data-audio-options]').hidden = kind !== 'audio' || this.fields.format.value !== 'mp3';
        this.el.querySelector('[data-video-options]').hidden = kind !== 'video';
        this.el.querySelector('[data-quality-row]').hidden = this.fields.format.value === 'png';
        this.el.querySelector('[data-quality-value]').value = this.fields.imageQuality.value;
        this.syncDuration();
    }

    optionsChanged(event) {
        if (!this.info) return;
        if (this.info.kind === 'image' && this.fields.keepAspect.checked) {
            if (event.target.name === 'width') this.fields.height.value = String(Math.max(1, Math.round(Number(this.fields.width.value) * this.info.height / this.info.width)));
            if (event.target.name === 'height') this.fields.width.value = String(Math.max(1, Math.round(Number(this.fields.height.value) * this.info.width / this.info.height)));
        }
        this.syncOptions();
    }

    syncDuration() {
        if (!this.info || this.info.kind === 'image') return;
        const duration = Number(this.fields.end.value) - Number(this.fields.start.value);
        this.el.querySelector('[data-duration]').textContent = duration > 0 ? `片段 ${seconds(duration)} 秒` : '片段范围无效';
    }

    preview(mode) {
        const info = mode === 'result' ? this.result : this.info;
        if (!info) return;
        const host = this.el.querySelector('[data-preview-host]');
        host.querySelector('video, audio')?.pause();
        const element = document.createElement(info.kind === 'image' ? 'img' : info.kind);
        element.src = `local-res://${encodeURIComponent(info.filePath)}`;
        if (info.kind === 'image') element.alt = info.name;
        else { element.controls = true; element.preload = 'metadata'; }
        host.replaceChildren(element);
        this.previewMode = mode;
        this.el.querySelectorAll('[data-preview]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.preview === mode)));
        this.el.querySelectorAll('[data-mark]').forEach(button => { button.disabled = mode !== 'source' || this.busy; });
    }

    setBusy(busy) {
        this.busy = busy;
        this.button?.classList.toggle('is-processing', busy);
        this.el.querySelector('[data-progress]').hidden = !busy;
        this.el.querySelectorAll('form input, form select, form button, [data-selection], [data-choose], [data-sources]').forEach(element => { element.disabled = busy; });
        if (!busy && this.info) {
            this.fields.keepAudio.disabled = !this.info.hasAudio;
            this.form.querySelector('[value="replace"]').disabled = !this.source.itemId;
            this.el.querySelectorAll('[data-mark]').forEach(button => { button.disabled = this.previewMode !== 'source'; });
        }
    }

    async convert() {
        if (this.busy || !this.info || !this.form.reportValidity()) return;
        const info = this.info;
        const source = { ...this.source };
        const mode = this.fields.placement.value;
        const options = { format: this.fields.format.value };
        if (info.kind === 'image') Object.assign(options, { width: Number(this.fields.width.value), height: Number(this.fields.height.value),
            quality: Number(this.fields.imageQuality.value), keepAspect: this.fields.keepAspect.checked });
        else Object.assign(options, { start: Number(this.fields.start.value), end: Math.min(info.duration, Number(this.fields.end.value)),
            bitrate: Number(this.fields.bitrate.value), maxEdge: Number(this.fields.maxEdge.value),
            quality: this.fields.videoQuality.value, keepAudio: this.fields.keepAudio.checked });
        this.jobId = crypto.randomUUID();
        this.setBusy(true); this.status('正在处理');
        this.el.querySelector('progress').value = 0;
        try {
            const result = await this.api.convert({ jobId: this.jobId, filePath: info.filePath, options });
            if (!result.success) {
                if (result.canceled) { this.status('已取消'); return; }
                throw new Error(result.error);
            }
            this.result = result;
            this.el.querySelector('[data-preview="result"]').disabled = false;
            this.preview('result');
            this.el.querySelector('[data-result-actions]').hidden = false;
            this.el.querySelector('[data-add-current]').hidden = false;
            const applied = await this.applyResult(result, source, mode);
            if (applied.applied && mode === 'replace') this.source.targetPath = result.filePath;
            this.el.querySelector('[data-add-current]').hidden = applied.applied;
            this.status(`${applied.applied ? mode === 'replace' ? '已替换当前素材' : '已添加副本' : applied.reason || '处理完成'} · ${this.describe(result)}`);
        } catch (error) { this.status(error.message || '处理失败', true); }
        finally { this.jobId = null; this.setBusy(false); this.clampPosition(); }
    }

    clampPosition() {
        if (this.el.hidden) return;
        const rect = this.el.getBoundingClientRect();
        this.el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8))}px`;
        this.el.style.top = `${Math.max(44, Math.min(rect.top, window.innerHeight - rect.height - 8))}px`;
    }

    bindDrag() {
        const header = this.el.querySelector('header');
        header.addEventListener('pointerdown', event => {
            if (event.button !== 0 || event.target.closest('button')) return;
            const box = this.el.getBoundingClientRect();
            const offset = { x: event.clientX-box.left, y: event.clientY-box.top };
            header.setPointerCapture(event.pointerId);
            const move = current => {
                this.el.style.left = `${current.clientX-offset.x}px`; this.el.style.top = `${current.clientY-offset.y}px`;
                this.clampPosition();
            };
            const stop = () => { header.removeEventListener('pointermove', move); header.removeEventListener('pointerup', stop); header.removeEventListener('pointercancel', stop); };
            header.addEventListener('pointermove', move); header.addEventListener('pointerup', stop); header.addEventListener('pointercancel', stop);
        });
        window.addEventListener('resize', () => this.clampPosition());
    }
}
