export function selectGenerationHealth(entry, endpoint) {
    let host;
    try { host = new URL(endpoint).hostname.toLowerCase(); } catch { return null; }
    const metrics = entry?.generationHealth?.filter(value => value.host === host);
    if (metrics?.length !== 1) return null;
    const timings = entry.generationHealthTimings?.filter(value => value.host === host);
    return timings?.length === 1 && Array.isArray(timings[0].seconds) && timings[0].seconds.length === metrics[0].samples?.length
        ? { ...metrics[0], sampleDurationsSeconds: timings[0].seconds } : metrics[0];
}

export function describeGenerationHealth(metric, now = Date.now()) {
    const fresh = metric && Number.isFinite(Date.parse(metric.validUntil)) && now <= Date.parse(metric.validUntil);
    const state = fresh && ['available', 'degraded'].includes(metric.state) ? metric.state : 'unknown';
    const labels = { available: '近期可用', degraded: '近期不稳定', unknown: '状态待确认' };
    const samples = Array.isArray(metric?.samples) ? metric.samples.slice(-50) : [];
    const seconds = Math.round(metric?.averageSeconds);
    const timed = fresh && Number.isFinite(metric?.averageSeconds) && seconds >= 0 && metric.durationSamples > 0;
    const duration = !timed ? '平均 --' : seconds < 60 ? `平均 ${seconds}秒`
        : `平均 ${Math.floor(seconds / 60)}分${seconds % 60}秒`;
    const reason = !metric ? '暂无统计' : !fresh || metric.reason === 'stale' ? '统计已过期'
        : metric.reason === 'insufficient' ? '有效样本不足' : metric.reason === 'unavailable' ? '统计暂不可用'
            : metric.reason === 'no_data' ? '暂无近期任务' : '';
    const title = [labels[state], reason, `最近 ${samples.length} 次任务：成功 ${metric?.successCount || 0}，服务失败 ${metric?.failureCount || 0}`,
        '黄色：成功，但生成耗时超过 30 分钟',
        `平均耗时样本 ${metric?.durationSamples || 0} 次（含排队）`,
        `参数、账户或审核等原因排除 ${metric?.excludedCount || 0} 次`].filter(Boolean).join('\n');
    // The aggregate needs multiple samples; each confirmed task is still observable.
    const showSamples = fresh && (state !== 'unknown' || metric.reason === 'insufficient');
    const lights = samples.map((value, index) => {
        if (!showSamples) return 'unknown';
        const elapsed = metric?.sampleDurationsSeconds?.[index];
        if (value === 'success' && Number.isFinite(elapsed) && elapsed > 1800) return 'slow';
        return ['success', 'failure'].includes(value) ? value : 'unknown';
    }).slice(-10);
    return { state, duration, title, samples: [...Array(Math.max(0, 10 - lights.length)).fill('unknown'), ...lights] };
}
