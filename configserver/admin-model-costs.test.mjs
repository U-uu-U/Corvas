import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { projectAdminModelCosts } from './lib/admin-model-costs.mjs';
import { catalogModelCost } from './lib/admin-catalog-model.mjs';

const snapshot = JSON.parse(fs.readFileSync(new URL('./seed/admin-model-costs.json', import.meta.url), 'utf8'));
const entry = { id: 'starframe.ch0107-sd-2.5-720p', kind: 'video',
    catalog: { model: 'ch0107-sd-2.5-720p', hosts: ['art.ravenhash.org', 'cart.ravenhash.org', 'api.xzapi.vip'] } };

test('costs preserve source, precision, user exchange convention and historical status without becoming sale prices', () => {
    const projected = projectAdminModelCosts(snapshot);
    const cost = catalogModelCost(entry, projected);
    assert.ok(cost.text.includes('¥1.50/秒'));
    assert.ok(cost.text.includes('1:1'));
    assert.ok(cost.text.includes('上游参考价'));
    assert.equal(cost.status, 'reference');
    assert.ok(cost.title.includes('https://api.xzapi.vip/api/pricing'));
    const historical = catalogModelCost({ id: 'ravenhash-video.sd2.5-route1' }, projected);
    assert.equal(historical.status, 'historical');
    assert.ok(historical.text.includes('US$1.50/次'));
    assert.ok(historical.text.includes('当前价格待核对'));
    const fast = catalogModelCost({ id: 'ravenhash-video.seedance-2.0-fast' }, projected);
    assert.ok(fast.text.includes('¥20.944/百万 Token'));
    const credits = catalogModelCost({ id: 'shanhai-video.oc-model-1iq31f' }, projected);
    assert.ok(credits.text.includes('0.78 积分/秒'));
    assert.ok(!credits.text.includes('¥'));
    const data = structuredClone(snapshot);
    data.entries[0].prices[0].amount = 0;
    assert.ok(catalogModelCost({ id: data.entries[0].ids[0] }, projectAdminModelCosts(data)).text.includes('¥0.00/次'));
});

test('cost lookups reject changed bindings and never treat missing prices as zero', () => {
    assert.equal(catalogModelCost(entry, null).text, '成本价：读取中');
    assert.equal(catalogModelCost(entry, { error: true }).text, '成本价：读取失败');
    assert.equal(catalogModelCost({ ...entry, id: 'new-id' }, snapshot).text, '成本价：待核对');
    assert.equal(catalogModelCost({ ...entry, catalog: { ...entry.catalog, model: 'other' } }, snapshot).text, '成本价：待核对');
    assert.equal(catalogModelCost({ ...entry, catalog: { ...entry.catalog, hosts: ['other.example'] } }, snapshot).text, '成本价：待核对上游绑定');
    const unknown = catalogModelCost({ id: 'ravenhash-video.seedance-2.5-pro-1' }, snapshot);
    assert.ok(unknown.text.includes('待核对'));
    assert.ok(!unknown.text.includes('¥0'));
});

test('server projection rejects malformed costs and strips credentials and internal evidence', () => {
    const data = structuredClone(snapshot);
    data.secret = 'hidden'; data.entries[0].apiKey = 'hidden'; data.entries[0].prices[0].secret = 'hidden';
    const projected = projectAdminModelCosts(data);
    assert.ok(!JSON.stringify(projected).includes('hidden'));
    assert.ok(!JSON.stringify(projected).includes('server/seedance968'));
    for (const patch of [{ currency: 'INVALID' }, { status: 'sale' }, { sourceUrl: 'https://user:secret@api.example' },
        { sourceUrl: 'https://api.example?key=secret' }, { prices: [{ amount: -1, label: '', unit: 'second' }] },
        { prices: [{ amount: '1', label: '', unit: 'second' }] }]) {
        const bad = structuredClone(snapshot); Object.assign(bad.entries[0], patch);
        assert.throws(() => projectAdminModelCosts(bad));
    }
});
