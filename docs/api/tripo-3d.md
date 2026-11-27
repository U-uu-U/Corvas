# Tripo 3D 生成 API（v3）

更新时间：2026-11-12。本文是 Tripo（Tripo3D / VAST）官方 API 文档在 2026-11-12 的快照整理，
供不使用 SDK、直接编写 HTTP 适配器的工程师使用。文中所有事实均为当天从官方来源读到的内容；
没能确认的内容集中放在第 11 节「未核实」，不要按记忆补全。

来源标注约定：

- 不带标注：`https://developers.tripo3d.ai/en/docs/*` 官方文档页（含定价页、模型页）。
- 〔迁移〕：官方文档站提供下载的 v2→v3 迁移说明 `SKILL.md`（自述 2026-07 对照服务端源码核对）。
- 〔PySDK〕〔JSSDK〕：官方文档 SDK 页链接的官方仓库 `Tripo-Developer/tripo-python-sdk` v1.0.0、
  `Tripo-Developer/tripo-js-sdk` v0.5.0。
- 〔实测〕：2026-11-12 未携带 Key 访问时服务端返回的内容（没有调用任何生成接口）。

主文档与〔迁移〕〔SDK〕说法不一致的地方，正文会同时列出两种说法，并在第 11 节汇总。

## 1. 概述

Tripo API 提供异步的 3D 内容生成与后处理：

- 3D 生成：文本生成 3D、单图生成 3D、多视图（2～4 张）生成 3D，输出带贴图 / PBR 材质的网格模型；
  另有单图生成高斯泼溅（`.splat`）。
- 模型后处理：重新贴图、格式转换、重拓扑（减面）、智能 UV、网格分割、部件补全、外部模型导入。
- 动画：可绑骨检查、自动绑骨、预设动画重定向。
- 辅助图像生成：文生图、图生图、单图生成多视图、多视图编辑。

接入前必须知道的三件事：

1. **文档与 API 已整体迁移到 v3。** 旧入口 `https://platform.tripo3d.ai/docs` 现在 302 跳转到
   `https://developers.tripo3d.ai/`。旧 v2 API（`https://api.tripo3d.ai/v2/openapi`，统一
   `POST /task` 加 `type` 字段）在官方 SDK 文档中写明「计划于 2026-10-31 关停」。新适配器只对接 v3。
2. **v3 每种能力一个独立端点**，请求体里不再有 `type`；任务类型名（`text_to_model` 等）只出现在查询结果的 `type` 字段。
3. **v2 的 WebSocket watch、`refine_model`、`stylize_model` 在 v3 不可用**：watch 已移除〔迁移〕，
   refine / stylize 已退役（SDK 文档页）。详见 4.18。

官方文档入口：

- 文档首页与索引：`https://developers.tripo3d.ai/en/docs/introduction`、`https://developers.tripo3d.ai/llms.txt`
- 快速开始：`https://developers.tripo3d.ai/en/docs/quick-start`
- 每个文档页都有原始 Markdown 版本，在页面地址后加 `.md` 即可（如 `https://developers.tripo3d.ai/en/docs/task-query.md`），
  适合逐字比对参数。注意快速开始页的「模型 URL 5 分钟过期」提示和分场景流程只在渲染后的 HTML 页面里，`.md` 版本没有。
- 定价：`https://developers.tripo3d.ai/en/pricing`
- 中国大陆站：`https://developers.tripo3d.com`（文档结构相同，域名与计价货币不同）
- 没有找到公开的 OpenAPI schema（见第 11 节）。

## 2. 接入

### 2.1 Base URL 与区域

| 项目 | 国际站 | 中国大陆站 |
| --- | --- | --- |
| API Base URL | `https://openapi.tripo3d.ai/v3` | `https://openapi.tripo3d.com/v3` |
| 控制台（Key、Webhook、充值） | `https://developers.tripo3d.ai` | `https://developers.tripo3d.com` |
| 积分单价（定价页） | 1 积分 = $0.01 | 1 积分 = ¥0.07 |
| 结果下载域名〔迁移〕 | `tripo-data.rg1.data.tripo3d.com`（CloudFront） | `openapi.cdn.tripo3d.com`（百度 CDN） |

- 官方文档写明：从中国访问请使用中国站。〔迁移〕写明：一个 API Key 只在自己所属的区域有效，
  在错误区域调用 `GET /v3/account/balance` 会得到 HTTP 401；两个区域的端点、参数、响应结构、错误码一致。
- 适配器应把 Base URL 做成可配置项，不要写死其中一个。〔JSSDK〕的默认 Base URL 是中国站，
  〔PySDK〕默认国际站，说明两者都是正式入口。

### 2.2 鉴权

所有请求都带请求头：

```
Authorization: Bearer {api_key}
```

- Key 在控制台的「API Keys」页创建（`https://developers.tripo3d.ai/en/keys`），创建后只显示一次。
- Key 形如 `tsk_...`（SDK 文档页示例 `export TRIPO_API_KEY="tsk_..."`；〔迁移〕同样写 `tsk_…`；〔PySDK〕会拒绝不以 `tsk_` 开头的 Key）。
  快速开始页的安全提示里写的却是 `export TRIPO_API_KEY="sk-..."`，鉴权页用的是占位符 `your_api_key_here`。
  适配器不要校验 Key 前缀，原样放进 `Authorization` 头（见第 11 节）。
- 官方要求 Key 只放在服务端，不要放进前端代码；怀疑泄漏时在控制台删除后重建。
- v2 与 v3 共用同一把 Key。
- **文档没有提供测试 Key、沙箱环境或免费试用端点。**

### 2.3 版本

- API 版本写在路径里，当前为 `v3`。
- API 版本与模型版本相互独立：`model` 的取值（如 `v2.5-20250123`）是模型快照，不是 API 版本。
- 生产环境官方建议固定具体模型版本，避免模型更新导致输出不一致。

### 2.4 统一响应结构

成功：

```json
{
  "code": 0,
  "data": {
    ...
  }
}
```

失败：

```json
{
  "code": 2010,
  "status": "error",
  "message": "You don't have enough credit to create this task",
  "suggestion": "Please purchase more credit",
  "request_id": "req_abc123"
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `code` | integer | `0` 表示成功，非 `0` 表示错误 |
| `status` | string | 失败时为 `error`；部分成功响应会带 `success`（如用量历史接口示例、〔迁移〕） |
| `data` | object / array | 业务数据，仅成功时返回 |
| `message` | string | 错误描述，仅失败时返回 |
| `suggestion` | string | 修复建议，仅失败时返回 |
| `request_id` | string | 请求标识，失败时返回，但官方注明「可能缺失」 |

- 判断成功只看 `code == 0`，不要依赖 `status` 是否存在。
- 响应头带 `X-Request-ID` 与 `X-Tripo-Trace-ID`〔实测〕〔迁移〕；〔迁移〕称请求时也可以自带 `X-Request-ID`。
  排查问题时把它们和 `request_id`、`task_id` 一起记录。
- 积分类字段（`balance`、`frozen`、`credits_consumed`）是最多两位小数的 JSON **number**，
  必须按浮点 / 十进制解析，不能用整数解析。

## 3. 任务流程

所有生成与处理接口都是异步任务：

```
1. POST /v3/generation/* | /v3/models/* | /v3/mesh/* | /v3/animations/*   → 返回 task_id
2. GET  /v3/tasks/{task_id}（或 POST /v3/tasks/list 批量）               → 轮询到终态
3. status=success 后从 output.model_url 等字段立即下载
```

### 3.1 返回的标识

| 标识 | 来源 | 说明 |
| --- | --- | --- |
| `task_id` | 创建任务的响应 `data.task_id` | UUID 字符串（示例 `123e4567-e89b-42d3-a456-426614174000`）。当作不透明字符串原样保存，不要加 `task_` 前缀〔迁移〕 |
| `file_token` | `POST /v3/files`、`POST /v3/files/presign` | 形如 `file_<uuid>`〔迁移〕；用于后续请求的 `input` |
| `request_id` | 错误响应体 | 可能缺失 |
| `X-Request-ID` / `X-Tripo-Trace-ID` | 响应头 | 〔实测〕两者取值相同 |

`task_id` 可以直接作为后续任务的输入（例如把生成任务的 `task_id` 传给贴图、转换、绑骨），
服务端会自动取该任务的输出。

### 3.2 轮询

- 官方建议间隔：每 1～2 秒查询一次（任务生命周期页）；快速开始页写「每 2 秒」，并提示
  「不要超过每秒 1 次请求，以免触发限流」。〔迁移〕建议 2～5 秒。
- 多任务时用 `POST /v3/tasks/list`（一次最多 100 个）代替多次单查。
- 必须设置轮询上限。任务生命周期页建议设最大轮询时长（举例 5 分钟），SDK 文档页的示例用 20 分钟。
- 耗时参考：快速开始页写「通常 10～120 秒」；模型页写 H3.1 约 40 秒、绑骨约 30 秒、动画约 5 秒；
  高斯泼溅约 4 分钟；〔迁移〕写 3D 任务约 1～10 分钟。官方不承诺固定耗时。
- 查询请求不消耗创建配额〔迁移〕。
- 官方示例里的具体数值：快速开始页的完整示例最多轮询 300 次、每次间隔 2 秒（约 10 分钟），单次查询请求的超时设为 30 秒；
  〔PySDK〕`wait_for_task` 的间隔从 2 秒起每次翻倍、封顶 30 秒，默认不设总超时；〔JSSDK〕`waitForTask` 默认固定 2 秒、默认不设总超时。

### 3.3 Webhook（替代轮询）

- 在控制台 **Settings → Webhooks** 添加 HTTPS 地址并勾选事件，保存后得到签名密钥 `whsec_…`（只显示一次）。
  注册只能在控制台完成，没有 `/v3` 注册接口〔迁移〕。
- 事件：`task.completed`（成功）、`task.failed`（失败或取消）、`balance.low`（余额低于控制台 **Billing → Credit alert** 里设定的阈值；
  官方注明这个告警本身不会让任务失败）。
- Tripo 向你的地址 `POST` JSON，`Content-Type: application/json`。你的端点返回非 2xx 或超时会自动重试；
  要求约 5 秒内返回 2xx，耗时处理放到异步。失败的投递可在控制台 Settings → Webhooks → Recent deliveries 查看；
  重试次数与间隔官方没有写（见第 11 节）。

请求头：

| 请求头 | 说明 |
| --- | --- |
| `Tripo-Webhook-Id` | Tripo 侧的 Webhook 端点 ID |
| `Tripo-Webhook-Delivery` | 本次投递的唯一 ID，同一事件可能重复投递，用它去重 |
| `Tripo-Webhook-Event` | 与请求体 `type` 相同 |
| `Tripo-Webhook-Signature` | `t=<unix秒>,v1=<hex>` |

验签：先确认签名头里恰好有一个整数 `t` 和一个 64 位十六进制的 `v1`，再计算
`v1 = 小写hex(HMAC-SHA256(secret, t + "." + 原始请求体))`，用常数时间比较；
可选地拒绝 `t` 与当前时间相差超过 5 分钟的请求（官方示例启用了这一项）。
必须用未经解析的原始请求体字节计算。

请求体：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 事件 ID（任务 ID 加事件类型组合而成） |
| `type` | string | `task.completed` / `task.failed` / `balance.low` |
| `created_at` | string | ISO 8601 |
| `data` | object | 任务事件与「任务查询」的字段和状态一致；`balance.low` 带余额字段 |

```json
{
  "id": "evt_123e4567-e89b-42d3-a456-426614174000_task_completed",
  "type": "task.completed",
  "created_at": "2026-05-06T12:00:00Z",
  "data": {
    "task_id": "123e4567-e89b-42d3-a456-426614174000",
    "type": "text_to_model",
    "status": "success",
    "output": {
      "model_url": "https://cdn.tripo3d.ai/output/model_pbr.glb"
    }
  }
}
```

```json
{
  "id": "evt_123e4567-e89b-42d3-a456-426614174000_task_failed",
  "type": "task.failed",
  "created_at": "2026-05-06T12:00:05Z",
  "data": {
    "task_id": "123e4567-e89b-42d3-a456-426614174000",
    "type": "text_to_model",
    "status": "failed",
    "error_code": 2018,
    "error_message": "Task processing timeout"
  }
}
```

```json
{
  "id": "evt_balance_low:balance.low",
  "type": "balance.low",
  "created_at": "2026-05-06T12:00:00Z",
  "data": {
    "balance": 1200,
    "threshold": 5000
  }
}
```

### 3.4 SSE / WebSocket

v3 文档没有 SSE 或 WebSocket 接口。v2 的 `GET /task/watch/:id`、`/task/watch/all` 在 v3 没有对应物，
官方替代方案是轮询加 Webhook〔迁移〕。

### 3.5 下载与结果有效期

- 成功后从 `output.model_url` 下载模型，预览图在 `output.rendered_image_url`。
- 下载链接是带签名的临时链接。下载时**不要**附带 `Authorization` 头（SDK 文档页：官方 SDK 下载签名 URL 时都不带 API Key）。
- **有效期官方说法不一致**：快速开始页与〔JSSDK〕README 写「模型 URL 在 5 分钟后过期，任务成功后立即下载」；
  〔迁移〕写「签名下载 URL 约 24 小时有效」。适配器按 5 分钟处理：任务一成功就立刻下载并转存到自己的存储，
  不要把签名 URL 当作永久资源保存。
- 链接过期后重新查询任务可拿到新的链接（SDK 文档页排障条目、〔迁移〕）。
- 服务条款写明 Tripo 没有保存输入与输出的义务；文档没有给出任务结果在服务端的保留时长。

## 4. 端点

### 4.1 通用约定

- 除文件上传外，所有创建任务的请求都是 `POST`，`Content-Type: application/json`，带 `Authorization` 头。
- 创建成功的响应统一为下面的结构，只需读取 `data.task_id`。〔迁移〕称实际响应里还可能带
  `status: "success"` 以及 `data.type`、`data.status: "queued"`，不要依赖它们。

```json
{
  "code": 0,
  "data": {
    "task_id": "123e4567-e89b-42d3-a456-426614174000"
  }
}
```

- 任务结果统一通过 4.13「查询任务」获取，各小节的「任务结果示例」就是查询接口返回的内容。
- **`input` 字段的三种取值**（只能选一种，是同一个字符串字段，服务端自动识别类型）：

| 取值 | 示例 | 说明 |
| --- | --- | --- |
| `task_id` | `550e8400-e29b-41d4-a716-446655440000` | 之前任务的 ID，服务端自动取其输出。必须是裸 UUID〔迁移〕 |
| `file_token` | `file_abc123` | 先调用 4.15 / 4.16 上传得到 |
| URL | `https://example.com/model.glb` | 可公开访问的直链 |

- **不支持 Base64 / data URI**：〔迁移〕写明 `input: "data:image/png;base64,…"` 会被 400 拒绝，
  图片字节必须先上传换成 `file_token`。〔迁移〕同时写明请求体上限为 20 MB。
- 〔迁移〕写明未知的多余字段会被转发而不是拒绝，因此拼错的参数名不会报错，只会不生效。
- 〔迁移〕写明 v2 的字段名（如 `model_version`、`original_model_task_id`）在 v3 仍被接受；新代码一律使用本文的 v3 字段名。

### 4.2 3D 生成公共参数

文本、单图、多视图三个生成端点共用下面这组参数。H 系列与 P 系列是同一个端点，靠 `model` 区分，
但可用参数不同；「适用」列写明了范围。**不适用的参数必须整个省略，不要传 `false`**
（〔迁移〕：国际站对 P1 即使显式传 `false` 也会 400）。

| 参数 | 类型 | 必填 | 默认 | 取值与约束 | 适用 |
| --- | --- | --- | --- | --- | --- |
| `model` | string | 是 | 无 | H：`v3.1-20260211`、`v3.0-20250812`、`v2.5-20250123`；P：`P1-20260311`、`P2-20260801`。省略会返回 400 / `1004`〔迁移〕 | 全部 |
| `model_seed` | integer | 否 | 随机 | 几何随机种子；相同种子加相同输入得到相同网格 | 全部 |
| `face_limit` | integer | 否 | 自适应 | 输出面数上限，范围见下表 | 全部 |
| `texture` | boolean | 否 | `true` | 是否生成贴图；`false` 得到无贴图的白模 | 全部 |
| `pbr` | boolean | 否 | `true` | 是否生成 PBR 材质贴图（`base_color`、`metallic`、`roughness`、`normal`）；为 `true` 时 `texture` 被强制为 `true` | 全部 |
| `texture_seed` | integer | 否 | 随机 | 贴图随机种子；固定 `model_seed`、改变 `texture_seed` 可得到同几何不同贴图 | 全部 |
| `texture_quality` | string | 否 | `standard` | `fast` / `standard` / `detailed` / `extreme`（8K）。`fast` 只能配合贴图模型 `v3.5-20260815`：在生成端点上必须同时显式传 `texture_version=v3.5-20260815`（省略时推导出的是 v3.0 / v2.5），否则返回 `1004`，不会静默降级 | H 仅 ≥ v3.0；P 全部 |
| `texture_version` | string | 否 | 随几何模型推导 | `v3.5-20260815` / `v3.0-20250812` / `v2.5-20250123`。省略时：v2.5 几何用 `v2.5-20250123`，其余（含 P 系列）用 `v3.0-20250812` | 全部 |
| `delight` | boolean | 否 | `true` | 贴图前去除参考图里烘焙的光照；只有 `v3.5-20260815` 贴图模型读取，旧版本忽略 | 全部 |
| `geometry_quality` | string | 否 | `standard` | `standard` / `detailed`（Ultra，几何更精细）。不要与 v2.5 一起使用 | 仅 H ≥ v3.0 |
| `auto_size` | boolean | 否 | `false` | 按真实世界尺寸缩放，单位为米 | H 仅 ≥ v3.0；P 全部 |
| `quad` | boolean | 否 | `false` | 输出四边面网格。H 系列：未设 `face_limit` 时默认 10,000 面，且输出格式强制为 `FBX`。P 系列只有 P2 支持，对 P1 传 `quad=true` 返回 400 | H ≥ v3.0、P2 |
| `smart_low_poly` | boolean | 否 | `false` | 生成手工风格的干净低模拓扑，适合简单输入，复杂模型可能失败 | 仅 H ≥ v3.0 |
| `generate_parts` | boolean | 否 | `false` | 生成可编辑的分部件模型，与贴图互斥，见下方说明 | 仅 H ≥ v3.0 |
| `compress` | string | 否 | 不压缩 | 只有一个取值 `geometry`（meshopt 压缩） | 仅 H ≥ v3.0（P 系列文档页未列出） |
| `export_orientation` | string | 否 | `+x` | 导出朝向（前向轴）：`+x` / `-x` / `+y` / `-y` | 全部 |
| `export_uv` | boolean | 否 | `true` | 生成阶段是否展 UV；`false` 更快、文件更小，UV 留到贴图阶段处理 | 全部 |

`face_limit` 范围：

| 模型与模式 | 范围 |
| --- | --- |
| v3.1 三角面 | 上限 1,500,000；`geometry_quality=detailed` 时上限 2,000,000 |
| v3.0 三角面 | 上限 1,000,000；`geometry_quality=detailed` 时上限 2,000,000 |
| v2.5 三角面 | 上限 500,000（无 detailed 模式） |
| H 系列 `quad=true` | 上限 150,000 |
| H 系列 `smart_low_poly=true` | 固定范围：三角面 500～20,000，四边面 500～10,000，与模型版本无关 |
| `P1-20260311` | 50～20,000 |
| `P2-20260801` 三角面 | 48～50,000 |
| `P2-20260801` 且 `quad=true` | 48～25,000 |

- 官方参考值：游戏资产 50,000～100,000，Web / 移动端 10,000～50,000。
- P 系列质量建议：简单模型不低于 150 面，复杂模型不低于 250 面。

必须遵守的约束：

- `generate_parts=true` 时必须显式传 `texture=false` 且 `pbr=false`。因为 `texture` 默认 `true`，
  只省略不传也会被 `1004` 拒绝。同时传 `quad=true` 时 quad 被忽略（部件是三角面）；
  同时传 `smart_low_poly=true` 时以 smart_low_poly 为准，**不会**产出部件。
- `export_orientation` 只影响本次生成。模型后续还要做贴图、绑骨、重定向、转换时不要设置它：
  后处理可能得到朝向错误的结果，而任务仍然报告 `success`，不会报错。需要改朝向时放到最后一步的格式转换里做。
- P1、P2 都不支持 `smart_low_poly`、`generate_parts`、`geometry_quality`；P1 还不支持 `quad`。

### 4.3 文本生成 3D

`POST https://openapi.tripo3d.ai/v3/generation/text-to-model`，`Content-Type: application/json`。任务类型 `text_to_model`。

本端点特有参数（其余见 4.2）：

| 参数 | 类型 | 必填 | 默认 | 取值与约束 |
| --- | --- | --- | --- | --- |
| `prompt` | string | 是 | 无 | 文本提示词，最长 1024 字符。建议描述形状、材质、风格、尺度 |
| `negative_prompt` | string | 否 | 无 | 反向提示词，最长 255 字符 |
| `image_seed` | integer | 否 | 随机 | 内部「文生图」阶段的随机种子（先由文本生成参考图，再转 3D） |

H 系列请求示例：

```bash
curl --request POST \
  --url https://openapi.tripo3d.ai/v3/generation/text-to-model \
  --header 'Authorization: Bearer <token>' \
  --header 'Content-Type: application/json' \
  --data '{
  "prompt": "A cat wearing a spacesuit",
  "model": "v3.1-20260211",
  "texture": true,
  "pbr": true,
  "texture_quality": "detailed"
}'
```

```json
{
  "prompt": "A futuristic sci-fi helmet with glowing blue visor.",
  "model": "v3.1-20260211",
  "face_limit": 80000,
  "geometry_quality": "detailed",
  "auto_size": true
}
```

P 系列请求示例：

```json
{
  "prompt": "A cat wearing a spacesuit",
  "model": "P1-20260311",
  "face_limit": 3000,
  "texture": true,
  "pbr": true
}
```

```json
{
  "prompt": "A low-poly wooden chair",
  "model": "P2-20260801",
  "quad": true,
  "face_limit": 5000,
  "texture": true,
  "pbr": true
}
```

创建响应见 4.1。任务结果示例：

```json
{
  "code": 0,
  "data": {
    "task_id": "123e4567-e89b-42d3-a456-426614174000",
    "type": "text_to_model",
    "status": "success",
    "progress": 100,
    "output": {
      "model_url": "https://cdn.tripo3d.ai/output/model_pbr.glb",
      "rendered_image_url": "https://cdn.tripo3d.ai/output/preview.png"
    },
    "created_at": "2026-04-28T12:00:00Z",
    "completed_at": "2026-04-28T12:01:30Z"
  }
}
```

### 4.4 单图生成 3D

`POST https://openapi.tripo3d.ai/v3/generation/image-to-model`，`Content-Type: application/json`。任务类型 `image_to_model`。

本端点特有参数（其余见 4.2；没有 `prompt`、`negative_prompt`、`image_seed`）：

| 参数 | 类型 | 必填 | 默认 | 取值与约束 |
| --- | --- | --- | --- | --- |
| `input` | string | 是 | 无 | 图片来源，三选一：`file_token`；公开图片直链；之前图像生成任务（`text_to_image` 或 `image_to_image`）的 `task_id`。格式 `PNG` / `JPEG` / `WebP`，最大 20 MB，建议不小于 256 × 256 px，主体清晰、背景干净、少遮挡 |
| `enable_image_autofix` | boolean | 否 | `false` | 生成前自动优化输入图（低分辨率、低质量图的增强） |
| `texture_alignment` | string | 否 | `original_image` | `original_image`（优先贴合输入图颜色）/ `geometry`（优先贴合生成的几何） |
| `orientation` | string | 否 | `default` | `default`（自动朝向）/ `align_image`（对齐输入图视角）。只在 `texture` 为 `true` 时生效 |

请求示例：

```json
{
  "input": "https://example.com/image.png",
  "model": "v3.1-20260211",
  "texture": true,
  "pbr": true,
  "texture_quality": "detailed"
}
```

```json
{
  "input": "file_abc123",
  "model": "v3.1-20260211",
  "enable_image_autofix": true,
  "orientation": "align_image"
}
```

```json
{
  "input": "https://example.com/image.png",
  "model": "P2-20260801",
  "quad": true,
  "texture": true,
  "pbr": true
}
```

任务结果示例：

```json
{
  "code": 0,
  "data": {
    "task_id": "123e4567-e89b-42d3-a456-426614174000",
    "type": "image_to_model",
    "status": "success",
    "progress": 100,
    "output": {
      "model_url": "https://cdn.tripo3d.ai/output/model_pbr.glb",
      "rendered_image_url": "https://cdn.tripo3d.ai/output/preview.png"
    },
    "created_at": "2026-04-28T12:00:00Z",
    "completed_at": "2026-04-28T12:01:30Z"
  }
}
```

### 4.5 多视图生成 3D

`POST https://openapi.tripo3d.ai/v3/generation/multiview-to-model`，`Content-Type: application/json`。任务类型 `multiview_to_model`。

本端点特有参数（其余见 4.2；文档页没有列出 `enable_image_autofix`）：

| 参数 | 类型 | 必填 | 默认 | 取值与约束 |
| --- | --- | --- | --- | --- |
| `inputs` | object[] 或 string[] | 是 | 无 | 多视图图片，三种写法只能用一种，不能混用，见下 |
| `texture_alignment` | string | 否 | `original_image` | 同 4.4 |
| `orientation` | string | 否 | `default` | 同 4.4 |

`inputs` 的三种写法：

1. **view-key（推荐）**：对象数组，每个对象恰好有一个键，键名为 `front` / `left` / `back` / `right`。
   值可以是 URL、`file_token`，或嵌套对象 `{url}` / `{file_token}` / `{object:{bucket,key}}`。
   顺序无关，服务端会规范化为 `[front, left, back, right]`。
2. **旧式按位置**：恰好 4 个字符串，顺序 `[front, left, back, right]`，没有的视图用空字符串 `""` 占位。
   〔JSSDK〕按此发送空字符串；〔PySDK〕对缺失视图发送的是 JSON `null`，主文档没有写 `null` 是否被接受（见第 11 节）。
3. **task_id**：只接受单元素数组 `[{"task_id":"..."}]`，引用之前「单图生成多视图」或「多视图编辑」任务的 4 视图输出。
   源任务必须已经 `success` 且类型为 `image_to_multiview` 或 `edit_multiview`。

约束：正面（`front`）不能省略；其他视图可以省略，但至少要有 2 张图，最多 4 张。
所有图应是同一物体、光照一致。格式 `PNG` / `JPEG` / `WebP`，建议不小于 256 × 256 px。

文档索引（`llms.txt`）里多张图生成 3D 的端点只有这一个，视图固定为 `front` / `left` / `back` / `right` 四个槽位；
没有接受任意角度、任意张数图片的 3D 生成端点。

请求示例（view-key + URL）：

```json
{
  "inputs": [
    {
      "front": "https://example.com/front.png"
    },
    {
      "back": "https://example.com/back.png"
    },
    {
      "right": "https://example.com/right.png"
    }
  ],
  "model": "v3.1-20260211",
  "texture": false,
  "geometry_quality": "detailed"
}
```

请求示例（view-key + 本地文件）。每张本地图片先各自调用一次 4.15 上传，再把返回的 `file_token` 原样填进对应视图：

```json
{
  "inputs": [
    {
      "front": "<front 图上传返回的 file_token>"
    },
    {
      "left": "<left 图上传返回的 file_token>"
    }
  ],
  "model": "v3.1-20260211"
}
```

这个示例是按官方页面对取值的说明（每个视图的值接受 `file_token`，例 `file_abc123`）与上传接口的响应写的；
官方页面自己的「View-key with file_tokens」示例填的是裸 UUID，与上传接口的 `file_...` 格式对不上（见第 11 节第 22 条）。

请求示例（按位置）：

```json
{
  "inputs": [
    "https://example.com/front.png",
    "",
    "https://example.com/back.png",
    "https://example.com/right.png"
  ],
  "model": "v3.1-20260211",
  "texture": true,
  "pbr": true,
  "texture_quality": "detailed"
}
```

请求示例（引用多视图任务）：

```json
{
  "inputs": [
    {
      "task_id": "550e8400-e29b-41d4-a716-446655440000"
    }
  ],
  "model": "v3.1-20260211",
  "texture": true,
  "pbr": true
}
```

任务结果示例：

```json
{
  "code": 0,
  "data": {
    "task_id": "123e4567-e89b-42d3-a456-426614174000",
    "type": "multiview_to_model",
    "status": "success",
    "progress": 100,
    "output": {
      "model_url": "https://cdn.tripo3d.ai/output/model_pbr.glb",
      "rendered_image_url": "https://cdn.tripo3d.ai/output/preview.png"
    },
    "created_at": "2026-04-28T12:00:00Z",
    "completed_at": "2026-04-28T12:01:30Z"
  }
}
```

### 4.6 重新贴图

`POST https://openapi.tripo3d.ai/v3/models/texture`，`Content-Type: application/json`。任务类型 `texture_model`。
为已有模型重新生成贴图。

| 参数 | 类型 | 必填 | 默认 | 取值与约束 |
| --- | --- | --- | --- | --- |
| `input` | string | 是 | 无 | 模型来源，三选一：3D 生成任务的 `task_id`；`file_token`；模型直链。文件格式 `GLB` / `GLTF` / `FBX` / `OBJ` / `STL`，最大 150 MB |
| `model` | string | 否 | `v3.0-20250812` | 贴图模型版本：`v3.5-20260815`（最新，`fast` 与 `delight` 需要它）/ `v3.0-20250812`（适合 v3.0、v3.1 生成的模型）/ `v2.5-20250123`（适合 v2.5 生成的模型） |
| `texture_prompt` | object | 否 | 无 | 贴图引导，结构见下。模型由 Tripo 生成时可省略 |
| `pbr` | boolean | 否 | `true` | 是否生成 PBR 材质 |
| `texture_seed` | integer | 否 | 随机 | 贴图随机种子 |
| `texture_alignment` | string | 否 | `original_image` | `original_image` / `geometry` |
| `texture_quality` | string | 否 | `standard` | `fast`（仅 `model=v3.5-20260815`，否则 `1004`）/ `standard` / `detailed` / `extreme`（8K） |
| `part_names` | string[] | 否 | 全部部件 | 来自网格分割任务的部件名；省略时对所有部件贴图 |
| `compress` | string | 否 | 不压缩 | `geometry`（meshopt 压缩） |
| `bake` | boolean | 否 | `true` | 把高级材质效果烘焙进基础贴图，提高兼容性 |
| `delight` | boolean | 否 | `true` | 去除参考图光照；只有 `v3.5-20260815` 读取 |

`texture_prompt` 的字段（`text` / `image` / `images` 三者互斥，只能用一个）：

| 字段 | 说明 |
| --- | --- |
| `text` | 文本描述，例：`{"text": "worn leather with scratches"}` |
| `style_image` | 风格参考图，只能和 `text` 一起用。接受 `file_token` 或 `url`（官方示例是 `{"url": ...}` 对象写法），建议不小于 256 × 256 px。例：`{"text": "cyberpunk style", "style_image": {"url": "https://..."}}` |
| `image` | 单张参考图，接受 `file_token` 或 URL |
| `images` | 多角度参考图。view-key 写法：对象数组，每个对象恰好一个键 `front` / `left` / `back` / `right`，值为 URL、`file_token` 或 `{url}` / `{file_token}` / `{object:{bucket,key}}`，例：`{"images": [{"front": "https://..."}, {"left": "file_..."}]}`。按位置写法：4 项 `[front, left, back, right]`，缺失视图传 `null` 或 `""`。`front` 必填，至少 2 个视图，两种写法不能在同一数组里混用 |

官方强烈建议：基于已有 `task_id` 重新贴图时，在本次请求里重新提供参考图。

请求示例：

```json
{
  "input": "550e8400-e29b-41d4-a716-446655440000",
  "model": "v3.0-20250812",
  "texture_prompt": {
    "text": "worn leather with scratches"
  },
  "texture_quality": "detailed"
}
```

```json
{
  "input": "550e8400-e29b-41d4-a716-446655440000",
  "model": "v3.5-20260815",
  "texture_quality": "fast",
  "delight": true,
  "pbr": true
}
```

任务结果示例：

```json
{
  "code": 0,
  "data": {
    "task_id": "123e4567-e89b-42d3-a456-426614174000",
    "type": "texture_model",
    "status": "success",
    "progress": 100,
    "output": {
      "model_url": "https://cdn.tripo3d.ai/output/model_pbr.glb",
      "rendered_image_url": "https://cdn.tripo3d.ai/output/preview.png"
    },
    "created_at": "2026-04-28T12:00:00Z",
    "completed_at": "2026-04-28T12:01:30Z"
  }
}
```

### 4.7 格式转换（导出）

`POST https://openapi.tripo3d.ai/v3/models/convert`，`Content-Type: application/json`。任务类型 `convert_model`。
把模型转换为其他格式，可同时做减面、贴图烘焙和导出设置。

| 参数 | 类型 | 必填 | 默认 | 取值与约束 |
| --- | --- | --- | --- | --- |
| `input` | string | 是 | 无 | 模型来源：`task_id` / `file_token` / 模型直链。文件格式 `GLB` / `GLTF` / `FBX` / `OBJ` / `STL`，最大 150 MB |
| `format` | string | 是 | 无 | 目标格式：`GLTF` / `FBX` / `USDZ` / `OBJ` / `STL` / `3MF`（〔迁移〕：大小写不敏感） |
| `quad` | boolean | 否 | `false` | 输出四边面；未设 `face_limit` 时默认 10,000 面；会强制输出 `FBX` |
| `force_symmetry` | boolean | 否 | `false` | 强制对称，只在 `quad=true` 时有效 |
| `face_limit` | integer | 否 | 保持原面数 | 输出面数上限 |
| `flatten_bottom` | boolean | 否 | `false` | 压平模型底部 |
| `flatten_bottom_threshold` | float | 否 | `0.01` | 压平深度阈值 |
| `texture_size` | integer | 否 | `4096` | 漫反射贴图尺寸（像素） |
| `texture_format` | string | 否 | `JPEG` | `JPEG` / `PNG` / `WEBP` / `BMP` / `DPX` / `HDR` / `OPEN_EXR` / `TARGA` / `TIFF` |
| `bake` | boolean | 否 | `true` | 把高级材质烘焙进基础贴图 |
| `pack_uv` | boolean | 否 | `false` | 把所有 UV 打包进统一布局 |
| `export_vertex_colors` | boolean | 否 | `false` | 导出顶点色，只对 `OBJ` 和 `GLTF` 有效 |
| `pivot_to_center_bottom` | boolean | 否 | `false` | 把轴心移到底部中心 |
| `scale_factor` | float | 否 | `1` | 导出缩放系数 |
| `with_animation` | boolean | 否 | `true` | 是否包含骨骼与动画数据 |
| `animate_in_place` | boolean | 否 | `false` | 原地动画（去掉根位移） |
| `part_names` | string[] | 否 | 无 | 要导出的部件名，来自网格分割 |
| `export_orientation` | string | 否 | `+x` | `+x` / `-x` / `+y` / `-y` |
| `fbx_preset` | string | 否 | `blender` | `blender` / `3dsmax` / `mixamo` / `bake_scale`（导出 FBX 时把缩放烘焙进几何） |
| `texture_packaging` | string | 否 | `embedded` | 只用于 `format=FBX`，其他格式传它返回 `400`。`embedded`：贴图内嵌在单个 `.fbx`；`zip`：`model_url` 指向一个 `.zip`，内含 `.fbx` 和 `<name>.fbm/` 贴图文件夹 |

计费提示：下列任一参数取非默认值即按「高级转换」计费（见第 9 节）：
`quad`、`face_limit`、`flatten_bottom`、`flatten_bottom_threshold`、`texture_size`、`texture_format`、
`pivot_to_center_bottom`、`scale_factor`。

请求示例：

```json
{
  "input": "550e8400-e29b-41d4-a716-446655440000",
  "format": "FBX",
  "texture_size": 2048,
  "texture_format": "PNG",
  "pivot_to_center_bottom": true,
  "fbx_preset": "blender"
}
```

```json
{
  "input": "550e8400-e29b-41d4-a716-446655440000",
  "format": "FBX",
  "texture_packaging": "zip"
}
```

任务结果示例（注意 `model_url` 不一定带扩展名）：

```json
{
  "code": 0,
  "data": {
    "task_id": "123e4567-e89b-42d3-a456-426614174000",
    "type": "convert_model",
    "status": "success",
    "progress": 100,
    "output": {
      "model_url": "https://cdn.tripo3d.ai/output/converted-model",
      "rendered_image_url": "https://cdn.tripo3d.ai/output/preview.png"
    },
    "created_at": "2026-04-28T12:00:00Z",
    "completed_at": "2026-04-28T12:01:30Z"
  }
}
```

### 4.8 重拓扑（减面）

`POST https://openapi.tripo3d.ai/v3/mesh/decimate`，`Content-Type: application/json`。任务类型 `highpoly_to_lowpoly`。

| 参数 | 类型 | 必填 | 默认 | 取值与约束 |
| --- | --- | --- | --- | --- |
| `input` | string | 是 | 无 | 模型来源：`task_id` / `file_token` / 模型直链。`GLB` / `GLTF` / `FBX` / `OBJ` / `STL`，最大 150 MB |
| `model` | string | 否 | `v2.0` | 算法版本：`v3.0` / `v2.0` / `v1.0`。只接受这三个短名（〔PySDK〕：v3 拒绝 `P-v2.0-20251225` 这类全名） |
| `face_limit` | integer | 视版本 | 自适应 | `v3.0`、`v2.0`：可选，三角面 500～20,000，四边面 500～10,000，省略则自适应。`v1.0`：**必填**，三角面上限 2,000,000，四边面上限 150,000 |
| `quad` | boolean | 否 | `false` | 输出四边面，三个版本都支持。`v2.0` 输出 GLB，`quad=true` 时输出 FBX |
| `smart_uv` | boolean | 否 | `false` | 重拓扑时一并展 UV，只对 `model=v3.0` 有效；对 `v1.0` / `v2.0` 传它返回 `400` / `1004`。不改变价格，也不产出 UV 预览图 |
| `bake` | boolean | 否 | `true` | 把贴图烘焙到低模上。`v1.0` 不支持 |
| `part_names` | string[] | 否 | 无 | 要减面的部件名（来自分割）。`v1.0` 不支持 |

请求示例：

```json
{
  "input": "550e8400-e29b-41d4-a716-446655440000",
  "model": "v3.0",
  "smart_uv": true,
  "face_limit": 5000
}
```

```json
{
  "input": "550e8400-e29b-41d4-a716-446655440000",
  "model": "v1.0",
  "face_limit": 3000
}
```

任务结果示例：

```json
{
  "code": 0,
  "data": {
    "task_id": "123e4567-e89b-42d3-a456-426614174000",
    "type": "highpoly_to_lowpoly",
    "status": "success",
    "progress": 100,
    "output": {
      "model_url": "https://cdn.tripo3d.ai/output/model_pbr.glb",
      "rendered_image_url": "https://cdn.tripo3d.ai/output/preview.png"
    },
    "created_at": "2026-04-28T12:00:00Z",
    "completed_at": "2026-04-28T12:01:30Z"
  }
}
```

### 4.9 智能 UV

`POST https://openapi.tripo3d.ai/v3/mesh/uv`，`Content-Type: application/json`。任务类型 `mesh_uv`。
重新展 UV，并把已有贴图、绑定、动画重映射到新布局。

| 参数 | 类型 | 必填 | 默认 | 取值与约束 |
| --- | --- | --- | --- | --- |
| `input` | string | 是 | 无 | 模型来源：`task_id` / `file_token` / 模型直链。输入模型不得超过 80,000 等效三角面（一个四边面算两个）；超出时创建会成功但任务失败并退还积分 |
| `model` | string | 否 | `default` | 只支持 `default` |
| `bake` | boolean | 否 | `true` | 把已有贴图烘焙到新 UV；`false` 只返回带 UV 的几何 |
| `export_orientation` | string | 否 | 无 | `+x` / `-x` / `+y` / `-y` |
| `compress` | string | 否 | 不压缩 | `geometry` |

请求示例：

```json
{
  "input": "file_<your-upload-token>",
  "model": "default",
  "bake": false
}
```

任务结果示例：

```json
{
  "code": 0,
  "data": {
    "task_id": "123e4567-e89b-42d3-a456-426614174000",
    "type": "mesh_uv",
    "status": "success",
    "progress": 100,
    "output": {
      "model_url": "https://cdn.tripo3d.ai/output/model.glb",
      "uv_render_url": "https://cdn.tripo3d.ai/output/uv_render.webp"
    },
    "credits_consumed": 20.00,
    "created_at": "2026-09-20T12:00:00Z",
    "completed_at": "2026-09-20T12:01:30Z"
  }
}
```

### 4.10 可绑骨检查

`POST https://openapi.tripo3d.ai/v3/animations/rig-check`，`Content-Type: application/json`。任务类型 `animate_prerigcheck`。
检查模型能否绑骨，并返回推荐的骨骼类型。免费。

| 参数 | 类型 | 必填 | 默认 | 取值与约束 |
| --- | --- | --- | --- | --- |
| `input` | string | 是 | 无 | 模型来源：`task_id` / `file_token` / 模型直链。文件格式 `GLB` / `FBX` / `OBJ` / `STL`，最大 150 MB |

任务输出字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `output.riggable` | boolean | 模型是否可绑骨 |
| `output.rig_type` | string | 推荐骨骼类型：`biped`（双足人形）/ `quadruped`（四足）/ `hexapod`（六足）/ `octopod`（八足）/ `avian`（鸟类）/ `serpentine`（蛇形）/ `aquatic`（水生） |

请求示例：

```json
{
  "input": "550e8400-e29b-41d4-a716-446655440000"
}
```

任务结果示例：

```json
{
  "code": 0,
  "data": {
    "task_id": "123e4567-e89b-42d3-a456-426614174000",
    "type": "animate_prerigcheck",
    "status": "success",
    "output": {
      "riggable": true,
      "rig_type": "biped"
    },
    "credits_consumed": 0.00
  }
}
```

〔PySDK〕称 v3 把检测到的骨骼类型放在 `output.topology`，SDK 再映射成 `rig_type`；〔迁移〕则称 `topology` 键已移除、只有 `rig_type`。
适配器先读 `rig_type`，没有时回退读 `topology`。

### 4.11 自动绑骨

`POST https://openapi.tripo3d.ai/v3/animations/rig`，`Content-Type: application/json`。任务类型 `animate_rig`。
官方建议先跑 4.10 确认可绑骨并取得推荐类型。

| 参数 | 类型 | 必填 | 默认 | 取值与约束 |
| --- | --- | --- | --- | --- |
| `input` | string | 是 | 无 | 模型来源：`task_id` / `file_token` / 模型直链。`GLB` / `FBX` / `OBJ` / `STL`，最大 150 MB |
| `model` | string | 否 | `v1.0-20240301` | 绑骨模型版本，见下 |
| `rig_type` | string | 否 | `biped` | `biped` / `quadruped` / `hexapod` / `octopod` / `avian` / `serpentine` / `aquatic` / `others`（不属于前述任何拓扑的骨骼，随 v3.0 提供） |
| `spec` | string | 否 | `tripo` | 骨骼命名规范，只在 `rig_type=biped` 时生效：`tripo` / `mixamo` / `actorcore` / `unity` / `unreal` / `vrm`（VRM 1.0） |
| `out_format` | string | 否 | `glb` | `glb` / `fbx` |

`model` 取值：

| 取值 | 说明 |
| --- | --- |
| `v1.0-20240301` | 默认值。只支持双足人形，对应 90 多个 `preset:biped:*` 动画预设 |
| `v2.5-20260210` | 非人形生物（四足、六足、八足、蛇形、水生、鸟类）。`rig_type` 为 biped 或省略时，实际按 `v3.0-20260909` 绑骨 |
| `v3.0-20260909` | 官方推荐用于人形角色，更快、质量更高；其他类型保持 v2.5 的质量和速度。必须显式指定，默认值没有变 |

- `spec` 的版本要求官方说法不完全一致：主文档写 v3.0「支持 `others` 以及 `actorcore` / `unity` / `unreal` / `vrm`」；
  〔JSSDK〕写这四个 spec 需要 v3.0；〔PySDK〕写 `tripo`、`mixamo`、`actorcore` 在所有版本可用，
  `unity`、`unreal`、`vrm` 需要 `v2.5-20260210` 或 `v3.0-20260909`（配 `v1.0-20240301` 时任务失败）。
  稳妥做法：用 `actorcore` / `unity` / `unreal` / `vrm` 时一律显式传 `model=v3.0-20260909`。
- 已退役的 `v2.0-20250506` 在 v3 被拒绝〔迁移〕。

请求示例：

```json
{
  "input": "550e8400-e29b-41d4-a716-446655440000",
  "model": "v3.0-20260909",
  "rig_type": "biped",
  "spec": "mixamo",
  "out_format": "glb"
}
```

任务结果示例：

```json
{
  "code": 0,
  "data": {
    "task_id": "123e4567-e89b-42d3-a456-426614174000",
    "type": "animate_rig",
    "status": "success",
    "output": {
      "model_url": "https://cdn.tripo3d.ai/output/rigged.glb"
    },
    "credits_consumed": 25.00
  }
}
```

### 4.12 动画重定向

`POST https://openapi.tripo3d.ai/v3/animations/retarget`，`Content-Type: application/json`。任务类型 `animate_retarget`。
把预设动画应用到已绑骨的模型上。

| 参数 | 类型 | 必填 | 默认 | 取值与约束 |
| --- | --- | --- | --- | --- |
| `input` | string | 是 | 无 | **绑骨任务**（4.11）返回的 `task_id`（主文档原文「The returned task_id of the rigged model」；〔迁移〕：必须是一个成功的绑骨任务）。不要传原始生成任务的 `task_id` |
| `animation` | string | 二选一 | 无 | 单个预设动画标识。与 `animations` 互斥 |
| `animations` | string[] | 二选一 | 无 | 多个预设动画标识，最多 5 个，超过会报错。与 `animation` 互斥。按动画个数计费 |
| `out_format` | string | 否 | `glb` | `glb` / `fbx` |
| `export_with_geometry` | boolean | 否 | `true` | 导出时是否包含几何 |
| `animate_in_place` | boolean | 否 | `false` | 原地播放，不带位移 |
| `bake_animation` | boolean | 否 | 无 | 已废弃且被忽略，新接入不要发送 |

预设与绑骨版本的对应关系：

| 绑骨版本 | 可用预设 |
| --- | --- |
| `v3.0-20260909` 双足 | `preset:idle`、`preset:walk`、`preset:run`、`preset:dive`、`preset:climb`、`preset:jump`、`preset:slash`、`preset:shoot`、`preset:hurt`、`preset:fall`、`preset:turn` |
| `v2.5-20260210` / `v3.0-20260909` 四足及其他类型 | `preset:quadruped:walk`、`preset:hexapod:walk`、`preset:octopod:walk`、`preset:serpentine:march`、`preset:aquatic:march` |
| `v1.0-20240301` 双足 | `preset:biped:<name>`，`<name>` 见下方清单 |

- `preset:idle` 这类人形预设需要 v3.0 骨骼，在非双足骨骼上不可用；已有的 v2.5 双足绑定必须重新绑骨后才能使用。
- `preset:biped:*` 只适用于默认的 v1.0 绑定。
- 〔PySDK〕给出的实测兼容表（2026-10-15，其他组合会失败）：

| 绑骨版本 | 可绑的骨骼类型 | 人形预设 | 蛇形 / 水生预设 | 四足 / 六足 / 八足预设 |
| --- | --- | --- | --- | --- |
| `v3.0-20260909` | 全部 | 可用 | 可用 | 不可用 |
| `v2.5-20260210` | 全部 | 不可用 | 可用 | 可用 |
| `v1.0-20240301` | 仅双足 | 可用 | 不适用 | 不适用 |

这张表与主文档有一处对不上：主文档把 `preset:quadruped:walk`、`preset:hexapod:walk`、`preset:octopod:walk` 列在
「`v2.5-20260210` / `v3.0-20260909`」名下，〔PySDK〕的实测却是 v3.0 骨骼上四足 / 六足 / 八足预设不可用。
非人形角色要做动画时，稳妥做法是显式用 `v2.5-20260210` 绑骨（见第 11 节）。

`v1.0-20240301` 的 `preset:biped:<name>` 清单（官方文档页列出的 101 个）：

```
afraid, agree, angry_01, angry_02, angry_03, basketball_shot, bow, box_01, box_02, box_03,
cast_a_spell, cheer, chop, clap, climb, complain_01, complain_02, cross_body_crunch,
crossover_dribble, cry, dance_01, dance_02, dance_03, dance_04, dance_05, dance_06, defeat_02,
defeat_03, depressed, dig, dive, dribble, fall, fire, flee_01, flee_02, flip, fold_arms,
football_catch, football_save, football_pass, freaky, frightened, front_kick_01, front_kick_02,
frustrated_01, frustrated_02, golf, greet_01, greet_02, greet_03, greet_04, heart_pose,
hit_to_body_01, hit_to_body_02, hit_to_head, hit_to_side, hit_to_stomach, hug, hurt, idle,
jump_down, jump, jump_rope_01, jump_rope_02, laugh_01, laugh_02, lift_heavy, look_around,
make_a_call_01, make_a_call_02, pitch_baseball, play_mobile_game, play_video_game, press-up,
run_upstairs, run, scared_01, scared_02, scratch, shoot, shovel, sing_01, sing_02, sing_03,
sing_04, sit, slash, sob, standing_relax, surf, swagger, swim, turn, victory_celebration,
volleyball, wait, walk, warm_up, wave_goodbye_01, wave_goodbye_02
```

请求示例：

```json
{
  "input": "550e8400-e29b-41d4-a716-446655440000",
  "animation": "preset:walk",
  "out_format": "glb"
}
```

```json
{
  "input": "550e8400-e29b-41d4-a716-446655440000",
  "animations": [
    "preset:idle",
    "preset:walk",
    "preset:run"
  ],
  "out_format": "fbx"
}
```

任务结果示例：

```json
{
  "code": 0,
  "data": {
    "task_id": "123e4567-e89b-42d3-a456-426614174000",
    "type": "animate_retarget",
    "status": "success",
    "output": {
      "model_url": "https://cdn.tripo3d.ai/output/animated.glb"
    },
    "credits_consumed": 10.00
  }
}
```

主文档只给了单动画的输出示例。批量（`animations`）时的输出结构见第 11 节。

### 4.13 查询任务

`GET https://openapi.tripo3d.ai/v3/tasks/{task_id}`，只需 `Authorization` 头，没有请求体。

| 参数 | 位置 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `task_id` | 路径 | string | 是 | 创建任务时返回的标识，原样传入 |

响应 `data` 字段：

| 字段 | 类型 | 是否必有 | 说明 |
| --- | --- | --- | --- |
| `task_id` | string | 是 | 任务标识 |
| `type` | string | 是 | 任务类型，如 `text_to_model`、`animate_rig`、`convert_model` |
| `status` | string | 是 | 见第 5 节 |
| `progress` | integer | 是 | 0～100（部分官方示例里没有出现该字段，读取时给默认值 0） |
| `error_code` | integer | 否 | 任务失败原因代码。与顶层请求的 `code` 是两套编号，相同数字含义可能不同 |
| `error_message` | string | 否 | 任务失败的可读描述 |
| `output` | object | 否 | 只在 `status=success` 时填充，字段见第 7 节 |
| `credits_consumed` | number | 否 | 本任务实际消耗的积分，最多两位小数。以它为准计算成本 |
| `created_at` | string | 是 | ISO 8601 创建时间 |
| `completed_at` | string | 否 | ISO 8601 完成时间 |
| `input` | object | 否 | 请求参数回显（出现在智能分割示例与〔迁移〕中） |

请求示例：

```bash
TASK_ID="replace-with-created-task-id"
curl -s \
  -H "Authorization: Bearer YOUR_API_KEY" \
  https://openapi.tripo3d.ai/v3/tasks/$TASK_ID
```

响应示例：

```json
{
  "code": 0,
  "data": {
    "task_id": "123e4567-e89b-42d3-a456-426614174000",
    "type": "text_to_model",
    "status": "success",
    "progress": 100,
    "output": {
      "model_url": "https://cdn.tripo3d.ai/output/model_pbr.glb",
      "rendered_image_url": "https://cdn.tripo3d.ai/output/preview.png"
    },
    "created_at": "2026-04-28T12:00:00Z",
    "completed_at": "2026-04-28T12:01:30Z"
  }
}
```

任务不存在时返回 HTTP 404、`code: 2001`。

### 4.14 批量查询任务

`POST https://openapi.tripo3d.ai/v3/tasks/list`，`Content-Type: application/json`。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `task_ids` | string[] | 是 | 要查询的任务 ID，每次最多 100 个。ID 格式非法会导致整个请求失败 |

响应 `data` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `tasks` | object | 以 `task_id` 为键的任务详情，每个值的结构与状态同 4.13 |
| `missed` | string[] 或 null | 当前身份下找不到的任务 ID；全部找到时可能为 `null` 或缺失 |

这个接口只能按已知 ID 查询，**不是**「列出我的全部任务」。

请求示例：

```json
{
  "task_ids": [
    "123e4567-e89b-42d3-a456-426614174000",
    "987e6543-e21b-42d3-a456-426614174000"
  ]
}
```

响应示例：

```json
{
  "code": 0,
  "data": {
    "tasks": {
      "123e4567-e89b-42d3-a456-426614174000": {
        "task_id": "123e4567-e89b-42d3-a456-426614174000",
        "type": "text_to_model",
        "status": "success",
        "progress": 100,
        "credits_consumed": 100.00
      },
      "987e6543-e21b-42d3-a456-426614174000": {
        "task_id": "987e6543-e21b-42d3-a456-426614174000",
        "type": "image_to_model",
        "status": "running",
        "progress": 60
      }
    },
    "missed": null
  }
}
```

### 4.15 上传文件

`POST https://openapi.tripo3d.ai/v3/files`，`Content-Type: multipart/form-data`，带 `Authorization` 头。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `file` | binary | 是 | 表单字段名固定为 `file`。图片：`JPEG`、`PNG`，最大 20 MB。模型：`GLB`、`GLTF`、`FBX`、`OBJ`、`STL`，最大 150 MB |

- 文件大于 60 MB 时官方建议改用 4.16。
- 响应 `data.file_token`（如 `file_abc123`）用于其他接口的 `input`。
- 本页列出的图片格式只有 JPEG、PNG；单图生成 3D 的输入又写支持 WebP，预签名接口的 `format` 也包含 `webp`。
  〔迁移〕写 `POST /v3/files` 接受的图片格式是 webp / png / jpeg / bmp / tiff（含 jpg），模型文件是 glb / obj / fbx / stl / 3mf / usdz，
  与本页的列表不一致。WebP 能否走本接口上传见第 11 节。
- 〔迁移〕称上传限流约为每分钟 10 次，批量上传需要限速并处理 429。
- multipart 的分段细节：主文档只给了 `curl -F "file=@product-photo.png"`（curl 会自动带上文件名和按扩展名推断的分段 `Content-Type`），
  没有写文件名、分段 `Content-Type` 是否必需。〔PySDK〕发送 `file` 分段时带 `filename`（本地文件的文件名）和按扩展名推断的 `Content-Type`
  （推断不出时用 `application/octet-stream`）；〔JSSDK〕`uploadFile(blob, {filename, contentType})` 未指定文件名时用 `upload.bin`，
  README 示例传的是 `filename: 'hero.png'`、`contentType: 'image/png'`。不用 SDK 时照此发送：`file` 分段带有真实扩展名的文件名和对应的 MIME 类型（见第 11 节第 35 条）。
- 接口只定义了 `file` 这一个字段，响应里只有一个 `file_token`：一次请求上传一个文件，多视图的每张图分别上传一次。
- 上传返回的是 `file_token`，不是 `task_id`；计费页没有列出上传的费用。官方 SDK 对上传都不做自动重放：
  〔PySDK〕的 multipart 上传只发送一次；〔JSSDK〕的上传是 `POST`，只在连接没有建立或服务端回 429 / 503 时重试。
  上传失败不涉及任务，重新上传并改用新返回的 `file_token` 即可（重复上传有没有额外限制见第 11 节第 37 条）。

请求示例：

```bash
curl -s \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "file=@product-photo.png" \
  https://openapi.tripo3d.ai/v3/files
```

响应示例：

```json
{
  "code": 0,
  "data": {
    "file_token": "file_abc123"
  }
}
```

本地图片生成 3D 的调用顺序（不用 SDK；由上面的上传示例与单图生成 3D 页的 `file_token` 示例拼成）：

```bash
# 第 1 步：上传本地图片，读取 data.file_token
curl -s \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "file=@product-photo.png" \
  https://openapi.tripo3d.ai/v3/files
# 第 2 步：把 file_token 原样作为 input 创建任务，读取 data.task_id
curl -s -X POST \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":"<file_token from step 1>","model":"v3.1-20260211"}' \
  https://openapi.tripo3d.ai/v3/generation/image-to-model
# 第 3 步：轮询 GET /v3/tasks/{task_id} 到终态（3.2），成功后立即下载 output.model_url（3.5）
```

### 4.16 大文件上传（预签名）

`POST https://openapi.tripo3d.ai/v3/files/presign`，`Content-Type: application/json`。
取得预签名地址后直接 `PUT` 到存储，适合超过 60 MB 的文件。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `format` | string | 是 | 文件扩展名，不带点。图片：`jpeg`、`jpg`、`png`、`webp`、`bmp`、`tiff`；模型：`glb`、`gltf`、`fbx`、`obj`、`stl`、`3mf`、`usdz` |

响应 `data` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `presigned_url` | string | 临时的预签名 PUT 地址。拿到后立即上传；过期就重新申请新的地址和 `file_token` |
| `file_token` | string | 上传完成后用于 `input`。必须与同一次响应里的 `presigned_url` 配对使用 |
| `expires_in` | integer | 服务返回的过期秒数。官方注明它目前与 URL 签名的实际有效期不一致，不要把它当作 URL 或 `file_token` 的保证寿命 |

- 上传地址的键名有两种说法：主文档与〔JSSDK〕是 `presigned_url`；〔迁移〕写的响应是 `{upload_url, file_token, expires_in}`；
  〔PySDK〕先读 `presigned_url`，没有时回退读 `upload_url`。适配器按〔PySDK〕的顺序读取（见第 11 节）。
- 〔迁移〕建议把预签名地址当作约 30 分钟有效；主文档只说「立即上传」。

三步流程：

```bash
# 第 1 步：申请预签名地址
curl -s -X POST \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"format":"glb"}' \
  https://openapi.tripo3d.ai/v3/files/presign
# 第 2 步：直接 PUT 到存储（不带 Authorization）
curl -X PUT \
  -H "Content-Type: application/octet-stream" \
  -T model.glb \
  "<presigned_url from step 1>"
# 第 3 步：用 file_token 创建任务
curl -s -X POST \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"default","input":"<file_token from step 1>"}' \
  https://openapi.tripo3d.ai/v3/models/import
```

第 2 步官方 Python 示例断言 `PUT` 返回 HTTP 200。
`PUT` 的请求头：主文档三种语言的示例和〔JSSDK〕都用 `Content-Type: application/octet-stream`，并且不带 `Authorization`
（〔JSSDK〕源码注释：存储端靠签名 URL 自身鉴权，带第二份凭证的请求会被拒绝）；〔PySDK〕用的是按扩展名推断的 MIME 类型，并显式带 `Content-Length`。
〔JSSDK〕README 写明存储端需要预先知道文件的确切大小，所以它只接受 Blob / 缓冲区、不接受流；据此 `PUT` 应带 `Content-Length`，不要用分块传输（后半句是本文推断）。
`Content-Type` 是否必须与签名一致见第 11 节第 38 条。

响应示例：

```json
{
  "code": 0,
  "data": {
    "presigned_url": "https://storage.example.com/bucket/path/input.glb?X-Amz-Signature=...",
    "file_token": "file_abc123",
    "expires_in": 1800
  }
}
```

另有 `POST /v3/files/upload-credentials`（STS 直传凭证），只在更新日志和〔迁移〕中被提到，没有文档页，不要使用，见第 11 节。

### 4.17 账户：余额与用量

**余额** `GET https://openapi.tripo3d.ai/v3/account/balance`，只需 `Authorization` 头。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `balance` | number | 可用积分余额，最多两位小数 |
| `frozen` | number | 冻结积分，为进行中的任务预留 |

```bash
curl -X GET https://openapi.tripo3d.ai/v3/account/balance \
  -H "Authorization: Bearer {api_key}"
```

```json
{
  "code": 0,
  "data": {
    "balance": 10000.00,
    "frozen": 200.00
  }
}
```

这个接口只读、不创建任务，〔迁移〕把它作为验证 Key 与区域的第一步（期望 `code: 0`；区域不对时返回 HTTP 401）。

**用量明细** `GET https://openapi.tripo3d.ai/v3/account/usage`，返回数组：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `task_id` | string | 任务标识 |
| `type` | string | 任务类型 |
| `credits_consumed` | number | 消耗积分 |
| `created_at` | string | ISO 8601 创建时间 |

```json
{
  "code": 0,
  "data": [
    {
      "task_id": "123e4567-e89b-42d3-a456-426614174000",
      "type": "text_to_model",
      "credits_consumed": 100.00,
      "created_at": "2026-01-01T00:00:00Z"
    }
  ]
}
```

主文档没有写查询参数。〔迁移〕〔PySDK〕〔JSSDK〕显示它支持 `?limit=&offset=`：〔PySDK〕默认发送 `limit=50`、`offset=0`；
〔JSSDK〕不传参数时称服务端返回最近的 50 条（按时间倒序），并把 `limit` 限制在 1～200；〔迁移〕写 `limit ≤200`，并称每行还带 `status`。

**用量历史（对账用）** `GET https://openapi.tripo3d.ai/v3/account/usage/history`（2026-11 新增）。
列出当前 API Key 在时间窗内创建的**成功**任务，按时间倒序，不返回提示词、输入、输出或下载链接。

| 查询参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `start_time` | string | 是 | 无 | 窗口起点（含）。带时区偏移的 RFC 3339，如 `2026-10-01T00:00:00Z` |
| `end_time` | string | 是 | 无 | 窗口终点（不含）。必须晚于 `start_time`，且最多晚 31 天 |
| `page_size` | integer | 否 | `100` | 每页条数，1～100 |
| `cursor` | string | 否 | 无 | 上一页的 `next_cursor`；翻页期间保持时间窗不变 |

响应 `data`：`items[]`（`task_id`、`type`、`model_version`（可缺）、`status`（恒为 `success`）、`created_at`、
`completed_at`（可缺）、`credits_consumed`（与任务查询里的值相同；没有扣费时为 `0`））、`has_more`（boolean）、`next_cursor`（最后一页为 `null`）。
时间字段是 UTC 的 ISO 8601。

- 作用域是发起请求的那把 Key；多把 Key 需要分别查询。
- 只列成功任务，失败、过期、被拒绝的任务（官方注：通常已退款）不在其中，所以这份结果不能与账单记录逐行对应。
- 按创建时间过滤；查询时仍在运行的任务还不算成功，所以要查「至少 30 分钟前结束」的时间窗。
- 限流：每把 Key 每分钟 60 次，超限返回 `429` 加 `Retry-After`。
- 参数非法返回 `400`（`code=1004`）；服务端临时故障返回 `503`（`code=1008`）加 `Retry-After`，原样重试即可。

```json
{
  "code": 0,
  "status": "success",
  "data": {
    "items": [
      {
        "task_id": "123e4567-e89b-42d3-a456-426614174000",
        "type": "text_to_model",
        "model_version": "v3.0-20250812",
        "status": "success",
        "created_at": "2026-10-31T15:59:58.123456Z",
        "completed_at": "2026-10-31T16:01:12.654321Z",
        "credits_consumed": 30.00
      }
    ],
    "has_more": true,
    "next_cursor": "djE6MTc2MTkyNjM5ODEyMzQ1NjoxMjNlNDU2Ny1lODliLTQyZDMtYTQ1Ni00MjY2MTQxNzQwMDA"
  }
}
```

### 4.18 其他端点与不可用的能力

下列端点与 3D 生成相关但不是主链路，这里只给出要点；完整参数以各自的官方文档页为准（地址见第 12 节）。
它们都是 `POST`、JSON 请求体，创建响应同 4.1。

| 端点 | 任务类型 | 要点 |
| --- | --- | --- |
| `/v3/models/import` | `import_model` | 导入外部模型供后处理。`input`：`file_token` 或模型直链；`GLB` / `GLTF` / `FBX` / `OBJ` / `STL`，最大 150 MB。输出 `model_url`、`rendered_image_url`、`normalize_scale`、`normalize_translation`。后处理接口直接传 `file_token` 或 URL 时平台会自动先导入，无需单独调用 |
| `/v3/generation/image-to-splat` | `image_to_splat` | 单图生成高斯泼溅。参数 `input`（`file_token` 或图片直链，`PNG` / `JPEG` / `WebP`，最大 20 MB）、`model_seed`。输出 `model_url` 指向 `.splat`。固定 30 积分，约 4 分钟 |
| `/v3/generation/image-to-multiview` | `image_to_multiview` | 单图生成四视图。参数只有 `input`（`file_token` 或图片直链）。输出 `output.generate_multiview_image` 内的 `front_view_url`、`left_view_url`、`back_view_url`、`right_view_url`。其 `task_id` 可直接喂给 4.5 |
| `/v3/generation/edit-multiview` | `edit_multiview` | 编辑四视图。`input`：成功的 image-to-multiview 任务 `task_id`；`prompts`：1～4 项 `{prompt, view}`，`prompt` 非空且最长 1024 字符，`view` 为 `front` / `left` / `back` / `right` 且互不重复 |
| `/v3/generation/text-to-image` | `text_to_image` | 文生图。`prompt` 必填；`model` 默认 `seedream_v4`。输出 `output.generated_image_url`。其 `task_id` 可作为 4.4 的 `input` |
| `/v3/generation/image-to-image` | `image_to_image` | 图生图。`input` 必填（URL / `file_token` / `task_id`），`inputs` 可选（seedream 最多 4 张、banana 最多 10 张、chat_image 最多 16 张）；`model` 默认 `seedream_v5`；未指定 `template` 时 `prompt` 必填。输出 `output.generated_image_url` |
| `/v3/mesh/segment` | `mesh_segmentation` | 网格语义分割。`input` 模型来源；`model` 默认 `v1.0-20250506`，另有 `v2.0-20260430`（Beta）；v2 专用参数 `segmentation_granularity`（`simple` / `balanced` / `detailed`）、`split_by_connectivity`、`ref_image` |
| `/v3/mesh/complete` | `mesh_completion` | 部件补全。`input` 必须是 mesh/segment 任务的 `task_id`；`part_names` 可选；`completion_mode`：`ai_completion`（默认）/ `quick_cap` |
| `/v3/mesh/smartsegment` | `smartsegment_image`（图片管线示例；模型管线的类型名文档未给出） | 端到端智能分割。`seg_type`：`image` / `model`（仅 GLB，且必须传 16 个浮点数的列主序 4×4 `transform`）；`granularity`：`coarse` / `medium` / `fine`；`hint` 可选。输出 `prompt`、`mask_url`、`seg_model_url`、`seg_task_id`、`model_task_id` |

v3 中**不可用**或**没有文档**的能力：

| 能力 | 状态 |
| --- | --- |
| `refine_model`（草模精修） | 按已退役处理，但官方来源互相矛盾。SDK 文档页写「Refine and stylize are retired」；〔PySDK〕的 `refine_model` 直接抛错、不发请求。另一边，更新日志与迁移页的映射表仍列有 `POST /v3/models/refine`，〔迁移〕还给出了它的参数（`draft_model_task_id`，只接受 `text_to_model` 草模）和「约 50 次 refine / 分钟」的限流值，并发类目表（10.5）也仍写着 refine。没有文档页，不要调用（见第 11 节） |
| `stylize_model`（风格化，lego / voxel 等） | 同上：SDK 文档页与〔PySDK〕称已退役；更新日志、迁移页的映射表与〔迁移〕仍列有 `POST /v3/models/stylize`（〔迁移〕称 7 种风格不变）。没有文档页，不要调用 |
| 取消任务 | 文档中没有取消端点。状态 `cancelled` 存在（描述为「被用户取消」），但没有写明通过什么接口触发。〔迁移〕称取消接口在 v2 也从未存在 |
| 删除任务 / 删除结果文件 | 文档与 SDK 路由表里都没有删除端点 |
| 列出全部任务 | 没有（〔迁移〕称任务列表接口在 v2 也从未存在）。只能用 `POST /v3/tasks/list` 按已知 ID 查，或用用量接口按时间翻页 |
| WebSocket watch / SSE | v3 没有，用轮询或 Webhook〔迁移〕 |
| `/v3/generation/image-to-depth` | 只出现在 SDK 路由表里（仅 Python SDK 封装），没有文档页 |

## 5. 状态与进度

状态机：

```
queued -> running -> success
                  -> failed
                  -> cancelled
```

| `status` | 含义 | `progress` | 是否终态 |
| --- | --- | --- | --- |
| `queued` | 任务已创建，在队列中等待 | 0 | 否 |
| `running` | 正在处理 | 0～100 | 否 |
| `success` | 已完成，`output` 可用 | 100 | 是 |
| `failed` | 失败；查看 `error_code`、`error_message` | 无 | 是 |
| `cancelled` | 已取消 | 无 | 是 |
| `banned` | 内部状态（〔迁移〕：内容审核拒绝）。v3 通常把它报告为 `failed`；旧响应里若出现，按终态处理 | 无 | 是 |
| `expired` | 内部状态（〔迁移〕：排队超时）。v3 通常把它报告为 `failed`；旧响应里若出现，按终态处理 | 无 | 是 |
| `unknown` 及其他未列出的值 | 可能出现。官方要求：**不要当作成功，也不要当作失败**；带上限继续轮询，超时后带 `task_id` 联系支持 | 无 | 否 |

- `progress` 是 0～100 的整数，只用于展示进度；判断完成只看 `status`。
- 失败原因在 `error_code`（integer）与 `error_message`（string）里，二者都是可选字段。
  〔迁移〕给出的对应关系：审核拒绝为 `failed` 加 `error_code: 2008`；排队超时为 `failed` 加 `error_code: 2018`。
  官方 Webhook 示例里的失败任务是 `error_code: 2018`、`error_message: "Task processing timeout"`。
- 任务的 `error_code` 与请求级的 `code` 是两套编号：请求级 `2018` 的含义是「模型过于复杂无法重拓扑」，
  与任务级 `2018` 不同。不要用同一张表解释两者。
- 对未知状态，〔迁移〕的建议是「当作 `failed`」，与主文档「不要当作成功或失败」不一致；本文按主文档处理。
- 官方 SDK 的终态集合是 `success`、`failed`、`cancelled`、`banned`、`expired`〔PySDK〕〔JSSDK〕。
- 失败描述的键名：主文档是 `error_message`。〔PySDK〕解析时先读 `error_msg`、没有再读 `error_message`；
  〔JSSDK〕先读 `error_message`、没有再读 `error_msg`。适配器两个键都读（见第 11 节第 43 条）。

## 6. 输入限制

图片输入（用于 3D 生成）：

| 项目 | 限制 |
| --- | --- |
| 格式 | `PNG`、`JPEG`、`WebP` |
| 单文件大小 | 单图生成 3D、高斯泼溅：最大 20 MB。多视图页没有单独写大小上限 |
| 分辨率 | 只给了建议下限：不小于 256 × 256 px。没有写上限 |
| 内容要求 | 主体清晰、背景干净、少遮挡；多视图须为同一物体、光照一致 |
| 张数 | 单图：1 张。多视图：2～4 张，`front` 必填。贴图参考 `images`：2～4 个视图，`front` 必填 |
| 传入方式 | 公开直链 URL、`file_token`、之前任务的 `task_id`（视端点而定）。**不接受 Base64 / data URI**〔迁移〕 |

模型文件输入（用于后处理）：

| 项目 | 限制 |
| --- | --- |
| 格式 | 贴图、转换、重拓扑、分割、导入：`GLB` / `GLTF` / `FBX` / `OBJ` / `STL`。绑骨检查、绑骨：`GLB` / `FBX` / `OBJ` / `STL`（不含 GLTF）。智能分割 `seg_type=model`：仅 GLB |
| 单文件大小 | 最大 150 MB |
| 面数 | 智能 UV：不超过 80,000 等效三角面 |
| 传入方式 | `task_id`、`file_token`、公开直链 URL |

文本输入：

| 字段 | 限制 |
| --- | --- |
| `prompt`（文本生成 3D） | 最长 1024 字符 |
| `negative_prompt` | 最长 255 字符 |
| 多视图编辑的单条 `prompt` | 非空，最长 1024 字符 |
| 图像生成的 `prompt` | 主文档给的是建议值（不超过 300 个汉字或 600 个英文单词）；〔迁移〕称硬上限 1800 字符 |

其他：

- 上传：`POST /v3/files` 图片最大 20 MB、模型最大 150 MB；超过 60 MB 建议用预签名上传。
- 请求体上限 20 MB〔迁移〕。
- URL 输入必须能被 Tripo 服务端公开访问；私有文件先上传。URL 两端不要带空白字符（〔迁移〕：服务端不保证裁剪）。
- 批量查询一次最多 100 个任务 ID；动画重定向一次最多 5 个动画。

## 7. 输出

### 7.1 模型文件

| 场景 | 输出格式 |
| --- | --- |
| 3D 生成（文本 / 单图 / 多视图）默认 | GLB（快速开始页：从 `output.model_url` 下载 GLB 文件） |
| H 系列生成且 `quad=true` | 强制 FBX |
| 重拓扑 `v2.0` | GLB；`quad=true` 时 FBX |
| 格式转换 | `GLTF` / `FBX` / `USDZ` / `OBJ` / `STL` / `3MF`；FBX 可选 `texture_packaging=zip` 得到 `.zip` |
| 绑骨、动画重定向 | `out_format`：`glb`（默认）或 `fbx` |
| 高斯泼溅 | `.splat` |

- v3 每个任务只返回**一个**模型地址 `output.model_url`。v2 的 `pbr_model`、`model`、`base_model` 三个键已合并为它
  （优先级 pbr_model > model > base_model）〔迁移〕〔PySDK〕。不要再读取旧键名。
- 不要假定扩展名是 `.glb`：`quad` 会改变格式，转换任务的示例 URL 甚至不带扩展名。
  适配器应从 `model_url` 的路径或下载响应的 `Content-Type` 判断格式，再结合自己提交的参数兜底。
- 需要其他格式时，用生成任务的 `task_id` 再调一次 4.7 格式转换。
- 逐格式的取法。三个生成端点的参数里没有指定输出文件格式的字段，任务结果里也没有「一次返回多种格式」的字段：

| 想要的格式 | 取法 | 是否需要第二次调用 |
| --- | --- | --- |
| GLB | 生成任务自身的 `output.model_url` | 否。H 系列 `quad=true` 时这个地址给的是 FBX，不是 GLB |
| FBX | H 系列 `quad=true` 的生成任务直接给 FBX；其余情况调 4.7，`format=FBX` | 视情况 |
| GLTF / USDZ / OBJ / STL / 3MF | 调 4.7 格式转换，`format` 取对应值 | 是。每种格式一个转换任务，各自轮询，各自计费（5 或 10 积分，见 9.4），文件在该转换任务的 `output.model_url` |

- 4.7 的 `format` 一次只能填一个值，目标格式里没有 `GLB`（GLB 只出现在它的输入格式列表里）。
  生成结果被 `quad` 强制成 FBX 之后怎样得到 GLB，官方文档未说明（见第 11 节第 40 条）。
- 转换任务引用的是生成任务的 `task_id`，由服务端取原任务的模型输出，不经过签名的 `model_url`
  （原任务结果在服务端保留多久见第 11 节第 6 条）。
  除 FBX 之外各格式的结果是单文件还是压缩包，官方文档未说明（见第 11 节第 41 条）。

### 7.2 贴图与 PBR

- `texture=true` 时模型带贴图；`pbr=true` 时带 PBR 材质贴图：`base_color`、`metallic`、`roughness`、`normal`。
  文档没有提供单独下载各张贴图的 URL，贴图随模型文件交付（FBX 的 `zip` 打包除外）。
- 贴图质量档位：`fast` / `standard` / `detailed` / `extreme`；`extreme` 为 8K。`fast` 与 `standard` 输出贴图尺寸相同。
- 格式转换可指定 `texture_size`（默认 4096）与 `texture_format`（默认 `JPEG`）。
- `texture=false` 得到无贴图的纯几何（白模）。

### 7.3 预览图与其他输出字段

| `output` 字段 | 出现在 | 说明 |
| --- | --- | --- |
| `model_url` | 生成、贴图、转换、重拓扑、UV、绑骨、重定向、导入、分割、补全、泼溅 | 模型下载地址（签名、临时） |
| `rendered_image_url` | 生成、贴图、转换、重拓扑、导入、分割、补全 | 渲染预览图，可作缩略图。示例里有 `.png` 和 `.webp` |
| `uv_render_url` | 智能 UV | UV 图集预览 |
| `riggable`、`rig_type` | 绑骨检查 | 见 4.10 |
| `generated_image_url` | 文生图、图生图 | 生成的图片 |
| `generate_multiview_image.{front,left,back,right}_view_url` | 单图生成多视图 | 四视图图片 |
| `normalize_scale`（number）、`normalize_translation`（`[tx, ty, tz]`） | 导入模型，以及以 `file_token` 或 URL 作为模型输入的后处理任务 | 导入归一化时施加的等比缩放与平移：`归一化坐标 = 原坐标 × normalize_scale + normalize_translation`。以 `task_id` 为输入时不返回 |
| `prompt`、`mask_url`、`seg_model_url`、`seg_task_id`、`model_task_id` | 智能分割 | 见 4.18 |

- 绑骨与重定向的官方示例只有 `model_url`，没有 `rendered_image_url`，读取时要允许缺失。
- 〔迁移〕〔PySDK〕〔JSSDK〕里还出现过 `rendered_video_url`、`rendered_sequence_url`、`multiview_basecolor_url`、
  `depth_image_url`、`topology`、`model_urls` 等键，主文档没有说明，不要依赖。
- 更稳妥的做法：把 `output` 整体原样落库，再从中取已知键。

### 7.4 面数与拓扑选项

| 需求 | 做法 |
| --- | --- |
| 控制面数 | `face_limit`（范围见 4.2）；省略则自适应 |
| 高精度几何 | H 系列 `geometry_quality=detailed`（面数上限 2,000,000） |
| 四边面 | H 系列 `quad=true`（上限 150,000，输出 FBX）；P2 `quad=true`（48～25,000，原生四边面拓扑） |
| 干净的低模 | P 系列（P1：50～20,000 面；P2：三角面 48～50,000）；或 H 系列 `smart_low_poly=true`（500～20,000） |
| 分部件 | H 系列 `generate_parts=true`（必须无贴图）；或生成后做网格分割 |
| 已有模型减面 | 4.8 重拓扑；或 4.7 格式转换里的 `face_limit` / `quad` |
| 真实尺寸 | `auto_size=true`，单位米 |
| 压缩 | `compress=geometry`（meshopt）。注意加载端需要支持 meshopt 解码 |

## 8. 模型版本

3D 生成的 `model`（**必填，没有默认值**）：

| 取值 | 系列 | 说明 |
| --- | --- | --- |
| `v3.1-20260211` | H | H3.1，最新高精度模型，官方推荐。面数最高 2,000,000 |
| `v3.0-20250812` | H | H3.0，上一代稳定版 |
| `v2.5-20250123` | H | H2.5，旧版；不支持 `texture_quality`、`geometry_quality`、`auto_size`、`quad`、`smart_low_poly`、`generate_parts`、`compress` |
| `P2-20260801` | P | P2，原生四边面拓扑；三角面 48～50,000 或四边面 48～25,000。〔JSSDK〕标注为 Preview |
| `P1-20260311` | P | P1，低模；50～20,000 面 |

- 省略 `model` 会返回 HTTP 400 / `code 1004`〔迁移〕。官方 JS SDK 在未指定时自己填 `v3.1-20260211`，
  〔PySDK〕的 `text_to_model` / `image_to_model` / `multiview_to_model` 在未指定时填的是 `v2.5-20250123`，这些都是 SDK 行为，不是服务端默认。
- 〔PySDK〕称 `v1.4-20240625` 在文本、单图生成上「仍被接受」，`v2.0-20240919` 在 v3 不可用；
  〔迁移〕把 v1.x、v2.0、Turbo 列为已退役。新接入只用上表五个值。

其他任务的版本参数：

| 端点 | 参数 | 取值 | 默认 |
| --- | --- | --- | --- |
| 生成端点的贴图模型 | `texture_version` | `v3.5-20260815` / `v3.0-20250812` / `v2.5-20250123` | v2.5 几何用 `v2.5-20250123`，其余用 `v3.0-20250812` |
| `/v3/models/texture` | `model` | `v3.5-20260815` / `v3.0-20250812` / `v2.5-20250123` | `v3.0-20250812` |
| `/v3/mesh/decimate` | `model` | `v3.0` / `v2.0` / `v1.0` | `v2.0` |
| `/v3/mesh/uv` | `model` | `default` | `default` |
| `/v3/animations/rig` | `model` | `v1.0-20240301` / `v2.5-20260210` / `v3.0-20260909` | `v1.0-20240301` |
| `/v3/mesh/segment` | `model` | `v1.0-20250506` / `v2.0-20260430`（Beta） | `v1.0-20250506` |
| `/v3/mesh/complete` | `model` | `v1.0-20250506` | `v1.0-20250506` |
| `/v3/generation/text-to-image` | `model` | `seedream_v4`、`seedream_v5`、`banana`、`banana_pro`、`banana2`、`chat_image_1`、`chat_image_1.5`、`chat_image_2`、`chat_image_2.5_flare`、`chat_image_2.5_sunburst` | `seedream_v4` |
| `/v3/generation/image-to-image` | `model` | 同上但不含 `seedream_v4` | `seedream_v5` |

`chat_image_1` 标注「2026-10-23 退役」（已过期），`chat_image_1.5` 标注「2026-12-01 退役」，不要在新接入中使用。

## 9. 计费

### 9.1 规则

- 按积分（credit）计费。国际站 1 积分 = $0.01（100 积分 = $1.00）；中国站 1 积分 = ¥0.07。
- **先冻结、后扣除**：创建任务时从可用余额冻结所需积分；任务成功后冻结转为实际消耗；
  任务失败或被取消时冻结的积分退回可用余额。官方明确：失败和取消的任务不收费。
- 实际消耗以任务详情里的 `credits_consumed` 为准（可能带小数，例如 VIP 折扣）。〔迁移〕建议不要在代码里写死价格。
- 余额不足时创建请求返回 HTTP 403、`code 2010`。
- 购买的积分不会过期（官网 FAQ）。API 与 Tripo Studio 是两套独立的计费系统，Studio 订阅不能用于 API。
- API 积分为预付费，购买后不可退款，法律另有规定或 Tripo 另有明示的除外（服务条款 6.4）。
- 自 2026-12-01 起控制台改为以美元显示价格与余额（按 1 积分 = $0.01 等值换算）。
  API 的请求参数与响应字段不变，`balance`、`frozen`、`credits_consumed` 仍以积分返回。
- 文档页与定价页没有写新账号的免费额度或试用积分。官网前端脚本里有控制台账单页的文案
  「Includes {{credits}} trial credits, expiring {{date}}」「Trial credits expired」，说明存在会过期的试用积分；
  数量、发放条件、有效期都没有公开说明（见第 11 节）。FAQ 的「积分不过期」问的是购买的积分。

### 9.2 3D 生成（H 系列）

| 任务 | 无贴图 | 标准贴图 | 高清贴图（`detailed`） | 8K 贴图（`extreme`） |
| --- | --- | --- | --- | --- |
| 文本生成 3D | 10 | 20 | 30 | 40 |
| 单图生成 3D | 20 | 30 | 40 | 50 |
| 多视图生成 3D | 20 | 30 | 40 | 50 |

叠加项（在基础积分上累加）：

| 选项 | 加收 |
| --- | --- |
| 高清贴图（`texture_quality=detailed`） | +10（已含在上表） |
| 8K 贴图（`texture_quality=extreme`） | +20（已含在上表） |
| 高精度几何（`geometry_quality=detailed`） | +20 |
| 四边面（`quad=true`） | +5 |
| 智能低模（`smart_low_poly=true`） | +10 |
| 分部件生成（`generate_parts=true`） | +20 |

`texture_quality=fast` 与 `standard` 同价。上表无贴图 / 标准贴图两列来自定价页的 H 系列表，高清 / 8K 两列来自 H3.1 模型页。

### 9.3 3D 生成（P 系列）

| 任务 | P1 无贴图 | P1 标准贴图 | P2 无贴图 | P2 标准贴图 | P2 高清贴图 | P2 8K 贴图 |
| --- | --- | --- | --- | --- | --- | --- |
| 文本生成 3D | 30 | 40 | 100 | 110 | 120 | 130 |
| 单图生成 3D | 40 | 50 | 100 | 110 | 120 | 130 |
| 多视图生成 3D | 40 | 50 | 100 | 110 | 120 | 130 |

- P2 的四档数字在 P2 模型页和更新日志里都有。
- P1 的两档数字读自定价页「P 系列」页签的内嵌数据（该页签不在静态 HTML 里渲染），接入前请在定价页上再看一眼。
- P1 的高清 / 8K 贴图价格没有单独列出。定价页的说明是「P2 的贴图加价与 P1 相同」，据此推算 P1 为标准贴图价 +10 / +20，
  这是推算值，不是官方直接给出的数字（见第 11 节）。

### 9.4 模型后处理与动画

| 操作 | 积分 |
| --- | --- |
| 贴图（`fast`） | 10 |
| 贴图（`standard`） | 10 |
| 贴图（`detailed`） | 20 |
| 贴图（`extreme`，8K） | 30 |
| 格式转换（基础） | 5 |
| 格式转换（高级：`quad`、`face_limit`、`flatten_bottom`、`flatten_bottom_threshold`、`texture_size`、`texture_format`、`pivot_to_center_bottom`、`scale_factor` 任一取非默认值） | 10 |
| 重拓扑 `v3.0` 三角面 | 35 |
| 重拓扑 `v3.0` 四边面 | 40 |
| 重拓扑 `v2.0` | 30 |
| 重拓扑 `v1.0` | 10 |
| 智能 UV | 20 |
| 网格分割 | 40 |
| 部件补全（`ai_completion`） | 50 |
| 部件补全（`quick_cap`） | 30 |
| 智能分割（图片） | 85 |
| 智能分割（模型） | 55 |
| 可绑骨检查 | 免费 |
| 自动绑骨 | 25 |
| 动画重定向 | 每个动画 10（批量为 10 × 个数） |
| 高斯泼溅 | 30 |
| 导入模型 | 〔JSSDK〕README 标注免费；定价页没有列出 |

### 9.5 图像生成（辅助）

| 模型 | ≤1K | 2K | 4K |
| --- | --- | --- | --- |
| `seedream_v5` / `seedream_v4` | 5 | 5 | 5 |
| `banana` | 5 | 不支持 | 不支持 |
| `banana2` | 10 | 10 | 15 |
| `banana_pro` | 15 | 15 | 20 |
| `chat_image_1`（定价页标注 2026-10-23 退役） | 5 | 不支持 | 不支持 |
| `chat_image_1.5`（定价页标注 2026-12-01 退役） | 10 | 不支持 | 不支持 |
| `chat_image_2`、`chat_image_2.5_flare`、`chat_image_2.5_sunburst` | 10 | 10 | 15 |
| `chat_image_2` / `chat_image_2.5_*`，`quality=high` | 20 | 25 | 40 |
| `chat_image_2.5_*`，`quality=xhigh` | 25 | 30 | 45 |
| `chat_image_2.5_*`，`quality=max` | 30 | 50 | 50 |

省略 `quality` 或传 `low` / `medium` 按基础价计费；不支持 `auto`；`size` 为 `auto` 时按 2K 档计费。

单图生成多视图 10 积分；多视图编辑每张被编辑的图 5 积分。

## 10. 错误与限流

### 10.1 错误响应结构

```json
{
  "code": 2010,
  "status": "error",
  "message": "You don't have enough credit to create this task",
  "suggestion": "Please purchase more credit",
  "request_id": "req_abc123"
}
```

字段含义见 2.4。官方注明字段会因来源不同而变化，`request_id` 可能缺失。例如〔实测〕不带 Key 的请求返回 HTTP 401，
响应体里就没有 `request_id`（标识在响应头 `X-Request-ID` 里）：

```json
{"code":2,"status":"error","message":"Authentication required","suggestion":"Check if your credentials is valid"}
```

解析时要容忍响应体不是 JSON 的情况（网关或代理返回的 5xx）。

### 10.2 HTTP 状态码

| 状态码 | 含义 |
| --- | --- |
| 200 | 请求处理成功 |
| 400 | 参数缺失或格式错误 |
| 401 | API Key 缺失或无效 |
| 403 | 无权访问资源，或积分不足 |
| 404 | 任务或资源不存在 |
| 429 | 超过频率限制或并发限制 |
| 500 | 服务端内部错误 |
| 503 | 服务端临时故障（用量历史接口文档提到，带 `Retry-After`） |

### 10.3 请求级错误码

| `code` | HTTP | 含义 | 处理 |
| --- | --- | --- | --- |
| 2 | 401 | 未提供鉴权或鉴权无效 | 修正 Key 后再试 |
| 1000 | 500 | 服务端未知错误 | 带 `request_id` 联系支持；只在安全时重试 |
| 1001 | 500 | 服务端致命错误 | 同上 |
| 1002 | 401 | API 内鉴权失败 | 检查凭证与权限 |
| 1003 | 400 | 请求体格式错误 | 修正 JSON 语法与编码。〔迁移〕：HTTP 方法错误（405）或 Content-Type 错误（415）也返回 1003 |
| 1004 | 400 | 参数无效或缺失 | 修正指出的参数。〔迁移〕：无效或过期的 `file_token` 也返回 1004 |
| 1007 | 429 | 超过频率限制 | 降低频率，指数退避重试 |
| 1008 | 503 | 服务端临时故障（用量历史接口） | 按 `Retry-After` 原样重试 |
| 2000 | 429 | 超过并发限制 | 等同类目任务结束，或按 `Retry-After` 等待 |
| 2001 | 404 | 任务不存在 | 检查 `task_id` |
| 2002 | 400 | 不支持的任务类型 | 检查端点 |
| 2003 | 400 | 输入文件为空 | 确认上传的文件非空且格式有效 |
| 2004 | 400 | 不支持的文件类型 | 检查格式是否在支持列表内 |
| 2006 | 未注明 | 源任务没有可用的图片或 GLB 模型（智能分割页） | 先把其他格式转成 GLB |
| 2007 | 未注明 | 源任务尚未成功（智能分割页） | 等源任务成功 |
| 2008 | 400 | 内容违规 | 修改输入内容；不可重试 |
| 2010 | 403 | 积分不足 | 充值；不可重试 |
| 2015 | 400 | 模型或任务版本已废弃 | 换用受支持的版本 |
| 2018 | 400 | 模型过于复杂（无法重拓扑） | 降低输入模型的复杂度或面数 |
| 4001 | 404 | 端点不存在 | 检查 URL 与路径 |

- 鉴权失败按 **HTTP 401** 判断，不要只匹配某个 `code`（可能是 `2`，也可能是 `1002`）。
- 〔迁移〕还提到 `2013`（优先级权限）、`2015`～`2017`（版本类错误）、`2021` / `2022`（大小限制）、`2002`～`2009`（输入与审核类），
  主文档的错误码表里没有逐条说明。
- 官方注明示例里的 `message` 文案可能变化，不要匹配文案。

### 10.4 频率限制

- 按 **API Key** 计算；不同端点限额不同，生成类端点（`/v3/generation/*`）较低，查询类端点（`/v3/tasks/*`）较高。
- 超限返回 HTTP `429`、`code 1007`。
- 官方文档称每个响应都带以下响应头。〔实测〕未鉴权的 401 响应里没有这三个头，读取时要允许缺失：

| 响应头 | 说明 |
| --- | --- |
| `X-RateLimit-Limit` | 当前时间窗允许的最大请求数 |
| `X-RateLimit-Remaining` | 当前时间窗剩余请求数 |
| `X-RateLimit-Reset` | 时间窗重置时刻（Unix 秒） |

- 主文档没有给出具体的每分钟数值。已知的数值：用量历史接口每把 Key 每分钟 60 次；
  〔迁移〕给出的近似值是生成约 200 次 / 分钟、refine 约 50 次 / 分钟、上传约 10 次 / 分钟。限流时间窗的长度主文档也没有写。
- 轮询建议：间隔不低于 1～2 秒，批量查询代替逐个查询。

### 10.5 并发限制

- 按**账号**计算（不是按 Key），并且**按任务类目**分别计数，各类目互不影响。
- 某类目并发已满时，创建该类目的新任务返回 HTTP `429`、`code 2000`，响应带 `Retry-After` 头（秒）。

| 类目 | 包含的任务 | 默认并发 |
| --- | --- | --- |
| 3D 生成（H 系列） | 文本 / 单图 / 多视图生成 3D（H） | 10 |
| 3D 生成（P 系列） | 文本 / 单图 / 多视图生成 3D（P） | 5 |
| 图像生成 | 文生图、图生图、单图生成多视图、多视图编辑 | 1 |
| 动画 | 自动绑骨、绑骨检查、动画重定向 | 10 |
| 模型处理 | 贴图、格式转换、refine | 5 |
| 网格操作 | 分割、补全、重拓扑 | 10 |

同一类目共用一个并发池。提高并发上限需要联系官方支持，可按类目单独配置。

```json
{
  "code": 2000,
  "message": "You have exceeded the limit of generation",
  "suggestion": "Try again later. You can also check `Retry-After` header."
}
```

### 10.6 重试指引

| 情况 | 能否重试 | 说明 |
| --- | --- | --- |
| `429`（`1007` 或 `2000`） | 可以 | 请求没有被受理。优先按 `Retry-After`，其次按 `X-RateLimit-Reset`，否则指数退避（1 秒起、每次翻倍、封顶 32 秒，最多 5 次） |
| `503` 且带 `Retry-After` | 可以 | 按头部等待后原样重试 |
| `GET` 查询类请求遇到 `429` / `5xx` / 网络错误 | 可以 | 查询是幂等的；〔PySDK〕对 `GET` 在 429 / 502 / 503 / 504 和连接错误时最多尝试 3 次（即重试 2 次，不含 500）；〔JSSDK〕默认额外重试 2 次 |
| **创建任务**时遇到 `500` / `502` / `504`、超时、连接中断 | **不要自动重试** | 结果不确定。错误处理页把 429 和 500 都列为可退避重试的错误，但同时写明「服务端错误只在安全时重试；创建请求即使响应丢失也可能已经成功，在确认结果之前不要重新提交」。官方 SDK 对创建请求不自动重放〔PySDK〕〔JSSDK〕（〔JSSDK〕把 408 / 425 / 500 / 502 / 504 归为「结果未知」）。〔迁移〕的核对清单则笼统地写「对 1007 / 2000 / 5xx 退避重试，不要重试 1004 / 2008 / 2010」，没有区分创建与查询；本文按主文档与 SDK 的保守做法处理 |
| `400`（`1003`、`1004`、`2002`～`2004`、`2015`、`2018`） | 不可 | 修正请求后再提交 |
| `400` / `2008` 内容违规 | 不可 | 修改内容 |
| `401` | 不可 | 修正 Key 或区域 |
| `403` / `2010` 积分不足 | 不可 | 充值 |

关于「失败的提交是否已计费」：

- 文档里没有幂等键（idempotency key）机制。官方 JS SDK 的说明是：创建任务按提交次数计费，盲目重试会造成重复扣费。
- 计费跟随任务：创建时冻结，成功才扣除，失败或取消退回。所以「提交失败」本身不扣费，风险在于
  「没有拿到响应、但任务其实已经创建」的提交会在任务成功后扣费。
- 哪些失败可以确定任务没有创建：官方 JS SDK 只把「连接被拒绝、DNS 失败、服务端回 `429` / `503`」视为请求确定未被处理；
  连接中途断开、超时、`500` / `502` / `504` 都按「不确定」处理。主文档没有逐个状态码说明，
  `400` / `401` / `403` / `404` 按语义是请求被拒绝，本文据此列为「不可重试、需修正」。
- 提交结果不确定时先对账再决定是否重提。v3 没有「列出全部任务」的接口：〔JSSDK〕README 建议「先查 `listTasks()` 再决定是否重提」，
  但它对应的 `POST /v3/tasks/list` 只能按已知 `task_id` 查询，找不出一个没拿到 ID 的任务。可行的手段是用 `GET /v3/account/usage`
  查看最近的任务行（〔迁移〕建议重连或启动后翻这个接口补查，称每行带 `status`），或用 `GET /v3/account/balance` 看 `frozen` 是否增加
  （后者是本文建议，非官方流程）。进行中的任务是否会出现在 `usage` 里没有官方说明（见第 11 节）。
- 已经拿到 `task_id` 的任务，一次查询失败不等于任务失败，继续用原 `task_id` 查询。

按「任务是否可能已经创建」归类的速查表（针对创建任务的 `POST` 请求，内容与上文一致，只是换了排列方式）：

| 现象 | 归类 | 依据 |
| --- | --- | --- |
| HTTP 200、`code=0`、拿到 `data.task_id` | 任务已创建，积分已冻结 | 主文档 |
| 连接被拒绝、DNS 解析失败、主机或网络不可达、建立连接超时 | 没有创建，可以重新提交 | 〔JSSDK〕：连接没有建立，请求没有发出 |
| HTTP 429（`1007` / `2000`）、HTTP 503 | 没有创建，按 `Retry-After` 或退避等待后可以重新提交 | 〔JSSDK〕：服务端已答复并拒绝处理 |
| HTTP 400 / 401 / 403 / 404，响应体是带非零 `code` 的错误 JSON | 按错误语义是请求被拒绝、没有创建；原样重提没有意义，修正请求、Key 或余额后再提交 | 主文档错误码表的语义；官方没有逐条写明「未创建任务」 |
| HTTP 408 / 425 / 500 / 502 / 504 | 可能已创建，成功后会扣费；先对账，不要直接重提 | 〔JSSDK〕；主文档「创建请求即使响应丢失也可能已经成功」 |
| 请求发出后超时、连接被重置、读取响应中断 | 同上 | 〔JSSDK〕 |
| HTTP 200 但响应体不是 JSON，或没有 `task_id` | 官方文档未说明；按「可能已创建」处理 | 本文的保守处理 |
| 已拿到 `task_id`，任务终态为 `failed` / `cancelled` | 任务存在但不扣费（冻结积分退回），可以作为新任务重新提交 | 计费页、任务生命周期页 |
| 上传、申请预签名、`PUT` 到存储失败 | 不涉及任务；重新上传，改用新的 `file_token` | 上传接口只返回 `file_token`（见 4.15） |

## 11. 未核实

以下内容今天没能在官方来源里确认，或官方来源之间互相矛盾。写适配器时不要按猜测实现，需要时用真实 Key 小额验证。

1. **结果 URL 有效期**：快速开始页与官方 JS SDK README 写 5 分钟；官方迁移说明写约 24 小时。本文按 5 分钟处理。
2. **OpenAPI schema**：没有找到公开的 schema。文档站 `/openapi.json`、`/openapi.yaml`、`/swagger.json`、`/en/docs/schema`、
   `/en/docs/openapi`、`/api-reference`、`/llms-full.txt` 均为 404，本次核对的文档页（接入、上传、三个生成端点、任务查询、SDK、更新日志、迁移）正文里也没有 schema 链接；
   `https://openapi.tripo3d.ai/v3/openapi.json` 对未鉴权请求返回 401，无法判断是否存在。
3. **免费额度 / 试用积分 / 沙箱 Key**：文档页、定价页均未提及。官网前端脚本里的控制台文案提到会过期的「trial credits」，
   但数量、发放条件、有效期没有任何公开说明；沙箱 Key 没有任何来源提到。
4. **取消与删除任务**：有 `cancelled` 状态（任务查询页描述为「cancelled by user」），但没有任何取消端点的文档；
   也没有删除任务或删除结果文件的端点。
5. **频率限制的具体数值**：主文档未给出，时间窗长度也没有写；迁移说明里的「约 200 次生成 / 分钟、约 50 次 refine / 分钟、
   约 10 次上传 / 分钟」是近似说法，未在主文档印证。主文档称每个响应都带 `X-RateLimit-*` 头，与未鉴权 401 响应的实测不符；
   鉴权后的响应是否都带没有验证。
6. **任务与结果在服务端的保留时长**：未说明。`file_token` 的有效期也未说明（预签名接口明确说 `expires_in` 不可作为保证）。
7. **上传细节**：`POST /v3/files` 是否接受 WebP（该页只列 JPEG、PNG；迁移说明列的是 webp / png / jpeg / bmp / tiff，
   模型文件列的是 glb / obj / fbx / stl / 3mf / usdz，比主文档多 3mf、usdz 而少 gltf）；multipart 上限主文档写 150 MB，迁移说明写 200 MB；
   改用预签名的阈值主文档建议 60 MB，Python SDK 用 50 MB。
8. **多视图图片的单文件大小上限、3D 输入图片的最大分辨率**：未写明（只有单图 20 MB 与 256 px 建议下限）。
9. **批量动画重定向的输出结构**：主文档只有单动画示例（`model_url`）。官方 JS SDK 的示例读取 `output.model_urls`（数组），主文档没有这个字段。
10. **绑骨检查的输出键**：主文档与迁移说明写 `rig_type`；Python SDK 说 v3 返回的是 `topology`。
11. **`spec` 取值与绑骨版本的对应**：主文档、JS SDK、Python SDK 三处说法不同（见 4.11）。
12. **价格细节**：定价页的 H 系列表没有按 `v3.1` / `v3.0` / `v2.5` 区分，不确定三个版本是否同价；`texture=true` 且 `pbr=false`
    是否与带 PBR 同价未说明；`enable_image_autofix`、`auto_size`、`compress`、`texture_version=v3.5-20260815` 是否加价未说明；
    P1 的无贴图 / 标准贴图价格读自页面内嵌数据，P1 的高清 / 8K 贴图价格是推算值；导入模型「免费」只见于 JS SDK README。
13. **创建响应的完整字段**：主文档示例只有 `data.task_id`；迁移说明称还有 `status`、`data.type`、`data.status`。
14. **并发类目归属**：智能 UV、智能分割、导入模型、高斯泼溅属于哪个并发类目未列出；并发表里仍写着已退役的 refine。
15. **参数适用范围**：P 系列是否接受 `compress`、多视图是否接受 `enable_image_autofix` 未写明（各自文档页没有列出）。
    `P1-20260311` 的 `face_limit` 下限主文档写 50，迁移说明写国际站 48、中国站 50。H 系列 `face_limit` 的下限未写明。
16. **任务级 `error_code` 的完整取值表**：文档只说明它与请求级 `code` 是两套编号，没有给出完整表；本文只收录了 `2008`、`2018` 两个例子。
17. **`GET /v3/account/usage` 的查询参数**：主文档未写；`limit` / `offset` 来自迁移说明与 SDK。
18. **哪些任务的 `task_id` 可以作为后处理输入**：各后处理页写的是「3D 生成任务（`text_to_model`、`image_to_model`、`multiview_to_model`）」，
    没有明确说贴图、转换、导入、绑骨等任务的 `task_id` 是否通用（Python SDK 称导入任务的 ID 可以到处使用；重定向明确要求绑骨任务的 ID）。
19. **Webhook**：重试次数与间隔未写明；不支持在单个请求里指定回调地址（只能在控制台配置）。
20. **v2 是否已实际关停**：官方写的是「计划于 2026-10-31 关停」，今天没有调用 v2 验证。
21. **两个区域的行为差异**：迁移说明称除 Base URL、下载域名、P1 `face_limit` 下限与个别校验严格程度外完全一致；未逐项验证。
    下载域名（`tripo-data.rg1.data.tripo3d.com`、`openapi.cdn.tripo3d.com`）只见于迁移说明；主文档示例用的是占位域名 `cdn.tripo3d.ai`。

22. **`file_token` 的字面格式**：上传接口示例与迁移说明都是 `file_...` 前缀；但多视图页「View-key with file_tokens」示例里用的是裸 UUID。
    迁移说明称字符串 `input` 里的裸 UUID 会被当作任务引用。适配器不要自行构造或改写 token，原样回传上传接口返回的值。
23. **API Key 前缀**：SDK 文档页、迁移说明、Python SDK 都是 `tsk_`；快速开始页的安全提示写 `sk-...`。没有用真实 Key 核对。
24. **预签名响应的地址键名**：主文档与 JS SDK 是 `presigned_url`，迁移说明是 `upload_url`，Python SDK 两个都读。
    预签名地址的实际有效期也没有官方数值（迁移说明称约 30 分钟，主文档称 `expires_in` 不可靠）。
25. **多视图按位置写法的占位值**：主文档与 JS SDK 用空字符串 `""`，Python SDK 发送 `null`，迁移说明提到 v2 的 `files` 写法用 `{}`。
    `null` 是否被 v3 接受没有文档说明；新适配器用 view-key 写法可以避开。
26. **P2 `quad=true` 的输出格式**：H 系列页写明 `quad` 强制输出 FBX，P 系列页只写「输出四边面网格」，没有写文件格式。
27. **迁移说明里多出来的生成参数**：`return_multiview`、`check_printable`（需权限）、`style_image`、`image_autofix`
    （称是 `enable_image_autofix` 的别名）只出现在迁移说明里，三个生成端点的文档页都没有列出，不要使用。
28. **`progress` 在非成功状态下的取值**：任务生命周期页对 `failed`、`cancelled` 只写了「-」，没有说明字段是缺失还是保留最后的数值；
    任务查询页又把 `progress` 标为必有字段。读取时允许缺失。
29. **refine / stylize 在 v3 是否还能调用**：SDK 文档页与 Python SDK 称已退役；更新日志、迁移页的映射表、迁移说明（含参数与限流值）
    和并发类目表仍把 `POST /v3/models/refine`、`POST /v3/models/stylize` 当作现有路由。两者都没有文档页，也没有价格，本文按不可用处理。
30. **v3.0 骨骼能否使用四足及其他类型预设**：主文档把 `preset:quadruped:walk` 等列在「`v2.5-20260210` / `v3.0-20260909`」名下，
    Python SDK 的实测表（2026-10-15）写 v3.0 骨骼上四足 / 六足 / 八足预设不可用。
31. **创建请求遇到 5xx 能否重试**：错误处理页一边把 429 和 500 并列为可退避重试，一边写「服务端错误只在安全时重试」；
    迁移说明写「对 5xx 退避重试」；官方 JS、Python SDK 对创建请求一律不重放。没有幂等键，本文按不自动重试处理。
32. **`GET /v3/account/usage` 的覆盖范围**：主文档示例里没有 `status` 字段；迁移说明称每行带 `status`。
    排队中、运行中、失败的任务是否出现在其中，返回顺序与最多能回溯多久，都没有文档说明。
33. **〔实测〕内容本轮未复核**：2026-11-12 的这一轮复核只读公开文档与 SDK 仓库，没有再向 `openapi.tripo3d.ai` 发请求。
    文中标〔实测〕的内容（401 响应体的 `suggestion` 文案、响应体缺少 `request_id`、缺少 `X-RateLimit-*` 头、
    `X-Request-ID` 与 `X-Tripo-Trace-ID` 取值相同）沿用同一天稍早的记录。
34. **是否每一类失败都退回冻结积分**：官方只说失败、取消的任务会退回冻结积分；智能 UV 页单独写了面数超限时「任务失败并退还积分」。
    内容审核拒绝（`2008`）这类失败，只有迁移说明明确写了退款，主文档没有逐类说明。
35. **multipart 上传的分段要求**：`file` 分段是否必须带文件名、扩展名和分段 `Content-Type`，服务端按什么判断文件类型，官方文档未说明
    （主文档只有 `curl -F` 示例；Python、JS 两个 SDK 都带文件名和 MIME 类型）。
36. **`file_token` 能否复用**：同一个 `file_token` 能否用于多个任务、能否被同账号的另一把 Key 使用，官方文档未说明。
    另外 JS SDK README 把 `'8f2a4c...'` 这种不带 `file_` 前缀的字符串标为 `uploadFile()` 返回的 token，与第 22 条是同一个疑点。
37. **上传是否计费、有没有数量或存储配额**：计费页没有上传的价目，也没有写「上传免费」；重复上传同一文件有没有限制，官方文档未说明。
38. **预签名 `PUT` 的请求头要求**：`Content-Type` 是否必须是 `application/octet-stream`、是否必须带 `Content-Length`，官方文档未说明
    （主文档与 JS SDK 用 `application/octet-stream`，Python SDK 用按扩展名推断的 MIME 类型）。
39. **URL 输入的抓取规则**：服务端抓取 URL 时是否跟随重定向、等待多久、是否要求 URL 带扩展名或特定的响应 `Content-Type`，官方文档未说明
    （只写了「可公开访问的直链」以及格式、大小限制）。
40. **得到 GLB 的转换路径**：`/v3/models/convert` 的目标格式没有 GLB。`quad=true` 得到的 FBX、或导入的非 GLB 模型怎样得到 GLB，官方文档未说明。
41. **转换结果的文件形态**：只有 FBX 写明了 `embedded` / `zip` 两种交付方式。`GLTF`、`OBJ`、`USDZ`、`3MF` 的 `model_url` 指向单文件还是压缩包、
    贴图是否内嵌，官方文档未说明；官方示例的转换结果 URL 不带扩展名。下载响应的 `Content-Type` 取值也未说明。
42. **`1007` 限流响应是否带 `Retry-After`**：频率限制页只写明并发超限（`2000`）的响应带 `Retry-After`；官方示例代码对所有 429 都读取这个头，
    但没有写 `1007` 的响应一定带。
43. **任务失败描述的键名**：主文档是 `error_message`；Python、JS 两个官方 SDK 都同时兼容 `error_msg`。服务端实际返回哪一个没有用真实任务核对。
44. **HTTP 200 加非零 `code` 是否会出现**：错误码表里每个非零 `code` 都标了 4xx / 5xx 状态码，HTTP 200 的响应体里会不会出现非零 `code`，官方文档未说明。
    Python、JS 两个官方 SDK 在 2xx 响应里读到非零 `code` 时都按 API 错误处理。本仓库的适配器更保守：状态码低于 500 时只信任
    `2010`、`2008`、`1007`、`2000` 这四个明确的拒绝码，2xx 响应里出现其他非零 `code` 按“可能已创建”处理。
45. **多图输入的范围**：除固定四视图的 `multiview-to-model` 外，有没有接受任意角度、任意张数图片的 3D 生成方式，官方文档未说明（文档索引里没有这样的端点）。

## 12. 来源

全部于 2026-11-12 读取。除最后一条外均为未登录状态下的公开页面。

官方文档站 `developers.tripo3d.ai`：

| URL | 提供的内容 |
| --- | --- |
| `https://platform.tripo3d.ai/docs/quick-start` | 旧文档入口，302 跳转到 `https://developers.tripo3d.ai/` |
| `https://developers.tripo3d.ai/llms.txt` | 文档索引、端点清单 |
| `https://developers.tripo3d.ai/en/docs/<页面>.md` | 各文档页的原始 Markdown（本文 2.1～2.2、3.2、4.1～4.5、4.13、4.15、4.16、第 5 节、第 8 节据此逐项比对） |
| `https://developers.tripo3d.ai/sitemap.xml` | 全部文档页地址 |
| `https://developers.tripo3d.ai/en` | 首页：定价摘要、FAQ（积分不过期、失败不扣费、API 与 Studio 分开计费；FAQ 答案文本在页面脚本 `/assets/index-DB1rwZXR.js` 里，同一脚本里还有控制台账单页的 trial credits 文案） |
| `https://developers.tripo3d.ai/en/docs/introduction` | Base URL、鉴权、统一响应结构、端点总览、中国站提示 |
| `https://developers.tripo3d.ai/en/docs/quick-start` | 最小流程、轮询示例、「模型 URL 5 分钟过期」、典型耗时、绑骨链路示例 |
| `https://developers.tripo3d.ai/en/docs/authentication` | 鉴权头、Key 创建步骤、安全建议 |
| `https://developers.tripo3d.ai/en/docs/changelog` | v3 变更历史、P2、贴图 v3.5、重拓扑 v3.0、绑骨 v3.0、用量历史、端点映射 |
| `https://developers.tripo3d.ai/en/docs/sdk` | 官方 SDK 仓库与版本、v3 路由表、refine / stylize 已退役、v2 关停日期、Key 前缀 `tsk_`、下载不带 Key |
| `https://developers.tripo3d.ai/en/docs/task-lifecycle` | 状态机、状态与进度、`banned` / `expired` / `unknown` 处理、冻结扣费模型、轮询建议 |
| `https://developers.tripo3d.ai/en/docs/models-and-versions` | 3D 与图像模型版本清单、选型建议 |
| `https://developers.tripo3d.ai/en/docs/billing` | 积分规则、冻结 / 扣除、2026-12-01 美元显示、余额与用量接口 |
| `https://developers.tripo3d.ai/en/docs/generation-text-to-model/standard` | 文本生成 3D（H 系列）参数、示例 |
| `https://developers.tripo3d.ai/en/docs/generation-text-to-model/p` | 文本生成 3D（P 系列）参数、示例 |
| `https://developers.tripo3d.ai/en/docs/generation-image-to-model/standard` | 单图生成 3D（H 系列）参数、图片限制、示例 |
| `https://developers.tripo3d.ai/en/docs/generation-image-to-model/p` | 单图生成 3D（P 系列）参数、示例 |
| `https://developers.tripo3d.ai/en/docs/generation-multiview-to-model/standard` | 多视图生成 3D（H 系列）`inputs` 三种写法、示例 |
| `https://developers.tripo3d.ai/en/docs/generation-multiview-to-model/p` | 多视图生成 3D（P 系列）参数、示例 |
| `https://developers.tripo3d.ai/en/docs/generation-image-to-splat` | 高斯泼溅参数、价格、耗时 |
| `https://developers.tripo3d.ai/en/docs/generation-text-to-image` | 文生图参数、模型清单 |
| `https://developers.tripo3d.ai/en/docs/generation-image-to-image` | 图生图参数、图片限制、张数上限 |
| `https://developers.tripo3d.ai/en/docs/generation-image-to-multiview` | 单图生成多视图参数、输出结构 |
| `https://developers.tripo3d.ai/en/docs/generation-edit-multiview` | 多视图编辑参数 |
| `https://developers.tripo3d.ai/en/docs/models-texture` | 重新贴图参数、`texture_prompt` 结构、示例 |
| `https://developers.tripo3d.ai/en/docs/models-convert` | 格式转换参数、示例 |
| `https://developers.tripo3d.ai/en/docs/models-import` | 导入模型参数、`normalize_*` 输出 |
| `https://developers.tripo3d.ai/en/docs/mesh-decimate` | 重拓扑三个版本的参数、范围、价格 |
| `https://developers.tripo3d.ai/en/docs/mesh-uv` | 智能 UV 参数、面数上限、输出 |
| `https://developers.tripo3d.ai/en/docs/mesh-segment` | 网格分割参数 |
| `https://developers.tripo3d.ai/en/docs/mesh-complete` | 部件补全参数 |
| `https://developers.tripo3d.ai/en/docs/mesh-smartsegment` | 智能分割参数、输出、错误码 2001 / 2006 / 2007 |
| `https://developers.tripo3d.ai/en/docs/animations-rig-check` | 绑骨检查参数、输出 |
| `https://developers.tripo3d.ai/en/docs/animations-rig` | 自动绑骨参数、版本、`spec` |
| `https://developers.tripo3d.ai/en/docs/animations-retarget` | 动画重定向参数、全部预设标识 |
| `https://developers.tripo3d.ai/en/docs/task-query` | 查询任务的响应字段 |
| `https://developers.tripo3d.ai/en/docs/task-batch-query` | 批量查询的请求与响应 |
| `https://developers.tripo3d.ai/en/docs/files` | 文件上传、格式与大小限制 |
| `https://developers.tripo3d.ai/en/docs/files-presign` | 预签名上传流程、`expires_in` 说明 |
| `https://developers.tripo3d.ai/en/docs/account` | 余额与用量接口 |
| `https://developers.tripo3d.ai/en/docs/account-usage-history` | 用量历史接口、限流、错误码 1008 |
| `https://developers.tripo3d.ai/en/docs/error-handling` | 错误结构、HTTP 状态码、错误码表、重试建议 |
| `https://developers.tripo3d.ai/en/docs/rate-limits` | 频率限制、响应头、并发类目与默认值 |
| `https://developers.tripo3d.ai/en/docs/webhooks` | Webhook 配置、事件、请求头、验签、示例 |
| `https://developers.tripo3d.ai/en/docs/migration-v2-to-v3` | v2→v3 的 Base URL、端点与字段映射、Key 共用 |
| `https://developers.tripo3d.ai/assets/developer/tripo-v2-to-v3-migration/SKILL.md` | 官方迁移说明全文（文中标〔迁移〕的内容）：区域与下载域名、Base64 被拒、`model` 必填、状态与错误码对应、watch 移除、近似限流值 |
| `https://developers.tripo3d.ai/en/pricing` | 各操作积分价格、高级转换触发条件、P 系列与泼溅价格（页签数据在 `/assets/PricingPage-DJFjUfyW.js`） |
| `https://developers.tripo3d.ai/en/models`、`/en/models/v3-1`、`/en/models/p2`、`/en/models/texture`、`/en/models/rig`、`/en/models/animation` | 模型概览、典型耗时、带贴图档位的价格表、并发说明 |
| `https://developers.tripo3d.ai/en/terms` | 服务条款：不承诺保存输入输出、API 积分不可退款 |
| `https://developers.tripo3d.ai/zh/docs/quick-start` | 中文版快速开始，确认「模型 URL 在 5 分钟后过期」 |

中国站 `developers.tripo3d.com`：

| URL | 提供的内容 |
| --- | --- |
| `https://developers.tripo3d.com/zh/docs/introduction`、`/zh/docs/quick-start` | 中国站 Base URL `https://openapi.tripo3d.com/v3` |
| `https://developers.tripo3d.com/zh/docs/rate-limits` | 并发类目与默认值，与国际站一致 |
| `https://developers.tripo3d.com/zh/pricing` | 1 积分 = ¥0.07；H 系列、后处理、动画的积分数与国际站一致 |

官方 SDK 仓库（由 SDK 文档页链接；`github.com/VAST-AI-Research/tripo-python-sdk` 现跳转到 `Tripo-Developer/tripo-python-sdk`）：

| URL | 提供的内容 |
| --- | --- |
| `https://raw.githubusercontent.com/Tripo-Developer/tripo-python-sdk/v1.0.0/docs/API.md` | 路由表、输入类型、绑骨与预设兼容表、重试策略、refine / stylize 已移除、`wait_for_task` 的轮询间隔 |
| `https://raw.githubusercontent.com/Tripo-Developer/tripo-python-sdk/v1.0.0/CHANGELOG.md` | 1.0.0 迁移到 v3 的变更、v2 关停日期 |
| `https://raw.githubusercontent.com/Tripo-Developer/tripo-python-sdk/v1.0.0/tripo3d/models.py`、`client.py`、`_http.py`、`inputs.py` | 状态枚举与终态集合、输出字段、Base URL、Key 前缀校验、上传阈值、`usage` 查询参数、重试的状态码、multipart 分段的文件名与 MIME 类型、预签名 `PUT` 的请求头、`error_msg` 键 |
| `https://raw.githubusercontent.com/Tripo-Developer/tripo-js-sdk/v0.5.0/README.md` | 「模型 URL 约 5 分钟过期」、创建请求不重放与重复计费说明、`quad` 强制 FBX、导入免费 |
| `https://raw.githubusercontent.com/Tripo-Developer/tripo-js-sdk/v0.5.0/src/constants.js`、`client.js`、`http.js`、`errors.js` | 各枚举取值、默认 Base URL、`usage` 上限 200、重试分类（哪些失败算「请求确定未被处理」）、上传的默认文件名、轮询默认间隔、`error_msg` 键 |

服务端未鉴权响应（没有使用任何 Key，没有调用生成接口）：

| URL | 提供的内容 |
| --- | --- |
| `https://openapi.tripo3d.ai/v3/openapi.json`（`GET`，不带 Key） | 返回 HTTP 401 与 `code: 2` 的错误体；响应头含 `X-Request-ID`、`X-Tripo-Trace-ID` |
