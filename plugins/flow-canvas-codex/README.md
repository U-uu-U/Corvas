# Corvas Codex Plugin

这个插件让 Codex 通过标准 MCP 连接正在运行的 Corvas。Codex 可以读取当前项目、文件夹组、素材和规划表，修改画布节点与连线，调用 Corvas 已授权的图片和视频生成能力，也可以直接运行和恢复混元模型导入 Rhino 的固定工作流。

## 使用前提

- 已安装 Node.js 18 或更高版本。
- Corvas 已从源码安装依赖，并且正在运行桌面应用。
- Codex 能够访问这个插件目录和 Corvas 源码目录。
- 使用 Rhino 工作流时，本机需安装 Rhino，并配置好 Corvas 的 Rhino/Cordyceps 连接；混元账号需已在 Corvas 中登录，目标模型已经生成。

## 安装与连接

将这个目录作为 Codex 本地插件安装后，插件会用 `scripts/launch.cjs` 启动 `mcp/flow-canvas-mcp.mjs`。在当前仓库目录中无需额外设置；如果插件被复制到其他位置，请设置：

```powershell
$env:FLOW_CANVAS_ROOT = 'E:\path\to\flow-canvas'
```

如果 Corvas 使用非默认桥接端口，可以设置：

```powershell
$env:FLOW_CANVAS_MCP_PORT = '18765'
```

默认桥接地址是 `http://127.0.0.1:18765`。Corvas 启动后，Codex 会自动发现插件里的 `flow-canvas` MCP 服务。

## 能力范围

- 读取当前项目、文件夹组、画板快照和素材
- 读取、创建、更新、删除规划表及其行
- 通过带 revision 检查的事务创建和修改节点、连线、排列并撤销
- 查询、取消和恢复生成任务
- 调用已在 Corvas 中配置并允许使用的图片或视频模型
- 列出内置工作流、读取混元模型来源、提交 Rhino 整理任务、查询阶段结果，以及恢复或取消任务

画布修改遵循 `get_snapshot -> preview -> apply`。媒体生成属于可能产生费用的操作，Codex 应在提交前确认模型、素材、数量和参数。

## 复用 Rhino 工作流

首个可执行模板是 `hunyuan-rhino-cleanup`，版本 `1`。它下载已生成的混元模型，连接 Rhino，导入并按固定脚本完成检查、清理、四边面整理和验证。执行过程不调用内置 Agent 的文字模型。页面上的自动/手动入口仍然可用。

连接后可以直接说：

> 把当前混元模型按之前的流程导入犀牛并整理。

Agent 先通过 `flow_canvas.workflow.list/get` 读取模板，再用 `flow_canvas.workflow.sources` 找到当前模型，调用 `flow_canvas.workflow.run` 提交。接口立即返回任务 ID，之后用 `flow_canvas.workflow.status` 查询进度。

换一个模型时复用同一模板，创建新任务；继续旧任务时，通过 `flow_canvas.workflow.history` 找回原项目中的任务，再用 `flow_canvas.workflow.resume` 继续。每次提交保留固定的 `requestId`；提交响应丢失时使用同一 ID 和相同参数重试，避免重复启动。取消只停止后续阶段，不能撤销已经导入的模型或强制中止正在执行的 Rhino 命令。

工作流定义、任务和阶段记录保存在 Corvas 本地，不依赖某一段聊天。换聊天或换 MCP 客户端后，连接同一个 Corvas 实例并使用原项目，仍可找回任务。Corvas 退出后不再调度后续步骤，已发出的 Rhino 命令可能继续；重启后需先查询状态，按返回的恢复指引继续。这不意味着任务会自动同步到其他电脑。

当前只提供这一条内置模板，不支持通过 MCP 上传任意脚本或定义任意工作流。完整调用约定见 [工作流指引](skills/flow-canvas/references/workflows.md)。

## Skill 与其他 MCP 客户端

插件通过 `.codex-plugin/plugin.json` 同时声明 MCP 服务和 `skills/flow-canvas/SKILL.md`。支持该插件格式及 Skill 的客户端可以发现配套操作指引。

仅配置 MCP 连接的其他客户端会获得工具及参数说明，**不会因此自动加载这个 Skill**。这些客户端仍可通过 `workflow.list/get` 发现并使用已保存的工作流；需要完整操作指引时，应另外安装或提供这个 Skill。MCP 客户端退出不会删除任务，但本地执行需要 Corvas 持续运行。

## 手动验证

在 Corvas 运行后，可在插件目录执行：

```powershell
node scripts/launch.cjs
```

该进程使用 MCP stdio 协议，不要把日志写入 stdout；错误只会写入 stderr。
