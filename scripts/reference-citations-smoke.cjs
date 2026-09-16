const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-citations-'));
    let app;
    try {
        await fs.mkdir(path.join(profile, 'data'));
        const previewPaths = ['first', 'second'].map(name => path.join(profile, `${name}.png`));
        for (const [index, file] of previewPaths.entries()) {
            await require('sharp')({ create: { width: 160, height: 100, channels: 3,
                background: index ? '#bb7f50' : '#559b8c' } }).png().toFile(file);
        }
        const audioPath = path.join(profile, 'narration.wav');
        await fs.writeFile(audioPath, 'smoke-audio');
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, items: [], folderGroups: [], mcp: { enabled: false } }));
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'),
            args: ['--disable-gpu', path.join(__dirname, 'mcp-client-smoke-entry.cjs')], env });
        app.process().stderr?.on('data', chunk => process.stderr.write(chunk));
        let page;
        for (let attempt = 0; attempt < 80 && !page; attempt += 1) {
            page = app.windows().find(window => /dist[\\/]index\.html|127\.0\.0\.1:15321/.test(window.url()));
            if (!page) await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!page) throw new Error('Corvas main window did not open');
        await page.waitForFunction(() => window.flowCanvas?.store);
        const source = await fs.readFile(path.join(__dirname, '../src/canvas.js'), 'utf8');
        // Exercise the production composer methods with real Electron selection/contenteditable behavior.
        const methods = source.slice(source.indexOf('    _generationComposerPromptValue('), source.indexOf('    _syncGenerationComposerModelButton('));
        await page.evaluate(({ methods, previewPaths, audioPath }) => {
            const normalizeAnnotation = value => String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
            const materialLabel = (mediaType, index) => {
                const prefix = { image: '图', video: '视频', audio: '音频' }[mediaType] || '素材';
                return `${prefix}${['一', '二', '三', '四'][index] || index + 1}`;
            };
            const Fixture = new Function('resolveCanvasFilePath', 'normalizeReferenceAnnotation', 'referenceMaterialLabel',
                `const GENERATION_COMPOSER_CARET_ANCHOR = '\\u200B'; return class { ${methods} }`)(value => value, normalizeAnnotation, materialLabel);
            const fixture = new Fixture();
            const data = { nodeType: 'video', config: { prompt: 'A B C' } };
            const references = ['first', 'second'].map(id => ({ connection: { id, transient: true }, source: { id: `source-${id}`, filePath: '', mediaType: 'image' } }));
            references.forEach((entry, index) => { entry.source.filePath = previewPaths[index]; });
            references.push({ connection: { id: 'audio', transient: true },
                source: { id: 'source-audio', filePath: audioPath, mediaType: 'audio' } });
            const element = document.createElement('section');
            element.className = 'generation-composer';
            element.style.cssText = 'position:fixed;left:120px;top:160px;width:540px;z-index:999999';
            element.innerHTML = '<div class="generation-composer-reference-row"><div class="generation-composer-reference-scroll"><div class="generation-composer-references" data-reference-list></div></div></div><div class="generation-composer-prompt-shell"><div class="generation-composer-prompt" data-prompt contenteditable="true"></div></div><div class="generation-composer-footer"><button type="button" class="generation-composer-trigger">Seedance 2.5</button></div>';
            document.body.append(element);
            fixture.items = new Map([['test', { data }]]);
            fixture._generationComposer = { nodeId: 'test', element };
            fixture._opReferenceEntries = () => references;
            fixture._getItemMediaType = source => source.mediaType;
            fixture._copyableFilePath = source => source.filePath || '';
            fixture._fileNameFromPath = value => value;
            fixture._saveReferenceAnnotation = async (source, value) => {
                source.referenceAnnotation = normalizeAnnotation(value);
                const result = await window.flowCanvas.asset.updateMetadata(source.filePath, {
                    referenceAnnotation: source.referenceAnnotation
                });
                if (!result?.success) throw new Error(result?.error || '素材标注保存失败');
                return source.referenceAnnotation;
            };
            fixture._normalizeVideoConfigForProfile = () => ({ referenceLimits: { image: 9, video: 3, audio: 3 } });
            fixture._getVideoReferenceLimitsForConfig = () => ({ image: 9, video: 3, audio: 3 });
            fixture._getVideoReferenceOverflow = () => [];
            fixture._syncGenerationComposerPromptMergeButton = () => {};
            fixture._positionGenerationComposer = () => {};
            fixture._cacheMediaGenerationPromptDraft = () => {};
            fixture.emit = () => {};
            const prompt = element.querySelector('[data-prompt]');
            fixture._setGenerationComposerPromptValue(prompt, data.config.prompt);
            fixture._renderGenerationComposerReferences('test');
            window.citationFixture = { fixture, data, prompt, references };
        }, { methods, previewPaths, audioPath });
        const pills = page.locator('.generation-composer-citation');
        const first = page.locator('.generation-composer-reference.citable').nth(0);
        const second = page.locator('.generation-composer-reference.citable').nth(1);
        await page.evaluate(() => {
            const { fixture, prompt } = window.citationFixture;
            fixture._focusGenerationComposerPromptEnd(prompt);
        });
        await first.locator('.generation-composer-reference-preview').click();
        await first.locator('.generation-composer-reference-preview').click();
        await second.locator('.generation-composer-reference-preview').click();
        assert.deepEqual(await pills.allTextContents(), ['图一', '图一', '图二']);
        const audio = page.locator('.generation-composer-reference.citable').nth(2);
        const audioAnnotation = audio.locator('.generation-composer-reference-annotation input');
        await audio.hover();
        await audioAnnotation.fill('旁白');
        await audioAnnotation.press('Tab');
        await audio.locator('.generation-composer-reference-preview').click();
        assert.deepEqual(await pills.allTextContents(), ['图一', '图一', '图二', '旁白 · 音频一']);
        await pills.nth(3).click();
        assert.deepEqual(await pills.allTextContents(), ['图一', '图一', '图二']);
        await page.evaluate(() => window.citationFixture.fixture._renderGenerationComposerReferences('test'));
        assert.equal(await page.locator('.generation-composer-reference.citable').nth(2)
            .locator('.generation-composer-reference-annotation input').inputValue(), '旁白');
        assert.equal(await page.evaluate(async filePath => {
            const metadata = await window.flowCanvas.asset.readMetadata([filePath]);
            return metadata[filePath]?.referenceAnnotation;
        }, audioPath), '旁白');
        await pills.nth(0).hover();
        await page.waitForFunction(() => {
            const preview = document.querySelector('.generation-citation-preview');
            return preview?.matches(':popover-open') && preview.complete && preview.naturalWidth === 160;
        });
        if (process.env.FLOW_CITATIONS_SCREENSHOT) await page.screenshot({ path: process.env.FLOW_CITATIONS_SCREENSHOT });
        await page.mouse.move(30, 30);
        assert.equal(await page.locator('.generation-citation-preview').count(), 0);
        await pills.nth(0).click();
        assert.deepEqual(await pills.allTextContents(), ['图一', '图二']);
        assert.equal(await page.locator('.generation-composer-reference.citable').count(), 3);
        await page.evaluate(() => {
            const { prompt } = window.citationFixture;
            const range = document.createRange();
            range.setStart(prompt.firstChild, 2);
            range.collapse(true);
            prompt.focus();
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
        });
        await first.locator('.generation-composer-reference-preview').click();
        assert.deepEqual(await pills.allTextContents(), ['图一', '图一', '图二']);
        const before = await page.evaluate(() => {
            const { fixture, data, prompt } = window.citationFixture;
            return { text: fixture._generationComposerPromptValue(prompt), occurrences: data.config.referenceCitationOccurrences };
        });
        assert.deepEqual(before.occurrences.map(entry => entry.offset), [2, 5, 5]);
        assert.equal(new Set(before.occurrences.map(entry => entry.id)).size, 3);
        await page.evaluate(() => {
            const { fixture, data, prompt } = window.citationFixture;
            data.config = JSON.parse(JSON.stringify(data.config));
            prompt.replaceChildren();
            fixture._setGenerationComposerPromptValue(prompt, data.config.prompt);
            fixture._renderGenerationComposerReferences('test');
        });
        const after = await page.evaluate(() => window.citationFixture.data.config.referenceCitationOccurrences);
        assert.deepEqual(after, before.occurrences);
        // Materialized/reopened composers have new connection IDs but the same source nodes.
        await page.evaluate(() => {
            const { fixture, references } = window.citationFixture;
            references.forEach(reference => { reference.connection.id += '-materialized'; });
            fixture._renderGenerationComposerReferences('test');
        });
        assert.deepEqual(await pills.allTextContents(), ['图一', '图一', '图二']);
        assert.deepEqual(await page.evaluate(() => window.citationFixture.data.config.referenceCitationOccurrences.map(entry => entry.connectionId)),
            ['first-materialized', 'first-materialized', 'second-materialized']);
        await first.focus();
        await page.keyboard.press('Enter');
        assert.equal(await pills.count(), 4);
        // Simulate keyboard removal and the composer's input synchronization.
        await page.evaluate(() => {
            const { fixture, data, prompt } = window.citationFixture;
            prompt.querySelector('[data-citation-id]').remove();
            fixture._syncGenerationComposerCitationsFromPrompt(data, prompt);
            fixture._renderGenerationComposerReferences('test');
        });
        assert.equal(await pills.count(), 3);
        await page.evaluate(() => {
            const { fixture, references } = window.citationFixture;
            references.shift();
            fixture._renderGenerationComposerReferences('test');
        });
        assert.equal(await pills.count(), 3);
        assert.equal(await page.locator('.generation-composer-citation.is-missing').count(), 2);
        // Reconnection to the same stable node restores both occurrences; another node cannot hijack them.
        await page.evaluate(firstPath => {
            const { fixture, references } = window.citationFixture;
            references.push({ connection: { id: 'reconnected', transient: true },
                source: { id: 'source-first', filePath: firstPath, mediaType: 'image' } });
            fixture._renderGenerationComposerReferences('test');
        }, previewPaths[0]);
        assert.equal(await page.locator('.generation-composer-citation.is-missing').count(), 0);
        assert.deepEqual((await pills.allTextContents()).sort(), ['图一', '图二', '图二'].sort());
        const preservedText = await page.evaluate(() => {
            const { fixture, prompt } = window.citationFixture;
            return fixture._generationComposerPromptValue(prompt);
        });
        assert.equal(preservedText, before.text);
        while (await pills.count()) await pills.first().click();
        assert.equal(await pills.count(), 0);
        assert.deepEqual(await page.evaluate(() => window.citationFixture.data.config.referenceCitationOccurrences), []);
        // Legacy single-reference configurations migrate with their saved offsets.
        await page.evaluate(() => {
            const { fixture, data, prompt } = window.citationFixture;
            data.config = { prompt: 'A B C', referenceCitationIds: ['second-materialized'], referenceCitationOffsets: { 'second-materialized': 2 } };
            prompt.replaceChildren();
            fixture._setGenerationComposerPromptValue(prompt, data.config.prompt);
            fixture._renderGenerationComposerReferences('test');
        });
        assert.equal(await pills.count(), 1);
        assert.equal(await page.evaluate(() => window.citationFixture.data.config.referenceCitationOccurrences[0].offset), 2);
        await page.evaluate(() => {
            const { fixture, references } = window.citationFixture;
            references.splice(0);
            fixture._renderGenerationComposerReferences('test');
        });
        assert.deepEqual(await pills.allTextContents(), ['引用失联']);
        await pills.click();
        assert.equal(await pills.count(), 0);
        assert.equal(await page.locator('.generation-citation-preview').count(), 0);
        // Many references scroll independently of the prompt and footer at either window width.
        await page.evaluate(() => {
            const { fixture, references, prompt } = window.citationFixture;
            for (let index = 0; index < 20; index += 1) {
                references.push({ connection: { id: `overflow-${index}`, transient: true },
                    source: { id: `overflow-source-${index}`, filePath: `C:/refs/voice-${index}.wav`,
                        mediaType: 'audio', referenceAnnotation: `旁白角色 ${index + 1}` } });
            }
            fixture._renderGenerationComposerReferences('test');
            fixture._setGenerationComposerPromptValue(prompt, '依据参考素材生成视频');
        });
        for (const theme of ['dark', 'light']) {
            for (const width of [900, 420]) {
                await page.setViewportSize({ width, height: 700 });
                await page.evaluate(() => {
                    const { fixture, prompt } = window.citationFixture;
                    fixture._generationComposer.element.style.cssText =
                        'position:fixed;left:12px;top:140px;width:calc(100vw - 24px);z-index:999999';
                    prompt.focus();
                });
                await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
                await page.mouse.move(10, 100);
                await page.waitForFunction(() => [...document.querySelectorAll('.generation-composer-reference')]
                    .every(tile => Math.abs(tile.getBoundingClientRect().width - 40) < 1));
                const beforeScroll = await page.evaluate(() => {
                    const composer = window.citationFixture.fixture._generationComposer.element;
                    const scroll = composer.querySelector('.generation-composer-reference-scroll');
                    scroll.scrollLeft = 0;
                    return { overflow: scroll.scrollWidth > scroll.clientWidth,
                        composerOverflow: composer.scrollWidth - composer.clientWidth,
                        promptLeft: composer.querySelector('[data-prompt]').getBoundingClientRect().left };
                });
                assert.equal(beforeScroll.overflow, true);
                assert.ok(beforeScroll.composerOverflow <= 1, 'Only the reference strip may overflow horizontally');
                await first.hover();
                await first.locator('input').focus();
                await page.mouse.move(10, 100);
                await page.waitForFunction(() => document.querySelector('.generation-composer-reference').getBoundingClientRect().width >= 175);
                assert.equal(await first.locator('input').evaluate(input => input === document.activeElement), true);
                if (process.env.FLOW_CITATIONS_SCREENSHOT) {
                    const screenshot = path.parse(process.env.FLOW_CITATIONS_SCREENSHOT);
                    await page.screenshot({ path: path.join(screenshot.dir, `${screenshot.name}-${theme}-${width}.png`) });
                }
                await page.locator('[data-prompt]').focus();
                await page.waitForFunction(() => document.querySelector('.generation-composer-reference').getBoundingClientRect().width <= 41);
                const scrollBox = await page.locator('.generation-composer-reference-scroll').boundingBox();
                await page.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + 2);
                await page.mouse.wheel(600, 0);
                await page.waitForFunction(() => document.querySelector('.generation-composer-reference-scroll').scrollLeft > 100);
                assert.equal(await page.locator('[data-prompt]').evaluate(prompt => prompt.getBoundingClientRect().left), beforeScroll.promptLeft);
                assert.equal(await page.locator('.generation-composer').evaluate(composer => composer.scrollLeft), 0);
            }
        }
        console.log('Reference citations smoke passed: image/audio add, annotation, repeat, remove, caret, persistence, preview, disconnect, reconnect, reorder, legacy migration.');
    } finally {
        await app?.close();
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
