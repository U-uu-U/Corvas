import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAdminBalances } from './lib/admin-balances.mjs';

test('balances cache and deduplicate queries, preserve stale values, and never expose keys or errors', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-balances-'));
    try {
        fs.writeFileSync(path.join(dataDir, 'admin-balance-credentials.json'), JSON.stringify({ 'zhubo-art': { key: 'test-secret' } }));
        let clock = 1000000;
        let calls = 0;
        let fail = false;
        const balances = createAdminBalances({ dataDir, seedPath: new URL('./seed/admin-balance-accounts.json', import.meta.url), now: () => clock,
            fetchImpl: async (url, options) => {
                calls += 1;
                assert.equal(url, 'https://video.zhubo.asia/v1/billing/balance');
                assert.equal(options.redirect, 'error');
                assert.equal(options.headers.Authorization, 'Bearer test-secret');
                if (fail) throw new Error('provider leaked test-secret');
                return { ok: true, json: async () => ({ billing: true, balance: 44.35 }) };
            } });
        const [first, concurrent] = await Promise.all([balances.list(), balances.list()]);
        assert.equal(calls, 1);
        assert.deepEqual(first, concurrent);
        assert.equal(first.accounts[0].amount, 44.35);
        assert.equal(first.accounts[0].low, true);
        assert.equal(first.accounts[1].amount, null);
        assert.equal(first.accounts[1].status, 'unavailable');
        assert.ok(!JSON.stringify(first).includes('test-secret'));
        balances.setThreshold('zhubo-art', null);
        assert.equal((await balances.list()).accounts[0].threshold, null);
        assert.equal((await balances.list()).accounts[0].low, false);
        assert.equal(calls, 1);
        assert.throws(() => balances.setThreshold('zhubo-art', -1));
        assert.throws(() => balances.setThreshold('unknown', 10));
        fail = true;
        clock += 300001;
        const failed = await balances.list();
        assert.equal(failed.accounts[0].status, 'stale');
        assert.equal(failed.accounts[0].amount, 44.35);
        assert.equal(failed.accounts[0].updatedAt, first.accounts[0].updatedAt);
        assert.ok(!JSON.stringify(failed).includes('test-secret'));
        await balances.list({ force: true });
        assert.equal(calls, 2, 'Even forced refresh has a short retry cooldown');
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('invalid balance, expired auth and changed accounts never become a zero balance or inherit old money', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-balances-'));
    try {
        const credentials = path.join(dataDir, 'admin-balance-credentials.json');
        fs.writeFileSync(credentials, JSON.stringify({ 'zhubo-art': { key: 'one' } }));
        let response = { ok: true, json: async () => ({ billing: true, balance: 0 }) };
        const balances = createAdminBalances({ dataDir, seedPath: new URL('./seed/admin-balance-accounts.json', import.meta.url), fetchImpl: async () => response });
        assert.equal((await balances.list()).accounts[0].amount, 0);
        fs.writeFileSync(credentials, JSON.stringify({ 'zhubo-art': { key: 'two' } }));
        response = { ok: true, json: async () => ({ billing: true, balance: 'unknown' }) };
        const invalid = (await balances.list()).accounts[0];
        assert.equal(invalid.amount, null);
        assert.equal(invalid.status, 'error');
        fs.writeFileSync(credentials, JSON.stringify({ 'zhubo-art': { key: 'three' } }));
        response = { ok: false, status: 401 };
        assert.equal((await balances.list()).accounts[0].detail, '查询授权已失效');
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
