const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'corvas-routing-'));
    const requests = [];
    const png = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#879aa6' } }).png().toBuffer();
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const request = { method: req.method, path: req.url };
        if (req.headers['content-type']?.includes('application/json')) request.model = JSON.parse(Buffer.concat(chunks)).model;
        requests.push(request);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.url.includes('/images/') ? { data: [{ b64_json: png.toString('base64') }] }
            : { choices: [{ message: { role: 'assistant', content: '文字模型工作正常' } }] }));
    });
    let app;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
        await fs.mkdir(path.join(profile, 'data'));
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, items: [], folderGroups: [], mcp: { enabled: false } }));
        const filePath = path.join(profile, 'reference.png');
        await fs.writeFile(filePath, png);
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'mcp-client-smoke-entry.cjs')], env });
        let page;
        for (let i = 0; i < 150; i++) {
            page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page);
        await page.waitForFunction(() => window.flowCanvas?.ai && window.flowCanvas?.mcp);
        const blocked = await page.evaluate(async ({ endpoint, filePath }) => {
            const failures = [];
            for (const capability of ['image', 'text']) {
                const provider = { capability, endpoint, apiKey: 'fixture-key', model: 'gpt-image-2', type: 'openai' };
                failures.push(await window.flowCanvas.ai.generateText({ provider, prompt: 'test' }));
                failures.push(await window.flowCanvas.ai.describeImages({ provider, filePaths: [filePath] }));
                failures.push(await window.flowCanvas.ai.planImageEdit({ provider, filePaths: [filePath] }));
                failures.push(await window.flowCanvas.ai.classifyAsset(filePath, provider));
            }
            return failures;
        }, { endpoint, filePath });
        assert.equal(requests.length, 0, 'All mismatched text calls must stop before network access');
        assert.ok(blocked.every(result => result.success === false && result.code === 'TEXT_PROVIDER_REQUIRED'));
        const results = await page.evaluate(async ({ endpoint, filePath, profile }) => {
            const provider = { capability: 'text', endpoint, apiKey: 'fixture-key', model: 'gpt-5.5', type: 'openai' };
            const text = await window.flowCanvas.ai.generateText({ provider, prompt: 'test' });
            const image = await window.flowCanvas.mcp.generateImage({ provider: 'openai',
                providerConfig: { ...provider, capability: 'image', model: 'gpt-image-2' },
                prompt: 'test image', size: '512x512', quality: 'high', stream: false,
                sourceReferences: [{ filePath }], targetDir: profile, addToCanvas: false });
            return { text, image: { success: image.success, error: image.error, filePath: image.filePath } };
        }, { endpoint, filePath, profile });
        assert.equal(results.text.success, true, results.text.error);
        assert.equal(results.image.success, true, results.image.error);
        assert.ok(results.image.filePath);
        assert.deepEqual(requests.map(request => request.path), ['/v1/chat/completions', '/v1/images/edits']);
        assert.equal(requests[0].model, 'gpt-5.5');
        console.log('Provider routing passed: 8 invalid text/vision calls sent no requests; valid text uses chat; Image 2 reference generation uses images/edits.');
    } finally {
        await app?.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
        assert.ok(path.basename(profile).startsWith('corvas-routing-'));
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
