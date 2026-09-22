const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-video-reuse-'));
    const profile = path.join(root, 'profile'), assets = path.join(root, 'assets');
    let app;
    try {
        await fs.mkdir(path.join(profile, 'data'), { recursive: true });
        await fs.mkdir(assets);
        const imagePath = path.join(assets, 'scene.png');
        await require('sharp')({ create: { width: 160, height: 100, channels: 3, background: '#559b8c' } }).png().toFile(imagePath);
        const sources = [
            { id: 'image', mediaType: 'image', filePath: imagePath, referenceAnnotation: '人物和环境参考' },
            { id: 'video', mediaType: 'video', filePath: path.join(assets, 'action.mp4'), referenceAnnotation: '动作参考' },
            { id: 'audio', mediaType: 'audio', filePath: path.join(assets, 'voice.wav'), referenceAnnotation: '旁白' }
        ];
        for (const source of sources.slice(1)) await fs.writeFile(source.filePath, 'fixture');
        await fs.writeFile(path.join(profile, 'data/media-access.v1.json'), JSON.stringify({ version: 1, roots: [assets], files: [] }));
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, items: [],
            folderGroups: [], mcp: { enabled: false } }));
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: ['--disable-gpu', path.join(__dirname, 'mcp-client-smoke-entry.cjs')], env });
        let page;
        for (let attempt = 0; attempt < 100; attempt++) {
            page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page);
        await page.waitForFunction(() => window.flowCanvas?.store);
        const code = await fs.readFile(path.join(__dirname, '../src/canvas.js'), 'utf8');
        const methods = [['_getHistoricalGenerationReferenceConnections', '_closeGenerationTypeMenu'],
            ['_opReferenceEntries', '_getUpstreamAgentAttachments'],
            ['_generationComposerPromptValue', '_syncGenerationComposerModelButton']]
            .map(([from, to]) => code.slice(code.indexOf(`    ${from}(`), code.indexOf(`    ${to}(`))).join('\n');
        await page.evaluate(({ methods, sources }) => {
            const normalizeReferenceAnnotation = value => String(value || '').trim();
            const referenceMaterialLabel = (type, index) => `${{ image: '图', video: '视频', audio: '音频' }[type]}${['一', '二', '三'][index]}`;
            const Fixture = new Function('normalizeReferenceAnnotation', 'referenceMaterialLabel', 'resolveCanvasFilePath',
                `const GENERATION_COMPOSER_CARET_ANCHOR = '\\u200B'; return class { ${methods} }`)(normalizeReferenceAnnotation, referenceMaterialLabel, value => value);
            const fixture = new Fixture();
            fixture.items = new Map(sources.map(data => [data.id, { data }]));
            fixture.graphView = { connections: [] };
            fixture._getItemMediaType = source => source.mediaType;
            fixture._copyableFilePath = source => source.filePath;
            fixture._mediaOutputPortName = () => 'out';
            fixture._fileNameFromPath = value => value.split(/[\\/]/).pop();
            fixture._normalizeVideoConfigForProfile = () => ({});
            fixture._getVideoReferenceLimitsForConfig = () => ({ image: 30, video: 10, audio: 10 });
            fixture._getVideoReferenceOverflow = () => [];
            for (const name of ['_syncGenerationComposerPromptMergeButton', '_positionGenerationComposer', '_cacheMediaGenerationPromptDraft', 'emit']) fixture[name] = () => {};
            const record = { references: [{ filePath: '/cache/compressed.jpg' }],
                referenceBindings: sources.map((source, index) => ({ position: index + 1, sourceNodeId: source.id,
                    sourceNodeIds: [source.id], filePath: source.filePath, mediaType: source.mediaType })) };
            const links = fixture._getHistoricalGenerationReferenceConnections('result', 'video', record);
            const data = { id: 'draft', nodeType: 'video', composerDraft: true, composerSourceItemId: 'result',
                composerUseSourceAsReference: false, composerReferenceConnections: links,
                composerReferenceItemIds: links.map(link => link.nodeId), config: { prompt: '人物起始动作，参考视频动作，并配旁白。',
                    referenceCitationOccurrences: sources.map((source, index) => ({ id: `citation-${index}`, connectionId: `old-${index}`,
                        sourceNodeId: source.id, offset: index * 6, missing: index > 0 })) } };
            const element = document.createElement('section');
            element.className = 'generation-composer';
            element.style.cssText = 'position:fixed;left:20px;top:120px;width:calc(100vw - 40px);z-index:999999';
            element.innerHTML = '<div class="generation-composer-reference-row"><div class="generation-composer-reference-scroll"><div class="generation-composer-references" data-reference-list></div></div></div><div class="generation-composer-prompt-shell"><div class="generation-composer-prompt" data-prompt contenteditable="true"></div></div><div class="generation-composer-footer"><button type="button" class="generation-composer-trigger">2.5pro 备用（满参）</button></div>';
            document.body.append(element);
            fixture.items.set(data.id, { data });
            fixture._generationComposer = { nodeId: data.id, element };
            fixture._setGenerationComposerPromptValue(element.querySelector('[data-prompt]'), data.config.prompt);
            fixture._renderGenerationComposerReferences(data.id);
            window.reuseFixture = { fixture, data };
        }, { methods, sources });
        const composer = page.locator('.generation-composer');
        assert.equal(await composer.locator('.generation-composer-reference').count(), 3);
        assert.deepEqual(await composer.locator('.generation-composer-citation').allTextContents(),
            ['人物和环境参考 · 图一', '动作参考 · 视频一', '旁白 · 音频一']);
        assert.equal(await composer.locator('.is-missing').count(), 0);
        await page.waitForFunction(() => [...document.querySelectorAll('.generation-composer-reference img')].every(img => img.complete && img.naturalWidth > 0));
        const output = path.join(__dirname, '../output/playwright');
        await fs.mkdir(output, { recursive: true });
        for (const [label, width] of [['desktop', 1000], ['compact', 420]]) {
            await app.evaluate(({ BrowserWindow }, width) => {
                const win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('index.html'));
                win.setMinimumSize(320, 480);
                win.setSize(width, 700);
            }, width);
            await page.waitForFunction(width => window.innerWidth === width, width);
            assert.ok(await composer.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
            await page.screenshot({ path: path.join(output, `video-reference-reuse-${label}.png`), animations: 'disabled' });
        }
        await page.evaluate(() => {
            const { fixture, data } = window.reuseFixture;
            fixture.items.delete('video');
            fixture._renderGenerationComposerReferences(data.id);
        });
        assert.equal(await composer.locator('.generation-composer-citation.is-missing').count(), 1);
        console.log('Video reference reuse passed: legacy image-only snapshot restores image/video/audio capsules; removed sources remain missing.');
    } finally {
        await app?.close();
        assert.ok(root.startsWith(path.join(os.tmpdir(), 'flow-video-reuse-')));
        await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
