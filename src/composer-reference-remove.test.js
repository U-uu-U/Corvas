import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const originalLoad = Module._load;
let CanvasManager;
try {
    Module._load = function (name, ...args) { return name === 'canvas' ? {} : originalLoad.call(this, name, ...args); };
    ({ CanvasManager } = await import('./canvas.js'));
} finally { Module._load = originalLoad; }

function fixture(transient) {
    const sources = ['image', 'video', 'audio'].map(mediaType => ({ id: mediaType, kind: 'media', mediaType, filePath: `/fixture/${mediaType}.media` }));
    const data = { id: 'target', kind: 'op', nodeType: 'video', config: {}, ...(transient ? {
        composerDraft: true, composerSourceItemId: 'image', composerUseSourceAsReference: true,
        composerReferenceItemIds: ['video', 'audio'], composerReferenceConnections: [{ nodeId: 'video' }, { nodeId: 'audio' }]
    } : {}) };
    const manager = Object.assign(Object.create(CanvasManager.prototype), {
        items: new Map([...sources, data].map(item => [item.id, { data: item }])),
        _generationComposer: { nodeId: 'target', changed: false },
        _getItemMediaType: item => item.mediaType,
        _copyableFilePath: item => item.filePath,
        _connectionOutputDataType: connection => connection.from.nodeId === 'audio' ? 'file' : connection.from.nodeId,
        emit() {},
        _renderGenerationComposerReferences() { this._generationComposerCitationState(data); }
    });
    manager.graphView = {
        connections: transient ? [] : sources.map(source => ({ id: source.id+'-edge', from: { nodeId: source.id, port: 'out' }, to: { nodeId: data.id, port: 'source' } })),
        disconnect(id) { this.connections = this.connections.filter(connection => connection.id !== id); }
    };
    data.config.referenceCitationOccurrences = manager._opReferenceEntries(data).map(({ connection, source }) => ({
        id: source.id+'-citation', connectionId: connection.id, sourceNodeId: source.id, offset: 0
    }));
    return { manager, data, sources };
}

test('draft references can all be removed without materializing or deleting source nodes', () => {
    const { manager, data, sources } = fixture(true);
    for (const source of sources) {
        const entry = manager._opReferenceEntries(data).find(reference => reference.source.id === source.id);
        assert.equal(manager._removeGenerationComposerReference(data.id, entry.connection.id), true);
        assert.ok(manager.items.has(source.id));
        assert.ok(!data.config.referenceCitationOccurrences.some(citation => citation.sourceNodeId === source.id));
    }
    assert.equal(manager.items.size, 4);
    assert.equal(data.composerDraft, true);
    assert.deepEqual(manager._opReferenceEntries(data), []);
    assert.deepEqual(sources[0].generationPromptDraft.excludedReferenceSourceIds, ['image', 'video', 'audio']);
});

test('removing a connected reference deletes only that edge and its prompt citations', () => {
    const { manager, data } = fixture(false);
    assert.equal(manager._removeGenerationComposerReference(data.id, 'audio-edge'), true);
    assert.deepEqual(manager.graphView.connections.map(connection => connection.id), ['image-edge', 'video-edge']);
    assert.equal(manager.items.size, 4);
    assert.deepEqual(data.config.referenceCitationOccurrences.map(citation => citation.sourceNodeId), ['image', 'video']);
    assert.equal(manager._removeGenerationComposerReference('other', 'image-edge'), false);
});
