// Runs in the website's main world. Read only the stores already used by the
// loaded Studio module; never return cookies, account data or whole store objects.
async function readCurrentStudioModel() {
    if (location.origin !== 'https://3d.hunyuan.tencent.com' || !location.pathname.startsWith('/studio/')) {
        return { error: '请先登录并打开 3D Studio 中的模型' };
    }
    const script = [...document.scripts].find(element => element.type === 'module'
        && /^https:\/\/cdn-game-3d\.qstatic\.com\/game3d\/assets\/index-[^/]+\.js$/.test(element.src));
    if (!script) return { error: '尚未读取到 3D Studio 页面，请等待加载完成' };
    const module = await import(script.src);
    let assetStore, modelStore;
    for (const value of Object.values(module)) {
        if (typeof value?.getState !== 'function') continue;
        const state = value.getState();
        if (state && Array.isArray(state.assets) && 'currentWorksId' in state && 'currentAsset' in state) assetStore = value;
        if (state && typeof state.modelUrl === 'string' && 'isUploadModel' in state && 'hasUnsavedChanges' in state) modelStore = value;
    }
    if (!assetStore || !modelStore) return { error: '当前页面的模型读取接口不可用，请重新打开混元窗口' };
    const asset = assetStore.getState().currentAsset;
    const model = modelStore.getState();
    if (model.hasUnsavedChanges) return { error: '请先保存页面中的模型修改，再导入 Rhino' };
    if (model.isUploadModel) return { error: '请先将上传的模型保存为混元资产，再导入 Rhino' };
    if (!asset || !model.modelUrl) return { error: '请先选中一个已生成的模型，等待页面加载' };
    const responseKeys = { 2: 'geometryGenerationRsp', 3: 'componentSplittingRsp', 4: 'lowPolyTopologyRsp',
        5: 'uvUnwrappingRsp', 6: 'texturePaintingRsp', 7: 'boneSkinningRsp', 8: 'motionRetargetRsp' };
    const response = asset.modelInfo?.[responseKeys[asset.worksPipeline]];
    return { worksId: String(asset.worksId || ''), submittedAt: String(asset.submittedAt || ''),
        status: Number(asset.pipelineStatus), pipeline: Number(asset.worksPipeline), modelUrl: model.modelUrl,
        assetModelUrl: response?.fbxUrl || response?.glbUrl || '',
        label: String(asset.name || asset.title || '当前页面模型').slice(0, 60) };
}

module.exports = { readCurrentStudioModel };
