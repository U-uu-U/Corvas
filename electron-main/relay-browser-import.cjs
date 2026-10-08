const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SITES, findLocalTask } = require('./relay-browser-contract.cjs');

function createRelayImporter({ bridge, store, board, getSaveDir }) {
    return {
        currentProjectId: () => store.load().activeGroupId,
        prepare({ site, task, accountId, index, clientTaskId, projectId: selectedProjectId }) {
            const key = crypto.createHash('sha256').update(JSON.stringify([site, accountId, task.logId, index])).digest('hex').slice(0, 32);
            const original = index === 0 ? findLocalTask(bridge.recoveryStore.list(), site, task.taskId, clientTaskId) : null;
            const id = original?.clientTaskId || `relay-${key}`;
            const previous = bridge.recoveryStore.get(id);
            const projectId = original?.projectId || previous?.projectId || selectedProjectId || store.load().activeGroupId;
            const project = board.readProject(projectId);
            const request = { ...original, kind: 'video', projectId, clientTaskId: id,
                taskId: task.taskId || task.logId, nodeId: original?.nodeId || previous?.nodeId,
                prompt: original?.prompt || '中转站视频',
                providerConfig: { id: original?.providerId || null, model: task.model, endpoint: SITES[site].origin },
                targetDir: original?.targetDir || project.defaultSaveFolder || getSaveDir() };
            request.targetSignature = bridge.captureRecoveryTarget(request);
            try {
                fs.mkdirSync(request.targetDir, { recursive: true });
                fs.accessSync(request.targetDir, fs.constants.W_OK);
            } catch {
                throw Object.assign(new Error('目标素材目录不可写'), { publicMessage: '目标素材目录不可写，请检查画布的保存目录' });
            }
            const filePath = path.join(request.targetDir, `corvas-${key}.mp4`);
            return { request, filePath, existingPath: previous?.result?.filePath && fs.existsSync(previous.result.filePath)
                ? previous.result.filePath : null, site };
        },
        start(context) {
            const id = context.request.clientTaskId;
            bridge.activeGenerationRequests.get(id)?.abort();
            bridge.activeGenerationRequests.get(`recover:${id}`)?.abort();
        },
        async finish(context, filePath) {
            const file = fs.openSync(filePath, 'r');
            const header = Buffer.alloc(16);
            try { fs.readSync(file, header, 0, header.length, 0); } finally { fs.closeSync(file); }
            if (header.toString('ascii', 4, 8) !== 'ftyp' && header.readUInt32BE(0) !== 0x1a45dfa3) {
                throw new Error('下载内容不是支持的视频文件，未导入画布');
            }
            const { request, site } = context;
            bridge.registerMediaFile?.(filePath);
            const result = { filePath, filePaths: [filePath], taskId: request.taskId, mediaType: 'video' };
            bridge._rememberResult(request, result);
            bridge.recoveryStore.update(request.clientTaskId, { taskId: request.taskId,
                params: { ...(request.params || {}), nodeId: request.nodeId }, targetDir: request.targetDir });
            const attached = await bridge.attachRecoveredGeneration(request, result);
            bridge.recoveryStore.update(request.clientTaskId, { state: 'attached', ...attached });
            // Persist the public site/task association, never the upstream media URL.
            await board.updateProject(attached.projectId, project => {
                const node = project.items.find(item => item.id === attached.nodeId);
                if (node) node.generation = { ...node.generation, relaySite: site };
            });
            bridge.notifyTaskCompleted?.({ ...attached, clientTaskId: request.clientTaskId, remoteTaskId: request.taskId,
                filePath, filePaths: [filePath], recovered: true, site, model: request.providerConfig.model });
            return attached;
        }
    };
}

module.exports = { createRelayImporter };
