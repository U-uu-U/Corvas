// Provider-neutral entry points for 3D generation. Callers pick a provider id and use the same
// request, handle and status shapes for Meshy, Tripo and Hyper3D Rodin. See docs/model3d-providers.md.
const path = require('node:path');
const { model3dError, isAbortError, waitForModel3dTask, downloadModel3dOutput, extensionOf, safeFileStem } = require('./model3d-common.cjs');
const { MESHY, createMeshyProvider } = require('./meshy-3d.cjs');
const { TRIPO, createTripoProvider } = require('./tripo-3d.cjs');
const { HYPER3D, createHyper3dProvider } = require('./hyper3d-rodin.cjs');

const MODEL3D_PROVIDERS = Object.freeze({ meshy: MESHY, tripo: TRIPO, hyper3d: HYPER3D });
const FACTORIES = { meshy: createMeshyProvider, tripo: createTripoProvider, hyper3d: createHyper3dProvider };

const listModel3dProviders = () => Object.values(MODEL3D_PROVIDERS);

// `provider` is a provider id plus `config` ({ apiKey, baseUrl, region, fetchImpl }), or an already created provider.
function createModel3dProvider(provider, config = {}) {
    if (provider && typeof provider === 'object' && typeof provider.submit === 'function') return provider;
    const factory = FACTORIES[String(provider || '')];
    if (!factory) throw model3dError('invalid', null, { detail: `未知的 3D 服务：${String(provider || '')}` });
    return factory(config);
}

function primaryOutput(status, handle) {
    const models = (status?.outputs || []).filter(output => output.role === 'model');
    return models.find(output => output.format === handle?.format) || models[0] || null;
}

// The handle is the only record of a billed task, so an error from the caller's onHandle carries it along.
async function saveHandle(onHandle, handle) {
    try { await onHandle?.(handle); } catch (error) { throw Object.assign(error, { handle }); }
}

// Drives a submitted task to its final stage. Some providers need a second billable submission
// (Meshy refine, Tripo convert). Before sending it, the handle is saved with `advancing` set, so a
// crash or an unknown outcome is never followed by a blind resubmission.
// `fresh` is true when `handle` was created a moment ago, as opposed to a saved one being resumed.
async function completeModel3d(provider, handle, { signal, onHandle, onProgress, wait, now, resubmitUnknownStage = false, fresh = false } = {}) {
    const name = provider.info.name;
    let current = handle;
    let created = fresh;
    // The finished stage the current one was submitted from. If the current stage fails, only it needs
    // to be submitted again; the earlier stage is already paid for.
    let previous = null;
    if (current?.advancing) {
        if (!resubmitUnknownStage) {
            throw model3dError('submissionUnknown', name, { handle: current, stage: current.advancing,
                detail: `“${current.advancing}”阶段上次提交结果未知，请先在服务商后台核对` });
        }
        current = { ...current };
        delete current.advancing;
    }
    for (;;) {
        const status = await waitForModel3dTask({ provider: provider.info.id, handle: current, query: provider.query,
            delayMs: provider.pollDelayMs, maxWaitMs: provider.info.maxWaitMs, signal, onProgress, wait, now,
            initialDelayMs: created ? provider.pollDelayMs(0, null) : 0 });
        if (status.state !== 'succeeded') {
            throw model3dError(status.state === 'canceled' ? 'taskCanceled' : 'taskFailed', name, { handle: current, status,
                detail: status.error?.message, remoteCode: status.error?.code ?? null, retryable: Boolean(status.error?.retryable),
                ...(previous ? { retryHandle: previous } : {}) });
        }
        const next = provider.nextStage(current, status);
        if (!next) return { handle: current, status };
        const advancing = { ...current, advancing: next.stage };
        await saveHandle(onHandle, advancing);
        let advanced;
        try {
            advanced = await provider.advance(current, status, { signal });
        } catch (error) {
            // The marker is cleared only when nothing can have been created: a confirmed rejection,
            // or an abort that came before the request went out.
            const nothingSent = Boolean(error?.confirmedFailure) || (isAbortError(error) && error.dispatched === false);
            if (nothingSent) {
                try { await onHandle?.(current); } catch { /* The provider's answer is the error the caller needs. */ }
            }
            throw Object.assign(error, { handle: nothingSent ? current : advancing, stage: next.stage });
        }
        previous = current;
        current = advanced;
        await saveHandle(onHandle, current);
        created = true;
    }
}

// The file name the provider gave an output, without its extension.
function originalStem(output) {
    let name = extensionOf(output.name) ? String(output.name) : '';
    if (!name) {
        try { name = decodeURIComponent(new URL(output.url).pathname.split('/').pop()); } catch { /* Falls back to the role. */ }
    }
    return path.parse(name).name || output.role || 'file';
}

async function finishModel3d(provider, done, { saveDir, baseName, download = 'model', fetchImpl, signal } = {}) {
    const { handle, status } = done;
    const primary = primaryOutput(status, handle);
    const files = [];
    if (saveDir && download) {
        if (!primary) throw model3dError('invalidResponse', provider.info.name, { handle, status, detail: '任务成功但没有返回模型文件' });
        // Result links are short-lived (Tripo: about 5 minutes), so the model is fetched before anything else.
        const all = download === 'all';
        const wanted = all ? [primary, ...status.outputs.filter(output => output !== primary)] : [primary];
        // With 'all', every file keeps the provider's name inside one folder: an OBJ refers to its MTL,
        // and the MTL to its textures, by file name.
        const dir = all ? path.join(saveDir, safeFileStem(baseName)) : saveDir;
        for (const output of wanted) {
            try {
                files.push(await downloadModel3dOutput(output, { dir, fetchImpl, signal, provider: provider.info.name,
                    baseName: all ? originalStem(output) : baseName }));
            } catch (error) {
                if (output === primary || error?.name === 'AbortError') throw Object.assign(error, { handle, status });
            }
        }
    }
    return { provider: provider.info.id, handle, status, outputs: status.outputs, primary, files };
}

// Submits a new task and waits for the final result. `onHandle` receives every handle change and
// must persist it: the handle is the only way to resume after a restart without paying twice.
async function generateModel3d({ provider, config, request, ...options } = {}) {
    const instance = createModel3dProvider(provider, config);
    const handle = await instance.submit(request, { signal: options.signal });
    await saveHandle(options.onHandle, handle);
    const done = await completeModel3d(instance, handle, { ...options, fresh: true });
    return finishModel3d(instance, done, { ...options, fetchImpl: options.fetchImpl ?? config?.fetchImpl });
}

// Continues a task from a saved handle. Never submits the first stage again.
async function resumeModel3d({ provider, config, handle, ...options } = {}) {
    const instance = createModel3dProvider(provider ?? handle?.provider, config);
    if (!handle?.taskId || handle.provider !== instance.info.id) {
        // The record is unusable here, but its task may still be running at the provider.
        throw model3dError('invalid', instance.info.name, { detail: '任务记录与所选服务不匹配', confirmedFailure: false });
    }
    const done = await completeModel3d(instance, handle, options);
    return finishModel3d(instance, done, { ...options, fetchImpl: options.fetchImpl ?? config?.fetchImpl });
}

const queryModel3d = ({ provider, config, handle, signal } = {}) =>
    createModel3dProvider(provider ?? handle?.provider, config).query(handle, { signal });

const cancelModel3d = ({ provider, config, handle, signal } = {}) =>
    createModel3dProvider(provider ?? handle?.provider, config).cancel(handle, { signal });

const getModel3dBalance = ({ provider, config, signal } = {}) => createModel3dProvider(provider, config).balance({ signal });

module.exports = { MODEL3D_PROVIDERS, listModel3dProviders, createModel3dProvider, generateModel3d, resumeModel3d,
    queryModel3d, cancelModel3d, getModel3dBalance, primaryOutput };
