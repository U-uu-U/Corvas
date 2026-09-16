# 混元 3D 网页账号

鼠标停在右下角圆球上，点击「混元 3D」，在右侧账号栏添加一个账号名称，然后点击「打开」。首次在混元官网完成登录，后续打开会复用该账号的本地会话；登录失效时仍需重新登录。

- 每个账号可以同时打开一个独立网页窗口，再次打开会唤起已有窗口。
- 账号名称是本地备注，不代表已读取或验证混元用户身份。窗口状态只表示网页加载和窗口是否打开。
- 重命名不会改变登录会话。移除账号需在卡片中确认，会关闭其主窗口与登录弹窗，清理该账号的本机登录数据和缓存；不会删除混元服务器上的作品。
- 关闭账号侧栏不会关闭已经打开的网页。退出 Corvas 会关闭关联的混元窗口。
- 账号会话独立于系统 Chrome；原有 Chrome 登录不会自动导入。

## 实现

`electron-main/hunyuan-accounts.cjs` 保存账号名称、稳定 UUID、创建及最近打开时间，文件为应用数据目录下的 `data/hunyuan-accounts.json`。登录数据由 Electron 独立持久会话 `persist:corvas-hunyuan-<uuid>` 管理，不进入画板、API 配置或账号表单。

入口固定为 `https://3d.hunyuan.tencent.com/`。网页和登录弹窗使用所属账号的同一会话，开启 sandbox/contextIsolation，关闭 Node 集成，不载入画布 preload。账号 IPC 只接受 Corvas 主窗口的主框架请求。

当前阶段只提供账号选择和网页入口。图片自动上传、混元任务同步、模型下载回传、Rhino 与 Blender 启动和 MCP 连接属于后续阶段。

## 验证

```powershell
node --test electron-main/hunyuan-accounts.test.cjs
node scripts/hunyuan-accounts-smoke.cjs
```

桌面测试需要 Playwright，可通过 `PLAYWRIGHT_MODULE` 指定已安装模块路径。默认使用独立临时配置和模拟网页，验证两个会话的 Cookie/localStorage 隔离、重启保存、登录弹窗会话、窗口复用、重命名与移除，以及侧栏切换和不同主题布局。

设置 `FLOW_HUNYUAN_SMOKE_LIVE=1` 可在隔离配置中打开官网并验证登录页加载，不登录用户账号、不提交生成。
