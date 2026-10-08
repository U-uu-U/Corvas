const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SITES, relaySite, publicTask, findLocalTask } = require('./relay-browser-contract.cjs');
const { createRelayImporter } = require('./relay-browser-import.cjs');
const { GenerationRecoveryStore } = require('./generation-recovery-store.cjs');
const { RelayBrowser } = require('./relay-browser.cjs');

test('site detection uses exact origins; duplicate task numbers stay on their own site', () => {
    assert.equal(relaySite('https://art.ravenhash.org/v1/videos'), 'art');
    assert.equal(relaySite('https://art.ravenhash.org.attacker.test/v1'), null);
    assert.equal(relaySite('https://cart.ravenhash.org:8443'), null);
    const records = ['art', 'cart'].map(site => ({ clientTaskId: site, kind: 'video', taskId: 'task_1', endpoint: SITES[site].origin }));
    assert.equal(findLocalTask(records, 'cart', 'task_1').clientTaskId, 'cart');
    assert.equal(findLocalTask(records, 'art', 'task_1', 'cart'), null);
    assert.equal(findLocalTask([...records, { ...records[0], clientTaskId: 'duplicate' }], 'art', 'task_1'), null);
});

test('task summaries exclude upstream addresses, raw errors, credentials and prices', () => {
    const input = { log_id: 'log1', task_id: 'task1', model: 'video', is_completed: 1,
        preview_urls: ['https://private-upstream/video?token=private'], cost: 0.5, channel_name: 'private', token_key: 'secret' };
    const result = publicTask(input);
    assert.equal(result.count, 1);
    assert.equal(result.status, 'completed');
    assert.doesNotMatch(JSON.stringify(result), /private|secret|cost|channel|preview_urls/);
    assert.equal(publicTask({ ...input, is_completed: 0 }).count, 0);
    assert.equal(publicTask({ ...input, error_message: 'upstream failure' }).count, 0);
});

async function setup(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-import-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const { AgentBoardService } = await import('./agent-board-service.mjs');
    const { installGenerationRecoveryBoard } = await import('./generation-recovery-board.mjs');
    const original = { id: 'video-node', kind: 'op', nodeType: 'video', config: { prompt: 'retained' }, width: 320, height: 180 };
    let state = { activeGroupId: 'current', items: [], connections: [], folderGroups: [
        { id: 'original', savedItems: [original], connections: [], defaultSaveFolder: directory },
        { id: 'current', savedItems: [], connections: [], defaultSaveFolder: directory }
    ] };
    const store = { load: () => structuredClone(state), save: value => { state = value; return true; } };
    const board = new AgentBoardService({ store });
    const recoveryStore = new GenerationRecoveryStore(path.join(directory, 'recovery'));
    recoveryStore.update('client1', { kind: 'video', taskId: 'task1', projectId: 'original', nodeId: 'video-node',
        endpoint: SITES.art.origin, model: 'video', prompt: 'retained' });
    const bridge = { recoveryStore, activeGenerationRequests: new Map(), _rememberResult(request, result) {
        recoveryStore.update(request.clientTaskId, { kind: request.kind, endpoint: request.providerConfig.endpoint,
            projectId: request.projectId, nodeId: request.nodeId, result });
    } };
    installGenerationRecoveryBoard(bridge, board);
    const importer = createRelayImporter({ bridge, store, board, getSaveDir: () => directory });
    const task = { logId: 'log1', taskId: 'task1', model: 'video' };
    const prepare = (site = 'art', accountId = 'user1') => importer.prepare({ site, task, accountId, index: 0 });
    const video = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom000000000000000')]);
    return { board, bridge, importer, prepare, video };
}

test('import restores original project/node; repeated import reuses file and node', async t => {
    const h = await setup(t);
    const context = h.prepare();
    assert.equal(context.request.projectId, 'original');
    fs.writeFileSync(context.filePath, h.video);
    await h.importer.finish(context, context.filePath);
    const again = h.prepare();
    assert.equal(again.existingPath, context.filePath);
    await h.importer.finish(again, again.existingPath);
    assert.equal(h.board.readProject('original').items.length, 1);
    assert.equal(h.board.readProject('current').items.length, 0);
    const node = h.board.readProject('original').items[0];
    assert.equal(node.runStatus, 'done');
    assert.equal(node.generation.relaySite, 'art');
});

test('independent website task imports to frozen current project and isolates account/site', async t => {
    const h = await setup(t);
    const context = h.prepare('cart');
    assert.equal(context.request.projectId, 'current');
    assert.notEqual(context.filePath, h.prepare('art').filePath);
    assert.notEqual(context.filePath, h.prepare('cart', 'user2').filePath);
    fs.writeFileSync(context.filePath, h.video);
    await h.importer.finish(context, context.filePath);
    const again = h.prepare('cart');
    await h.importer.finish(again, again.existingPath);
    assert.equal(h.board.readProject('current').items.length, 1);
});

test('editing original node during download preserves edit and keeps recoverable local result', async t => {
    const h = await setup(t), context = h.prepare();
    fs.writeFileSync(context.filePath, h.video);
    await h.board.updateProject('original', project => { project.items[0].config.prompt = 'edited'; });
    await assert.rejects(h.importer.finish(context, context.filePath), /被修改/);
    assert.equal(h.board.readProject('original').items[0].config.prompt, 'edited');
    assert.equal(h.bridge.recoveryStore.get('client1').result.filePath, context.filePath);
});

test('HTML error pages cannot be imported as successful videos', async t => {
    const h = await setup(t), context = h.prepare();
    fs.writeFileSync(context.filePath, '<html>not a video</html>');
    await assert.rejects(h.importer.finish(context, context.filePath), /不是支持的视频/);
    assert.equal(h.board.readProject('original').items[0].filePath, undefined);
});

test('browser IPC rejects remote views and iframes', async () => {
    const browser = Object.create(RelayBrowser.prototype);
    browser.window = { webContents: { mainFrame: {} } };
    await assert.rejects(browser.command({ sender: {}, senderFrame: {} }, 'download', {}), /Invalid/);
    await assert.rejects(browser.command({ sender: browser.window.webContents, senderFrame: {} }, 'list'), /Invalid/);
});
