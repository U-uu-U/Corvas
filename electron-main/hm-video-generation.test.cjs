const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const sharp = require('sharp');

let profile;
let fetchFixture;
let Bridge;
const uploadCacheProfiles = [];
test.after(() => uploadCacheProfiles.forEach(directory => fs.rmSync(directory, { recursive: true, force: true })));
const originalLoad = Module._load;
try {
    Module._load = function (name, ...args) {
        return name === 'electron' ? { app: { getPath: () => profile }, net: { fetch: (...args) => fetchFixture(...args) } }
            : originalLoad.call(this, name, ...args);
    };
    Bridge = require('./mcp-bridge');
} finally { Module._load = originalLoad; }

const mediaUrl = bytes => `https://hm-fixture.test/media/${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

const zhuboModels = [
    ['LongXia-video-seedance2_5-standard-480p-express-PerSecond', '480p', 25, 'art.ravenhash.org'],
    ['LongXia-video-seedance2_5-standard-720p-express-PerSecond', '720p', 25, 'video.zhubo.asia'],
    ['seedance-2.5-480p', '480p', 30, 'cart.ravenhash.org'],
    ['seedance-2.5-720p', '720p', 30, 'art.ravenhash.org'],
    ['seedance-2.5-1080p', '1080p', 30, 'video.zhubo.asia']
];

for (const [caseIndex, [model, resolution, maxDuration, host]] of zhuboModels.entries()) {
    test(`Zhubo ${model} submits 30 image and 10 audio URLs, rejects invalid inputs before upload and resumes GET only`, async () => {
        profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-zhubo-fixed-'));
        uploadCacheProfiles.push(profile);
        const bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory: path.join(profile, 'records') });
        bridge._loadWithPlanService = () => ({ data: { items: [] }, planService: {} });
        const uploadEndpoint = `https://zhubo-fixture.test/upload/${caseIndex}`;
        const generationEndpoint = `https://${host}/v1/${host === 'video.zhubo.asia' ? 'videos' : 'video/generations'}`;
        const request = { prompt: 'Zhubo wire fixture', duration: maxDuration, resolution, ratio: 'adaptive',
            targetDir: profile, addToCanvas: false, cameraFixed: true, generateAudio: true, webSearch: true, watermark: true,
            providerConfig: { endpoint: `https://${host}/v1`, model, apiKey: 'fixture-only',
                temporaryUploadEndpoint: uploadEndpoint, temporaryUploadToken: 'fixture-only' } };
        const expected = {};
        for (const [field, count, extension, wire] of [['sourceReferences', 30, 'png', 'image_urls'], ['audioReferences', 10, 'mp3', 'audio_urls']]) {
            request[field] = [];
            expected[wire] = [];
            for (let index = 0; index < count; index++) {
                const bytes = extension === 'png'
                    ? await sharp({ create: { width: 18, height: 32, channels: 3,
                        background: { r: caseIndex + 20, g: index + 10, b: 160 } } }).png().toBuffer()
                    : Buffer.from(`zhubo-${caseIndex}-${field}-${index}`);
                const filePath = path.join(profile, `${field}-${index}.${extension}`);
                fs.writeFileSync(filePath, bytes);
                request[field].push({ filePath });
                expected[wire].push(mediaUrl(bytes));
            }
        }
        let submissions = 0;
        let uploads = 0;
        const methods = [];
        fetchFixture = async (url, options = {}) => {
            methods.push(options.method || 'GET');
            if (url === uploadEndpoint) {
                const form = await new Response(options.body, { headers: options.headers }).formData();
                uploads++;
                return json({ success: true, url: mediaUrl(Buffer.from(await form.get('file').arrayBuffer())) });
            }
            assert.equal(new URL(url).hostname, host, 'All provider traffic remains intercepted');
            if (url.endsWith('/output.mp4')) return new Response('Zhubo fixture video');
            assert.equal(options.headers.Authorization, 'Bearer fixture-only');
            if (options.method === 'POST') {
                submissions++;
                assert.equal(url, generationEndpoint);
                assert.deepEqual(JSON.parse(options.body), { model, prompt: request.prompt, ratio: '9:16',
                    seconds: maxDuration, resolution, ...expected });
                return json({ id: 'zhubo-task', status: 'queued' });
            }
            const query = host === 'video.zhubo.asia' ? '' : `?model=${encodeURIComponent(model)}`;
            assert.equal(url, `${generationEndpoint}/zhubo-task${query}`);
            return json({ id: 'zhubo-task', status: 'completed', video_url: `https://${host}/output.mp4` });
        };
        const generated = await bridge._generateVideoFromRenderer(request, AbortSignal.timeout(5000));
        assert.equal(uploads, 40);
        assert.equal(submissions, 1);
        assert.ok(fs.existsSync(generated.filePath));
        const recoveryStart = methods.length;
        await bridge._resumeVideoFromRenderer({ ...request, taskId: 'zhubo-task' }, AbortSignal.timeout(5000));
        assert.ok(methods.length > recoveryStart);
        assert.ok(methods.slice(recoveryStart).every(method => method === 'GET'));

        const extraImage = path.join(profile, 'extra.png'), extraAudio = path.join(profile, 'extra.mp3');
        const video = path.join(profile, 'unsupported.mp4'), badAudio = path.join(profile, 'unsupported.aac');
        fs.copyFileSync(request.sourceReferences[0].filePath, extraImage);
        fs.copyFileSync(request.audioReferences[0].filePath, extraAudio);
        fs.writeFileSync(video, 'unsupported video');
        fs.writeFileSync(badAudio, 'unsupported audio');
        const invalidStart = methods.length;
        for (const [overrides, pattern] of [
            [{ sourceReferences: [...request.sourceReferences, { filePath: extraImage }] }, /最多支持 30/],
            [{ audioReferences: [...request.audioReferences, { filePath: extraAudio }] }, /最多支持 10/],
            [{ videoReferences: [{ filePath: video }] }, /最多支持 0/],
            [{ audioReferences: [{ filePath: badAudio }] }, /仅支持/],
            [{ duration: 3 }, /时长/], [{ duration: maxDuration + 1 }, /时长/], [{ duration: 4.5 }, /时长/],
            [{ duration: 'unknown' }, /时长/], [{ resolution: resolution === '480p' ? '720p' : '480p' }, /仅支持/],
            [{ ratio: '21:9' }, /画幅/]
        ]) {
            await assert.rejects(() => bridge._generateVideoFromRenderer({ ...request, ...overrides }), pattern);
        }
        for (const [field, extension] of [['sourceReferences', 'png'], ['audioReferences', 'mp3'], ['videoReferences', 'mp4']]) {
            await assert.rejects(() => bridge._generateVideoFromRenderer({ ...request,
                [field]: [{ filePath: path.join(profile, `missing.${extension}`) }] }), /参考素材不存在或格式不支持/);
        }
        fs.truncateSync(extraImage, 20 * 1024 * 1024 + 1);
        fs.truncateSync(extraAudio, (maxDuration === 25 ? 15 : 20) * 1024 * 1024 + 1);
        await assert.rejects(() => bridge._generateVideoFromRenderer({ ...request, sourceReferences: [{ filePath: extraImage }] }), /图片不能超过 20/);
        await assert.rejects(() => bridge._generateVideoFromRenderer({ ...request, audioReferences: [{ filePath: extraAudio }] }), /音频参考不能超过/);
        assert.equal(methods.length, invalidStart, 'Invalid inputs never reach upload or generation endpoints');

        const uploadFailureImage = path.join(profile, 'upload-failure.png');
        await sharp({ create: { width: 16, height: 9, channels: 3, background: '#abcdee' } }).png().toFile(uploadFailureImage);
        fetchFixture = async (url, options = {}) => {
            assert.notEqual(url, generationEndpoint, 'Failed uploads must never fall back to a Base64 generation');
            assert.equal(options.method, 'POST');
            return new Response('fixture upload refused', { status: 400 });
        };
        await assert.rejects(() => bridge._generateVideoFromRenderer({ ...request,
            sourceReferences: [{ filePath: uploadFailureImage }], audioReferences: [] }), /临时上传失败/);
        assert.equal(submissions, 1);
    });
}

test('HM submit wrapped as a status URL persists its task ID then polls with relay authentication', async t => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-hm-wrapped-'));
    t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
    const bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory: path.join(profile, 'records') });
    bridge._loadWithPlanService = () => ({ data: { items: [] }, planService: {} });
    let posts = 0;
    let polls = 0;
    let downloads = 0;
    fetchFixture = async (url, options) => {
        if (options.method === 'POST') {
            posts++;
            return json({ created: 1789653371, data: [{ url: 'https://supplier.example/v1/videos/task_10194' }] });
        }
        assert.equal(new URL(url).hostname, 'relay.example', 'must not download or send relay credentials to the supplier task URL');
        if (url.endsWith('/output.mp4')) {
            downloads++;
            return new Response('video fixture');
        }
        polls++;
        assert.equal(options.headers.Authorization, 'Bearer fixture-key');
        assert.equal(bridge.recoveryStore.get('local-task').taskId, 'task_10194');
        assert.match(url, /\/task_10194\?model=seedance_v2.5$/);
        return json({ id: 'task_10194', status: 'completed', video_url: 'https://relay.example/output.mp4' });
    };
    const result = await bridge.generateVideoFromRenderer({ clientTaskId: 'local-task', nodeId: 'node',
        prompt: 'fixture', duration: 9, targetDir: profile, addToCanvas: false,
        providerConfig: { endpoint: 'https://relay.example/v1', model: 'seedance_v2.5', apiKey: 'fixture-key' } });
    assert.equal(result.taskId, 'task_10194');
    assert.deepEqual([posts, polls, downloads], [1, 1, 1]);
    assert.equal(fs.readFileSync(result.filePath, 'utf8'), 'video fixture');
});

test('Zhubo Pro preserves 480p through the full submission and recovery pipeline', async t => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-zhubo-pro-'));
    t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
    const bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory: path.join(profile, 'records') });
    bridge._loadWithPlanService = () => ({ data: { items: [] }, planService: {} });
    let posts = 0;
    fetchFixture = async (url, options = {}) => {
        assert.equal(new URL(url).hostname, 'pro-fixture.test');
        if (url.endsWith('/output.mp4')) return new Response('fixture video');
        if (options.method === 'POST') {
            posts++;
            assert.deepEqual(JSON.parse(options.body), { model: 'seedance-2.5-pro', prompt: 'fixture', seconds: 4, ratio: '16:9', resolution: '480p' });
        }
        return json({ id: 'pro-task', status: 'completed', video_url: 'https://pro-fixture.test/output.mp4' });
    };
    const request = { prompt: 'fixture', duration: 4, resolution: '480p', ratio: '16:9', targetDir: profile, addToCanvas: false,
        providerConfig: { endpoint: 'https://pro-fixture.test/v1', model: 'seedance-2.5-pro', apiKey: 'fixture-only' } };
    const generated = await bridge._generateVideoFromRenderer(request);
    assert.ok(fs.existsSync(generated.filePath));
    await bridge._resumeVideoFromRenderer({ ...request, taskId: 'pro-task' });
    assert.equal(posts, 1);
});

test('Yueqi 720 route carries video and audio references without the legacy zero-reference limit', async () => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-yueqi-720-'));
    // The bridge's upload cache persists across tests in this process.
    uploadCacheProfiles.push(profile);
    const bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory: path.join(profile, 'records') });
    bridge._loadWithPlanService = () => ({ data: { items: [] }, planService: {} });
    const request = { prompt: 'fixture', duration: 60, resolution: '720p', ratio: '16:9', targetDir: profile, addToCanvas: false,
        providerConfig: { endpoint: 'https://art.ravenhash.org/v1', model: 'seedance-2.5-pro-720', apiKey: 'fixture-only',
            temporaryUploadEndpoint: 'https://yueqi-fixture.test/upload', temporaryUploadToken: 'fixture-only' } };
    const expected = {};
    for (const [field, extension, wire] of [['sourceReferences', 'png', 'image_urls'],
        ['videoReferences', 'mp4', 'video_urls'], ['audioReferences', 'mp3', 'audio_urls']]) {
        const bytes = extension === 'png'
            ? await sharp({ create: { width: 8, height: 8, channels: 3, background: '#cccccc' } }).png().toBuffer()
            : Buffer.from(field);
        const filePath = path.join(profile, `reference.${extension}`);
        fs.writeFileSync(filePath, bytes);
        request[field] = [{ filePath }];
        expected[wire] = [mediaUrl(bytes)];
    }
    let submissions = 0;
    let uploads = 0;
    fetchFixture = async (url, options = {}) => {
        if (url === 'https://yueqi-fixture.test/upload') {
            const form = await new Response(options.body, { headers: options.headers }).formData();
            uploads++;
            return json({ success: true, url: mediaUrl(Buffer.from(await form.get('file').arrayBuffer())) });
        }
        assert.equal(new URL(url).hostname, 'art.ravenhash.org', 'Every request is intercepted by this fixture');
        if (url.endsWith('/output.mp4')) return new Response('fixture video');
        if (options.method === 'POST') {
            submissions++;
            assert.equal(url, 'https://art.ravenhash.org/v1/video/generations');
            assert.deepEqual(JSON.parse(options.body), { model: 'seedance-2.5-pro-720', prompt: 'fixture',
                seconds: 60, resolution: '720p', ratio: '16:9', ...expected });
        }
        return json({ id: 'yueqi-existing-task', status: 'completed', video_url: 'https://art.ravenhash.org/output.mp4' });
    };
    const result = await bridge._generateVideoFromRenderer(request);
    assert.ok(fs.existsSync(result.filePath));
    assert.equal(uploads, 3);
    await bridge._resumeVideoFromRenderer({ ...request, taskId: 'yueqi-existing-task' });
    assert.equal(submissions, 1, 'Recovery only queries the existing job');
});

for (const [hostIndex, host] of ['art.ravenhash.org', 'cart.ravenhash.org', 'yueqi.icu'].entries()) {
    test(`SD2 Fast ${host} submits 9 image URLs and 3 video URLs, resolves adaptive ratio and only polls on recovery`, async () => {
        profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-sd2-fast-'));
        uploadCacheProfiles.push(profile);
        const bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory: path.join(profile, 'records') });
        bridge._loadWithPlanService = () => ({ data: { items: [] }, planService: {} });
        const uploadEndpoint = `https://sd2-fast-fixture.test/upload/${hostIndex}`;
        const generationEndpoint = `https://${host}/v1/${host === 'yueqi.icu' ? 'videos' : 'video/generations'}`;
        const request = { prompt: 'SD2 Fast wire fixture', duration: 12, resolution: '720p', ratio: 'adaptive',
            targetDir: profile, addToCanvas: false, cameraFixed: true, generateAudio: true, webSearch: true, watermark: true,
            providerConfig: { endpoint: `https://${host}/v1`, model: 'sd2-fast', apiKey: 'fixture-only',
                temporaryUploadEndpoint: uploadEndpoint, temporaryUploadToken: 'fixture-only' } };
        const expected = {};
        for (const [field, count, extension, wire] of [['sourceReferences', 9, 'png', 'image_urls'],
            ['videoReferences', 3, 'mp4', 'video_urls']]) {
            request[field] = [];
            expected[wire] = [];
            for (let index = 0; index < count; index++) {
                const bytes = extension === 'png'
                    ? await sharp({ create: { width: 18, height: 32, channels: 3,
                        background: { r: hostIndex + 100, g: index + 100, b: 60 } } }).png().toBuffer()
                    : Buffer.from(`sd2-fast-${host}-${field}-${index}`);
                const filePath = path.join(profile, `${field}-${index}.${extension}`);
                fs.writeFileSync(filePath, bytes);
                request[field].push({ filePath });
                expected[wire].push(mediaUrl(bytes));
            }
        }
        let submissions = 0;
        let uploads = 0;
        const methods = [];
        fetchFixture = async (url, options = {}) => {
            methods.push(options.method || 'GET');
            if (url === uploadEndpoint) {
                assert.equal(options.method, 'POST');
                const form = await new Response(options.body, { headers: options.headers }).formData();
                uploads++;
                return json({ success: true, url: mediaUrl(Buffer.from(await form.get('file').arrayBuffer())) });
            }
            assert.equal(new URL(url).hostname, host, 'All upstream and relay traffic must stay intercepted');
            if (url.endsWith('/output.mp4')) return new Response('SD2 Fast fixture video');
            assert.equal(options.headers.Authorization, 'Bearer fixture-only');
            if (options.method === 'POST') {
                submissions++;
                assert.equal(url, generationEndpoint);
                // This schema avoids the upstream Go Alias.images string decode error.
                assert.deepEqual(JSON.parse(options.body), { model: 'sd2-fast', prompt: request.prompt,
                    aspect_ratio: '9:16', duration: 12, seconds: '12', resolution: '720p', ...expected });
                return json({ id: 'sd2-fast-task', status: 'queued' });
            } else {
                const query = host === 'yueqi.icu' ? '' : '?model=sd2-fast';
                assert.equal(url, `${generationEndpoint}/sd2-fast-task${query}`);
            }
            return json({ id: 'sd2-fast-task', status: 'completed', video_url: `https://${host}/output.mp4` });
        };
        const generated = await bridge._generateVideoFromRenderer(request, AbortSignal.timeout(5000));
        assert.equal(uploads, 12);
        assert.equal(submissions, 1);
        assert.ok(fs.existsSync(generated.filePath));

        const recoveryStart = methods.length;
        await bridge._resumeVideoFromRenderer({ ...request, taskId: 'sd2-fast-task' }, AbortSignal.timeout(5000));
        assert.ok(methods.length > recoveryStart);
        assert.ok(methods.slice(recoveryStart).every(method => method === 'GET'), 'Recovery must not upload or resubmit');

        const audioPath = path.join(profile, 'unsupported.mp3');
        const extraImagePath = path.join(profile, 'extra.png');
        const extraVideoPath = path.join(profile, 'extra.mp4');
        fs.writeFileSync(audioPath, 'unsupported audio fixture');
        fs.copyFileSync(request.sourceReferences[0].filePath, extraImagePath);
        fs.copyFileSync(request.videoReferences[0].filePath, extraVideoPath);
        const invalidRequests = [
            { ...request, sourceReferences: [...request.sourceReferences, { filePath: extraImagePath }] },
            { ...request, videoReferences: [...request.videoReferences, { filePath: extraVideoPath }] },
            { ...request, audioReferences: [{ filePath: audioPath }] }
        ];
        const invalidStart = methods.length;
        for (const invalid of invalidRequests) {
            await assert.rejects(() => bridge._generateVideoFromRenderer(invalid), /最多支持/);
        }
        assert.equal(methods.length, invalidStart, 'Unsupported references must be rejected before uploading or submitting');
        for (const [field, extension] of [['sourceReferences', 'png'], ['videoReferences', 'mp4'], ['audioReferences', 'mp3']]) {
            const missing = { ...request, [field]: [{ filePath: path.join(profile, `missing.${extension}`) }] };
            await assert.rejects(() => bridge._generateVideoFromRenderer(missing), /参考素材不存在或格式不支持/);
        }
        assert.equal(methods.length, invalidStart, 'Missing references must not be silently dropped before submitting');
        assert.equal(submissions, 1);
    });
}

for (const [hostIndex, host] of ['art.ravenhash.org', 'cart.ravenhash.org'].entries()) {
    test(`Dola 30 ${host} submits 10 public image URLs, enforces fixed options and resumes with GET only`, async () => {
        profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-shanhai-30-relay-'));
        uploadCacheProfiles.push(profile);
        const bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory: path.join(profile, 'records') });
        bridge._loadWithPlanService = () => ({ data: { items: [] }, planService: {} });
        const uploadEndpoint = `https://shanhai-30-fixture.test/upload/${hostIndex}`;
        const generationEndpoint = `https://${host}/v1/video/generations`;
        const request = { prompt: 'Dola 30 wire fixture', resolution: '720p', ratio: '21:9',
            targetDir: profile, addToCanvas: false, cameraFixed: true, generateAudio: true, webSearch: true, watermark: true,
            providerConfig: { endpoint: `https://${host}/v1`, model: 'oc-model-r5cfh8', apiKey: 'fixture-only',
                temporaryUploadEndpoint: uploadEndpoint, temporaryUploadToken: 'fixture-only' }, sourceReferences: [] };
        const expectedImages = [];
        for (let index = 0; index < 10; index++) {
            const bytes = await sharp({ create: { width: 16, height: 9, channels: 3,
                background: { r: hostIndex + 50, g: index + 40, b: 70 } } }).png().toBuffer();
            const filePath = path.join(profile, `reference-${index}.png`);
            fs.writeFileSync(filePath, bytes);
            request.sourceReferences.push({ filePath });
            expectedImages.push(mediaUrl(bytes));
        }
        let submissions = 0;
        let uploads = 0;
        const methods = [];
        fetchFixture = async (url, options = {}) => {
            methods.push(options.method || 'GET');
            if (url === uploadEndpoint) {
                assert.equal(options.method, 'POST');
                const form = await new Response(options.body, { headers: options.headers }).formData();
                uploads++;
                return json({ success: true, url: mediaUrl(Buffer.from(await form.get('file').arrayBuffer())) });
            }
            assert.equal(new URL(url).hostname, host, 'Every request must stay intercepted');
            if (url.endsWith('/output.mp4')) return new Response('Dola 30 fixture video');
            assert.equal(options.headers.Authorization, 'Bearer fixture-only');
            if (options.method === 'POST') {
                submissions++;
                assert.equal(url, generationEndpoint);
                assert.deepEqual(JSON.parse(options.body), { model: 'oc-model-r5cfh8', prompt: request.prompt,
                    aspect_ratio: '21:9', duration: 30, resolution: '720p', image_urls: expectedImages });
                return json({ id: 'dola-30-task', status: 'queued' });
            }
            assert.equal(url, `${generationEndpoint}/dola-30-task?model=oc-model-r5cfh8`);
            return json({ id: 'dola-30-task', status: 'completed', video_url: `https://${host}/output.mp4` });
        };
        const generated = await bridge._generateVideoFromRenderer(request, AbortSignal.timeout(5000));
        assert.equal(uploads, 10);
        assert.equal(submissions, 1);
        assert.ok(fs.existsSync(generated.filePath));
        const recoveryStart = methods.length;
        await bridge._resumeVideoFromRenderer({ ...request, taskId: 'dola-30-task' }, AbortSignal.timeout(5000));
        assert.ok(methods.length > recoveryStart);
        assert.ok(methods.slice(recoveryStart).every(method => method === 'GET'));

        const videoPath = path.join(profile, 'unsupported.mp4');
        const audioPath = path.join(profile, 'unsupported.mp3');
        const extraPath = path.join(profile, 'extra.png');
        fs.writeFileSync(videoPath, 'unsupported video fixture');
        fs.writeFileSync(audioPath, 'unsupported audio fixture');
        fs.copyFileSync(request.sourceReferences[0].filePath, extraPath);
        const invalidStart = methods.length;
        const invalidRequests = [
            [{ sourceReferences: [...request.sourceReferences, { filePath: extraPath }] }, /最多支持 10/],
            [{ videoReferences: [{ filePath: videoPath }] }, /最多支持 0/],
            [{ audioReferences: [{ filePath: audioPath }] }, /最多支持 0/],
            [{ duration: 15 }, /时长/],
            [{ duration: 31 }, /时长/],
            [{ resolution: '480p' }, /分辨率/],
            [{ ratio: '2:1' }, /画幅/]
        ];
        for (const [overrides, pattern] of invalidRequests) {
            await assert.rejects(() => bridge._generateVideoFromRenderer({ ...request, ...overrides }), pattern);
        }
        for (const [field, extension] of [['sourceReferences', 'png'], ['videoReferences', 'mp4'], ['audioReferences', 'mp3']]) {
            await assert.rejects(() => bridge._generateVideoFromRenderer({ ...request,
                [field]: [{ filePath: path.join(profile, `missing.${extension}`) }] }), /参考素材不存在或格式不支持/);
        }
        assert.equal(methods.length, invalidStart, 'Invalid inputs must fail before uploads or submissions');
        assert.equal(submissions, 1);
    });
}

test('direct video recovery keeps every original bound medium in the landed generation record', async t => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-video-reuse-'));
    t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
    const data = { items: [] };
    const bridge = new Bridge({ store: { load: () => data }, recoveryDirectory: path.join(profile, 'records') });
    bridge._loadWithPlanService = () => ({ data, planService: {} });
    bridge._saveAndNotify = () => {};
    fetchFixture = async (url, options = {}) => {
        assert.notEqual(options.method, 'POST', 'Recovery must only query the existing task');
        return url.endsWith('/output.mp4') ? new Response('fixture video')
            : json({ id: 'existing-task', status: 'completed', video_url: 'https://pro-fixture.test/output.mp4' });
    };
    const referenceBindings = ['image', 'video', 'audio'].map((mediaType, index) => ({
        position: index + 1, sourceNodeId: `original-${index}`, filePath: `/original.${['png', 'mp4', 'wav'][index]}`, mediaType
    }));
    const result = await bridge._resumeVideoFromRenderer({ prompt: 'fixture', taskId: 'existing-task', targetDir: profile,
        referenceBindings, providerConfig: { endpoint: 'https://pro-fixture.test/v1', model: 'seedance-2.5-pro', apiKey: 'fixture-only' } });
    assert.deepEqual(result.item.generation.references, referenceBindings.map(binding => ({
        itemId: binding.sourceNodeId, filePath: binding.filePath, mediaType: binding.mediaType
    })));
});

test('HM 301010 transports all 50 references, preserves order and supports task-ID recovery', { timeout: 15000 }, async t => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-hm-'));
    t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
    const bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory: path.join(profile, 'records') });
    bridge._loadWithPlanService = () => ({ data: { items: [] }, planService: {} });
    const body = { prompt: 'reference order fixture', duration: 4, ratio: '16:9', targetDir: profile, addToCanvas: false,
        providerConfig: { endpoint: 'https://hm-fixture.test/v1', model: 'seedance_v2.5-301010', apiKey: 'fixture-only',
            temporaryUploadEndpoint: 'https://hm-fixture.test/upload', temporaryUploadToken: 'fixture-only' } };
    const expected = {};
    for (const [field, count, ext, wire] of [['sourceReferences', 30, 'png', 'image_urls'],
        ['videoReferences', 10, 'mp4', 'video_urls'], ['audioReferences', 10, 'mp3', 'audio_urls']]) {
        body[field] = [];
        expected[wire] = [];
        for (let i = 0; i < count; i++) {
            const bytes = ext === 'png'
                ? await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: i, g: 80, b: 80 } } }).png().toBuffer()
                : Buffer.from(`${field}-${i}`);
            const filePath = path.join(profile, `${field}-${i}.${ext}`);
            fs.writeFileSync(filePath, bytes);
            body[field].push({ filePath });
            expected[wire].push(mediaUrl(bytes));
        }
    }
    let posts = 0;
    let uploads = 0;
    fetchFixture = async (url, options = {}) => {
        assert.equal(new URL(url).hostname, 'hm-fixture.test', 'mock must not use a live upstream');
        if (url.endsWith('/upload')) {
            const form = await new Response(options.body, { headers: options.headers }).formData();
            const bytes = Buffer.from(await form.get('file').arrayBuffer());
            uploads++;
            return json({ success: true, url: mediaUrl(bytes) });
        }
        if (url.endsWith('/output.mp4')) return new Response('fixture video');
        if (options.method === 'POST') {
            posts++;
            assert.equal(url, 'https://hm-fixture.test/v1/video/generations');
            assert.deepEqual(JSON.parse(options.body), { model: body.providerConfig.model, prompt: body.prompt,
                seconds: 4, ratio: '16:9', resolution: '720p', ...expected });
        } else assert.match(url, /fixture-task/);
        return json({ id: 'fixture-task', status: 'completed', video_url: 'https://hm-fixture.test/output.mp4' });
    };
    const generated = await bridge._generateVideoFromRenderer(body);
    assert.equal(uploads, 50);
    assert.equal(posts, 1);
    assert.ok(fs.existsSync(generated.filePath));
    await bridge._resumeVideoFromRenderer({ ...body, taskId: 'fixture-task' });
    assert.equal(posts, 1, 'recovery must not resubmit a billed request');
    for (const field of ['sourceReferences', 'videoReferences', 'audioReferences']) {
        const extraPath = path.join(profile, `extra-${field}${path.extname(body[field][0].filePath)}`);
        fs.copyFileSync(body[field][0].filePath, extraPath);
        await assert.rejects(() => bridge._generateVideoFromRenderer({ ...body,
            [field]: [...body[field], { filePath: extraPath }] }), /最多支持/);
    }
    assert.equal(posts, 1, 'over-limit input must not create another task');
});
