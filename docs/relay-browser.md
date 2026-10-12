# 内置中转站

首次使用且没有已保存账户时，画布弹出“登录 Corvas”，选择生图站（ai）、视频站（art）或企业站（cart），随后直接显示原站 UI。可“暂不登录”继续使用本地画布，该选择保存在本机。设置中的“登录认证”展示三站登录状态及后台入口，下方保留“手动 API 配置”，可继续添加、编辑或删除 URL/Key 配置。历史 API 配置保留。MCP 外部软件连接与诊断日志位于“创作”页。

右下角“站点后台”打开上次选择的站点；登录、充值、任务列表、预览和下载均沿用网站页面。不另建账户后台。

选站结果保存在用户资料 `data/relay-browser.json`；工具栏支持前进、后退、刷新、任务日志和切站。三站使用独立的 Electron 持久化 session，保存网站自身 Cookie/Local Storage。额外使用系统凭据服务加密保存同源 Cookie 及 Session Storage 中的 `token`、`user`，存放于 `data/relay-sessions.v1.json`。关闭窗口和退出应用时等待会话写盘，重开时恢复会话并进入后台首页，不强制跳登录页。恢复不延长网站的有效期、不覆盖较新的登录，退出登录会清除对应加密记录。远程页面仍无 preload、Node 和本地 IPC 权限。

## 任务与下载

视频节点右键或任务记录的“查看后台任务”打开原站 `/task-logs`。画布发起的定位会为该站任务查询增加精确的 `task_id`，移除默认日期、模型和关键词限制；工具栏显示该任务编号，点击清除后恢复原站查询。不会重建、替换原站的筛选栏或任务卡片。

用户点击原站视频播放器自带的下载操作后，Electron 接管下载并保存临时文件。主进程用该站当前登录身份读取原站当前页任务，按下载地址精确匹配已完成任务；不以模型、时间或相似文件名猜测。

匹配成功后，画布任务回填原项目和节点，网站独立任务导入点击下载时所在项目。重复导入复用已完成文件；下载期间修改节点时保留下载文件和恢复检查点，不覆盖编辑。无法唯一匹配时只保留下载文件并打开文件位置，不猜测节点。非视频下载仍走原来的另存为流程。

持久化的画布和任务不包含上游产物 URL。网站自身原有内容与展示策略不在本次改动中调整。

## 登录连接画布

登录后，主进程核对用户身份并分页读取该用户已有的 API Key。画布弹出勾选列表，显示名称、掩码和可用状态。只有确认勾选的 Key 才读取完整值并导入；取消或空列表不修改 API 配置，也不自动创建 Key。停用、过期、仅限网页使用的 Key 不允许选择。确认时重新核对当前账户和 Key 状态，避免把已经撤销或其他账户的凭据导入。工具栏和设置中的“选择 API Key”可重新打开列表。

生图站使用 New API 的 `/api/user/self`、`/api/token/` 和 `/api/token/{id}/key`。其网页访问令牌由主进程观察该站 BrowserView 自身的同源 API 请求获得；不从其他窗口或请求接收凭据，不主动刷新登录令牌，不读取用户密码。退出登录请求清除内存令牌和加密会话。仅为用户勾选的 Key 调用完整值读取接口。视频站和企业站使用 `/api/v1/user/profile` 与 `/api/v1/tokens`，不会调用创建 Key 接口。

API 端点由固定站点确定，模型目录来自 CONFIG，不调用 `/v1/models`。按站点、用户、Key ID 和模型用途保存独立 API 配置，多个 Key 不互相覆盖，重选同一个 Key 保留原配置 ID 和节点绑定。一次确认的多 Key 导入作为一次配置保存提交，失败时不部分落库。未勾选的既有画布 API 不会被删除，其他手动配置保持不变。

网页登录会话仅通过系统凭据服务加密存储，不写入画布 API 配置，也不传给本地工具栏。选择弹窗仅接收 Key 元数据，不接收完整 Key。确认后，所选 API Key 通过受信任画布 IPC 交付并沿用系统凭据加密存储；画布确认保存后，工具栏才显示导入完成。此功能需要更新客户端，不能由 CONFIG 单独下发。

这期没有服务器视频缓存，也不保证原产物地址不可达时浏览器能下载成功。新增 Electron 窗口与下载衔接需要更新客户端；不能仅靠 CONFIG 下发。

## 验证

`node --test electron-main/relay-browser.test.cjs electron-main/generation-recovery-board.test.mjs`

`node scripts/relay-browser-smoke.cjs` 使用隔离资料与本地站点，验证原站页面、登录隔离、原生浏览器下载、任务定位、回填和重复导入，不发生真实生成费用。

登录连接回归：`node --test electron-main/relay-account-link.test.cjs electron-main/relay-session-store.test.cjs src/relay-account-config.test.js src/agent-api-catalog.test.js`。浏览器冒烟覆盖三站现有 Key 选择、加密保存、Session Storage 与会话 Cookie 的窗口关闭和应用重启恢复，以及退出后不恢复。`node scripts/api-catalog-smoke.cjs` 通过真实画布 preload 验证弹窗勾选、取消、禁用项、窄窗口、多 Key 原子保存、重复导入与 CONFIG 不接收 Key。

源码启动回归需先运行 Vite（15321），再设置 `FLOW_SOURCE_SMOKE=1` 执行 `node scripts/api-catalog-smoke.cjs`，使用独立用户资料和本地 CONFIG。源码模式与构建模式都需要检查；共享 CJS 文件增加浏览器引用时，需同步加入 `vite.config.js` 的开发转换清单与构建转换规则。
