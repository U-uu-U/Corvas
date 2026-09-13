import { DISPLAY_FIELDS } from './admin-editor-model.mjs';

export const EDITOR_STYLE = `
[hidden] { display: none !important; }
main { max-width: 1440px; margin: 0 auto; }
header .badge { white-space: normal; overflow-wrap: anywhere; }
input, select, textarea, button { letter-spacing: 0; }
input[type=number], input[type=search], select { background: #0b0d12; color: inherit; border: 1px solid #2b3140; border-radius: 6px; padding: 8px 10px; font: inherit; }
button:disabled { cursor: default; opacity: .5; }
:focus-visible { outline: 2px solid #81b3d8; outline-offset: 2px; }
.editor-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; flex-wrap: wrap; }
.editor-tabs { display: flex; gap: 4px; }
.editor-tabs button { background: none; border-color: transparent; border-radius: 4px; }
.editor-tabs [aria-selected=true] { background: #25313a; color: #c6e2ea; border-color: #40545b; }
.editor-grid { display: grid; grid-template-columns: 270px minmax(0, 1fr); border-top: 1px solid #2b3140; border-bottom: 1px solid #2b3140; }
.model-browser { padding: 18px 16px 18px 0; border-right: 1px solid #2b3140; min-width: 0; }
.model-filter { display: grid; grid-template-columns: minmax(0, 1fr) 88px; gap: 8px; align-items: center; }
.model-filter input { grid-column: 1 / -1; width: 100%; min-width: 0; }
.model-list { max-height: 740px; overflow: auto; margin-top: 12px; scrollbar-width: thin; scrollbar-color: #48515d transparent; }
.model-entry { display: block; width: 100%; text-align: left; border: 0; border-left: 2px solid transparent; border-radius: 0; background: none; padding: 11px 12px; }
.model-entry strong, .model-entry small { display: block; white-space: normal; overflow-wrap: anywhere; }
.model-entry strong { font-size: 13px; font-weight: 600; }
.model-entry small { color: #939caa; font-size: 11px; margin-top: 4px; }
.model-entry:hover { background: #1b232a; }
.model-entry[aria-selected=true] { background: #202d33; border-left-color: #94bdbe; }
.model-details { padding: 18px 0 20px 24px; min-width: 0; }
.model-heading { display: flex; gap: 12px; justify-content: space-between; align-items: start; margin-bottom: 20px; }
.model-heading output { overflow-wrap: anywhere; min-width: 0; color: #aeb8c6; font-size: 12px; }
.model-heading button { flex-shrink: 0; font-size: 12px; }
#modelFields { border: 0; padding: 0; margin: 0; min-width: 0; }
.field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 18px; }
.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; color: #bfc6d1; font-size: 12px; }
.field.full { grid-column: 1 / -1; }
.field input, .field select, .field textarea { width: 100%; min-width: 0; border-radius: 6px; font: 13px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif; }
.field textarea { min-height: 82px; resize: vertical; }
.field-label { color: #aeb7c6; }
.form-section { border: 0; border-top: 1px solid #29303b; padding: 18px 0 0; margin: 20px 0 0; }
.form-section h3 { font-size: 13px; font-weight: 600; color: #d3d9e1; margin: 0 0 14px; }
.price-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; font-size: 11px; color: #939caa; }
.publish-bar { padding: 16px 0; display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
.publish-bar input[type=text] { flex: 1 1 220px; min-width: 0; }
#editorState { font-size: 12px; color: #a2c9b1; }
#editorState[data-error=true] { color: #e7a1a1; }
.table-scroll { width: 100%; overflow: auto; scrollbar-width: thin; scrollbar-color: #48515d transparent; }
table td:last-child { min-width: 190px; }
pre.errors { white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 760px) {
    header { padding: 14px 16px; }
    main { padding: 16px; }
    .editor-grid { grid-template-columns: minmax(0, 1fr); }
    .model-browser { border-right: 0; border-bottom: 1px solid #2b3140; padding: 14px 0; }
    .model-list { max-height: 190px; }
    .model-details { padding: 18px 0; }
    .model-heading { flex-wrap: wrap; }
    .field-grid { grid-template-columns: minmax(0, 1fr); }
    .publish-bar { align-items: stretch; }
    .publish-bar label { width: 100%; }
    .login { padding: 16px; }
}
`;

export function modelEditorMarkup() {
    const field = ({ key, label, max, multiline }) => `<label class="field${multiline ? ' full' : ''}">
        <span>${label}</span>${multiline
        ? `<textarea data-field="${key}" maxlength="${max}" rows="3" spellcheck="false" placeholder="未设置"></textarea>`
        : `<input type="text" data-field="${key}" maxlength="${max}" autocomplete="off" placeholder="${key === 'label' ? '沿用默认' : '未设置'}">`}</label>`;
    return `
      <div class="editor-toolbar">
        <div class="editor-tabs" id="editorTabs" role="tablist" aria-label="编辑方式" hidden>
          <button type="button" id="formTab" role="tab" aria-controls="formPane" data-editor-mode="form">表单</button>
          <button type="button" id="jsonTab" role="tab" aria-controls="jsonPane" data-editor-mode="json">JSON</button>
        </div>
        <span id="editorState" role="status" aria-live="polite"></span>
      </div>
      <pre class="errors" id="editorErrors" role="alert" hidden></pre>
      <div id="formPane" role="tabpanel" aria-labelledby="formTab" hidden>
        <div class="editor-grid">
          <aside class="model-browser">
            <div class="model-filter">
              <input type="search" id="modelSearch" placeholder="搜索模型或线路" aria-label="搜索模型或线路">
              <select id="modelKind" aria-label="模型类型"><option value="">全部类型</option><option value="image">图片</option><option value="video">视频</option><option value="text">文字</option></select>
              <span class="muted" id="modelCount"></span>
            </div>
            <div class="model-list" id="modelList" role="listbox" aria-label="模型列表"></div>
          </aside>
          <div class="model-details">
            <div class="model-heading"><output id="selectedModelId" class="mono"></output><button type="button" id="restoreModelBtn">还原此模型</button></div>
            <fieldset id="modelFields" disabled>
              <div class="field-grid">${DISPLAY_FIELDS.slice(0, 2).map(field).join('')}</div>
              <div class="form-section">
                <h3>线路展示</h3>
                <div class="field-grid">
                  ${DISPLAY_FIELDS.slice(2).map(field).join('')}
                  <label class="field"><span>推荐状态</span><select data-field="recommended"><option value="inherit">沿用默认</option><option value="true">推荐</option><option value="false">不推荐</option></select></label>
                </div>
              </div>
              <div class="form-section">
                <h3>展示售价</h3>
                <div class="field-grid">
                  <label class="field"><span>售价状态</span><select data-field="priceMode"><option value="inherit">沿用客户端默认价</option><option value="unknown">费用未知</option><option value="known">指定售价</option></select></label>
                </div>
                <div id="priceScope" class="field-grid" style="margin-top:16px" hidden>
                  <label class="field full"><span>适用 API 域名</span><textarea data-field="hosts" rows="2" placeholder="art.ravenhash.org" spellcheck="false"></textarea></label>
                </div>
                <div id="knownPriceFields" class="field-grid" style="margin-top:16px" hidden>
                  <label class="field"><span>售价金额</span><input type="number" data-field="amount" min="0" max="1000000" step="any" inputmode="decimal"></label>
                  <label class="field"><span>币种</span><select data-field="currency"><option value="CNY">人民币 CNY</option><option value="USD">美元 USD</option></select></label>
                  <label class="field"><span>计价单位</span><select data-field="unit"><option value="request">每次请求</option><option value="image">每张图片</option><option value="second">每秒视频</option></select></label>
                  <label class="field"><span>价格来源</span><input type="text" data-field="source" maxlength="200"></label>
                </div>
                <div class="price-meta"><span>价格更新时间</span><output id="priceUpdatedAt"></output></div>
              </div>
            </fieldset>
          </div>
        </div>
      </div>`;
}
