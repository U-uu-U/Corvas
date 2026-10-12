import assert from 'node:assert/strict';
import { models, addCatalogModels } from './catalog.mjs';

export const existingSpec = models.find(spec => spec.id === 'ravenhash-video.ft20-933');
export const newSpec = models.find(spec => spec.id === 'ravenhash-video.ft20-longterm');

export function updateSeedance20Catalog(current) {
    const config = addCatalogModels(current, [newSpec]);
    const existing = config.models.find(entry => entry.id === existingSpec.id);
    assert.ok(existing && existing.catalog?.model === existingSpec.model, 'Existing 933 entry missing');
    const group = config.catalogGroups.find(entry => entry.id === newSpec.group);
    const added = config.models.at(-1);
    existing.catalog.enabled = true;
    const presentation = existing.presentation ||= {};
    if (presentation.routeGroup !== group.id) {
        presentation.routeOrder = added.presentation.routeOrder;
        added.presentation.routeOrder++;
    }
    Object.assign(presentation, { visible: true, routeGroup: group.id, routeGroupLabel: group.label,
        routeGroupOrder: group.order, routeGroupDescription: group.description || '', routeGroupAlways: true, routeGroupScope: 'catalog' });
    for (const entry of current.models) {
        if (entry.id !== existingSpec.id) assert.deepEqual(config.models.find(candidate => candidate.id === entry.id), entry);
    }
    return config;
}
