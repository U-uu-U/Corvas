// Runs in the 3D Studio page's main world, like hunyuan-current-model.cjs. It reuses the
// site's own API client (auth and requestId interceptors) and COS uploader, located by
// shape because export names are minified per build. Never returns credentials.
async function submitStudioGeometry(payload) {
    const result = (error, submitted = false, extra = {}) => ({ error, submitted, ...extra });
    if (location.origin !== 'https://3d.hunyuan.tencent.com' || !location.pathname.startsWith('/studio/')) {
        return result('请先登录并打开 3D Studio 页面');
    }
    const script = [...document.scripts].find(element => element.type === 'module'
        && /^https:\/\/cdn-game-3d\.qstatic\.com\/game3d\/assets\/index-[^/]+\.js$/.test(element.src));
    if (!script) return result('尚未读取到 3D Studio 页面，请等待加载完成');
    const values = Object.values(await import(script.src));
    const client = values.find(value => value && typeof value === 'object' && typeof value.post === 'function'
        && typeof value.postRaw === 'function' && typeof value.upload === 'function');
    const uploadToCos = values.find(value => typeof value === 'function'
        && /uploadFile\(\{Bucket/.test(Function.prototype.toString.call(value)));
    if (!client || !uploadToCos) return result('混元页面的上传接口已变化，暂时无法自动提交');
    const urls = {};
    try {
        for (const view of payload.views) {
            const binary = atob(view.data);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
            const file = new File([bytes], view.fileName, { type: view.mimeType });
            const body = await client.post('/game3d/resource/upload', { fileName: view.fileName });
            if (body && typeof body.errNo === 'number' && body.errNo !== 0) return result('混元拒绝了图片上传，请检查登录状态');
            const credentials = body?.data?.bucket ? body.data : body;
            if (!credentials?.bucket || !credentials?.resourceUrl) return result('混元上传凭据格式已变化，暂时无法自动提交');
            const url = String(await uploadToCos({ ...credentials, fileName: view.fileName, file }));
            if (!/^https:\/\//.test(url)) return result('混元图片上传未返回有效地址');
            urls[view.key] = url;
        }
    } catch (_) {
        return result('混元图片上传失败，请检查网络和登录状态后重试');
    }
    // Same body as the site's multi-image tab (GeometryLeftPanel handleCreate).
    const eight = ['v3.1', 'v3.6'].includes(payload.modelVersion);
    const viewsImage = { frontImageUrl: urls.front || '', backImageUrl: urls.back || '', leftImageUrl: urls.left || '',
        rightImageUrl: urls.right || '' };
    if (eight) Object.assign(viewsImage, { topImageUrl: urls.top || '', bottomImageUrl: urls.bottom || '',
        frontLeftImageUrl: '', frontRightImageUrl: '' });
    let response;
    try {
        response = await client.postRaw('/game3d/geometry_generation/views2geometry', {
            modelVersion: payload.modelVersion, viewsImage, faceCount: Number(payload.faceCount) });
    } catch (error) {
        // An HTTP response with an error body is a definite refusal (for example a full task
        // queue). Only a missing response (network/timeout) leaves the outcome unknown.
        const data = error?.response?.data;
        const status = Number(error?.response?.status) || 0;
        if (status && data && typeof data === 'object' && typeof data.errNo === 'number' && data.errNo !== 0) {
            return result(`混元拒绝了生成请求（${data.errNo}）：${String(data.errMsg || data.message || '').slice(0, 120)}`, false,
                { httpStatus: status, errNo: data.errNo });
        }
        if (status >= 400 && status < 500 && status !== 408) {
            return result(`混元拒绝了生成请求（HTTP ${status}）：${String(data?.errMsg || data?.message || '').slice(0, 120)}`, false,
                { httpStatus: status });
        }
        return result(`混元生成请求未返回结果${status ? `（HTTP ${status}）` : ''}，可能已提交，请在作品列表核对`, 'unknown',
            { httpStatus: status || undefined });
    }
    const worksId = String(response?.worksId || response?.data?.worksId || '');
    if (!worksId) {
        if (response && typeof response.errNo === 'number' && response.errNo !== 0) {
            return result(String(response.errMsg || response.message || '混元拒绝了生成请求').slice(0, 160));
        }
        return result('混元生成请求未返回作品编号，可能已提交，请在作品列表核对', 'unknown');
    }
    return { submitted: true, worksId, views: Object.keys(urls) };
}

module.exports = { submitStudioGeometry };
