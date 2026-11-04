# Electron 45 升级同步清单（给 Codex）

分支：`claude/electron-upgrade-ca1882`，基于 `master` 58edcfd（与 `dev` 同一份代码）。未推送，未开 PR，未打包。

| 提交 | 内容 |
|---|---|
| `55abdbe` | Electron 28.3.3 → 45.2.2，以及剪贴板、`File.path`、`console-message`、crypto 兼容代码 |
| `e93bce7` | safeStorage 改异步、`BrowserView` 改 `WebContentsView`、剪贴板粘贴兜底 |

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

## 3. 核对过、不用改的

- 所有 webPreferences 都是 `sandbox: true` 加 `contextIsolation: true`。没有用 `nodeIntegrationInWorker`/`nodeIntegrationInSubFrames`，所以 45 的 worker 和子 frame 变化不影响。
- 预加载脚本只 `require('electron')`，没用 45 删掉的 `Buffer`、`setImmediate`、`events`/`timers`/`url`。
- 没有 `setPermissionRequestHandler`，45 的 `display-capture` 变化不影响。没有 `desktopCapturer`/`chromeMediaSource`。
- `protocol.handle('local-res')`、`registerSchemesAsPrivileged`、混元 worker 的 `session.protocol.handle('https')` 用法不受影响；`local-res://` 已由 media-preview 冒烟验证。
- 没有 `clearStorageData({quotas})`、`setLoginItemSettings({openAsHidden})`、`isUnityRunning`、`showHiddenFiles`（Linux）。
- 浏览器前进/后退：`creative-web-apps.cjs` 还在用 `canGoBack`/`goBack`，从 32 起弃用但还没删，下面列为后续。

## 4. 验证结果

- `npm run check`：lint 无报错，1639/1639 测试通过，构建成功（在 `e93bce7` 上跑）。
- Playwright 冒烟（Electron 45.2.2，Windows）：
  - `startup-smoke` 通过：source 和 packaged 两种模式、两种延迟，主窗口、画布和启动页都正常。注意它需要先启动 `vite --port 15321`。
  - `relay-browser-smoke` 通过：`WebContentsView`、站点隔离、下载、账号写入都正常，API 配置文件是 `safe-storage` 格式。
  - `media-preview-smoke` 通过：`local-res://` 缩略图和原图、重启都正常。
- 实测脚本：
  - safeStorage 同步/异步互相解密已验证。
  - 剪贴板：`clipboard.write`/`read` 读写 PNG（得到 `image/png`）、HTML、文本都正常，测完已恢复原来的剪贴板。

## 5. 已知失败（不是这次升级引起的）

| 冒烟 | 现象 | 对照 |
|---|---|---|
| `canvas-drop-smoke` | "不支持的文件"那一步状态栏显示"请求失败"，等不到"没有可用图片" | 在 Electron 28 基线 58edcfd 上同样失败 |
| `diagnostics-smoke` | 页面提前关闭 | 在 Electron 28 基线上同样失败 |
| `mcp-client-smoke` | "配置 API"引导弹窗 `#siteLoginDialog` 挡住了点击 | 在 `55abdbe` 上同样失败；`board-*` 冒烟已有关闭弹窗的写法，可以照着改 |

## 6. 没验证到的

- macOS 完全没测（本机是 Windows），包括钥匙串下的 `isAsyncEncryptionAvailable`、Finder 剪贴板、拖放。
- 没有打包，也没测 Windows/macOS 安装包和 `electron-updater` 更新流程。
- 真实界面里的手动拖文件、Win+Shift+S 截图粘贴（只有 `image/bmp` 或其他原生格式时的情况）都没测。
- Linux 没测，不过项目也不发 Linux 包。
- 被弃用后又删除的 API 只查了 `electron-main/`、`scripts/`、`src/`，没查 `configserver/`、`mcp/` 这些不在 Electron 进程里跑的代码。

## 7. 后续

1. 修 `mcp-client-smoke` 被弹窗挡住的问题。
2. 查 `canvas-drop-smoke` 和 `diagnostics-smoke` 在 Electron 28 下就失败的原因。
3. `creative-web-apps.cjs` 的 `canGoBack`/`goBack`/`canGoForward`/`goForward` 改用 `webContents.navigationHistory`。
4. `decryptStringAsync` 返回的 `shouldReEncrypt` 现在被忽略。审查结论是目前没有实际影响，但可以在为 true 时重新加密写回。
5. macOS 上实测一次：启动、API 配置读写、中转浏览器登录恢复、粘贴图片。
6. Windows 和 macOS 两个包要用同一个提交打（AGENTS.md 的规定），只在用户要求发布时做。

## 8. 合并注意

- 主工作树里有一个未提交的 MCP Host/Origin 校验修复，在 `electron-main/mcp-bridge.js`，和本分支无关，本分支没碰这个文件。
- 主工作树还有很多别人未提交的改动。如果其中有调用 `ApiConfigStore.load()/save()`、`McpClientManager` 构造后直接读 `configs`、`RelaySessionStore.get/save/clear` 的地方，合并时都要补 `await`；要同步读取的改用 `apiConfigStore.cached()`。
