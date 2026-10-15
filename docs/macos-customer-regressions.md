# macOS 客户反馈排查（2026-10-01）

## 2026-10-04 补充定位

在压缩构建的真实视频生成落图测试中复现了 `ReferenceError: s is not defined`。实际堆栈位于 `CanvasManager._layoutVideoControlGroup`，由 `_addGeneratorVideoControls` / `_drawGeneratorPlaceholder` / `_landResult` 调用，发生在视频已下载之后。

源码默认参数 `stageScale = this.stage?.scaleX?.()` 被当前构建工具降低语法后生成嵌套函数，内层临时变量 `s` 却被外层 `r.call(s)` 引用，造成打包代码作用域错误。已在源码将默认值求值移入函数体，避免该转换。增加了 esbuild 压缩/降级后的方法回归测试，完整 Electron 视频落图测试也通过。该修复尚未打包，此前的 beta.14 不包含；仍不能据此断言客户所有图片失败都只有这一个原因。以下为 10 月 1 日当时的排查记录。

客户反馈删除后重启恢复、图片生成后画布落地出现 `s is not defined`，以及 2026-09-26 的 `fse_instance_destroy -> napi_release_threadsafe_function -> uv_mutex_lock -> abort` 崩溃。客户安装包使用 `index-B47ZC7wG.js`，具体版本尚未确认；当前源码不能仅凭压缩变量名定位该 ReferenceError。未取得客户的 board.json、app.asar 或原始崩溃报告，反馈中的分析不是已复现的源码根因。

## 本次修改

- 从画布删除后立即同步保存 items、连线与删除记录，缩短文件监听崩溃或强制退出造成删除丢失的窗口。分组切换时同步顶层删除记录镜像，旧无分组画布迁移时保留原删除记录。文件仍保留在磁盘；没有清空删除名单。
- 图片生成节点先创建替换卡片和连线，成功后才销毁原节点；创建或连线异常时恢复原节点数据和连线。失败仍如实上报，不将未落地任务标成成功，不自动重新提交生成。
- macOS 使用 Chokidar 的 `fs.watch` 后端，显式关闭 `useFsEvents`，避开客户崩溃栈中的原生 fsevents 释放路径。移除监听后忽略迟到事件；跟踪所有尚未完成的 `close()`，应用退出等待它们完成，包括组切换期间已移除的监听器。不会切换为全目录轮询。

## 验证与限制

`electron-main/watcher.test.cjs` 验证平台选择、迟到事件、关闭等待及真实文件事件。`src/sidebar.test.js` 验证分组删除记录隔离。`src/canvas-generation-routing.test.js` 验证创建卡片和转换连线抛错时原节点不丢失。

`scripts/board-persistence-smoke.cjs` 使用独立临时配置、1268 条历史删除记录、两个分组、独立素材目录及本地模拟图片接口，验证 Delete 立即落盘、切组、完整退出重启、生成结果落地及再次重启。没有真实供应商请求，也不修改客户资料。Windows 当前构建修复前的基础删除/生成场景已通过，修复后的完整流程也通过；没有复现客户旧包中的 `s is not defined`。测试结束删除临时资料，截图保留在 `output/playwright/board-persistence.png`。

macOS 打包工作流已加入该 smoke，使用实际打包后的 app.asar，在下一次发布构建时执行；本次未触发打包，也未执行 macOS 原生运行验证。不能声称客户的 SIGABRT 已在 Mac 实机验证消失。

这些修改涉及客户端代码，CONFIG 无法推送，需要后续发布新安装包。客户现有生成文件和 recovery 记录应保留，升级后从任务记录拉取已有产物；不要清空目录或重新付费生成。确认旧包的具体 ReferenceError 仍需要版本号及相应错误堆栈/构建产物。
