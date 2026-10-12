# 素材处理

2026-10-12 新增本地素材处理工具，入口位于画布工具栏和素材右键菜单。面板可拖动、关闭后继续处理，不阻止画布操作。此功能包含新的主进程 IPC，源码版需要重启 Electron；安装版需要包含本次代码的新版本，不能仅通过模型 CONFIG 添加。

## 支持范围

- 图片：按实际内容识别格式，输出 PNG、JPG、WebP；调整宽高、保持比例、设置 JPG/WebP 质量。JPG 的透明区域使用白色背景。不会覆盖原文件。
- 音频：输出 MP3 或 16-bit PCM WAV；MP3 支持 128/192/320 kbps；通过开始、结束时间截取片段，支持从播放器当前位置设置边界。
- 视频：输出 MP4（H.264 / yuv420p，音轨为 AAC）；原始尺寸或长边 1920/1280/854，三档画质，支持截取及保留/移除音轨。
- 默认添加副本；选择“替换当前素材”时保留节点 ID 和连线，也支持生成节点的当前结果。源文件保留，可撤销画布变更。

关闭面板不会取消任务，取消按钮会终止当前任务并清理本次未完成输出。全局一次处理一个素材。处理中切换画布、删除节点或更换源素材时，不会把结果误写到其他项目；结果保留，可明确选择添加到当前画布或另存为。

## 实现与存储

主进程模块为 `electron-main/media-processor.cjs`，使用现有 Sharp 和 FFmpeg / FFprobe；渲染模块为 `src/media-processing.js`。新增 IPC 限制主窗口主 frame，输入经过 `MediaAccessPolicy`，不接受网络输入或任意 FFmpeg 参数。处理输出存于用户数据目录 `data/processed-media`，完成后才授予访问并回填。可通过“打开文件夹”和“另存为”导出。

图片按实际格式读取，避免 JPEG 内容误标为 PNG。输出先写独立临时文件，成功校验后再完成；原素材不改写。音视频子进程不经 shell，隐藏控制台，限制线程，支持取消与超时；处理不调用生成 API，也不触发模型计费。

开发依赖固定 `ffmpeg-static@5.3.0`、`ffprobe-static@3.1.0`。打包前 `scripts/prepare-media-tools.cjs` 将当前平台的两个工具和许可文件放入 Resources/media-tools，不把其他系统的全部二进制放入安装包。macOS 打包路径准备 x64/arm64 两份 FFmpeg 并通过 lipo 合并。由于 ffprobe-static@3.1.0 的 darwin/arm64 文件实际是 Intel 二进制，macOS 的 FFprobe 从同一个固定 FFmpeg release 下载并逐个验证真实架构，再合并。发布流水线在两平台打包后使用 `scripts/packaged-media-tools-smoke.cjs` 执行安装包内的组件，验证实际 MP4/MP3 转码；macOS 额外检查两个组件均包含 x86_64 和 arm64。

## 验证

两个转换组件在打包前已合并为通用二进制，`mac.x64ArchFiles` 仅对这两个路径允许双架构应用内的文件完全相同，避免 electron-builder 再次合并。最终产物仍强制通过 `lipo -verify_arch x86_64 arm64` 及实际转码验证。

- `node --test electron-main/media-processor.test.cjs`：实际图片、MP3/WAV、MP4 转换及截取；源文件保留、参数拒绝、取消与临时文件清理。
- `node scripts/media-processing-smoke.cjs`：隔离 Electron 用户目录，真实工具栏/右键入口、替换连线保留、MP3 截取、MP4 播放、跨项目防误回填，以及深色/浅色/窄窗口截图。
- `npm run build`、相关文件 ESLint、Windows 转换组件准备验证通过。

上游“参考素材无法读取”与本工具分开排查。最新已核实 art 日志 956、`fc_c528b9f349b547319cfe35a77a5c5408`，仍是飞拓明确返回的素材读取失败，本站记录 cost=0；没有借测试工具重新提交生成。转换工具提供格式和片段控制，不把本地转换成功当作上游素材抓取成功。
