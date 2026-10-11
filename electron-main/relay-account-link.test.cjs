const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { resolveRelayAccount, requestAccountJson, RelayAccountDelivery } = require('./relay-account-link.cjs');

const token = (overrides = {}) => ({ id: 1, user_id: 'user1', name: 'Corvas Canvas',
    token_key: 'sk-fixtureOnly123', is_active: 1, ...overrides });
function fixture(tokens = []) {
    const calls = [];
    const options = { site: 'art', origin: 'https://art.ravenhash.org', auth: 'login-fixture', stillCurrent: async () => true,
        session: { fetch: async (url, init) => {
            calls.push({ url, ...init });
            assert.equal(init.redirect, 'error');
            assert.equal(init.headers.Authorization, 'Bearer login-fixture');
            if (url.endsWith('/user/profile')) return Response.json({ id: 'user1', username: 'Fixture', is_active: 1 });
            if (init.method === 'POST') { const created = token(); tokens.push(created); return Response.json(created); }
            return Response.json({ data: tokens });
        } } };
    return { calls, options, tokens };
}

test('first connection creates one dedicated key; subsequent connection reuses it', async () => {
    const h = fixture();
    const account = await resolveRelayAccount(h.options);
    assert.deepEqual(account, { site: 'art', userId: 'user1', username: 'Fixture', tokenId: '1', apiKey: 'sk-fixtureOnly123' });
    assert.deepEqual(await resolveRelayAccount(h.options), account);
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
    assert.deepEqual(JSON.parse(h.calls.find(call => call.method === 'POST').body), { name: 'Corvas Canvas' });
    assert.doesNotMatch(JSON.stringify(account), /login-fixture/);
});

test('foreign accounts are excluded and unrelated keys are not repurposed', async () => {
    const h = fixture([token({ user_id: 'other', id: 2 }), token({ name: 'Other app', id: 3 })]);
    const account = await resolveRelayAccount(h.options);
    assert.equal(account.tokenId, '1');
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
});

test('disabled, expired and web-only dedicated keys are never silently replaced', async () => {
    for (const fields of [{ is_active: 0 }, { only_playground: 1 }, { only_playground_2026: 1 },
        { expires_at: '2000-01-01 00:00:00' }, { expires_at: 'invalid' }]) {
        const h = fixture([token(fields)]);
        await assert.rejects(resolveRelayAccount(h.options));
        assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
    }
});

test('deleted linked keys require a manual reconnection', async () => {
    const h = fixture(); h.options.getPrevious = () => ({ tokenId: '50' });
    await assert.rejects(resolveRelayAccount(h.options));
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
    await resolveRelayAccount({ ...h.options, manual: true });
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
});

test('creation uncertainty is not automatically retried; retry looks up the created key first', async () => {
    const h = fixture(); const fetch = h.options.session.fetch;
    h.options.session.fetch = async (url, init) => {
        const result = await fetch(url, init);
        if (init.method === 'POST') throw new Error('connection lost after create');
        return result;
    };
    await assert.rejects(resolveRelayAccount(h.options));
    assert.equal((await resolveRelayAccount({ ...h.options, manual: true })).tokenId, '1');
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
});

test('an account change blocks key creation or credential delivery', async () => {
    for (const tokens of [[], [token()]]) {
        const h = fixture(tokens); h.options.stillCurrent = async () => false;
        await assert.rejects(resolveRelayAccount(h.options));
        assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
    }
});

test('HTTP failures and oversized responses never expose credential-bearing server details', async () => {
    const session = { fetch: async () => new Response('secret-key upstream-price', { status: 500 }) };
    await assert.rejects(requestAccountJson(session, 'https://art.ravenhash.org', 'secret', '/api/v1/tokens'), error => {
        assert.doesNotMatch(error.message, /secret|upstream/); return true;
    });
    session.fetch = async () => new Response('x'.repeat(1024 * 1024 + 1));
    await assert.rejects(requestAccountJson(session, 'https://art.ravenhash.org', 'secret', '/api/v1/tokens'));
});

test('canvas acknowledges persistence through its own webContents only', async () => {
    const web = new EventEmitter(); web.isDestroyed = () => false;
    let sent; web.send = (channel, payload) => { sent = { channel, ...payload }; };
    const delivery = new RelayAccountDelivery();
    const result = delivery.send(web, { apiKey: 'fixture-private' });
    assert.equal(sent.channel, 'relay-account:connect');
    assert.equal(delivery.complete({}, sent.id, { success: true }), false);
    assert.equal(delivery.complete(web, sent.id, { success: true }), true);
    await result;
    assert.equal(delivery.pending.size, 0);
    assert.equal(web.listenerCount('destroyed'), 0);
});

test('missing save acknowledgements time out and release listeners', async () => {
    const web = new EventEmitter(); web.isDestroyed = () => false; web.send = () => {};
    const delivery = new RelayAccountDelivery({ timeout: 10 });
    await assert.rejects(delivery.send(web, {}));
    assert.equal(delivery.pending.size, 0);
    assert.equal(web.listenerCount('destroyed'), 0);
});

test('image station uses New API profile, paged keys and secret retrieval without exposing login tokens', async () => {
    const tokens = [], calls = [];
    const options = { site: 'ai', origin: 'https://ai.ravenhash.org', auth: 'image-login-fixture', stillCurrent: async () => true,
        session: { fetch: async (url, init) => {
            calls.push({ url, method: init.method, body: init.body });
            assert.equal(init.headers.Authorization, 'Bearer image-login-fixture');
            if (url.endsWith('/user/self')) return Response.json({ success: true, data: { id: 7, username: 'Image user', status: 1 } });
            if (url.endsWith('/token/9/key')) return Response.json({ success: true, data: { key: 'imageFixtureOnly123' } });
            if (init.method === 'POST') {
                tokens.push({ id: 9, user_id: 7, name: 'Corvas Canvas', status: 1, expired_time: -1, key: 'masked***' });
                return Response.json({ success: true });
            }
            return Response.json({ success: true, data: { items: tokens, total: tokens.length } });
        } } };
    const account = await resolveRelayAccount(options);
    assert.deepEqual(account, { site: 'ai', userId: '7', username: 'Image user', tokenId: '9', apiKey: 'sk-imageFixtureOnly123' });
    assert.deepEqual(await resolveRelayAccount(options), account);
    assert.equal(calls.filter(call => call.url.endsWith('/api/token/') && call.method === 'POST').length, 1);
    assert.doesNotMatch(JSON.stringify(account), /image-login-fixture|masked/);
    tokens[0].status = 2;
    await assert.rejects(resolveRelayAccount(options));
    assert.equal(calls.filter(call => call.url.endsWith('/api/token/') && call.method === 'POST').length, 1);
});

test('image authentication errors do not fall back to a different station API', async () => {
    const calls = [];
    await assert.rejects(resolveRelayAccount({ site: 'ai', origin: 'https://ai.ravenhash.org', auth: 'expired',
        session: { fetch: async url => { calls.push(url); return Response.json({ success: false, message: 'private-details' }); } },
        stillCurrent: async () => true }));
    assert.deepEqual(calls, ['https://ai.ravenhash.org/api/user/self']);
});
