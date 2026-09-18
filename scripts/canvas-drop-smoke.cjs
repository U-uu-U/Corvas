const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-drop-'));
    let app;
    try {
        const media = path.join(profile, 'data', 'captured');
        await fs.mkdir(media, { recursive: true });
        const filePath = path.join(media, 'local.png');
        await sharp({ create: { width: 40, height: 30, channels: 3, background: '#7d9b91' } }).png().toFile(filePath);
        const memoryImage = await sharp({ create: { width: 30, height: 40, channels: 3, background: '#a18976' } }).png().toBuffer();
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'mcp-client-smoke-entry.cjs')], env });
        let page;
        for (let attempt = 0; attempt < 100; attempt++) {
            page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page);
        await page.waitForFunction(() => window.Konva?.stages[0]);
        const drop = async (kind) => page.evaluate(({ kind, filePath, bytes }) => {
            const transfer = new DataTransfer();
            if (kind !== 'unsupported') {
                const file = new File(['local'], 'local.png', { type: 'image/png' });
                Object.defineProperty(file, 'path', { value: filePath });
                transfer.items.add(file);
                if (kind === 'mixed') transfer.items.add(new File([new Uint8Array(bytes)], 'memory.png', { type: 'image/png' }));
            } else transfer.items.add(new File(['unsupported'], 'unknown.bin', { type: 'application/octet-stream' }));
            window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, clientX: 400, clientY: 300, bubbles: true, cancelable: true }));
        }, { kind, filePath, bytes: [...memoryImage] });
        for (const [kind, expected] of [['local', 1], ['mixed', 2]]) {
            await drop(kind);
            await page.waitForFunction(expected => document.querySelector('.titlebar-status').textContent.includes(`${expected} 个素材已加入画板`), expected);
            assert.equal(await page.locator('.titlebar-status').evaluate(el => el.classList.contains('status-error')), false);
            await page.waitForFunction(expected => window.Konva.stages[0].find('.nodeGroup').length === expected, expected);
        }
        await drop('unsupported');
        await page.waitForFunction(() => document.querySelector('.titlebar-status').textContent.includes('没有可用图片'));
        assert.equal(await page.locator('.titlebar-status').evaluate(el => el.classList.contains('status-error')), true);
        assert.equal(await page.evaluate(() => window.Konva.stages[0].find('.nodeGroup').length), 2);
        console.log('Local and mixed file drops retain imported images without a false error; unsupported drops still report failure.');
    } finally {
        await app?.close().catch(() => {});
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
