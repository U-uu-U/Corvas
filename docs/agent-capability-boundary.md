# 内部 Agent 与外部软件的职责划分

状态：规划稿，2026-09-21。用户要求 Blender、Rhino 等外部软件入口衔接 ChatGPT，重新限定画布内 Agent 的能力。本文记录目标与迁移顺序，不代表连接已经完成。ChatGPT 的具体入口仍待确定。

## 目标分工

画布内 Agent 定位为当前项目的创作助手，负责素材理解、提示词与分镜、画布整理、图像和视频生成、结果回收及可复用创作流程。它的上下文围绕当前项目，不承担外部软件建模、脚本编写或跨软件调度。

外部助手负责 Blender、Rhino 等软件的场景理解、操作规划、脚本和工具调用，以及跨软件任务的推进。涉及这些软件的交流、选择、确认和错误处理放在外部对话中。

Corvas 的软件工作台负责打开软件、连接状态、选中素材的交接和产物回画布。已验证的固定脚本流程由本地任务执行器负责下载、执行、检查点、取消与恢复，不依赖内部文字模型重新规划。

## 内部 Agent 的能力范围

保留以下任务：

- 搜索当前项目素材，查看图片和指定时间点的视频抽帧；音频理解仍受现有实现限制。
- 编写和优化提示词，整理剧本、角色表、镜头表及项目简报。
- 创建、连接和整理画布节点，通过带版本校验的事务修改画布。
- 读取实际可用模型与参数，组织图片和视频生成批次，按现有机制确认、执行、查询和恢复。
- 检查生成结果，记录已完成任务，保存和实例化画布创作流程。
- 保存用户确认的项目约束，保持素材引用与项目归属。

工具白名单：

- `flow_canvas.board.get_snapshot`
- `flow_canvas.board.transaction.preview`、`apply`、`undo`
- `flow_canvas.asset.search`、`read`
- `flow_canvas.model.list`
- `flow_canvas.graph.run`
- `flow_canvas.document.list`、`get`、`create`、`update`
- `flow_canvas.skill.list`、`save`、`instantiate`
- `flow_canvas.task.list`、`get`、`cancel`
- `flow_canvas.memory.read`、`propose`

普通内部对话不再获得 `external_mcp_*`、`flow_canvas.rhino.cleanup`、任意脚本、终端或浏览器控制能力。用户自定义 Skill 只提供指令，不能增加工具权限。调用方传入的 `toolAllowlist` 只能缩小上述范围。

这条边界同时约束工具发布和实际执行。系统提示或隐藏按钮不能替代执行端校验。旧对话中仍含外部工具调用时，也不能绕过新的范围继续执行。

## 软件入口与交接

Blender 和 Rhino 保留现有的软件启动、连接和设置入口。预览、动画、模型整理等任务按钮改为创建外部助手任务，不再选择内部 Skill 或跳到内部 Agent 输入框。

交接记录应持久保存目标软件、项目 ID、任务说明、有序素材节点 ID、素材版本、输出要求和任务状态。外部助手先读取记录和真实场景，再执行操作。交接记录不包含 API Key、认证头或整个 MCP 启动配置。

交接状态区分待接手、处理中、等待用户、完成、失败和取消。Corvas 只显示简短状态及返回外部对话的入口。只有接收到外部助手的确认，才显示已接手；创建记录或打开网页不等于消息已经送达。

外部软件输出通过现有 `flow_canvas.item.add` 及素材路径校验回到原项目。工具返回截图或文件路径时，只有实际入库成功才能标为已加入画布。

建议优先让外部助手直接连接各软件的 MCP，同时连接 Corvas 的画布 MCP。这样外部助手持有完整工具 schema，不需要让内置 Agent 再转述、规划和调用。若目标客户端不能直接连接本机服务，再单独设计转发层。

## 连接方式待决

目前 Corvas 对外接口是 `mcp/flow-canvas-mcp.mjs` 的本机 stdio 包装器，转发到仅接受 localhost 的桥接服务。它已经提供画布工具和 `flow_canvas.workflow.*`，没有通用 Blender/Rhino 工具代理、远程 MCP 认证或 ChatGPT 消息交接接口。

- 若目标是当前 Codex 对话：优先复用本机 MCP，将 Corvas 与软件 MCP 分别连接到外部助手，再增加持久交接记录。仍需核实客户端如何接收或主动读取新任务，不能承诺仅连接 MCP 就自动唤醒对话。
- 若目标是 ChatGPT 网页或桌面应用：先验证该账户实际可用的 MCP 接入方式，再实现它支持的远程连接和认证。当前本机接口不能直接当作已完成的 ChatGPT 连接。
- 若目标是 Corvas 内嵌的 ChatGPT 页面：打开页面与 MCP 接入是两个独立步骤；必须验证页面所属账户的工具接入能力，不能仅把按钮改成打开网页。

官方文档查询在本次环境返回 403，账户支持范围未核实。连接方案以实际可用能力为准。

## 已有 Rhino 工作流的兼容

已有混元到 Rhino 流程通过 `flow_canvas.workflow.*` 对外提供稳定接口，执行固定的导入、检查、清理、四边面整理和验证脚本，不调用文字模型。

实现上，`HunyuanRhinoWorkflow.startCleanup()` 仍借用 `AgentRuntime.start({ execution: 'rhino_cleanup' })`，恢复也使用同一 runtime。直接删除该分支会破坏已有任务。

迁移分两步：

1. 普通 Agent 启动入口与受信任工作流入口分开。普通 IPC/MCP 请求不能通过 `execution` 或伪造工作流来源获得外部操作能力；固定工作流入口校验任务和项目绑定，只运行限定的整理阶段。
2. 将固定工作流的执行和自动/手动设置迁出普通对话配置，保留 `workflow.*` 名称、工作流版本、任务 ID、历史记录和检查点。已有成功阶段复用，结果不明时查询状态，不能自动重放。

历史普通 Agent 的外部任务保留可读记录。待确认计划或待执行外部调用应进入待交接状态，明确提示由外部助手接续；不能因为升级就执行或重新提交。既有画布创作 Skill 不需要清空。

## 实施顺序与验收

1. 确认外部对话入口，完成一个只读场景查询与任务交接闭环。
2. 建立内部 Agent 工具白名单、执行端校验和受信任工作流启动入口。覆盖普通调用、旧计划确认、恢复和重试。
3. 修改 Blender/Rhino 工作台和 Skill 选择器，任务入口改为外部交接，软件连接继续可用。
4. 落地持久交接、外部任务状态和产物回画布。切换项目或重启后仍能找到原任务，不重复执行。
5. 独立固定工作流设置与执行记录，并同步现有 MCP、Rhino 工作台和 Agent 文档。

验收只围绕本次边界调整：已连接外部 MCP 不进入内部模型工具列表；伪造或历史外部调用不会执行；画布生成与整理继续可用；已有 Rhino 固定流程无文字模型请求且可恢复；软件任务由目标外部对话接手；产物进入原项目。真实建模或付费生成不用于替代这些边界测试。

## 代码依据

- `src/agent-sidebar.js`：软件面板回调目前选中外部软件 Skill 并切到内部 Agent。
- `src/blender-workbench.js`、`src/rhino-workbench.js`：任务按钮目前调用 `onAgent`。
- `electron-main/agent-runtime.cjs`：工具注入、外部调用、确认和恢复均在此处。
- `electron-main/agent-services.cjs`：内部 runtime 与 MCP 连接服务的装配。
- `electron-main/hunyuan-rhino-workflow.cjs`：固定脚本任务对 runtime 的依赖。
- `electron-main/workflow-service.cjs`、`shared/workflow-tools.cjs`：需要保留兼容的工作流接口。
- `mcp/flow-canvas-mcp.mjs`、`electron-main/mcp-bridge.js`：现有本机对外接口。
