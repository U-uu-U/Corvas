const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const site = process.env.CORVAS_RELEASE_TEST_SITE === 'art' ? 'art' : 'cart';
    const base = `https://${site}.ravenhash.org`;
    const infoResponse = await fetch(base + '/corvas/api/latest', { signal: AbortSignal.timeout(15000) });
    assert.equal(infoResponse.status, 200);
    assert.ok(infoResponse.headers.get('content-type').includes('application/json'));
    const info = await infoResponse.json();
    assert.equal(info.version, '1.6.0-beta.13');
    assert.equal(info.assets.length, 3);
    const tests = [];
    for (const asset of info.assets) {
        const head = await fetch(base + asset.url, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
        assert.equal(head.status, 200);
        assert.equal(Number(head.headers.get('content-length')), asset.bytes);
        assert.equal(head.headers.get('etag'), `"${asset.sha256}"`);
        const response = await fetch(base + asset.url, { headers: { range: 'bytes=0-63' }, signal: AbortSignal.timeout(15000) });
        assert.equal(response.status, 206);
        assert.equal(response.headers.get('content-range'), `bytes 0-63/${asset.bytes}`);
        const local = await fs.open(path.join(__dirname, '../release', `v${info.version}`, asset.name));
        const expected = Buffer.alloc(64);
        try { await local.read(expected, 0, 64, 0); } finally { await local.close(); }
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
        tests.push({ name: asset.name, head: 200, range: 206, bytesMatched: 64 });
    }
    const health = await (await fetch(base + '/corvas/health')).json(); assert.equal(health.ok, true);
    const root = await fetch(base + '/'); assert.equal(root.status, 200);
    const api = await fetch(base + '/v1/models'); assert.ok([401, 403].includes(api.status));
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const output = path.join(__dirname, '../output/playwright');
    await fs.mkdir(output, { recursive: true });
    try {
        const page = await browser.newPage();
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
            await page.setViewportSize({ width, height });
            await page.goto(base + '/corvas', { waitUntil: 'networkidle' });
            assert.equal(await page.getByRole('heading', { name: 'Corvas 画布', exact: true }).count(), 1);
            assert.equal(await page.locator('a.download').count(), 2);
            assert.equal(await page.locator('.brand img').evaluate(image => image.complete && image.naturalWidth > 0), true);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            assert.equal(await page.locator('#features').evaluate(element => element.getBoundingClientRect().top < innerHeight), true);
            await page.screenshot({ path: path.join(output, `corvas-release-${site}-${name}.png`), fullPage: true });
        }
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
    console.log(JSON.stringify({ site, version: info.version, livePage: true, desktopMobile: true, downloads: tests, relayStillRequiresAuth: api.status }));
})().catch(error => { console.error(error); process.exitCode = 1; });
