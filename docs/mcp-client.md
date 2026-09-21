# MCP 外部软件连接

Corvas 管理 Rhino、Blender 等本机软件的 MCP 连接，外部 Codex 对话通过 `flow_canvas.handoff.*` 接手任务并调用软件。画布内 Agent 只执行当前项目的画布创作工具，不再发现或调用外部 MCP。

## 连接方式

进入 **设置 > API > MCP 外部软件连接**，点击加号。

| 类型 | 配置 |
| --- | --- |
| 本地程序（stdio） | 程序路径或命令、参数 JSON 数组、可选工作目录和环境变量 |
| Streamable HTTP | 完整 MCP URL、可选认证请求头 |
| SSE | 旧版 SSE URL、可选认证请求头 |

参数必须是数组，例如 `["/absolute/path/to/server.js"]`，不能把整行 shell 命令塞进“程序”。工作目录使用绝对路径。安装包不会捆绑 Node、Python、uv、Rhino 或 Blender；按外部 MCP 项目的要求安装运行环境和软件侧插件。macOS 图形应用的 PATH 可能与终端不同，程序使用绝对路径更可靠。

保存并连接后会显示连接状态和完整工具列表。已有配置可编辑、停用、删除或重新连接；重连会重新读取工具。外部助手只能调用交接任务目标软件的已启用连接。Blender 服务名称包含 Blender；Rhino 名称包含 Rhino/Cordyceps，或提供 `rhino_scene` 工具。

环境变量和请求头不会回传到表单。编辑时留空保留原值，输入 `{}` 清空。配置使用 Electron `safeStorage` 加密，单独保存在应用数据目录的 `data/mcp-clients.json`，不改动已有 API 配置。解密失败时保留原文件，不静默覆盖。

## Codex 交接

工作台的预览、整理或动画按钮创建持久交接任务，固定原项目、有序素材节点和素材版本。用户复制交接指令到已连接 Corvas MCP 的 Codex 对话；创建任务不会自动发送消息或唤醒空闲对话。接手后状态回写到工作台，确认和错误处理在 Codex 中完成。记录对话链接后可从工作台返回该对话。

- `handoff.list/get`：显式传入 `projectId`，读取任务与 `referenceIssues`；素材变化时先核对原始要求。
- `handoff.claim`：未接手任务使用稳定 `clientId`；跨对话恢复时沿用返回的 `owner.clientId`。可记录 `codex://threads/<uuid>` 的 `conversationUrl`。
- `handoff.tools`：取得目标软件真实 schema、`serverId`、远端 `name` 和 `binding`，不返回启动命令、环境变量、认证头或连接 URL。
- `handoff.call`：传入原项目、任务、owner、工具绑定、参数和稳定 `requestId`。响应丢失时复用原请求，不换 ID 重发。
- `handoff.update`：同步 `running/awaiting_user/completed/failed/canceled` 与摘要。只有原项目已存在的产物才能填入 `resultNodeIds`。

产物回画布使用 `flow_canvas.item.add` 并显式传任务的 `projectId`；切换当前项目不会改变输出归属。同一路径重复导入会复用节点。单纯返回截图或文件路径不代表已经入库。

## 执行与恢复

- 通过官方 MCP SDK 完成初始化、工具发现、调用、超时和取消。内部工具名按服务 ID 和远端工具名哈希，避免不同软件的同名工具冲突。
- 同一个连接上的操作串行提交；工具参数按发现的 JSON Schema 校验。配置或工具 schema 变更后，旧规划不能直接执行。
- 任务状态和调用回执独立保存在 `data/external-handoffs.json`。外部助手负责规划和用户确认，不调用内部文字模型。服务的 `readOnlyHint` 是服务提供的提示。
- 工具文本、结构化数据和图像进入持久回执，图像通过 MCP 原生内容返回外部助手；单次结果限制为 4 MB。
- 调用前写入检查点。崩溃、超时或断连造成修改结果不明时，中止该轮执行；恢复不能自动重发。已保存的完成结果可复用，避免再次操作场景。
- 停止请求会通知 MCP 服务，但不能保证外部程序撤回已经执行的操作。Flow Canvas 的画布撤销不等于 Rhino/Blender 的场景撤销。

## 当前边界

这是通用客户端，并未自动安装 Rhino/Blender 的软件侧插件。地址、启动命令和工具能力应以用户安装的 MCP 服务为准，不将普通软件 socket 端口当成标准 MCP HTTP 地址。

外部软件的活动文档是全局状态，Codex 应先读取场景再操作。同一连接存在未知写操作时，其他项目或任务也不能继续写入；阻断信息指出原任务。不同连接指向同一场景仍不能保证互斥，应避免重复配置。

未知结果可用声明只读的工具核验。混合读写工具不能仅凭 action 参数推定只读；没有独立只读工具时，可在软件界面核验后，通过 `update.resolvedCalls` 提交观察结果。已取消任务也可补充核验，但不能重新开启。

对外使用 `mcp/flow-canvas-mcp.mjs` 本机 stdio 入口，不含 ChatGPT 网页端远程 MCP 或 OAuth。内部 Agent 的历史外部任务保留可读记录，但不能继续执行通用软件调用。混元到 Rhino 固定流程保留 `workflow.*` 及检查点；独立模式用 `workflow.list/configure` 查看和设置。

## 验证

```powershell
node --test electron-main/mcp-client.test.cjs electron-main/agent-runtime.test.cjs
npm run build
node scripts/mcp-client-smoke.cjs
```

桌面冒烟测试使用 Playwright（可通过 `PLAYWRIGHT_MODULE` 指定模块路径）、隔离配置和模拟服务，不读取用户 API、不产生付费调用。覆盖软件任务交接、真实 stdio/HTTP 调用、内部模型隔离、状态回写和连接设置。测试结束关闭进程并删除临时配置。
