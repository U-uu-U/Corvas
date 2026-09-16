# 混元 3D 网页账号

鼠标停在右下角圆球上，点击「混元 3D」，在右侧账号栏添加一个账号名称，然后点击「打开」。首次在混元官网完成登录，后续打开会复用该账号的本地会话；登录失效时仍需重新登录。

- 每个账号使用独立浏览器进程和独立数据目录，可同时打开，再次打开只唤起该账号已有窗口。
- 账号名称是本地备注，不代表已读取或验证混元用户身份。窗口状态只表示网页加载和窗口是否打开。
- 重命名不会改变登录会话。移除账号需在卡片中确认，会关闭其主窗口与登录弹窗，清理该账号的本机登录数据和缓存；不会删除混元服务器上的作品。
- 关闭账号侧栏不会关闭已经打开的网页。退出 Corvas 会关闭关联的混元窗口。
- 账号会话独立于系统 Chrome；原有 Chrome 登录不会自动导入。

## 实现

`electron-main/hunyuan-accounts.cjs` 保存账号名称、稳定 UUID、创建及最近打开时间，文件为应用数据目录下的 `data/hunyuan-accounts.json`。每个账号的浏览器进程由 `hunyuan-browser-process.cjs` 拉起，`hunyuan-window-worker.cjs` 负责网页窗口；账号数据目录固定为 `data/hunyuan-browser-profiles/<uuid>`，不进入画板、API 配置或账号表单。

应用入口 `entry.cjs` 区分画布与账号浏览器进程，打包版本复用同一 Electron 可执行程序，开发版本使用相同的入口脚本。账号浏览器不会启动画布、Agent、文件监听或本地 API 服务，控制消息只通过父子进程 IPC 传递。

旧版只隔离 session partition，仍处在同一 Electron 主进程内。Electron 28 会按窗口名在主进程范围内复用弹窗，导致不同账号的同名登录弹窗串用。独立进程同时隔离 Chromium 窗口名注册表、Cookie、localStorage、缓存及 Service Worker。这里不伪装设备指纹，也不承诺平台会将账号识别为不同设备。

升级后保留原账号名称，新环境第一次需要重新登录。旧 partition 数据不会自动复制，以免继承已经串用的登录状态；旧数据先保留，在用户明确移除相应账号时一并清理。

入口固定为 `https://3d.hunyuan.tencent.com/`。网页和登录弹窗使用所属账号的同一会话，开启 sandbox/contextIsolation，关闭 Node 集成，不载入画布 preload。账号 IPC 只接受 Corvas 主窗口的主框架请求。

当前阶段只提供账号选择和网页入口。图片自动上传、混元任务同步、模型下载回传、Rhino 与 Blender 启动和 MCP 连接属于后续阶段。

## 验证

```powershell
node --test electron-main/hunyuan-accounts.test.cjs
node scripts/hunyuan-accounts-smoke.cjs
```

桌面测试需要 Playwright，可通过 `PLAYWRIGHT_MODULE` 指定已安装模块路径。默认使用独立临时配置和模拟网页，验证两个浏览器进程的 Cookie/localStorage 隔离、同时打开同名登录弹窗、保留 opener、重启保存、窗口复用、重命名与移除，以及侧栏切换和不同主题布局。调试端口仅在隔离冒烟环境中启用。

设置 `FLOW_HUNYUAN_SMOKE_LIVE=1` 可在隔离配置中打开官网并验证登录页加载，不登录用户账号、不提交生成。
