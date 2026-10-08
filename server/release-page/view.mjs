const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const megabytes = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function releasePage(release) {
    const windows = release.assets.find(asset => asset.platform === 'windows');
    const mac = release.assets.find(asset => asset.platform === 'macos');
    const portable = release.assets.find(asset => asset.platform === 'windows-portable');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Corvas 画布 · 下载与更新</title><meta name="description" content="下载 Corvas：在无限画布中组织素材、连接图片与视频生成流程。">
<link rel="icon" href="/corvas/icon.png"><link rel="stylesheet" href="/corvas/style.css"></head>
<body><header><a class="brand" href="/corvas"><img src="/corvas/icon.png" alt="" width="36" height="36">Corvas</a><nav><a href="#features">功能</a><a href="#release">更新记录</a><a href="/">API 控制台 ↗</a></nav></header>
<main><section class="intro"><p class="eyebrow">图片 · 视频 · 创作工作流</p><h1>Corvas 画布</h1><p class="lead">把素材、提示词和生成结果放在一张画布上。</p>
<p class="version">v${escape(release.version)} <span>${release.channel === 'beta' ? '测试版' : '正式版'}</span></p>
<div class="downloads"><a class="download primary" href="${escape(windows.url)}" download><b>↓ Windows 安装版</b><small>x64 · ${megabytes(windows.bytes)}</small></a>
<a class="download" href="${escape(mac.url)}" download><b>↓ macOS 通用版</b><small>Apple Silicon / Intel · ${megabytes(mac.bytes)}</small></a></div>
<p class="download-extra">${portable ? `<a href="${escape(portable.url)}" download>Windows 便携版</a><span>·</span>` : ''}<a href="/corvas/SHA256SUMS.txt">SHA-256 校验文件</a></p>
</section><section id="features"><h2>主要功能</h2><dl class="features">
<div><dt>无限画布</dt><dd>组织图片、视频、音频与提示词，用连线构建创作流程。</dd></div>
<div><dt>图片与视频生成</dt><dd>在模型卡片中选择渠道、参数和参考素材，统一管理生成结果。</dd></div>
<div><dt>远端模型配置</dt><dd>同步模型列表、能力限制与售价，减少手动维护。</dd></div>
<div><dt>任务记录与恢复</dt><dd>查看生成记录，继续查询已有任务并拉取产物。</dd></div>
<div><dt>渠道状态</dt><dd>在具体模型卡片中查看近期任务表现和平均生成耗时。</dd></div>
<div><dt>错误反馈与排查</dt><dd>显示可操作的错误原因，支持提交错误和 AI 排查建议。</dd></div>
</dl></section><section id="release"><div class="section-heading"><h2>本版更新</h2><time datetime="${escape(release.publishedAt)}">${escape(release.publishedAt.slice(0, 10))}</time></div>
<ul>${release.notes.map(note => `<li>${escape(note)}</li>`).join('')}</ul><p class="meta">Windows 与 macOS 来自同一源版本 · <code>${escape(release.sourceCommit.slice(0, 7))}</code></p></section>
<section class="install"><h2>安装</h2><p>Windows：运行安装程序，按提示选择安装目录。macOS：打开 DMG，将 Corvas 拖入“应用程序”。</p>
<p>macOS 当前版本尚未进行 Apple Developer ID 签名与公证，系统可能需要额外确认。生成服务需要在设置中填写你的 API 地址和 Key。</p></section></main>
<footer><span>Corvas · RavenHash</span><a href="/corvas/api/latest">版本 API</a></footer></body></html>`;
}
