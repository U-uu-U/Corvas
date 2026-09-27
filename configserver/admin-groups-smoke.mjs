import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createConfigServer } from './server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-config-groups-'));
let server;
let browser;
try {
    const model = (id, label, group, position, enabled = true) => ({ id, kind: 'video',
        match: { model: [`^${id}$`] }, catalog: { model: id, hosts: ['art.example.com'], enabled },
        presentation: { label, ...(group ? { routeGroup: group, routeGroupLabel: group === 'recommended' ? '推荐渠道' : '备用渠道',
            routeGroupOrder: group === 'recommended' ? 10 : 20, routeOrder: position } : {}) },
        options: { duration: { type: 'range', min: 4, max: 30, default: 10 } },
        capabilities: { referenceImages: { supported: true, max: 9 } } });
    const seed = { schemaVersion: 1, catalogMode: 'remote', models: [
        model('standalone', '独立模型', '', 0), model('alpha', '推荐模型 A', 'recommended', 0),
        model('bravo', '推荐模型 B', 'recommended', 1, false), model('charlie', '备用模型', 'backup', 0)
    ] };
    const seedPath = path.join(dataDir, 'seed.json');
    await fs.writeFile(seedPath, JSON.stringify(seed));
    server = await createConfigServer({ dataDir, seedPath, port: 0, adminPassword: 'groups-local',
        logger: { log() {}, warn() {}, error() {} } });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(`${server.url}/admin`);
    await page.getByPlaceholder('管理密码').fill('groups-local');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const snapshot = async () => JSON.parse(await page.locator('#configText').inputValue());
    const groups = page.locator('#catalogGroups [data-catalog-group]');
    const group = key => page.locator(`#catalogGroups [data-catalog-group="${key}"]`);
    const card = id => page.locator(`#catalogPane [data-catalog-model-id="${id}"]`);
    const action = (id, type) => page.locator(`#catalogPane [data-action-model-id="${id}"][data-model-action="${type}"]`);
    assert.equal(await groups.count(), 2);
    assert.equal(await page.locator('#catalogUngrouped [data-catalog-model-id]').count(), 1);
    assert.equal(await page.locator('.model-details').isVisible(), false);
    const groupColumn = page.locator('#catalogGroups').locator('..');
    const columnBounds = await groupColumn.boundingBox();
    await card('standalone').dragTo(groupColumn, { targetPosition: { x: 35, y: columnBounds.height - 15 } });
    assert.equal((await snapshot()).models[0].presentation.routeGroupLabel, '独立模型');
    assert.equal(await groups.count(), 3);
    await page.locator('#undoCatalogBtn').click();
    assert.equal(await groups.count(), 2);
    await action('standalone', 'group').click();
    const singleGroup = await snapshot();
    assert.equal(singleGroup.models[0].presentation.routeGroupAlways, true);
    await action('standalone', 'group').click();
    assert.deepEqual(await snapshot(), singleGroup);
    await page.locator('#undoCatalogBtn').click();
    assert.equal(await page.locator('#catalogUngrouped [data-catalog-model-id="standalone"]').count(), 1);
    const createGroup = async label => {
        await page.locator('#createGroupBtn').click();
        await page.locator('#catalogDialogLabel').fill(label);
        await page.locator('#catalogDialogConfirm').click();
        await page.locator('#catalogDialog').waitFor({ state: 'hidden' });
        const record = (await snapshot()).catalogGroups.find(item => item.label === label);
        return `${record.kind}:${record.id}`;
    };
    const emptyKey = await createGroup('新建测试分组');
    assert.ok((await group(emptyKey).innerText()).includes('空分组'));
    await group('video:recommended').scrollIntoViewIfNeeded();
    await group('video:recommended').evaluate((element, key) => {
        const dataTransfer = new globalThis.DataTransfer();
        dataTransfer.setData('application/x-flow-catalog-group', key);
        element.dispatchEvent(new globalThis.DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer,
            clientY: element.getBoundingClientRect().top + 10 }));
    }, emptyKey);
    await page.locator('#catalogGroups [data-catalog-group="video:recommended"][data-drop-position="before"]').waitFor();
    await fs.mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/config-groups-drag-before.png' });
    await group('video:recommended').dispatchEvent('dragleave');
    await group(emptyKey).dragTo(group('video:recommended'), { targetPosition: { x: 35, y: 10 } });
    assert.equal(await groups.first().getAttribute('data-catalog-group'), emptyKey);
    const backupBounds = await group('video:backup').boundingBox();
    await group(emptyKey).dragTo(group('video:backup'), { targetPosition: { x: 35, y: backupBounds.height - 10 } });
    assert.equal(await groups.last().getAttribute('data-catalog-group'), emptyKey);
    await card('standalone').dragTo(group(emptyKey));
    assert.equal((await snapshot()).models[0].presentation.routeGroup, emptyKey.split(':')[1]);
    await action('standalone', 'move').click();
    assert.equal(await page.locator('#catalogUngrouped [data-catalog-model-id="standalone"]').count(), 1);
    await action('standalone', 'move').click();
    assert.equal(await page.locator('#catalogModels [data-catalog-model-id="standalone"]').count(), 1);
    await page.locator('#catalogMoveGroup').selectOption('video:recommended');
    await card('standalone').dragTo(card('alpha'), { targetPosition: { x: 30, y: 55 } });
    const ordered = () => page.locator('#catalogModels [data-catalog-model-id]').evaluateAll(items => items.map(item => item.dataset.catalogModelId));
    assert.deepEqual(await ordered(), ['standalone', 'alpha', 'bravo']);
    await page.locator('#catalogModels').evaluate(list => { list.scrollTop = list.scrollHeight; });
    const lastBounds = await card('bravo').boundingBox();
    await card('standalone').dragTo(card('bravo'), { sourcePosition: { x: 40, y: 60 }, targetPosition: { x: 30, y: lastBounds.height - 15 } });
    assert.deepEqual(await ordered(), ['alpha', 'bravo', 'standalone']);
    await card('standalone').dragTo(card('alpha'), { sourcePosition: { x: 40, y: 60 }, targetPosition: { x: 30, y: 55 } });
    assert.deepEqual(await ordered(), ['standalone', 'alpha', 'bravo']);
    await card('standalone').click();
    await page.locator('#moveModelDownBtn').click();
    assert.deepEqual(await ordered(), ['alpha', 'standalone', 'bravo']);
    await page.locator('#catalogModels').evaluate(list => { list.scrollTop = list.scrollHeight; });
    await group('video:backup').scrollIntoViewIfNeeded();
    await card('bravo').dragTo(group('video:backup'), { sourcePosition: { x: 40, y: 60 } });
    assert.equal((await snapshot()).models.find(item => item.id === 'bravo').presentation.routeGroup, 'backup');
    assert.equal((await snapshot()).models.find(item => item.id === 'bravo').catalog.enabled, false);
    await group('video:recommended').click();
    await page.locator('#deleteGroupBtn').click();
    await page.locator('#catalogDialogConfirm').click();
    assert.equal(await group('video:recommended').count(), 0);
    assert.equal(await page.locator('#catalogUngrouped [data-catalog-model-id]').count(), 2);
    assert.ok((await snapshot()).models.filter(item => ['standalone', 'alpha'].includes(item.id))
        .every(item => item.presentation.visible === false));
    await page.locator('#undoCatalogBtn').click();
    assert.equal(await group('video:recommended').count(), 1);
    await page.locator('#redoCatalogBtn').click();
    assert.equal(await group('video:recommended').count(), 0);
    await group(emptyKey).click();
    await page.locator('#renameGroupBtn').click();
    await page.locator('#catalogDialogLabel').fill('待加入模型');
    await page.locator('#catalogDialogConfirm').click();
    await page.locator('#moveGroupUpBtn').click();
    assert.equal(await groups.first().getAttribute('data-catalog-group'), emptyKey);
    await action('alpha', 'edit').click();
    assert.equal(await page.locator('#formTab').getAttribute('aria-selected'), 'true');
    await page.locator('[data-field="description"]').fill('参数保留验证');
    await page.locator('#operationTab').click();
    await group('video:backup').click();
    await page.locator('[data-call-model-id="charlie"]').click();
    assert.equal((await snapshot()).models.find(item => item.id === 'charlie').catalog.enabled, false);
    await action('alpha', 'group').click();
    await page.locator('#catalogDefaultVideoModel').selectOption('alpha');
    assert.equal((await snapshot()).defaultModels.video, 'alpha');
    await page.locator('#validateBtn').click();
    await page.waitForFunction(() => globalThis.document.getElementById('editorState').textContent.includes('校验通过'));
    await page.locator('#saveBtn').click();
    await page.waitForURL('**/admin?flash=*');
    await group(emptyKey).waitFor();
    const published = await fetch(`${server.url}/config`).then(response => response.json());
    assert.equal(published.models.length, seed.models.length);
    assert.equal(published.defaultModels.video, 'alpha');
    assert.equal(await page.locator('#catalogDefaultVideoModel').inputValue(), 'alpha');
    assert.equal(published.models.find(item => item.id === 'alpha').presentation.routeGroupLabel, '推荐模型 A');
    assert.equal(published.models.find(item => item.id === 'alpha').presentation.routeGroupAlways, true);
    assert.equal(published.models.find(item => item.id === 'alpha').presentation.visible, true);
    assert.equal(published.models.find(item => item.id === 'standalone').presentation.visible, false);
    assert.equal(await fetch(`${server.url}/config/preview`).then(response => response.text()), await fetch(`${server.url}/config`).then(response => response.text()));
    assert.equal(published.catalogGroups.find(item => `${item.kind}:${item.id}` === emptyKey).label, '待加入模型');
    for (const entry of seed.models) {
        const updated = published.models.find(item => item.id === entry.id);
        assert.deepEqual(updated.options, entry.options);
        assert.deepEqual(updated.capabilities, entry.capabilities);
        assert.equal(updated.catalog.model, entry.catalog.model);
    }
    await group('video:backup').click();
    await fs.mkdir('output/playwright', { recursive: true });
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1050 }], ['mobile', { width: 390, height: 844 }]]) {
        await page.setViewportSize(viewport);
        await page.locator('#catalogPane').scrollIntoViewIfNeeded();
        assert.ok(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
        assert.ok(await page.locator('#catalogPane .catalog-item').evaluateAll(items => items.every(item => {
            const control = item.querySelector('.catalog-call-control');
            return !control || control.getBoundingClientRect().bottom <= item.querySelector('strong').getBoundingClientRect().top;
        })));
        await page.screenshot({ path: `output/playwright/config-groups-${name}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1050 });
    await group(emptyKey).click();
    await page.locator('#deleteGroupBtn').click();
    await page.locator('#catalogDialogConfirm').click();
    assert.equal(await group(emptyKey).count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS group workspace: single-model promotion by drag/button, empty groups, drag ordering and cross-group moves, unassign/add controls, delete/undo/redo, form editing, call state, publish/reload, desktop/mobile.');
} finally {
    await browser?.close();
    await server?.close();
    await fs.rm(dataDir, { recursive: true, force: true });
}
