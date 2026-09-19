# Rhino 工作台

右下角圆球悬停菜单中点击「Rhino」，打开连接侧栏并尝试启动或唤起 Rhino。连接成功后，Cordyceps 工具会出现在同一套 Agent MCP 客户端中，不需要再手动填写第二份配置。

## 操作

- 「打开并连接」优先连接已经运行的 Cordyceps；服务未启动时，打开所选 Rhino，并通过连接脚本加载 Grasshopper 和 Cordyceps。
- 「仅连接」只连接现有 MCP 服务，不启动软件或运行连接脚本。
- 「预览当前模型」「整理四边面」切到 Agent，准备相应提示词并启用「Rhino 模型编辑」Skill，用户发送后才执行。已有输入内容会保留。
- 在「连接设置」中选择 Rhino 版本或其他安装路径，可调整本机 MCP 地址。默认地址为 `http://127.0.0.1:26929/mcp`。
- 如果软件启动提示或 COM 不可用阻止自动连接，可复制连接命令，在目标 Rhino 命令栏执行，然后点击「仅连接」。

Rhino 保持独立的软件窗口。关闭侧栏或退出 Corvas 不会关闭 Rhino，也不会保存、覆盖或清空用户模型。

## 连接与模型处理

启动脚本复用已有指定端口的 Cordyceps 组件；需要新建时，创建独立的 `Corvas-MCP.gh` 连接文档，不清空原 Grasshopper 文档，不处理几何。

设置保存在应用数据目录的 `data/rhino-workbench.json`。MCP 连接复用现有加密配置和工具调用循环，默认给建模工具保留 300 秒调用超时。已有相同本机地址的 MCP 配置、凭据和自定义超时不会被覆盖。

「Rhino 模型编辑」Skill 提供原 rhino-mesh-to-nurbs 流程的清理和 QuadRemesh 指引：先读取场景和选择，复制后清理并四边面重拓扑，保留原件与材质，按模型确定密度和对称轴。默认不转 NURBS、不清空 Grasshopper。该 Skill 定义在 `shared/rhino-model-skill.mjs`，供面板入口和混元模型自动传递共同使用。

混元窗口的新几何生成任务可按 Agent 的「自动 / 手动」模式发送到 Rhino，详见 [混元账号说明](hunyuan-accounts.md)。自动模式生成完成即下载、导入并启动整理；手动模式先在顶部非模态卡片确认。导入脚本记录新增网格 ID，整理任务不依赖当前选择。截图进入 Agent 工具结果，不代表已经创建了画布素材节点。

混元窗口顶部另有常驻「导入到 Rhino」按钮，用于当前预览中的模型，包括历史结果。点击即确认发送及整理，不必等待新的生成事件。

内置 Skill v2 优先使用任务给出的文档和对象 ID；先读取轻量统计，百万面网格先清理，必要时在工作副本上保形减面，再逐零件进行 QuadRemesh。总面数预算按复杂度分配，默认不强制对称，也不自动合并零件、补孔或封闭设计开口。导入统计与后续阶段报告按任务单独保存，以便超时后检查已有结果。该流程与原始鼠标示例的固定密度 NURBS runner 分开，默认仍只交付一次四边面预览。

## 验证与边界

本机 Windows 实测：Rhino 8.5 成功启动，关闭原有 SuperHelper 插件的 SDK 版本提示后，连接脚本启动 Cordyceps，并发现 7 个工具。通过 Corvas 实际 MCP 客户端和 Agent 执行链完成只读场景查询，未改动用户模型。

官方 Cordyceps 当前推荐 Rhino 8.21+。旧 Rhino 或其他组件可能弹出兼容性提示，画布不会把软件启动误报成工具已连接。Mac 提供应用路径检测和启动适配，但尚未在 Mac 真机验证；运行中的 Mac Rhino 可用复制连接命令完成首次启动。

```powershell
node --test electron-main/rhino-workbench.test.cjs
node scripts/rhino-workbench-smoke.cjs
```

桌面冒烟默认使用模拟 MCP 和模拟文字模型。设置 `FLOW_RHINO_SMOKE_LIVE=1` 可连接已经启动的本机 Cordyceps，只读取场景，文字模型仍为本地模拟服务，不产生付费调用。
