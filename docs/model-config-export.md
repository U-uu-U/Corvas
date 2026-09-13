# 模型配置导出说明

## 这份包是什么

这是当前工作区的**源码内置模型配置**，不是正在运行客户端的缓存，也不是线上正在使用的配置。
导出时间、来源版本、模型清单及文件 SHA-256 见 `MANIFEST.json`。
不读取或导出 API Key、用户 API 配置、对话和任务记录。

- `CONFIG.json`：可发布的纯参数 JSON。保留所有模型及参数值，移除原因、备注、实测记录和通过率说明。
- `CONFIG-NOTES.md`：按模型与原字段保存上述说明，与运行配置分开；不会下发或执行。
- `model-config.schema.json`：对应校验规则。
- `MANIFEST.json`：导出来源、模型清单及文件校验值，不是运行配置。

默认只导出上述四个文件，不附源码或测试资料。使用 `--with-reference` 才额外包含原始渠道 CSV、
`LOCAL-ONLY.json` 本地价格/默认值快照、交接说明和 `reference/` 相关源码。附录仅供迁移参考，不能直接作为 CONFIG 使用。
本次分离只影响导出结果，本地原始配置和已有 CSV 校验链不改动，原始依据仍可追溯。

## 当前不是全部写死本地

客户端已有远端配置机制，默认读取 `https://artconfig.ravenhash.org/config`。
启动时先使用已有缓存或内置默认，拉取成功后更新；失败保留现有配置，不清空模型。
默认每小时在后台刷新，用户界面不显示模型配置维护入口。
明确清空地址会关闭远端更新。当前线上内容必须通过实际 `/config` 响应或管理面板确认。

## 哪些能远端修改

| 配置部分 | 当前效果 |
| --- | --- |
| 模型/线路匹配规则、能力说明、提示词长度 | 参与匹配、展示及提交前校验；不等于创建账户的 API 通道 |
| 视频时长、分辨率、比例、参考素材数量和明确支持的开关 | 覆盖既有 profile，影响参数控件和提交校验；最终仍受适配器能发送的协议约束 |
| 图片分辨率档位 | 覆盖档位及默认档位；具体像素换算仍由本地实现 |
| `options` 的其他已接入字段 | 用于校验，不代表每个选项都能动态创建 UI 控件或更改控件默认值 |
| `parameters.accepts` / 字段别名 | 文档和校验使用，不会动态修改 HTTP 字段名或请求体 |
| `unknown` 或未收录模型 | 表示未确认，不把未知限制当成禁止；保留原适配逻辑 |

修改时保持 `schemaVersion: 1`，保留条目的稳定 `id` 和准确的 `match`。
现有服务按整份 CONFIG 发布，不是仅发送修改过的单个条目的 patch。
新增陌生接口协议仅修改 JSON 不够，仍需要客户端适配器。

## 仍在本地的部分

1. **售价和线路卡片**：`shared/video-model-profiles.mjs` 中的价格、币种、计价单位、线路分组等。
   当前 `mergeVideoProfile` 保留本地价格和线路元数据，远端加 `price` 不会改变显示；更不会改变中转站扣费。
   使用 `--with-reference` 时，已配置价格原样导出为 `LOCAL-ONLY.json` 的 `pricedRoutes`，币种是 `CNY`、单位是每次请求、类别是售价。
   未维护的价格没有填成 0，不推测成本。
2. **图片/MJ 控件和默认值**：`src/canvas.js`、`src/node-types.js`、`src/agent-sidebar.js`。
   MJ 版本、滑杆范围、预设和图片比例/尺寸菜单仍存在本地定义；最终 MJ 命令参数还会在适配器里限制。
3. **实际请求协议**：`electron-main/video-provider-adapters.js`、`openai-image-request.js`、`mcp-bridge.js`。
   URL 路由、鉴权方式、字段拼装、部分固定分辨率/时长、MJ 命令编译，以及上传/下载预算都不是 CONFIG 动态执行的。
4. **并发和任务数量**：`limits.concurrency` / `limits.resultsPerRequest` 目前主要用于能力说明。
   实际节点执行读取节点自己的 `config.concurrency`，MJ 单节点内部批次固定为 1；不代表整个画布只能跑一个节点。
   Agent 自己也有批次上限。因此不能仅靠修改 CONFIG 里的并发数字来控制全部执行。
5. **文字模型**：已有工具/流式字段描述，但上下文窗口等仍有 `unknown`，实际请求参数受 Provider 实现约束。

使用 `--with-reference` 时，以上源码位于包内 `reference/` 对应路径，供后续迁移到远端时核对。
不能把这些实现中的本地上限误写为“上游已验证的能力”。

## 如何发布

1. 先从现有管理面板下载线上现行版作为备份，并与本包 `CONFIG.json` 比较，避免覆盖线上已有修改。
2. 在配置服务的 `/admin` 编辑整份 JSON，先校验，再保存并应用。现有服务会生成新版本，自动设置 `revision`、`updatedAt` 和 `source`，历史版本可回滚。
3. 等待客户端后台自动刷新，再检查一个对应节点的参数控件。

现有管理面板入口：`https://artconfig.ravenhash.org/admin`。
若自行托管，配置 URL 应直接返回符合 schema 的 JSON；不要把 `LOCAL-ONLY.json` 或本说明当作 CONFIG 上传。
单纯导出不会修改或发布线上配置。

## 再次导出

在项目根目录执行 `node scripts/export-model-config.mjs`。
需要完整开发参考资料时执行 `node scripts/export-model-config.mjs --with-reference`。
新目录生成在 `output/Flow-Canvas-model-config-<UTC时间>/`，不会覆盖上一次导出。
如要更新源码内置版，修改 `shared/model-config.default.json` 并同步原始表说明，然后执行
`node scripts/sync-model-config.mjs --write` 和 `npm run check:model-config`。
