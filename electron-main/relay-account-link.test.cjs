const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { listRelayAccounts, resolveRelayAccounts, requestAccountJson, RelayAccountDelivery } = require('./relay-account-link.cjs');

const token = (id, patch = {}) => ({ id, user_id: 'user1', name: `Key ${id}`, token_key: `sk-fixtureOnly${id}123`, is_active: 1, ...patch });
function fixture(tokens = [token(1), token(2)]) {
    const calls = [];
    const options = { site: 'art', origin: 'https://art.ravenhash.org', auth: 'login-fixture', stillCurrent: async () => true,
        session: { fetch: async (url, init) => {
            calls.push({ url, ...init });
            assert.equal(init.redirect, 'error');
            assert.equal(init.headers.Authorization, 'Bearer login-fixture');
            assert.equal(init.method, 'GET', 'Listing and importing existing art keys must never create a key');
            if (url.endsWith('/user/profile')) return Response.json({ id: 'user1', username: 'Fixture', is_active: 1 });
            return Response.json({ data: tokens });
        } } };
    return { options, calls, tokens };
}

test('list returns existing key metadata only, excludes foreign keys and labels unavailable keys', async () => {
    const h = fixture([token(1), token(2, { is_active: 0 }), token(3, { only_playground: 1 }),
        token(4, { expires_at: '2000-01-01 00:00:00' }), token(5, { user_id: 'other' })]);
    const result = await listRelayAccounts(h.options);
    assert.deepEqual(result.tokens.map(value => [value.id, value.enabled]), [['1', true], ['2', false], ['3', false], ['4', false]]);
    assert.doesNotMatch(JSON.stringify(result), /fixtureOnly|login-fixture|token_key|apiKey/);
    assert.deepEqual((await listRelayAccounts(fixture([]).options)).tokens, []);
});

test('only explicitly selected keys are returned and no new key is ever created', async () => {
    const h = fixture();
    const accounts = await resolveRelayAccounts(h.options, { userId: 'user1', tokenIds: ['2'] });
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].tokenId, '2');
    assert.equal(accounts[0].apiKey, 'sk-fixtureOnly2123');
    assert.equal(accounts[0].tokenName, 'Key 2');
    assert.equal(h.calls.some(call => call.method === 'POST'), false);
});

test('large key lists read every page before presenting the selection', async () => {
    const h = fixture();
    const base = h.options.session.fetch;
    const pages = [];
    h.options.session.fetch = async (url, init) => {
        if (url.endsWith('/user/profile')) return base(url, init);
        const page = Number(new URL(url).searchParams.get('page'));
        pages.push(page);
        return Response.json({ total: 205, data: Array.from({ length: page === 3 ? 5 : 100 }, (_, index) => token((page - 1) * 100 + index + 1)) });
    };
    const catalog = await listRelayAccounts(h.options);
    assert.deepEqual(pages, [1, 2, 3]);
    assert.equal(catalog.tokens.length, 205);
});

test('selection is revalidated for deletion, revocation, user changes and forged IDs before delivery', async () => {
    const h = fixture();
    await listRelayAccounts(h.options);
    h.tokens[1].is_active = 0;
    for (const selection of [{ userId: 'user1', tokenIds: ['2'] }, { userId: 'other', tokenIds: ['1'] },
        { userId: 'user1', tokenIds: ['999'] }, { userId: 'user1', tokenIds: ['1', '1'] }, { userId: 'user1', tokenIds: [] }]) {
        await assert.rejects(resolveRelayAccounts(h.options, selection));
    }
    await assert.rejects(resolveRelayAccounts({ ...h.options, stillCurrent: async () => false }, { userId: 'user1', tokenIds: ['1'] }));
});

test('New API fetches full secrets only for selected keys and does not call key creation', async () => {
    const calls = [];
    const options = { site: 'ai', origin: 'https://ai.ravenhash.org', auth: 'image-login', stillCurrent: async () => true,
        session: { fetch: async (url, init) => {
            calls.push({ url, ...init });
            if (url.endsWith('/user/self')) return Response.json({ success: true, data: { id: 7, username: 'Image', status: 1 } });
            if (url.endsWith('/token/2/key')) return Response.json({ success: true, data: { key: 'selectedFixture123' } });
            assert.equal(init.method, 'GET');
            assert.equal(new URL(url).searchParams.get('page_size'), '100');
            return Response.json({ success: true, data: { items: [1, 2].map(id => ({ id, user_id: 7, name: `Image ${id}`,
                group: id === 1 ? 'text' : 'image', status: 1, expired_time: -1, key: 'masked***' })), total: 2 } });
        } } };
    const listed = await listRelayAccounts(options);
    assert.deepEqual(listed.tokens.map(item => item.group), ['text', 'image']);
    assert.equal(calls.some(call => call.method === 'POST'), false);
    const selected = await resolveRelayAccounts(options, { userId: listed.userId, tokenIds: ['2'] });
    assert.equal(selected[0].apiKey, 'sk-selectedFixture123');
    assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => new URL(call.url).pathname), ['/api/token/2/key']);
});

test('HTTP failures retain auth-expiry classification without revealing server response bodies', async () => {
    const session = { fetch: async () => new Response('secret-key upstream-price', { status: 401 }) };
    await assert.rejects(requestAccountJson(session, 'https://art.ravenhash.org', 'secret', '/api/v1/tokens'), error => {
        assert.equal(error.code, 'RELAY_AUTH_EXPIRED'); assert.doesNotMatch(error.message, /secret|upstream/); return true;
    });
    session.fetch = async () => new Response('x'.repeat(1024 * 1024 + 1));
    await assert.rejects(requestAccountJson(session, 'https://art.ravenhash.org', 'secret', '/api/v1/tokens'));
});

test('selection and persistence replies are scoped to the initiating canvas', async () => {
    const web = new EventEmitter(); web.isDestroyed = () => false;
    let sent; web.send = (channel, payload) => { sent = { channel, ...payload }; };
    const delivery = new RelayAccountDelivery();
    const pending = delivery.select(web, { tokens: [{ id: '2', name: 'Key 2' }] });
    assert.equal(sent.channel, 'relay-account:select');
    assert.equal(delivery.complete({}, sent.id, { tokenIds: ['2'] }), false);
    delivery.complete(web, sent.id, { tokenIds: ['2'] });
    assert.deepEqual(await pending, ['2']);
    const canceled = delivery.select(web, {});
    delivery.complete(web, sent.id, { canceled: true });
    assert.equal(await canceled, null);
    const saving = delivery.send(web, { apiKey: 'fixture' });
    delivery.complete(web, sent.id, { success: true });
    await saving;
    assert.equal(delivery.pending.size, 0);
    assert.equal(web.listenerCount('destroyed'), 0);
});

test('missing save replies and closing the selection window release pending requests', async () => {
    const web = new EventEmitter(); web.isDestroyed = () => false; web.send = () => {};
    const delivery = new RelayAccountDelivery({ timeout: 10 });
    await assert.rejects(delivery.send(web, {}));
    const selecting = delivery.select(web, {});
    web.emit('destroyed');
    await assert.rejects(selecting);
    assert.equal(delivery.pending.size, 0);
});
