# Flow Canvas 模型远端配置交接说明

核对日期：2026-09-13。以下是当前工作区的实现情况，不代表所有已发布安装包都具备相同代码。

## 交接目标

希望后续能在后台修改模型参数、限制、展示名称、线路说明、价格和默认值，客户端刷新后生效，减少重新打包。
**不要从零再建一套 CONFIG：项目已经有配置服务、客户端拉取、缓存和参数校验，需要补齐没有接入的部分。**
本次只导出配置并梳理现状，下面的改造建议尚未实现，也没有发布任何线上变更。

## 先看这些文件

配置含 15 条模型/线路：图片 3 条、视频 10 条、文字 2 条。最新导出将参数与说明分开，旧的 `20260913T085416Z` 包尚未做这次精简。
这不是账户可用模型清单；同一模型可以有多个线路条目，单个条目也可以匹配多个模型别名。

| 包内文件 | 用途 |
| --- | --- |
| `CONFIG.json` | 纯参数能力配置，去除原因与备注，不改参数值，可作为远端编辑底稿 |
| `CONFIG-NOTES.md` | 原因、备注、实测依据，单独保存，不参与运行配置 |
| `LOCAL-ONLY.json`（可选附录） | 本地视频 profile、售价、节点控件默认值和图片尺寸换算结果；仅作迁移参考，不能直接当 CONFIG 发布 |
| `model-config.schema.json` | 对应校验规则 |
| `model-channels.source.csv`（可选附录） | 原始渠道与限制说明 |
| `MANIFEST.json` | 导出来源、时间、模型清单和文件哈希 |
| `reference/`（可选附录） | 相关源码快照及配置服务说明，不是完整应用源码 |

`node scripts/export-model-config.mjs` 默认输出纯配置、配套说明、schema 和清单；添加 `--with-reference` 才输出开发附录。
本地原始资料未删除，导出时把说明移出 JSON；省略 `reason` 已符合当前 schema，`unknown` / `unsupported` 等状态仍保留。

包里不含 API Key、用户配置、对话或任务记录。它也不是客户端正在使用的缓存或线上现行版。
本机在上述日期访问默认服务的 `/config` 和 `/health` 均得到 HTTP 502，因此未取得线上配置。
这只说明本次访问失败，尚未定位是代理、网络还是配置服务本身的问题。发布前应先备份并比较线上现行版，不能直接覆盖。

## 现有配置链路

以下源码路径均相对于项目根目录。

```text
shared/model-channels.source.csv + shared/model-config.default.json
    -> scripts/sync-model-config.mjs --write
    -> src/model-config-default.js + configserver 的 seed/schema 副本

远端 GET /config -> Electron 主进程校验 -> 客户端缓存/生效配置
    -> 模型能力匹配 -> 参数界面与生成前校验
```

- 默认更新地址：`https://artconfig.ravenhash.org/config`；管理入口：`https://artconfig.ravenhash.org/admin`。
- 服务实现已在 `configserver/`，有校验、发布、历史版本和回滚；部署说明见 `configserver/README.md`。
- `src/model-config.js` 管理来源：启动先用缓存或内置版，成功拉取后更新；失败保留已有配置。默认每小时后台刷新，用户界面不提供配置维护入口。
- `electron-main/model-config-service.cjs` 负责请求和 schema 校验。当前客户端只消费 `schemaVersion: 1`，远端发布的是完整配置，不是局部 patch。
- `src/model-config-capabilities.js` 负责匹配、校验和转换 profile；`electron-main/agent-generation.mjs` 在 Agent 模型列表、计划和执行时复用能力校验。
- API Key、账户地址和账户可用模型属于独立的 API 配置，不应移入公开 `/config`。新增能力条目也不会自动给账户开通模型权限。

## 已接入与未接入

| 内容 | 当前实际效果 |
| --- | --- |
| 模型匹配、能力说明、提示词长度、已接入参数约束 | CONFIG 已参与展示或校验 |
| 视频时长、分辨率、比例、参考素材数量、明确支持的开关 | CONFIG 可覆盖既有 profile，影响控件与提交校验；但不能突破适配器支持的协议 |
| 图片分辨率档位 | 可覆盖档位和默认档位；具体像素换算仍在 `src/image-node-settings.js` |
| 所有控件的默认值和菜单项 | 未完全接入，尤其图片/MJ；JSON 中写了 `default` 不代表相应控件一定使用它 |
| 价格、线路分组、线路小字和名称 | 仍有本地定义；`mergeVideoProfile` 保留本地价格和线路元数据，远端加 `price` 不会自动生效 |
| `limits.concurrency` / `limits.resultsPerRequest` | 主要用于说明，不是统一调度或产物处理规则 |
| `parameters.accepts` / 参数别名 | 供说明和校验使用，不会自动改 HTTP 字段名或请求体 |
| 请求端点、鉴权、上传、轮询、MJ 参数编译 | 仍由适配器代码处理；未知协议不能靠增加 JSON 条目获得支持 |

本地定义重点查：`shared/video-model-profiles.mjs`、`src/canvas.js`、`src/agent-sidebar.js`、`src/node-types.js`。
请求实现重点查：`electron-main/openai-image-request.js`、`electron-main/video-provider-adapters.js`、`electron-main/mcp-bridge.js`。

价格快照均为**人民币售价/每次请求**：固定 30 秒 SD2.5 线路一、二为 6 元；`seedance_v2.5` 为 5 元；
`seedance_v2.0-933` 为 6.5 元；`seedance_v2.5-101010` 为 7 元；`seedance_v2.5-301010` 为 10 元。
这些是当前客户端代码中的显示值，适用于其 RavenHash art 地址匹配条件，不是本次读取的服务器计费规则，也不是成本。
修改显示价格与修改中转站实际扣费必须分开处理，其他未确认价格不能填 0 或推测为美元。

## 建议改造顺序

1. **先统一名称、线路说明和展示价格。** 扩展 schema 和共同的 profile 解析器，同时让画布与 Agent 读取；仅在有明确远端字段时覆盖，否则保留本地回退。价格包含金额、币种、单位、售价/成本类别、来源及更新时间。
2. **再统一控件和参数默认值。** 梳理 `options` 到 UI、节点默认配置和实际提交参数的完整路径，避免界面选了一个值、适配器却发送另一个值。刷新配置不应直接覆盖用户已填写的提示词和参数，失效值应明确提示。
3. **最后接入执行限制。** 区分单节点批次并发、跨节点并发、账户/线路限流及单请求产物数，不要把说明里的 `concurrency: 1` 变成整个画布的全局锁。目前图片节点默认并发 3、视频默认 2；MJ 单节点内部批次固定 1，Agent 另有批次数量限制。
4. **协议逻辑保留适配层。** 可按需提取已确认的固定参数，但不要通过远端配置下发任意可执行代码。对已有适配器的新别名和真正的新协议分别处理。

新字段仅通过 schema 还不够，必须有实际消费者；旧客户端忽略新字段也不代表已经支持。
新增字段及消费者应一起发布，明确最低支持版本。本地 fallback 与远端配置不应变成两套互相矛盾的限制。
服务端的 `revision`、`updatedAt`、`source` 已有发布盖章机制，继续复用，不另造版本体系。

## 保留的行为与验收

- SD2.5 线路一、二均固定 30 秒；独立 `seedance_v2.5` 才是 4-30 秒。其他 HM 模型按各自条目处理，不套用同名系列的范围。
- 已经明确的限制继续校验；未知边界保留 `unknown` 或警告，不因未列入 `accepts` 就全部禁止。未收录模型不应单纯因为未收录而无法使用。
- 同名多线路要保留匹配与歧义处理，尤其 H3；不要猜测线路，也不要自动套用其他供应商的规格。
- 验证后台发布后，设置里显示新版本，画布控件、请求前校验、实际提交参数、Agent/MCP 模型能力结果一致；改显示价格不得改变真实扣费。
- 验证断网、HTTP 502、坏 JSON、旧缓存、回滚和重启；已有配置与用户 API 不能丢失。
- 验证多个视频节点仍能并发、运行中刷新配置不重复提交任务；MJ 的四张产物不应变成四次付费调用。
- Windows 和 macOS 都需检查刷新与参数界面。先模拟 Provider 验证请求参数，不必为每个未知参数大规模付费试探。

源码配置更新后执行：

```sh
node scripts/sync-model-config.mjs --write
npm run check:model-config
npm run check
npm run test:model-config:smoke
```

已有烟测覆盖配置服务发布/回滚到 Electron 界面，新增字段应补充对应断言。上述命令是协作者改造后的验收步骤，不表示本次已对尚未实现的改造执行过测试。
按 `CONTRIBUTING.md` 从开发分支推进并通过 PR 集成；本次工作区还有其他未提交修改，不要整包覆盖源码或混入无关变更。
