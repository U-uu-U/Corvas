# Electron 45 升级同步清单（给 Codex）

分支：`claude/electron-upgrade-ca1882`，基于 `master` 58edcfd（与 `dev` 同一份代码）。未推送，未开 PR，未打包。

| 提交 | 内容 |
|---|---|
| `55abdbe` | Electron 28.3.3 → 45.2.2，以及剪贴板、`File.path`、`console-message`、crypto 兼容代码 |
| `e93bce7` | safeStorage 改异步、`BrowserView` 改 `WebContentsView`、剪贴板粘贴兜底 |
| `2872ac6` | 本清单 |
| `34eaba3` | mcp-client、diagnostics、canvas-drop 冒烟修复；前进/后退改 `navigationHistory`；safeStorage 密钥轮换后重新加密 |
| `6b27d95` | agent-materials 冒烟改用"复制"操作 |
| `133eee1` | **Electron 45 视频无法播放的回归修复**（新增 `local-media://` 协议）；"空图片"节点不显示；文件失联提示；其余冒烟测试修复 |

## 1. 版本

- `electron`：`^28.3.3` → `^45.2.2`。45 是当前最新稳定版，按 releases.electronjs.org 暂定 2027-04-27 停止支持。目前受支持的是 43、44、45。
- `electron-builder`、`sharp`、`electron-updater` 没改。sharp 是 N-API 预编译包，在 Electron 45 下的冒烟测试里能正常加载。
- 从 Electron 42 起，`npm install` 不再在 postinstall 阶段下载 Electron 二进制，`ELECTRON_SKIP_BINARY_DOWNLOAD` 也不再生效。新机器装完依赖后，运行 `npx install-electron` 或直接启动一次 Electron，二进制才会下载。`.npmrc` 里的 `electron_mirror` 仍然有效。
- Electron 45 内置 Node 24.22；`engines` 要求 Node ≥ 22.12。

## 2. 改了哪些 API 调用

### 剪贴板（Electron 44：异步、W3C 形式）
- `readText`/`writeText` 返回 Promise，`type` 参数已删除。
  - `main.js`：`writePlainTextToClipboard` 改为 `await clipboard.writeText(value)` 后再 `await clipboard.readText()` 校验；MCP 复制（`mcp-server:copy`）、交接指令复制（`handoff:copy`）、Rhino `copyCommand` 都加了 `await`。
  - `diagnostics-electron.cjs`：`diagnostics:copy` 改成 async 并 `await`。
- `readImage`/`readHTML` 已删除。`image:pasteFromClipboard` 改用 `clipboard.read()`：先试 `image/png`，再依次试其他列出的 `image/*` 类型；单个类型读取失败时返回 null，继续走 HTML 里的 `<img src>` 和 URL 文本兜底。
- 渲染进程从 Electron 44 起拿不到 `clipboard` 模块。渲染层原本就走 IPC，不受影响。

### `File.path` 已删除（Electron 32）
- `preload.js`：拖放授权 `media:grant-drop` 改用 `webUtils.getPathForFile(file)`。
- `preload.js` 新增 `flowCanvas.getPathForFile(file)`，异常时返回 `''`。
- `src/canvas.js`：拖放导入用 `filePathOf(file)`，先读 `file.path`，没有时调 `flowCanvas.getPathForFile`。
- `orb-preload.js` 本来就有 `webUtils` 兜底，没改。

### `console-message` 事件（Electron 35 弃用位置参数）
- `diagnostics-electron.cjs`、`scripts/api-catalog-smoke-entry.cjs` 改为解构事件对象 `{ level, message, lineNumber, sourceId }`。`level` 现在是字符串 `'warning'`/`'error'`，不再是数字 2/3。

### `globalThis.crypto` 兼容代码
- 删掉了 `mcp-http-server.cjs` 开头为 Electron 28 补 `globalThis.crypto` 的两行。已实测 Electron 45 主进程里有 `globalThis.crypto.subtle`。

### safeStorage 改异步（Electron 45 弃用同步方法，46 删除）
- 同步的 `encryptString`/`decryptString`/`isEncryptionAvailable` 已全部替换为 `encryptStringAsync`/`decryptStringAsync`（返回 `{ result, shouldReEncrypt }`）/`isAsyncEncryptionAvailable`。
- **兼容性已实测（Windows，45.2.2）**：同步方法和异步方法写出的密文都以 `v10` 开头，可以互相解密，`shouldReEncrypt` 为 false。用户已有的 API 配置、MCP 配置、中转站登录文件都能直接读，不需要迁移。
- `api-config-store.js`（**接口变化**）：
  - `load()`/`save()` 现在返回 Promise。
  - 同一个文件的读写在进程内按顺序排队，跨实例共享，队列挂在 `globalThis[Symbol.for('corvas.apiConfigQueues')]`。
  - 新增 `cached()`：返回最近一次**成功** `load()` 或 `save()` 的结果，给同步读取方用。失败的 `load()` 不会覆盖它，避免钥匙串临时锁住时诊断脱敏和 Agent 拿到空配置。
  - `protect`/`unprotect` 回调可以返回 Promise。
- `main.js`：
  - `initServices` 里创建 store 后 `await apiConfigStore.load()`。
  - `api-config:load`/`api-config:save` 两个 IPC 改成 async。
  - `getLinkedAccounts`、`relay-browser:open` 改为 `await load()`。
  - 诊断 `getSecrets`、混元 `readMode` 改读 `cached()`。
- `agent-services.cjs`：
  - `AgentGeneration` 的 `loadConfig` 读 `cached()`；测试替身没有 `cached` 时退回 `load()`。
  - `McpClientManager` 创建后 `await mcpClient.load()`。
- `mcp-client.cjs`（**接口变化**）：
  - 构造函数不再解密，新增 `load()`（只执行一次）。
  - `save`/`remove` 通过 `mutate()` 排队，并在执行前等 `load()` 完成。
  - `persist()` 改成 async。
- `relay-session-store.cjs`（**接口变化**）：
  - `get`/`save`/`clear` 返回 Promise，内部排队。
  - 新增 `idle()`，返回队列尾部。
- `relay-browser.cjs`：
  - 所有 `forgetSession` 调用都加了 `await`。
  - `flushSessions()` 最后等 `sessionStore.idle()`，保证退出前登出清理已经写盘。审查中确认了这个问题：不等的话，退出后旧登录状态会被恢复。
  - `getLinkedAccounts` 的结果加了 `await`。

### `BrowserView` → `WebContentsView`（Electron 30 起弃用）
- `relay-browser.cjs`：
  - 构造参数从 `BrowserView` 改为 `WebContentsView`。
  - `layout()` 里原来的 `setBrowserView`，改为对 `window.contentView` 做 `removeChildView`/`addChildView`，只显示当前站点的视图。
  - 新视图设了 `setBackgroundColor('#191b1e')`：`WebContentsView` 默认白底，`BrowserView` 默认透明。
- `main.js` 和 `scripts/relay-browser-smoke-entry.cjs` 改为传入 `WebContentsView`。

### 测试和脚本
- `api-config-store.test.js`、`mcp-client.test.cjs`、`relay-session-store.test.cjs` 改为异步，模拟对象补了异步方法。
- 所有 `scripts/*-entry.cjs` 和 `model-config-smoke.cjs` 的种子写入改成异步 safeStorage 并 `await`；`relay-browser-smoke.cjs` 也补了 `await`。
- `activate-shanhai-provider.cjs`、`configure-seedance-route.cjs`、`config-catalog-dev.cjs`、`agent-smoke-entry.cjs` 改为 `await` store 调用。

### 本地视频/音频改走 `local-media://`（Electron 45 回归，`133eee1`）
- **现象**：Electron 45 下，`<video>`/`<audio>` 通过非标准协议 `local-res://` 加载时不能跳转（seek）。moov 在文件末尾的 MP4（不少录屏和导出的视频都是这样）直接报 `MEDIA_ERR_SRC_NOT_SUPPORTED`（code 4），画布视频卡片显示"无法解码"。同一文件在 Electron 28 上正常。
- **定位**（最小复现脚本，同一个 `handleLocalResourceRequest`）：
  - 10 MB、moov 在末尾：`local-res` 失败；HTTP、或注册时带 `standard: true` 的协议都正常。
  - faststart 文件、12 KB 小文件：都正常。
  - 限制分段长度、去掉安全响应头、改用 `net.fetch` 转发 file://：都没用。只有 `standard: true` 有效。
- **修复**：
  - 新注册标准协议 `local-media`，URL 形如 `local-media://file/<encodeURIComponent(路径)>`。
  - `electron-main/local-resource.js` 新增 `handleLocalMediaRequest`：把请求转回 `local-res` 请求，交给同一个 `handleLocalResourceRequest`，所以走同一套 `MediaAccessPolicy`，Range、403/404 行为也完全一样。
  - 所有 `<video>`/`<audio>` 改用 `local-media`，并设 `crossOrigin = 'anonymous'`，保证 canvas 截帧仍可读：`canvas.js` 的视频卡片、封面、预览弹窗、生成结果视频预览，`canvas-audio-player.js`，`media-processing.js`，`sidebar.js` 素材库视频，Agent 抽帧（`agent-services.cjs` 和 `agent-media.html` 的 CSP）。
  - 图片仍走 `local-res`。
  - 已实测：中文路径、空格、`#` 的视频在 `local-media` 下都能播放和跳转；越权路径返回 404。
  - 新增单元测试：`media-access.test.cjs` 的 "local-media scheme…"。
- **Codex 合并时注意**：新增的视频或音频元素要用 `local-media://file/` 加 `crossOrigin`，不要用 `local-res://`。

### 其他产品修复
- `src/canvas.js` `_createCard`：右键菜单"空图片"从 `72a8661`（10 月 11 日）起什么都不画，原因是空占位没有文件路径，被 `isBoardMediaFile` 过滤掉了。现在放行空的 image/video/audio 占位。加载时的过滤只删有路径的项，所以重启后占位会保留。
- `main.js` `thumb:preview`：文件被删或被移动时（`ENOENT`/`ENOTDIR`）返回 `FILE_MISSING`（"文件失联"，可重接），不再统一显示"素材不存在或尚未授权"。
- `src/canvas.js`：拖入不支持的文件时，状态栏显示本地文案"拖拽数据中没有可用图片"，不再被改写成"请求失败"。
- `creative-web-apps.cjs`、`relay-browser.cjs` 的前进/后退改用 `webContents.navigationHistory`。
- safeStorage 的 `shouldReEncrypt` 为 true 时，API 配置、MCP 配置、中转站登录状态都会用新密钥重新加密写回，有单元测试。

## 3. 核对过、不用改的

- 所有 webPreferences 都是 `sandbox: true` 加 `contextIsolation: true`。没有用 `nodeIntegrationInWorker`/`nodeIntegrationInSubFrames`，所以 45 的 worker 和子 frame 变化不影响。
- 预加载脚本只 `require('electron')`，没用 45 删掉的 `Buffer`、`setImmediate`、`events`/`timers`/`url`。
- 没有 `setPermissionRequestHandler`，45 的 `display-capture` 变化不影响。没有 `desktopCapturer`/`chromeMediaSource`。
- `local-res://` 加载图片不受影响；混元 worker 的 `session.protocol.handle('https')` 用法不受影响。
- 没有 `clearStorageData({quotas})`、`setLoginItemSettings({openAsHidden})`、`isUnityRunning`、`showHiddenFiles`（Linux）。

## 4. 验证结果

- `npm run check`（在最终改动上跑）：lint 无报错，1641/1641 测试通过，构建成功。
- generation-routing 日志里有一条 403：是 Vite 开发服务器拒绝了 `@fs/.../electron-main/assets/app-icon.png`，只在开发模式出现，和 `local-media` 无关，测试本身通过。
- 冒烟测试（Electron 45.2.2，Windows）的逐项结果见第 5 节。

## 5. 冒烟测试状态

运行方式：Playwright 装在仓库外，用 `PLAYWRIGHT_MODULE` 指过去；`startup-smoke` 需要先启动 `vite --port 15321`；`model-config-smoke` 要用 `electron` 直接运行。

**冒烟测试失败的共同原因**：很多冒烟测试在 Electron 28 基线上本来就失败，原因是测试脚本跟产品对不上了，不是升级引起的。已修复的原因有：
1. 没有 API 账号时启动会弹出"配置 API"窗口，挡住点击。脚本里改为点"跳过"。
2. `app.firstWindow()` 拿到的是启动页，启动页随后会关闭。改为按 `dist/index.html` 找画布窗口。
3. 画布只显示真实存在的媒体文件（`72a8661`），而且媒体权限不允许 userData 目录下非素材目录的文件（`media-access.cjs`）。测试素材改为真实小文件，放在 `data/captured` 或临时目录里。
4. Ctrl 拖动现在是"拖出文件副本"（`67f9655`），复制节点改用"复制"操作。
5. 产品文案和尺寸规则变了：启动器多了"设置"和"站点后台"两个按钮；肖像/版权的错误提示改为显示上游原因；单张结果按长边 264 缩放（与 `generation-recovery-board.test.mjs` 一致）。
6. `model-config-smoke`：Electron 45 下，隐藏窗口执行 `reload()` 会卡住。
7. `generation-routing`、`ux-regression` 从源码运行时，画布窗口加载的是开发服务器地址，不是 `dist/index.html`，窗口判断改为两种都认。脚本改为把窗口显示在屏幕外（详见第 7 节第 2 条）。

修复测试时没有删掉任何断言。只有两处改了期望值，都有依据：启动器方向键的下一个按钮从 `tripo` 变成 `settings`；恢复后的节点尺寸从 400x300 变成 264x198。

最终全量结果（Electron 45.2.2，Windows，提交 `133eee1` 加上本次两个冒烟脚本的修改；通过 49 个，跳过 4 个，失败 0 个）：

| 冒烟 | 结果 | 说明 |
|---|---|---|
| `agent-material-citations-smoke` | 通过 |  |
| `agent-materials-smoke` | 通过 |  |
| `agent-smoke` | 通过 |  |
| `api-catalog-smoke` | 通过 |  |
| `app-update-live-smoke` | 跳过 | 需要真实更新源 |
| `app-update-smoke` | 通过 |  |
| `audio-card-smoke` | 通过 |  |
| `board-media-filter-smoke` | 通过 |  |
| `board-persistence-smoke` | 通过 |  |
| `canvas-context-menu-smoke` | 通过 |  |
| `canvas-drop-smoke` | 通过 |  |
| `canvas-pan-smoke` | 通过 |  |
| `canvas-sale-prices-smoke` | 通过 |  |
| `canvas-ui-scale-smoke` | 通过 |  |
| `composer-resize-smoke` | 通过 |  |
| `creative-app-launcher-smoke` | 通过 |  |
| `customer-error-message-smoke` | 通过 |  |
| `diagnostics-smoke` | 通过 |  |
| `duplicate-node-smoke` | 通过 |  |
| `error-report-client-smoke` | 通过 |  |
| `generation-progress-smoke` | 通过 |  |
| `generation-recovery-smoke` | 通过 |  |
| `generation-routing-smoke` | 通过 | 全量里因找不到画布窗口失败，修了窗口判断（`dist/index.html` 或开发服务器地址）后单独重跑通过 |
| `graph-visibility-smoke` | 通过 |  |
| `hunyuan-accounts-smoke` | 通过 |  |
| `mcp-client-smoke` | 通过 |  |
| `mcp-server-smoke` | 通过 |  |
| `media-preview-recovery-smoke` | 通过 |  |
| `media-preview-smoke` | 通过 |  |
| `media-processing-smoke` | 通过 |  |
| `model-config-smoke` | 通过 |  |
| `nano-banana-smoke` | 通过 |  |
| `packaged-media-tools-smoke` | 跳过 | 需要打包产物 |
| `portrait-error-smoke` | 通过 |  |
| `provider-routing-smoke` | 通过 |  |
| `reference-citations-smoke` | 通过 |  |
| `relay-browser-smoke` | 通过 |  |
| `release-page-smoke` | 跳过 | 访问线上站点 |
| `release-ui-smoke` | 通过 |  |
| `rhino-workbench-smoke` | 通过 |  |
| `sd2-fast-duration-smoke` | 通过 |  |
| `security-boundary-smoke` | 通过 |  |
| `startup-smoke` | 通过 |  |
| `ux-regression-smoke` | 通过 |  |
| `video-channel-picker-smoke` | 通过 |  |
| `video-download-progress-smoke` | 通过 |  |
| `video-reference-reuse-smoke` | 通过 |  |
| `video-resource-saver-smoke` | 通过 |  |
| `video-route-picker-smoke` | 通过 |  |
| `workflow-mcp-smoke` | 通过 |  |
| `workflow-notices-smoke` | 通过 |  |
| `zhubo-pro-smoke` | 通过 |  |
| `config-admin-smoke (.mjs)` | 跳过 | CONFIG 服务端，不在本次范围 |

## 6. 没验证到的

- macOS 完全没测（本机是 Windows），包括钥匙串下的 `isAsyncEncryptionAvailable`、Finder 剪贴板、拖放、`local-media` 播放。
- 没有打包，也没测 Windows/macOS 安装包和 `electron-updater` 更新流程。被跳过的冒烟：`app-update-live`（需要真实更新源）、`packaged-media-tools`（需要打包产物）、`release-page`（访问线上站点）、`config-admin`（CONFIG 服务端）。
- 真实界面里的手动拖文件、Win+Shift+S 截图粘贴（只有 `image/bmp` 或其他原生格式时的情况）都没测。
- Linux 没测，不过项目也不发 Linux 包。
- 被弃用后又删除的 API 只查了 `electron-main/`、`scripts/`、`src/`，没查 `configserver/`、`mcp/` 这些不在 Electron 进程里跑的代码。

## 7. 后续

1. macOS 上实测一次：启动、API 配置读写、中转浏览器登录恢复、粘贴图片、播放本地视频（moov 在末尾的 MP4）。
2. Electron 45 下隐藏窗口执行 `reload()` 会卡住，这是在 `model-config-smoke` 里发现的。产品如果在主窗口显示前重载页面，也会遇到，值得单独查一下。
3. Windows 和 macOS 两个包要用同一个提交打（AGENTS.md 的规定），只在用户要求发布时做。

## 8. 合并注意

- 主工作树里有一个未提交的 MCP Host/Origin 校验修复，在 `electron-main/mcp-bridge.js`，和本分支无关，本分支没碰这个文件。
- 主工作树还有很多别人未提交的改动。如果其中有调用 `ApiConfigStore.load()/save()`、`McpClientManager` 构造后直接读 `configs`、`RelaySessionStore.get/save/clear` 的地方，合并时都要补 `await`；要同步读取的改用 `apiConfigStore.cached()`。
- 新增的视频或音频元素要用 `local-media://file/` 加 `crossOrigin = 'anonymous'`，不要用 `local-res://`。
