import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfigStore, formatTimestamp, isVersionFileName } from './lib/store.mjs';

const SILENT = { log() {}, warn() {}, error() {} };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(HERE, 'seed', 'model-config.default.json');
const SEED_CONFIG = JSON.parse(fs.readFileSync(SEED, 'utf8'));

function tempStore(options = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'configstore-'));
    const store = createConfigStore({ dataDir, seedPath: SEED, logger: SILENT, ...options });
    return { store, dataDir, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

const sampleConfig = revision => ({
    schemaVersion: 1,
    revision,
    updatedAt: '2026-01-01T00:00:00.000Z',
    models: [{ id: 'a.b', kind: 'video', match: { model: ['^b$'] }, parameters: { accepts: ['model', 'prompt'] } }]
});

test('版本文件名带时间戳，且只认这种格式', () => {
    assert.equal(formatTimestamp(new Date('2026-09-11T23:00:12Z')), '20260911T230012');
    assert.equal(isVersionFileName('20260911T230012-r7.json'), true);
    assert.equal(isVersionFileName('20260911T230012-01-r7.json'), true);
    assert.equal(isVersionFileName('latest.json'), false);
    assert.equal(isVersionFileName('../state.json'), false);
    assert.equal(isVersionFileName('20260911T230012-r7.json.bak'), false);
});

test('空仓库首次启动用种子配置播种，/config 立刻有内容', () => {
    const { store, cleanup } = tempStore();
    try {
        const result = store.ensureSeed();
        assert.equal(result.seeded, true);
        const active = store.current();
        assert.ok(active, 'current 应该指向播种出来的版本');
        assert.deepEqual(active.config.models, SEED_CONFIG.models);
        assert.match(active.name, /^\d{8}T\d{6}-r0\.json$/);
        assert.equal(store.list().length, 1);
        assert.equal(store.list()[0].current, true);
        assert.equal(store.history()[0].action, 'seed');
    } finally {
        cleanup();
    }
});

test('保存：自动递增 revision、服务端盖章 revision/updatedAt/source、老版本留档不覆盖', () => {
    const { store, cleanup } = tempStore();
    try {
        store.ensureSeed();
        const first = store.save(sampleConfig(999), { actor: 'tester', note: '第一次' });
        assert.equal(first.revision, 1, '种子是 r0，第一次保存应为 r1（忽略管理员手填的 revision）');
        assert.equal(first.applied, true);
        assert.equal(first.config.updatedAt.endsWith('Z'), true);
        assert.equal(first.config.source, 'server:artconfig.ravenhash.org');
        assert.equal(store.current().name, first.name);
        assert.equal(store.current().config.revision, 1);

        const second = store.save(sampleConfig(0), { apply: false });
        assert.equal(second.revision, 2);
        assert.equal(second.applied, false);
        assert.equal(store.current().name, first.name, 'apply=false 时现行版本不变');

        assert.equal(store.list().length, 3, '两个新版本 + 种子，一个都没被覆盖');
        assert.deepEqual(store.listNames(), [...store.listNames()].sort());
    } finally {
        cleanup();
    }
});

test('一键应用老版本：只挪指针，文件内容逐字节不变', () => {
    const { store, cleanup } = tempStore();
    try {
        store.ensureSeed();
        const seedName = store.listNames()[0];
        const seedText = store.read(seedName).text;
        const saved = store.save(sampleConfig(1));
        assert.equal(store.current().config.revision, 1);

        const applied = store.apply(seedName, { actor: 'tester', note: '回滚' });
        assert.equal(applied.revision, 0);
        assert.equal(applied.previous, saved.name);
        assert.equal(store.current().name, seedName);
        assert.equal(store.read(seedName).text, seedText, '回滚不应改写文件内容');
        assert.deepEqual(store.current().config.models, SEED_CONFIG.models);
        assert.equal(store.history()[0].action, 'apply');
        assert.equal(store.history()[0].previous, saved.name);
    } finally {
        cleanup();
    }
});

test('删除：拒绝删除现行版本，非法文件名一律拒绝', () => {
    const { store, cleanup } = tempStore();
    try {
        store.ensureSeed();
        const current = store.current().name;
        assert.throws(() => store.remove(current), /不能删除当前正在生效的版本/);
        const saved = store.save(sampleConfig(1), { apply: false });
        assert.equal(store.remove(saved.name).name, saved.name);
        assert.equal(store.list().some(version => version.name === saved.name), false);
        assert.throws(() => store.read('../../etc/passwd'), /非法的版本文件名/);
        assert.throws(() => store.remove('latest.json'), /非法的版本文件名/);
    } finally {
        cleanup();
    }
});

test('current 指针损坏时回退到最新版本，而不是让 /config 变 404', () => {
    const { store, dataDir, cleanup } = tempStore();
    try {
        store.ensureSeed();
        store.save(sampleConfig(1), { apply: false });
        const statePath = path.join(dataDir, 'state.json');
        fs.writeFileSync(statePath, JSON.stringify({ current: '20000101T000000-r9.json', audit: [] }));
        const result = store.ensureSeed();
        assert.equal(result.seeded, false);
        assert.equal(store.current().name, result.state.current);
        assert.match(result.state.current, /-r1\.json$/);
        assert.equal(store.history()[0].action, 'repair');
    } finally {
        cleanup();
    }
});

test('没有种子时仓库为空：current() 返回 null 而不是抛错', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'configstore-empty-'));
    try {
        const store = createConfigStore({ dataDir, seedPath: path.join(dataDir, 'missing.json'), logger: SILENT });
        store.ensureSeed();
        assert.equal(store.current(), null);
        assert.deepEqual(store.list(), []);
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('同秒内连续保存不会互相覆盖', () => {
    const fixed = new Date('2026-09-11T23:00:12Z');
    const { store, cleanup } = tempStore({ now: () => fixed });
    try {
        store.ensureSeed();
        const names = [store.save(sampleConfig(1)).name, store.save(sampleConfig(2)).name, store.save(sampleConfig(3)).name];
        assert.equal(new Set(names).size, 3);
        assert.equal(store.list().length, 4);
    } finally {
        cleanup();
    }
});

test('源码预览兼容旧 state，发布清空及回滚均不改变正式配置', () => {
    const { store, dataDir, cleanup } = tempStore();
    try {
        store.ensureSeed();
        const stable = store.current();
        const legacyState = JSON.parse(fs.readFileSync(store.statePath, 'utf8'));
        delete legacyState.preview;
        delete legacyState.previewAppliedAt;
        fs.writeFileSync(store.statePath, JSON.stringify(legacyState));
        assert.equal(store.current('preview'), null);

        const first = store.save(sampleConfig(3), { channel: 'preview' });
        const empty = store.save({ schemaVersion: 1, catalogMode: 'remote', models: [] }, { channel: 'preview' });
        assert.equal(empty.revision, first.revision + 1);
        assert.deepEqual(store.current('preview').config.models, []);
        assert.equal(store.current().name, stable.name);
        assert.equal(store.current().text, stable.text);
        assert.equal(store.readState().appliedAt, legacyState.appliedAt);

        store.apply(first.name, { channel: 'preview' });
        assert.equal(store.current('preview').name, first.name);
        assert.equal(store.current().text, stable.text);
        const previewTime = store.readState().previewAppliedAt;
        const nextStable = store.save(sampleConfig(4));
        assert.equal(nextStable.revision, empty.revision + 1);
        assert.equal(store.readState().previewAppliedAt, previewTime);
        assert.equal(store.current('preview').name, first.name);
        store.remove(empty.name);
        assert.equal(store.current('preview').name, first.name);
        assert.throws(() => store.remove(first.name), /不能删除当前正在生效的版本/);
        assert.throws(() => store.remove(nextStable.name), /不能删除当前正在生效的版本/);
        assert.equal(store.list().find(item => item.name === first.name).preview, true);
        assert.equal(store.list().find(item => item.name === nextStable.name).current, true);

        const reopened = createConfigStore({ dataDir, seedPath: SEED, logger: SILENT });
        reopened.ensureSeed();
        assert.equal(reopened.current('preview').name, first.name);
        assert.equal(reopened.current().name, nextStable.name);
        reopened.apply(first.name);
        const both = reopened.list().find(item => item.name === first.name);
        assert.equal(both.current, true);
        assert.equal(both.preview, true);
        assert.throws(() => reopened.save(sampleConfig(5), { channel: 'typo' }), /配置通道/);
        assert.equal(reopened.list().length, 3);
    } finally {
        cleanup();
    }
});

test('正式指针损坏时不会把最新源码预览自动发布为正式配置', () => {
    const { store, cleanup } = tempStore();
    try {
        store.ensureSeed();
        const stableName = store.current().name;
        const preview = store.save({ schemaVersion: 1, catalogMode: 'remote', models: [] }, { channel: 'preview' });
        const state = { ...store.readState(), current: '20000101T000000-r999.json' };
        fs.writeFileSync(store.statePath, JSON.stringify(state));
        store.ensureSeed();
        assert.equal(store.current(), null);
        assert.equal(store.readState().current, state.current);
        assert.equal(store.current('preview').name, preview.name);
        store.apply(stableName);
        assert.equal(store.current().name, stableName);
        assert.equal(store.current('preview').name, preview.name);
    } finally {
        cleanup();
    }
});
