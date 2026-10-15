import relaySites from '../shared/relay-sites.cjs';

export function createRelayKeyPicker() {
    let queue = Promise.resolve();
    function open(catalog) {
        return new Promise(resolve => {
            const dialog = document.createElement('dialog');
            dialog.className = 'relay-key-picker';
            dialog.id = 'relayKeyPicker';
            dialog.setAttribute('aria-labelledby', 'relayKeyPickerTitle');
            dialog.innerHTML = `<header><div><h2 id="relayKeyPickerTitle">选择 API Key</h2><p data-account></p></div>
                <button type="button" data-close title="关闭" aria-label="关闭 API Key 列表"><svg class="flow-icon" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-close"></use></svg></button></header>
                <div class="relay-key-toolbar"><label><input type="checkbox" data-all>全选可用项</label><span data-count></span></div>
                <div class="relay-key-list"></div><p data-empty hidden>这个账户暂无 API Key</p>
                <footer><button type="button" data-cancel>取消</button><button type="button" data-confirm disabled>导入所选</button></footer>`;
            dialog.querySelector('[data-account]').textContent = `${relaySites.SITES[catalog.site]?.name || ''} · ${catalog.username || catalog.userId}`;
            const list = dialog.querySelector('.relay-key-list');
            const tokens = Array.isArray(catalog.tokens) ? catalog.tokens : [];
            for (const token of tokens) {
                const row = document.createElement('label'); row.className = 'relay-key-row';
                const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = token.id;
                checkbox.disabled = token.enabled !== true; checkbox.checked = token.enabled === true && token.imported === true;
                checkbox.setAttribute('aria-label', token.name || `Key ${token.id}`);
                const copy = document.createElement('span'); copy.className = 'relay-key-copy';
                const name = document.createElement('strong'); name.textContent = token.name;
                const masked = document.createElement('code'); masked.textContent = token.maskedKey || `Key ${token.id}`;
                const state = document.createElement('small'); state.textContent = token.reason || (token.imported ? '已添加' : '可用');
                row.dataset.disabled = String(checkbox.disabled);
                copy.append(name, masked);
                if (token.group) {
                    const group = document.createElement('small');
                    group.textContent = `分组：${token.group}`;
                    copy.append(group);
                }
                row.append(checkbox, copy, state); list.append(row);
            }
            dialog.querySelector('[data-empty]').hidden = tokens.length > 0;
            const all = dialog.querySelector('[data-all]');
            const confirm = dialog.querySelector('[data-confirm]');
            const available = [...list.querySelectorAll('input:not(:disabled)')];
            const refresh = () => {
                const selected = available.filter(input => input.checked).length;
                all.checked = available.length > 0 && selected === available.length;
                all.indeterminate = selected > 0 && selected < available.length;
                all.disabled = !available.length;
                confirm.disabled = selected === 0 || selected > 100;
                dialog.querySelector('[data-count]').textContent = `已选 ${selected} / ${tokens.length}`;
            };
            const finish = value => { dialog.close(); dialog.remove(); resolve(value); };
            all.addEventListener('change', () => { available.forEach(input => { input.checked = all.checked; }); refresh(); });
            list.addEventListener('change', refresh);
            confirm.addEventListener('click', () => finish(available.filter(input => input.checked).map(input => input.value)));
            for (const button of dialog.querySelectorAll('[data-close], [data-cancel]')) button.addEventListener('click', () => finish(null));
            dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
            refresh(); document.body.append(dialog); dialog.showModal();
        });
    }
    return { select(catalog) {
        const work = queue.catch(() => {}).then(() => open(catalog));
        queue = work; return work;
    } };
}
