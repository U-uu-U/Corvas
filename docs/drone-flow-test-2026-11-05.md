# 无人机全流程测试（2026-11-05 夜间，外部 MCP + 内部 Agent）

分支 `claude/electron-upgrade-ca1882`（Electron 45），用你的真实数据目录 `%APPDATA%/flow-canvas` 运行。

## 结果

| 步骤 | 方式 | 结果 |
|---|---|---|
| 整机六视图 | 外部 MCP `flow_canvas.image.generate`（gpt-image-2） | 成功，1 张 |
| 5 个零件四视图 | 外部 MCP，以六视图为参考图，每个零件一张 2×2 视图，再切成 4 张 | 成功，5 张（机身、涵道旋翼、旋翼支臂、云台相机、起落架） |
| 混元 3D 生成 | 外部 MCP 新工具 `workflow.open_account` + `workflow.generate`，账号 1，v3.1 四视图 | 5 个零件全部生成 |
| 导入 Rhino 并 reMesh | 自动模式：下载 → 导入 → 清理 → 四边面重建 → 校验 | 5 个全部完成 |
| Rhino 打开 Grasshopper + MCP | `scripts/rhino-open-mcp.cjs` | 成功，Cordyceps 端点 26929 可用 |
| 在 Rhino 拼装 | `scripts/rhino-assemble.mjs` + `scripts/rhino/drone-assembly.json`，通过 Rhino MCP | 12 个实例放在 `Corvas Assembly::Drone` 图层：1 机身、4 支臂、4 涵道、1 云台、2 起落架；源网格未改动 |
| 内部 Agent 跑全流程 | 通过外部 MCP 启动 `agent.start`，计划在任务卡确认 | Agent 依次调用 list → sources → open_account → generate，按规则先停下等确认；确认后混元返回 200008“当日配额已用完”，Agent 如实报告，没有重发 |

出图共用 6 张（批准的上限是 100 张）。混元账号 1 今天的配额已经用完，所以内部 Agent 的 Rhino 导入这一步没跑到；明天配额恢复后可以重跑。

## 改了什么（每条都已提交，`npm run check` 通过）

| 提交 | 内容 |
|---|---|
| `e89dc9d` | 新增 `flow_canvas.workflow.generate`：从已授权的画布素材上传视图，调用混元 `views2geometry`。按 requestId 记录回执，同一 requestId 不会重复提交；新增 `scripts/rhino-open-mcp.cjs` |
| `073f281` | 外部 MCP 出图、出视频改为传 `providerId`（取自 `model.list`），账号由 Corvas 在本机解析，Key 不经过外部客户端。原来不传账号会静默生成本地占位图，现在会直接报错 |
| `a8ea035` | 新增 `workflow.open_account`（免费，不会提交任何生成）。明确被拒的提交会清掉回执，允许原 requestId 重试；结果不明的提交仍然锁定 |
| `be829d3` | 内部 Agent 也能使用这套固定的混元→Rhino 工作流工具（和外部 MCP 共用同一个服务）；`workflow.generate` 和 `graph.run` 一样，先等用户确认 |
| `7bac470` | 混元返回 HTTP 错误体（例如任务过多、配额用完）时按“明确拒绝”处理，不再误判为“结果不明” |
| `8e0faf0` `79195ec` | Rhino 拼装脚本和无人机拼装配置 |
| `849eeb5` | 修复：外部调用 `agent.start` 时找不到文字模型（没有按生效的 CONFIG 解析） |
| `6d6ee81` | 修复：中转站对无参数的工具调用会返回 `""` 作为参数，Agent 原来直接失败，现在按 `{}` 处理；确认计划时如果混元窗口已关，会先自动重新打开 |

## 需要你决定或处理的

1. **内部 Agent 换成 Claude Code 的 Key：没做。** Claude Code 用的是 `~/.claude/settings.json` 里的 `ANTHROPIC_AUTH_TOKEN` 和 `https://ai.ravenhash.org`，但这个 Key 只能访问“Claude官号”分组，换到 Corvas 里任何调用都会返回 403“No permission to access group Claude官号”。我验证过 Messages 和 OpenAI 两种格式，模型试了 `claude-opus-4-8` 和 `gpt-5.6-terra`，全部 403。另外，那个账号所在的分组不允许走 `/v1/messages`。所以 Agent 继续用你原来配的文字模型 `gpt-5.6-terra`（OpenAI 兼容线路），实测支持工具调用。要换，得在中转站给这个 Key 开通对应分组，或者另给一个 Key。
2. **混元配额**：账号 1 今天的额度用完了。内部 Agent 的完整一轮（生成 → 导入 Rhino）要等配额恢复，或者换账号 2 再跑。
3. **拼装是初步的**：位置和比例是按六视图估的，支臂和涵道的接口没有精确对齐。拼装配置是 JSON，改坐标后重跑脚本就会替换原来那批副本。
4. **MCP 工具权限**：按你说的，外部 MCP 的允许列表已经补回 12 个默认工具（出图、出视频、item 增删改等）。
5. **还没推送**：这些提交都还在分支上，PR #66 里还看不到；那个 PR 本来只是 Electron 升级。要不要拆成单独的 PR，等你决定。

## 文件位置

- 视图：`%APPDATA%/flow-canvas/data/captured/drone-mcp-test/`（`views/` 下是 20 张切好的视图）
- Rhino：已另存为 `%APPDATA%/flow-canvas/data/captured/drone-mcp-test/drone-assembly.3dm`（285 MB，拼装在图层 `Corvas Assembly::Drone`），预览图 `drone-assembly-preview.png`
- 混元提交回执：`%APPDATA%/flow-canvas/data/hunyuan-generate-receipts.json`
