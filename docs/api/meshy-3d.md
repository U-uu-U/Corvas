# Meshy 3D 生成 API

快照日期：2026-11-12。本文全部内容来自当天读取的 Meshy 官方公开文档（见文末“来源”），
没有调用任何接口做实测。官方文档更新很频繁（更新日志最近一条是 2026-11-10），
写适配器前请先对照官方 Changelog。凡是没能在官方页面确认的内容都放在“11. 未核实”，不要当作事实使用。

核对情况：同一天又独立抓取官方来源，逐项核对了本文的路径、方法、参数名、类型、取值、默认值、状态值、响应字段、
模型 ID 和积分价格，发现的问题已经改正。对照的来源有三类：各页面的 `.md` 版本；OpenAPI 规范（`openapi.yaml` 和 `openapi.json`）；
官方开源 MCP server 的 npm 包 `@meshy-ai/meshy-mcp-server` 0.6.11（只读源码）。官方来源之间的出入都记在“11. 未核实”。

## 1. 概述

Meshy 是异步的 3D 资产生成 REST API，本文覆盖与 3D 生成直接相关的部分：

- 文生 3D（先 preview 出白模，再 refine 贴图，两次独立请求）。
- 图生 3D（单图）、多图生 3D（1～4 张同一物体的不同角度）。
- 后处理：重新贴图 Retexture、重拓扑 Remesh、格式转换 Convert、缩放 Resize、UV 展开。
- 角色：自动绑骨 Rigging、套用动作 Animation、文生动作 Text to Motion。
- 账户：余额 Balance、用量 Usage。

官方文档入口：

- 文档站：`https://docs.meshy.ai`
- 给程序读的索引：`https://docs.meshy.ai/llms.txt`，全文合集 `https://docs.meshy.ai/llms-full.txt`
- 每个页面都有 Markdown 版：`https://docs.meshy.ai/api/<page>.md`
- OpenAPI 规范：`https://docs.meshy.ai/openapi.yaml`（JSON 版 `openapi.json`）
- 状态页：`https://status.meshy.ai`

本文没有逐项抄录的官方接口（只确认了它们存在）：Text to Image、Image to Image、
3D 打印系列（`/openapi/v1/print/*`）、浮雕 Relief（`/openapi/v1/relief`）、Creative Lab 系列
（`/openapi/creative-lab/<product>/v1/...`）。Creative Lab 和 Text to Motion 不在 OpenAPI 规范里，只有文档页。

## 2. 接入

| 项目 | 内容 |
| --- | --- |
| Base URL | `https://api.meshy.ai/openapi`（后面接 `/v1/...` 或 `/v2/...`） |
| 协议 | 只用 HTTPS。HTTP 请求会得到 `301`；重定向只对 `GET` 有效，`POST` 被重定向后会丢失请求体，所以创建任务必须直接请求 `https://` |
| 鉴权 | 每个请求都带 `Authorization: Bearer msy_xxx`，`Bearer` 前缀必填。没有 Key 返回 `401` |
| Key 格式 | `msy_<随机字符串>` |
| Key 创建位置 | Developer Platform 的 API Keys 页：`https://www.meshy.ai/developers/keys`。Key 只在创建时显示一次 |
| 请求体 | `Content-Type: application/json`。官方文档和 OpenAPI 规范里没有任何 multipart / 文件上传接口（见 4.19） |
| 可选请求头 | `X-Meshy-Metadata: user=alex@example.com,team=fab`（W3C Baggage 格式，最多 64 对、8192 字节）。只有 Studio / Enterprise 团队的 Key 生效，其他套餐被忽略（也不会因此返回 `400`）。在 Studio / Enterprise 上，格式错误或超出上限的头返回 `400` 且不创建任务。Creative Lab 接口忽略该头 |

要点：

- **必须付费套餐才能创建 API Key**。Free 套餐不能创建自己的 Key，绝大多数创建任务的请求会返回 `402`。
- **没有测试 / 沙箱 Key**。以前的共享 test-mode Key 已在 2026-09-16 下线，继续使用会返回 `401`。
  官方建议用自己的 Key 或网页端 Playground（Playground 同样消耗账户积分并计入限流）。
- Key 可以设置每月积分上限，也可以绑定 IP 白名单（最多 50 条，必须是公网地址）。
  白名单之外的请求返回 `403`，错误码 `ip_not_authorized`，不扣积分也不计入限流。
- **版本**：版本号写在路径里。文生 3D 是 `v2`（`/openapi/v2/text-to-3d`），本文其他接口都是 `v1`。
  不带 `/openapi` 前缀的旧路径 `/v2/text-to-3d` 已于 2026-09-29 标记为废弃，不要使用。
- 所有时间戳都是 **Unix 毫秒**，不是秒。
- 不要在浏览器端直接调用，会暴露 Key。

## 3. 任务流程

所有生成接口都是异步的：`POST` 只返回任务 ID，不返回模型。

1. **提交**：`POST` 创建任务，成功返回 `202 Accepted`，响应体为 `{"result": "<task_id>"}`。
   积分在任务**创建时**扣除。
2. **等待结果**，三选一：
   - **轮询**：`GET .../{id}`，直到 `status` 进入终态。两次轮询的间隔取响应头 `Retry-After`（秒），没有就等 5 秒。轮询请求计入每秒请求数限流。
   - **SSE**：`GET .../{id}/stream`（`llms.txt` 的 Python 示例带请求头 `Accept: text/event-stream`，各页面的 curl 示例只用 `-N`、不带这个头；文档没有写它是否必填，适配器带上即可）。每个 `message` 事件的 `data` 是完整任务对象。流可能在任务结束前断开，断开后重连或改用轮询。
   - **Webhook**：在控制台登记一个 `https://` 回调地址，账户下所有 API 任务的状态变化都会推送过来（见 4.17）。
   官方文档只列出这三种方式，没有 WebSocket。
3. **下载**：任务 `SUCCEEDED` 后，从 `model_urls`、`texture_urls`、`thumbnail_url` 等字段取签名下载链接，
   直接 `GET` 下载（官方示例下载时不带 `Authorization`）。Quickstart 的 curl 下载示例是 `curl -L "<链接>" -o model.glb`，
   带 `-L`（跟随重定向）；文档没有说下载链接是否真的会重定向，适配器下载时允许跟随重定向即可。

返回的 ID 只有一个：任务 ID。把它当作不透明字符串，不要依赖格式。链式调用时把上一步的任务 ID 填进
下一步的 `preview_task_id`、`input_task_id`、`rig_task_id` 或 `motion_task_id`。

**结果链接有效期**

- 下载链接指向 `assets.meshy.ai`，带签名参数（`?Expires=…&Signature=…`），在任务的 `expires_at` 失效。
  重新查询任务会得到**同一个链接、同一个到期时间**，不会续期。
- 非 Enterprise 客户生成的文件最多保留 **3 天**，之后从服务器删除；Enterprise 可以长期保留。
- 文生 3D 任务没有 `expires_at`（或为 `null`），官方说它的链接不带过期时间，但任务仍会在完成 3 天后被删除，
  此后查询返回 `404`。
- 所以：任务一成功就立刻下载并自己保存。不要把下载链接存起来以后再当 `model_url` 传回 Meshy，
  签名过期后会得到 `400 failed to download model file`；源任务还在时应传 `input_task_id`。

**等待多久**（官方建议值）

| 设置 | 建议值 |
| --- | --- |
| 创建请求（`POST`）超时 | 60 秒 |
| 创建请求带超过 100 MB 的 `model_url` 文件 | 120 秒（Meshy 先下载文件再响应） |
| 查询请求（`GET`）超时 | 30 秒 |
| 轮询间隔 | `Retry-After` 头，没有则 5 秒 |
| 查询失败（超时、`429`、`5xx`） | 下次轮询再试，不代表任务失败 |
| 单个任务总等待 | 从任务的 `created_at` 起至少 60 分钟；重连 SSE 时不要重新计时 |

客户端超时、断线、关闭 SSE 都**不会**让任务失败或取消，任务会继续跑并且已经扣费。
保留任务 ID，稍后再查，不要重新创建。

**典型耗时**（2026 年 9 月生产流量中位数，官方明确说不要当作超时值）

| 接口 | 配置 | `meshy-7.1` | `meshy-6` | `meshy-6-lite` | `meshy-t2` |
| --- | --- | --- | --- | --- | --- |
| 文生 3D preview | 仅网格 | 75 秒 | 90 秒 | 45 秒 | 10 秒 |
| 图生 3D | 仅网格 | 75 秒 | 90 秒 | 40 秒 | 4 秒 |
| 图生 3D | 2K 贴图 | 2 分钟 | 3 分钟 | 75 秒 | 60 秒 |
| 图生 3D | 4K 贴图 | 2.5 分钟 | 3.5 分钟 | 不支持 | 80 秒 |
| 图生 3D | 8K 贴图 | 3.5 分钟 | 4 分钟 | 不支持 | 2.5 分钟 |
| 多图生 3D | 仅网格 | 65 秒 | 2 分钟 | 30 秒 | 不支持 |
| 多图生 3D | 2K 贴图 | 2.5 分钟 | 3.5 分钟 | 85 秒 | 不支持 |
| 多图生 3D | 4K 贴图 | 3 分钟 | 4 分钟 | 不支持 | 不支持 |
| 多图生 3D | 8K 贴图 | 3.5 分钟 | 4.5 分钟 | 不支持 | 不支持 |

`meshy-t2.5` 不在官方这张表里；Models 页给出它在图生 3D 仅网格时的典型耗时是 15 秒。

其他：文生 3D refine 2K/4K 约 80 秒、8K 约 3.5 分钟；Retexture 2K 55 秒、4K 90 秒、8K 2.5 分钟；
Rigging 40 秒；Animation 15 秒；Text to Motion `prime` 15 秒、`swift` 10 秒；Remesh 2 分钟；UV Unwrap 35 秒；
Convert 7 秒；Resize 15 秒。`enable_pbr` 多 30～60 秒，`geometry_resolution` 为 `2k` / `4k` 最多再加 1 分钟。
繁忙时有任务需要 20 分钟以上仍然成功。

## 4. 接口

### 4.1 通用规则：创建、查询、列表、删除、流

每类任务都有同一组五个接口，只是路径前缀不同：

| 任务 | 路径前缀 | 任务对象 `type` |
| --- | --- | --- |
| 文生 3D | `/openapi/v2/text-to-3d` | `text-to-3d-preview` 或 `text-to-3d-refine` |
| 图生 3D | `/openapi/v1/image-to-3d` | `image-to-3d` |
| 多图生 3D | `/openapi/v1/multi-image-to-3d` | `multi-image-to-3d` |
| 重新贴图 | `/openapi/v1/retexture` | `retexture` |
| 重拓扑 | `/openapi/v1/remesh` | `remesh` |
| 格式转换 | `/openapi/v1/convert` | `convert` |
| 缩放 | `/openapi/v1/resize` | `resize` |
| UV 展开 | `/openapi/v1/uv-unwrap` | `uv-unwrap` |
| 绑骨 | `/openapi/v1/rigging` | `rig` |
| 动画 | `/openapi/v1/animations` | `animate` |
| 文生动作 | `/openapi/v1/text-to-motion` | `text-to-motion` |

完整 URL = `https://api.meshy.ai` + 路径。

| 操作 | 方法与路径 | 说明 |
| --- | --- | --- |
| 创建 | `POST <前缀>` | JSON 请求体。成功 `202`，响应 `{"result": "<task_id>"}` |
| 查询 | `GET <前缀>/{id}` | 返回任务对象。任务未结束时响应带 `Retry-After` 头 |
| 列表 | `GET <前缀>` | 返回任务对象的 JSON **数组**（不是带分页信息的对象） |
| 删除 | `DELETE <前缀>/{id}` | 永久删除任务及其文件，不可恢复 |
| 流 | `GET <前缀>/{id}/stream` | SSE，响应 `Content-Type: text/event-stream` |

查询接口的失败状态码在文生 3D、图生 3D、多图生 3D 的文档页里没有单列；OpenAPI 规范给这三个查询接口列的是
`401`、`404`、`429`。Errors 页写明查询不存在的任务 ID 返回 `404`。

**创建响应**（所有创建接口相同）

```json
{
  "result": "018a210d-8ba4-705c-b111-1f1776f7f578"
}
```

**列表参数**（query string）

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `page_num` | integer | `1` | 页码，最大 `255`，更大返回 `400` |
| `page_size` | integer | `10` | 每页条数，最大 `100`。OpenAPI 规范补充：`101`～`255` 仍返回 100 条，更大返回 `400` |
| `sort_by` | string | `-created_at`（OpenAPI 规范） | `+created_at` 旧的在前，`-created_at` 新的在前。URL 里 `+` 要写成 `%2B` |

Rigging、Animation、UV Unwrap、Text to Motion 的列表小节只写了 `page_num`、`page_size`，并说明新的在前；
OpenAPI 规范给 Rigging、Animation、UV Unwrap 的列表接口同样声明了 `sort_by`。
`+` 要写成 `%2B` 这一条，官方只在 Usage 页写明（否则 `+` 被当成空格，请求返回 `400`）。
通过 API 创建的任务不会出现在网页端的 My Assets 里，丢了任务 ID 只能用列表接口找回。

```bash
curl "https://api.meshy.ai/openapi/v2/text-to-3d?page_size=10" \
  -H "Authorization: Bearer ${YOUR_API_KEY}"
```

**删除与“取消”**

- 没有单独的取消接口。`DELETE` 只对 `PENDING` 任务相当于取消：任务被删除，创建时扣的积分退回。
- `IN_PROGRESS` 任务**不能删除也不能取消**，返回 `409 Conflict`，任务继续运行，不退积分
  （这是 2026-09-11 的行为变更，之前会返回 `200` 并丢弃结果）。
- 终态任务（`SUCCEEDED`、`FAILED`、`CANCELED`）可以删除，不退积分。
- 成功返回 `200`。文档页写响应体为空，OpenAPI 规范却把这个响应声明成一个 JSON 对象。适配器只看状态码，不要解析响应体。
- OpenAPI 规范给各 `DELETE` 接口列的状态码是 `200`、`401`、`404`、`409`、`429`。文档页的删除小节只写了 `200` 和 `409`。

```bash
curl --request DELETE \
  --url https://api.meshy.ai/openapi/v2/text-to-3d/018a210d-8ba4-705c-b111-1f1776f7f578 \
  -H "Authorization: Bearer ${YOUR_API_KEY}"
```

`409` 响应体：

```json
{
  "message": "Task is IN_PROGRESS and cannot be deleted. Credits for a task the worker has already started are not refundable; wait for it to reach SUCCEEDED, FAILED or CANCELED, then delete it."
}
```

**SSE 流**

```bash
curl -N https://api.meshy.ai/openapi/v2/text-to-3d/018a210d-8ba4-705c-b111-1f1776f7f578/stream \
  -H "Authorization: Bearer ${YOUR_API_KEY}"
```

事件有两种：`event: message` 的 `data` 是与查询接口相同形状的完整任务对象；`event: error` 的 `data` 是
`status_code` 加 `message`。官方示例（已缩短，实际每个 `message` 事件都是完整对象）：

```text
event: error
data: {
  "status_code": 404,
  "message": "Task not found"
}

event: message
data: {
  "id": "018a210d-8ba4-705c-b111-1f1776f7f578",
  "progress": 0,
  "status": "PENDING"
}

event: message
data: {
  "id": "018a210d-8ba4-705c-b111-1f1776f7f578",
  "progress": 50,
  "status": "IN_PROGRESS"
}
```

收到 `SUCCEEDED`、`FAILED`、`CANCELED` 之一就关闭连接（UV Unwrap 页写明流在任务到达这三个状态之一时关闭）。
任务还在 `PENDING` / `IN_PROGRESS` 时，事件里的结果字段还没有值。
OpenAPI 规范给流接口列的状态码是 `200`、`401`、`404`；文档页的示例则把 `404` 画成流里的 `event: error` 事件。
两种形式适配器都要处理（见“未核实”）。

**创建接口常见的失败响应**（各接口的额外情况写在各自小节）

| 状态码 | 含义 |
| --- | --- |
| `400` | 参数错误，`message` 说明具体问题。没有创建任务 |
| `401` | Key 缺失或无效 |
| `402` | 积分不足、账户达到某个积分上限（官方原文是 “the account reached a credit limit”，没有说明是哪一种上限），或 Free 套餐（创建任务需要付费套餐） |
| `403` | 内容审核拦截了提示词或输入图片；后处理接口上还表示 `input_task_id` 是浮雕模型（消息为 `This model type does not support this operation`） |
| `404` | `input_task_id` 不是你的任务 |
| `429` | 超过限流，见第 10 节 |

### 4.2 文生 3D：preview（生成白模）

`POST https://api.meshy.ai/openapi/v2/text-to-3d`，`Content-Type: application/json`。

两步流程的第一步，只生成不带贴图的网格。成功后把任务 ID 作为 `preview_task_id` 提交 refine（4.3）才有贴图。

| 参数 | 类型 | 必填 | 默认 | 取值与约束 |
| --- | --- | --- | --- | --- |
| `mode` | string | 是 | 无 | 固定 `preview` |
| `prompt` | string | 是 | 无 | 最多 800 字符，超出返回 `400` |
| `model_type` | string | 否 | `standard` | `standard` 高细节网格；`smart-topology` 低面数三角网格（配合 `meshy-t2` / `meshy-t2.5`）。`smart-topology` 下忽略 `should_remesh`、`decimation_mode`，只接受 `topology: triangle` |
| `ai_model` | string | 否 | `latest` | `standard` 时：`meshy-6-lite`、`meshy-6`、`meshy-7.1`、`latest`（= Meshy 7.1）、`meshy-7`（已废弃，2026-12-31 下线）。`smart-topology` 时：`meshy-t2`、`meshy-t2.5`（该模式下的默认） |
| `geometry_resolution` | string | 否 | `standard` | `standard`、`2k`（2048³ Ultra）、`4k`（4096³ Ultra）。`2k` 需要 `meshy-7.1` / `latest` / `meshy-7`；`4k` 需要 `meshy-7.1` / `latest`；其他模型返回 `400`。只用于 preview |
| `should_remesh` | boolean | 否 | `meshy-6-lite` 为 `true`，其他模型为 `false` | 生成后是否重拓扑。要最高质量就传 `false` |
| `topology` | string | 否 | `triangle` | `quad`（四边面为主）或 `triangle`（减面三角网格）。仅在重拓扑时有意义；`meshy-t2` / `meshy-t2.5` 传 `quad` 返回 `400` |
| `decimation_mode` | integer | 否 | 无 | 自适应面数档位：`1` ultra、`2` high、`3` medium、`4` low。设置后忽略 `target_polycount` |
| `target_polycount` | integer | 否 | 见下表 | 目标面数，实际结果可能有偏差。超出范围返回 `400` |
| `pose_mode` | string | 否 | 无 | `a-pose` 或 `t-pose`。不要姿态就不传 |
| `moderation` | boolean | 否 | `false` | 生成前审核 `prompt`，命中则返回 `400` 且不创建任务 |
| `target_formats` | string[] | 否 | 除 `3mf` 外全部 | `glb`、`obj`、`fbx`、`stl`、`usdz`、`3mf`。只生成列出的格式，可缩短耗时；`3mf` 只有显式列出才生成 |
| `alpha_thumbnail` | boolean | 否 | `false` | 额外渲染透明背景预览图，返回在 `alpha_thumbnail_url` |
| `auto_size` | boolean | 否 | `false` | 用 AI 视觉估计真实高度并缩放模型 |
| `origin_at` | string | 否 | `bottom` | `bottom` 或 `center`，配合 `auto_size` |

`target_polycount` 的范围与默认：

| 场景 | 范围 | 默认 |
| --- | --- | --- |
| 重拓扑（`standard` 模型且 `should_remesh: true`） | `100`～`300000` | `30000` |
| `meshy-t2`（直接按该面数生成，不需要 `should_remesh`） | `100`～`15000` | `4000` |
| `meshy-t2.5`（同上） | `100`～`30000` | `15000` |

已废弃、不要再传的参数：`ultra_mode`（`true` 等于 `geometry_resolution: "2k"`）、`symmetry_mode`（被忽略）、
`is_a_t_pose`（改用 `pose_mode`）、`art_style`（被忽略）。

只出现在 OpenAPI 规范、文档页没有说明的参数：`name`（string，最多 100 字符，任务名）、
`seed`（int64，≥0，`0` 表示随机）、`negative_prompt`（已废弃无效）、`texture_richness`（已废弃无效）、
`should_texture`（规范称“尚未普遍开放”，未开通的账户会被忽略）、`experimental`（实验开关对象）。
规范还说 `ai_model` 接受别名 `meshy-standard-latest`、`meshy-smart-topology-latest`。这些见“未核实”。

该接口额外的 `400` 情况：缺 `prompt` 或 `mode`；提示词过长；`geometry_resolution` 与模型不匹配。

请求示例：

```bash
curl https://api.meshy.ai/openapi/v2/text-to-3d \
  -H "Authorization: Bearer ${YOUR_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
  "mode": "preview",
  "prompt": "a futuristic robot warrior",
  "ai_model": "meshy-7.1",
  "geometry_resolution": "4k",
  "should_remesh": true,
  "target_polycount": 100000,
  "pose_mode": "a-pose",
  "target_formats": ["glb"]
}'
```

最小请求体：

```json
{
  "mode": "preview",
  "prompt": "a monster mask"
}
```

响应（`202`）：

```json
{
  "result": "018a210d-8ba4-705c-b111-1f1776f7f578"
}
```

### 4.3 文生 3D：refine（给 preview 贴图）

`POST https://api.meshy.ai/openapi/v2/text-to-3d`（与 preview 同一路径，靠 `mode` 区分）。

| 参数 | 类型 | 必填 | 默认 | 取值与约束 |
| --- | --- | --- | --- | --- |
| `mode` | string | 是 | 无 | 固定 `refine` |
| `preview_task_id` | string | 是 | 无 | 状态为 `SUCCEEDED` 的 preview 任务 ID |
| `ai_model` | string | 否 | 与 preview 匹配的贴图模型 | 这里只选**贴图模型**：`meshy-7`、`latest`（= Meshy 7）、`meshy-6`、`meshy-6-lite`、`meshy-n1` |
| `enable_pbr` | boolean | 否 | `false` | 额外生成 metallic、roughness、normal 贴图。`meshy-6` 还会生成 emission（`8k` 除外）；`meshy-6-lite`、`meshy-7`、`latest`，以及不设置 `ai_model` 去 refine `meshy-t2` / `meshy-t2.5` preview 的任务都不生成 emission。`meshy-n1` 传 `true` 返回 `400` |
| `texture_resolution` | string | 否 | `2k` | `2k`（2048×2048）、`4k`（4096×4096）、`8k`（8192×8192）。`4k` / `8k` 需要 `meshy-6`、`meshy-7` 或 `latest`；`meshy-n1` 返回 `400`。只用于 refine，preview 传它返回 `400` |
| `texture_prompt` | string | 否 | 无 | 引导贴图的文字，最多 800 字符。`meshy-n1` 传它返回 `400` |
| `texture_image_url` | string | 否 | 无 | 引导贴图的图片，公网 URL 或 base64 data URI。限制见第 6 节。与 `texture_prompt` 同时传时用 `texture_prompt` |
| `moderation` | boolean | 否 | `false` | 审核 `texture_prompt` 和 `texture_image_url` |
| `remove_lighting` | boolean | 否 | `true` | 去掉底色贴图里的高光和阴影。只有 `meshy-6` 生效；`meshy-7` / `latest` 接受但忽略，不设置 `ai_model` 去 refine `meshy-t2` / `meshy-t2.5` 的 preview 时同样被忽略；`meshy-6-lite` 传它返回 `400`；`meshy-n1` 传 `true` 返回 `400` |
| `target_formats` | string[] | 否 | 除 `3mf` 外全部 | 同 preview |
| `alpha_thumbnail` | boolean | 否 | `false` | 同 preview |
| `auto_size` | boolean | 否 | `false` | 同 preview |
| `origin_at` | string | 否 | `bottom` | 同 preview |

`meshy-n1` 的限制：只出 2K 底色贴图；从 `texture_image_url` 取参考图，没传时使用 `meshy-7.1` / `latest`
preview 保存的参考图，其他 preview 不传 `texture_image_url` 会返回 `400`；preview 最多 7,999,999 个三角面；
重拓扑成四边面的 preview 返回 `400`。

`geometry_resolution` 不能用于 refine（返回 `400`）。已废弃：`hd_texture`（`true` 等于 `texture_resolution: "4k"`）。

该接口额外的 `400` 情况：`preview_task_id` 无效或不属于你；preview 还没成功；preview 的模型与所选 refine 模型不兼容。

请求示例：

```bash
curl https://api.meshy.ai/openapi/v2/text-to-3d \
  -H "Authorization: Bearer ${YOUR_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
  "mode": "refine",
  "preview_task_id": "018a210d-8ba4-705c-b111-1f1776f7f578",
  "enable_pbr": true
}'
```

响应（`202`）：

```json
{
  "result": "018a210d-8ba4-705c-b111-1f1776f7f578"
}
```

### 4.4 文生 3D：任务对象

`GET https://api.meshy.ai/openapi/v2/text-to-3d/{id}`，preview 和 refine 任务都用它查询。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 任务 ID |
| `type` | string | `text-to-3d-preview` 或 `text-to-3d-refine` |
| `model_urls` | object | 各格式下载链接，键为 `glb`、`fbx`、`usdz`、`obj`、`mtl`、`stl`、`3mf`。没生成的格式**没有这个键**，不是空字符串 |
| `prompt` | string | 创建时的 `prompt` 原文 |
| `texture_prompt` | string | refine 时的贴图提示词 |
| `texture_image_url` | string | refine 时的参考图下载链接 |
| `geometry_resolution` | string | `2k` 或 `4k`；`standard` 时没有该字段 |
| `thumbnail_url` | string | 缩略图 |
| `alpha_thumbnail_url` | string | 透明背景缩略图，仅在 `alpha_thumbnail: true` 时出现 |
| `progress` | integer | 0～100 |
| `created_at` / `started_at` / `finished_at` | integer | Unix 毫秒。`started_at`、`finished_at` 在开始 / 结束前为 `0` |
| `status` | string | 见第 5 节 |
| `texture_urls` | array | 贴图对象数组，通常只有 1 个。字段 `base_color`、`metallic`、`normal`、`roughness`、`emission` |
| `preceding_tasks` | integer | 队列里排在前面的任务数，只在 `PENDING` 时有意义 |
| `task_error` | object 或 null | 失败详情，非 `FAILED` 时为 `null` |
| `consumed_credits` | integer | 本任务消耗的积分。`FAILED` 时为 `0`（已退还） |

注意文生 3D 任务对象的官方字段表里**没有** `expires_at`（Asset retention 页的说法是“没有，或为 `null`”）。
适配器不要依赖这个字段，按“完成后 3 天内下载”处理。
OpenAPI 规范的文生 3D 任务对象里同样没有 `expires_at`。

官方字段表里还有一个已废弃的 `ultra_mode`（boolean），官方要求改读 `geometry_resolution`。

查询响应示例：

```json
{
  "id": "018a210d-8ba4-705c-b111-1f1776f7f578",
  "type": "text-to-3d-preview",
  "model_urls": {
    "glb": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/model.glb?Expires=***",
    "fbx": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/model.fbx?Expires=***",
    "obj": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/model.obj?Expires=***",
    "mtl": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/model.mtl?Expires=***",
    "usdz": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/model.usdz?Expires=***",
    "stl": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/model.stl?Expires=***"
  },
  "thumbnail_url": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/preview.png?Expires=***",
  "prompt": "a monster mask",
  "progress": 100,
  "started_at": 1692771667037,
  "created_at": 1692771650657,
  "finished_at": 1692771669037,
  "status": "SUCCEEDED",
  "texture_urls": [
    {
      "base_color": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/texture_0.png?Expires=***"
    }
  ],
  "preceding_tasks": 0,
  "task_error": null,
  "consumed_credits": 20
}
```

### 4.5 图生 3D（单图）

`POST https://api.meshy.ai/openapi/v1/image-to-3d`，`Content-Type: application/json`。

一次请求可以同时出网格和贴图（`should_texture` 默认 `true`），不需要像文生 3D 那样分两步。

| 参数 | 类型 | 必填 | 默认 | 取值与约束 |
| --- | --- | --- | --- | --- |
| `image_url` | string | 二选一 | 无 | 输入图片，公网 URL 或 base64 data URI（`data:image/jpeg;base64,...`）。限制见第 6 节 |
| `input_task_id` | string | 二选一 | 无 | 一个 Text to Image / Image to Image 任务的 ID：必须是 API 创建、`SUCCEEDED`、且只产出 1 张图。与 `image_url` 同时传时用 `input_task_id` |
| `model_type` | string | 否 | `standard` | `standard` 或 `smart-topology`。后者忽略 `should_remesh`、`save_pre_remeshed_model`、`decimation_mode`，只接受 `topology: triangle` |
| `ai_model` | string | 否 | `latest` | `standard` 时：`latest`（= Meshy 7.1）、`meshy-7.1`、`meshy-6`、`meshy-6-lite`、`meshy-7`（已废弃，2026-12-31 下线）。`smart-topology` 时：`meshy-t2`、`meshy-t2.5`（该模式下的默认） |
| `geometry_resolution` | string | 否 | `standard` | `standard`、`2k`、`4k`。`2k` 需要 `meshy-7.1` / `latest` / `meshy-7`；`4k` 需要 `meshy-7.1` / `latest` |
| `should_texture` | boolean | 否 | `true` | `false` 只出白模 |
| `texture_model` | string | 否 | 取决于 `ai_model`（见第 8 节） | `meshy-7`、`meshy-n1`、`meshy-6-lite`；`meshy-6` 只能作为 `ai_model: meshy-6` 的默认值。不影响积分。`should_texture: false` 时被忽略，但未知值仍返回 `400`。用 `meshy-n1` 时，生成的模型超过 7,999,999 个三角面会让**任务失败**（不是创建时的 `400`），积分退还 |
| `enable_pbr` | boolean | 否 | `false` | 额外生成 metallic、roughness、normal。需要 `should_texture: true`，否则返回 `400`。`texture_model: meshy-n1` 传 `true` 返回 `400` |
| `texture_resolution` | string | 否 | `2k` | `2k`、`4k`、`8k`。`4k` / `8k` 需要 Meshy 7 或 Meshy 6 贴图模型，其他返回 `400` |
| `texture_prompt` | string | 否 | 无 | 引导贴图的文字，最多 800 字符。`meshy-n1` 传它返回 `400` |
| `texture_image_url` | string | 否 | 无 | 引导贴图的图片，URL 或 data URI。与 `texture_prompt` 同时传时用 `texture_prompt`。`meshy-n1` 把它当正面视图，没传则用输入图 |
| `should_remesh` | boolean | 否 | `meshy-6-lite` 为 `true`，其他为 `false` | 是否执行重拓扑阶段 |
| `topology` | string | 否 | `triangle` | `quad` 或 `triangle`。`meshy-t2` / `meshy-t2.5` 传 `quad` 返回 `400`；`texture_model: meshy-n1` 且模型被重拓扑时传 `quad` 返回 `400` |
| `decimation_mode` | integer | 否 | 无 | `1` ultra、`2` high、`3` medium、`4` low。设置后忽略 `target_polycount` |
| `save_pre_remeshed_model` | boolean | 否 | `false` | 额外保存重拓扑前的 GLB，返回在 `model_urls.pre_remeshed_glb` |
| `target_polycount` | integer | 否 | 同 4.2 的表 | 重拓扑 `100`～`300000`（默认 `30000`）；`meshy-t2` `100`～`15000`（默认 `4000`）；`meshy-t2.5` `100`～`30000`（默认 `15000`） |
| `pose_mode` | string | 否 | 无 | `a-pose` 或 `t-pose` |
| `image_enhancement` | boolean | 否 | `true` | 生成前优化输入图。`false` 保留原图观感。只支持 `meshy-6`、`meshy-7.1`、`latest`；`meshy-6-lite` 或 `smart-topology` 传它返回 `400` |
| `remove_lighting` | boolean | 否 | `true` | 去除底色贴图的高光阴影。只有 Meshy 6 贴图模型生效；不支持它的贴图模型传 `true` 返回 `400`；`smart-topology`、或 `meshy-6-lite` 配默认贴图模型时传它返回 `400` |
| `moderation` | boolean | 否 | `false` | 审核 `image_url`、`texture_image_url`、`texture_prompt`，命中返回 `400` 且不创建任务 |
| `target_formats` | string[] | 否 | 除 `3mf` 外全部 | `glb`、`obj`、`fbx`、`stl`、`usdz`、`3mf` |
| `auto_size` | boolean | 否 | `false` | 估计真实高度并缩放 |
| `origin_at` | string | 否 | `bottom` | `bottom` 或 `center`，配合 `auto_size` |
| `alpha_thumbnail` | boolean | 否 | `false` | 透明背景预览图 |
| `multi_view_thumbnails` | boolean | 否 | `false` | 额外渲染前、右、后、左四张预览图，返回在 `thumbnail_urls`，任务多约 5 秒 |

已废弃：`ultra_mode`、`hd_texture`、`symmetry_mode`、`is_a_t_pose`、`surface_mode`（只接受 `organic` / `hard`，其他值返回 `400`，对输出无影响）。
只出现在 OpenAPI 规范的参数：`name`（最多 100 字符）、`experimental`。

该接口额外的 `400` 情况：`image_url` 和 `input_task_id` 都没传；图片格式不支持；URL 下载失败（`404` 或超时）；
图片超过 20 MB；尺寸不合规；data URI 的 base64 损坏；`enable_pbr: true` 配 `should_texture: false`；
`texture_model` 是 `meshy-6` 但 `ai_model` 不是 `meshy-6`；贴图模型不支持所请求的选项（如 `meshy-6-lite` 配 `4k`）。

请求示例：

```bash
curl https://api.meshy.ai/openapi/v1/image-to-3d \
  -X POST \
  -H "Authorization: Bearer ${YOUR_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "image_url": "<your publicly accessible image url or base64-encoded data URI>",
    "ai_model": "meshy-7.1",
    "geometry_resolution": "4k",
    "enable_pbr": true,
    "should_remesh": true,
    "target_polycount": 100000,
    "should_texture": true,
    "pose_mode": "a-pose",
    "target_formats": ["glb"]
  }'
```

低面数游戏角色的官方示例请求体（Meshy T2.5 网格配 Meshy N1 贴图）：

```json
{
  "image_url": "https://example.com/character.png",
  "model_type": "smart-topology",
  "ai_model": "meshy-t2.5",
  "target_polycount": 15000,
  "texture_model": "meshy-n1"
}
```

响应（`202`）：

```json
{
  "result": "018a210d-8ba4-705c-b111-1f1776f7f578"
}
```

**任务对象**（`GET https://api.meshy.ai/openapi/v1/image-to-3d/{id}`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 任务 ID |
| `type` | string | 固定 `image-to-3d` |
| `model_urls` | object | 键：`glb`、`fbx`、`obj`、`usdz`、`mtl`（有贴图时随 OBJ 返回）、`stl`、`3mf`、`pre_remeshed_glb`。没生成的格式没有键 |
| `thumbnail_url` | string | 预览图；有 `thumbnail_urls` 时等于其中的 `front` |
| `alpha_thumbnail_url` | string | 仅 `alpha_thumbnail: true` 时出现 |
| `thumbnail_urls` | object | `front`、`right`、`back`、`left`，512×512 PNG。仅 `multi_view_thumbnails: true` 且任务 `SUCCEEDED` 时出现 |
| `texture_prompt` | string | 贴图提示词 |
| `texture_image_url` | string | 贴图参考图下载链接 |
| `geometry_resolution` | string | `2k` 或 `4k`；`standard` 时没有该字段 |
| `progress` | integer | 0～100 |
| `created_at` / `started_at` / `finished_at` | integer | Unix 毫秒 |
| `expires_at` | integer | 结果过期时间，Unix 毫秒 |
| `status` | string | 见第 5 节 |
| `texture_urls` | array | 通常 1 个对象：`base_color`，`enable_pbr` 时还有 `metallic`、`normal`、`roughness`；`emission` 只在 `ai_model: meshy-6` 配默认贴图模型、`enable_pbr: true`、`2k` 或 `4k` 时出现 |
| `preceding_tasks` | integer | 排队位置，仅 `PENDING` 时有意义 |
| `task_error` | object 或 null | 失败详情 |
| `consumed_credits` | integer | 消耗积分，`FAILED` 时为 `0` |

官方字段表里还有一个已废弃的 `ultra_mode`（boolean），官方要求改读 `geometry_resolution`。多图生 3D 的任务对象也有它。

查询响应示例：

```json
{
  "id": "018a210d-8ba4-705c-b111-1f1776f7f578",
  "type": "image-to-3d",
  "model_urls": {
    "glb": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/model.glb?Expires=***",
    "fbx": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/model.fbx?Expires=***",
    "obj": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/model.obj?Expires=***",
    "usdz": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/model.usdz?Expires=***",
    "stl": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/model.stl?Expires=***",
    "pre_remeshed_glb": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/pre_remeshed_model.glb?Expires=***"
  },
  "thumbnail_url": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/preview.png?Expires=***",
  "thumbnail_urls": {
    "front": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/preview_front.png?Expires=***",
    "right": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/preview_right.png?Expires=***",
    "back": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/preview_back.png?Expires=***",
    "left": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/preview_left.png?Expires=***"
  },
  "texture_prompt": "",
  "progress": 100,
  "started_at": 1692771667037,
  "created_at": 1692771650657,
  "expires_at": 1692771679037,
  "finished_at": 1692771669037,
  "status": "SUCCEEDED",
  "texture_urls": [
    {
      "base_color": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/texture_0.png?Expires=***",
      "metallic": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/texture_0_metallic.png?Expires=XXX",
      "normal": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/texture_0_normal.png?Expires=XXX",
      "roughness": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/texture_0_roughness.png?Expires=XXX",
      "emission": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/texture_0_emission.png?Expires=XXX"
    }
  ],
  "preceding_tasks": 0,
  "task_error": null,
  "consumed_credits": 30
}
```

### 4.6 多图生 3D

`POST https://api.meshy.ai/openapi/v1/multi-image-to-3d`，`Content-Type: application/json`。

用同一物体 1～4 张不同角度的图生成模型。参数与图生 3D 基本相同，下面只列差异，其余参数
（`should_texture`、`enable_pbr`、`texture_resolution`、`texture_prompt`、`texture_image_url`、`should_remesh`、
`topology`、`decimation_mode`、`save_pre_remeshed_model`、`pose_mode`、`image_enhancement`、`remove_lighting`、
`moderation`、`target_formats`、`auto_size`、`origin_at`、`alpha_thumbnail`、`multi_view_thumbnails`）含义、默认值与 4.5 相同。

| 参数 | 类型 | 必填 | 默认 | 与图生 3D 的差异 |
| --- | --- | --- | --- | --- |
| `image_urls` | string[] | 二选一 | 无 | 1～4 张图，每张是公网 URL 或 data URI。超过 4 张返回 `400`。`meshy-7.1` / `latest` 把第 1 张当正面，其余顺序无所谓 |
| `input_task_id` | string | 二选一 | 无 | Text to Image / Image to Image 任务（含多视图任务）的 ID，用它的 1～4 张图。同时传时用 `input_task_id` |
| `ai_model` | string | 否 | `latest` | `latest`（= Meshy 7.1）、`meshy-7.1`、`meshy-6`、`meshy-6-lite`、`meshy-7`（已废弃）。**没有** `model_type`，不支持 `meshy-t2` / `meshy-t2.5` |
| `geometry_resolution` | string | 否 | `standard` | 只有 `standard` 和 `2k`。传 `4k` 返回 `400` |
| `texture_model` | string | 否 | 取决于 `ai_model` | 只有 `meshy-7` 和 `meshy-n1`。带贴图的请求传 `meshy-6` 或 `meshy-6-lite` 返回 `400`。用 `meshy-n1` 时从 `texture_image_urls` 或 `texture_image_url` 取参考图，都没传则用输入图（第 1 张为正面）；生成的模型超过 7,999,999 个三角面会让任务失败，积分退还 |
| `texture_image_urls` | string[] | 否 | 无 | 1～4 张引导贴图的多视图图片，第 1 张为正面。需要 Meshy 7 或 Meshy N1 贴图模型（`ai_model` 为 `meshy-7.1` / `latest` / `meshy-7`，或 `texture_model` 为 `meshy-7` / `meshy-n1`）。不能与 `texture_image_url`、`texture_prompt` 或 `should_texture: false` 同时传 |
| `target_polycount` | integer | 否 | `30000` | `100`～`300000`，超出返回 `400` |

`remove_lighting` 在本接口的补充：只有 Meshy 6 贴图模型使用；`8k` 时总是去光照；`meshy-n1` 传 `true` 返回 `400`；
`meshy-6-lite` 配默认贴图模型时传它返回 `400`。

请求示例：

```bash
curl https://api.meshy.ai/openapi/v1/multi-image-to-3d \
  -X POST \
  -H "Authorization: Bearer ${YOUR_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "image_urls": [
      "<your publicly accessible image url or base64-encoded data URI>",
      "<your second publicly accessible image url or base64-encoded data URI>"
    ],
    "ai_model": "meshy-7.1",
    "geometry_resolution": "2k",
    "should_texture": true,
    "enable_pbr": true,
    "target_formats": ["glb"]
  }'
```

响应（`202`）：

```json
{
  "result": "018a210d-8ba4-705c-b111-1f1776f7f578"
}
```

**任务对象**（`GET https://api.meshy.ai/openapi/v1/multi-image-to-3d/{id}`）：字段与图生 3D 相同，区别是
`type` 固定为 `multi-image-to-3d`；官方字段表列的是 `texture_image_urls`（string[]，仅创建时传了才出现），没有列 `texture_image_url`；
`geometry_resolution` 只会是 `2k`。

```json
{
  "id": "018a210d-8ba4-705c-b111-1f1776f7f578",
  "type": "multi-image-to-3d",
  "model_urls": {
    "glb": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/model.glb?Expires=***",
    "fbx": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/model.fbx?Expires=***",
    "obj": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/model.obj?Expires=***",
    "usdz": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/model.usdz?Expires=***",
    "stl": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/model.stl?Expires=***",
    "pre_remeshed_glb": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/pre_remeshed_model.glb?Expires=***"
  },
  "thumbnail_url": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/preview.png?Expires=***",
  "thumbnail_urls": {
    "front": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/preview_front.png?Expires=***",
    "right": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/preview_right.png?Expires=***",
    "back": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/preview_back.png?Expires=***",
    "left": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/preview_left.png?Expires=***"
  },
  "texture_prompt": "",
  "progress": 100,
  "started_at": 1692771667037,
  "created_at": 1692771650657,
  "expires_at": 1692771679037,
  "finished_at": 1692771669037,
  "status": "SUCCEEDED",
  "texture_urls": [
    {
      "base_color": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/texture_0.png?Expires=***",
      "metallic": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/texture_0_metallic.png?Expires=XXX",
      "normal": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/texture_0_normal.png?Expires=XXX",
      "roughness": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/texture_0_roughness.png?Expires=XXX"
    }
  ],
  "preceding_tasks": 0,
  "task_error": null,
  "consumed_credits": 30
}
```

### 4.7 重新贴图 Retexture

`POST https://api.meshy.ai/openapi/v1/retexture`，`Content-Type: application/json`。

给已有模型生成新贴图。模型来源二选一，风格输入三选一。

| 参数 | 类型 | 必填 | 默认 | 取值与约束 |
| --- | --- | --- | --- | --- |
| `input_task_id` | string | 模型来源二选一 | 无 | 产出过 3D 模型的任务 ID（Text to 3D、Image to 3D、Remesh、Retexture 等），必须是 API 创建且 `SUCCEEDED`。Meshy 对该任务的 GLB 贴图 |
| `model_url` | string | 模型来源二选一 | 无 | 公网 URL 或 data URI（MIME 用 `application/octet-stream`）。限制见第 6 节。同时传时用 `input_task_id` |
| `text_style_prompt` | string | 风格三选一 | 无 | 最多 800 字符。`meshy-n1` 下不带 `image_style_url` 单独传它返回 `400` |
| `image_style_url` | string | 风格三选一 | 无 | 风格参考图，URL 或 data URI。与 `text_style_prompt` 同时传时用 **`image_style_url`**（注意与图生 3D 的优先级相反）。`meshy-n1` 把它当正面视图 |
| `multiview_image_urls` | string[] | 风格三选一 | 无 | 1～4 张同一物体的多视图，第 1 张为正面。空数组或超过 4 张返回 `400`。不能与另外两种风格输入同时传。必须**显式**传 `ai_model` 为 `meshy-7` 或 `meshy-n1`，默认的 `latest` 也会返回 `400` |
| `ai_model` | string | 否 | `latest` | 贴图模型：`meshy-6-lite`、`meshy-6`、`meshy-7`、`meshy-n1`、`latest`（= Meshy 7）。不接受 `meshy-7.1` |
| `enable_original_uv` | boolean | 否 | `false` | `true` 保留模型原有 UV；`false` 由 Meshy 重新生成 UV |
| `enable_pbr` | boolean | 否 | `false` | 生成 metallic、roughness、normal。`meshy-6` 还有 emission（`8k` 除外）。`meshy-n1` 传 `true` 返回 `400` |
| `texture_resolution` | string | 否 | `2k` | `2k`、`4k`、`8k`。`4k` / `8k` 需要 `meshy-6`、`meshy-7` 或 `latest`；`meshy-6-lite`、`meshy-n1` 返回 `400` |
| `remove_lighting` | boolean | 否 | `true` | 只有 `meshy-6` 在 `2k` / `4k` 生效；`meshy-7` / `latest` 或 `8k` 接受但忽略；`meshy-6-lite`、`meshy-n1` 传任何值都返回 `400` |
| `target_formats` | string[] | 否 | 除 `3mf` 外全部 | `glb`、`obj`、`fbx`、`stl`、`usdz`、`3mf` |
| `alpha_thumbnail` | boolean | 否 | `false` | 透明背景预览图 |

`meshy-n1` 的模型面数上限为 7,999,999 个三角面（四边面算 2 个）。已废弃：`hd_texture`
（`true` 等于 `texture_resolution: "4k"`，两个都传时用 `texture_resolution`）。
OpenAPI 规范里还有 `art_style`（`realistic` / `cartoon`，默认 `realistic`）和已废弃的 `name`，文档页没有说明。

该接口额外的 `400` 情况：模型来源都没传；三种风格输入都没传；`multiview_image_urls` 与其他风格输入冲突；
模型文件扩展名不支持；URL 下载失败；模型或图片超过大小限制。`403` 还包括 `input_task_id` 是浮雕模型。

官方 `400` 清单里还有这些情况：

- `input_task_id` 不是受支持类型的成功任务。
- 传了 `multiview_image_urls`，却没有显式把 `ai_model` 设为 `meshy-7` 或 `meshy-n1`。
- `meshy-n1` 配了它不支持的选项：`enable_pbr: true`、`remove_lighting`（任何值）、`texture_resolution` 为 `4k` / `8k`、
  不带 `texture_resolution` 的 `hd_texture: true`、不带 `image_style_url` 的 `text_style_prompt`。
- `meshy-n1` 下模型超过 7,999,999 个三角面；`model_url` 文件太复杂、数不出三角面；数三角面超时（官方说可以重试，或缩小模型）。
- 超过 100 MB 的 `model_url` 文件：超过 10,000,000 个面、是 ASCII FBX、文件头读不出来（如 Draco 压缩的 GLB / glTF、早于 7.1 的二进制 FBX）、
  文件头里的网格 / 节点 / 记录太多。

`meshy-n1` 下，任务开始前检查不了的模型（官方举的例子是 STL）不会在创建时被拒绝；如果它超过 7,999,999 个三角面，
任务会失败，积分退还。

请求示例：

```bash
curl https://api.meshy.ai/openapi/v1/retexture \
  -H "Authorization: Bearer ${YOUR_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "model_url": "https://cdn.meshy.ai/model/example_model_2.glb",
    "text_style_prompt": "red fangs, Samurai outfit that fused with japanese batik style",
    "enable_original_uv": true,
    "enable_pbr": true
  }'
```

响应（`202`）：

```json
{
  "result": "018a210d-8ba4-705c-b111-1f1776f7f578"
}
```

**任务对象**（`GET https://api.meshy.ai/openapi/v1/retexture/{id}`）：`type` 固定 `retexture`；`model_urls`
键为 `glb`、`fbx`、`obj`、`usdz`、`mtl`、`stl`、`3mf`；回显 `text_style_prompt`、`image_style_url`、
`multiview_image_urls`；其余 `thumbnail_url`、`alpha_thumbnail_url`、`progress`、时间戳、`expires_at`、`status`、
`texture_urls`、`task_error`、`consumed_credits` 与图生 3D 相同。`preceding_tasks` 只在 `PENDING` 时出现，值为 `0` 时省略。

注意：下面这个官方查询响应示例里出现了 `"texture_image_url": ""`，而官方字段表里没有这个字段（字段表列的是 `image_style_url`）。
适配器读取风格图回显时用 `image_style_url`，并容忍响应里多出 `texture_image_url`。

```json
{
  "id": "018a210d-8ba4-705c-b111-1f1776f7f578",
  "type": "retexture",
  "model_urls": {
    "glb": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/model.glb?Expires=***",
    "fbx": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/model.fbx?Expires=***",
    "obj": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/model.obj?Expires=***",
    "usdz": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/model.usdz?Expires=***",
    "mtl": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/model.mtl?Expires=***",
    "stl": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/model.stl?Expires=***"
  },
  "thumbnail_url": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/preview.png?Expires=***",
  "text_style_prompt": "red fangs, Samurai outfit that fused with japanese batik style",
  "texture_image_url": "",
  "progress": 100,
  "started_at": 1692771667037,
  "created_at": 1692771650657,
  "expires_at": 1692771679037,
  "finished_at": 1692771669037,
  "status": "SUCCEEDED",
  "texture_urls": [
    {
      "base_color": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/texture_0.png?Expires=***",
      "metallic": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/texture_0_metallic.png?Expires=XXX",
      "normal": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/texture_0_normal.png?Expires=XXX",
      "roughness": "https://assets.meshy.ai/***/tasks/018a210d-8ba4-705c-b111-1f1776f7f578/output/texture_0_roughness.png?Expires=XXX"
    }
  ],
  "task_error": null,
  "consumed_credits": 10
}
```

### 4.8 重拓扑 Remesh

`POST https://api.meshy.ai/openapi/v1/remesh`，`Content-Type: application/json`。

用新的拓扑和面数重建网格，并按指定格式导出。

| 参数 | 类型 | 必填 | 默认 | 取值与约束 |
| --- | --- | --- | --- | --- |
| `input_task_id` | string | 二选一 | 无 | 要重拓扑的任务 ID（Text to 3D、Image to 3D、Retexture、Remesh 等），API 创建且 `SUCCEEDED` |
| `model_url` | string | 二选一 | 无 | 公网 URL 或 data URI（MIME 用 `application/octet-stream`）。限制见第 6 节。同时传时用 `input_task_id` |
| `target_formats` | string[] | 否 | `["glb"]` | `glb`、`fbx`、`obj`、`usdz`、`blend`、`stl`、`3mf` |
| `topology` | string | 否 | `triangle` | `quad` 或 `triangle` |
| `target_polycount` | integer | 否 | `30000` | `100`～`300000`，超出返回 `400` |
| `decimation_mode` | integer | 否 | 无 | `1` ultra、`2` high、`3` medium、`4` low。设置后忽略 `target_polycount` |
| `alpha_thumbnail` | boolean | 否 | `false` | 透明背景预览图 |

已废弃但仍可用（新接入请改用 Convert / Resize 接口）：`resize_height`、`resize_longest_side`、`auto_size`
（三者最多传一个）、`origin_at`、`convert_format_only`。

该接口额外的 `400` 情况：`input_task_id` 不是成功的 API 任务，或其 AI 模型不支持重拓扑；`topology` 非法；同时传了 `resize_height`、`resize_longest_side`、`auto_size` 中的多个；模型文件问题同第 6 节。

请求示例：

```bash
curl https://api.meshy.ai/openapi/v1/remesh \
  -X POST \
  -H "Authorization: Bearer ${YOUR_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
      "input_task_id": "018a210d-8ba4-705c-b111-1f1776f7f578",
      "target_formats": ["glb", "fbx"],
      "topology": "quad",
      "target_polycount": 50000
    }'
```

（官方示例里还带了已废弃的 `resize_height` 和 `origin_at`，这里去掉了。）

响应（`202`）：

```json
{
  "result": "0193bfc5-ee4f-73f8-8525-44b398884ce9"
}
```

**任务对象**（`GET https://api.meshy.ai/openapi/v1/remesh/{id}`）：`type` 固定 `remesh`；`model_urls` 键为
`glb`、`fbx`、`obj`、`usdz`、`blend`、`stl`、`3mf`；还有 `thumbnail_url`、`alpha_thumbnail_url`、`progress`、`status`、
`preceding_tasks`、`created_at`、`started_at`、`finished_at`、`expires_at`（结束前为 `0`）、`texture_urls`
（成功前为 `null`，模型没有贴图时为空数组；对象里可能还有 `metallic_roughness`）、`task_error`、`consumed_credits`。

```json
{
  "id": "0193bfc5-ee4f-73f8-8525-44b398884ce9",
  "type": "remesh",
  "model_urls": {
      "glb": "https://assets.meshy.ai/***/tasks/0193bfc5-ee4f-73f8-8525-44b398884ce9/output/model.glb?Expires=***",
      "fbx": "https://assets.meshy.ai/***/tasks/0193bfc5-ee4f-73f8-8525-44b398884ce9/output/model.fbx?Expires=***",
      "obj": "https://assets.meshy.ai/***/tasks/0193bfc5-ee4f-73f8-8525-44b398884ce9/output/model.obj?Expires=***",
      "usdz": "https://assets.meshy.ai/***/tasks/0193bfc5-ee4f-73f8-8525-44b398884ce9/output/model.usdz?Expires=***",
      "blend": "https://assets.meshy.ai/***/tasks/0193bfc5-ee4f-73f8-8525-44b398884ce9/output/model.blend?Expires=***",
      "stl": "https://assets.meshy.ai/***/tasks/0193bfc5-ee4f-73f8-8525-44b398884ce9/output/model.stl?Expires=***"
  },
  "progress": 100,
  "status": "SUCCEEDED",
  "created_at": 1699999999000,
  "started_at": 1700000000000,
  "finished_at": 1700000001000,
  "task_error": null
}
```

注意：Remesh 和 UV Unwrap 页面的另一份“任务对象示例”里，成功任务的 `task_error` 写成 `{"message": ""}` 而不是 `null`。
适配器判断失败应该看 `status`，不要靠 `task_error` 是否为 `null`。

### 4.9 格式转换 Convert

`POST https://api.meshy.ai/openapi/v1/convert`，`Content-Type: application/json`。

| 参数 | 类型 | 必填 | 默认 | 取值与约束 |
| --- | --- | --- | --- | --- |
| `input_task_id` | string | 二选一 | 无 | 产出过 3D 模型的任务 ID（Text to 3D、Image to 3D、Remesh、Resize、Retexture 等），API 创建且 `SUCCEEDED` |
| `model_url` | string | 二选一 | 无 | 公网 URL 或 data URI。限制见第 6 节。同时传时用 `input_task_id` |
| `target_formats` | string[] | 是 | 无 | 至少一个：`glb`、`fbx`、`obj`、`usdz`、`blend`、`stl`、`3mf`。缺失或为空返回 `400` |

请求示例：

```bash
curl https://api.meshy.ai/openapi/v1/convert \
  -X POST \
  -H "Authorization: Bearer ${YOUR_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "input_task_id": "018a210d-8ba4-705c-b111-1f1776f7f578",
    "target_formats": ["fbx", "stl"]
  }'
```

响应（`202`）：

```json
{
  "result": "0193bfc5-ee4f-73f8-8525-44b398884ce9"
}
```

**任务对象**（`GET https://api.meshy.ai/openapi/v1/convert/{id}`）：`type` 固定 `convert`；`model_urls` 只有请求的格式；
其余字段同 Remesh（官方的 Convert 任务对象没有列出缩略图字段）。

```json
{
  "id": "0193bfc5-ee4f-73f8-8525-44b398884ce9",
  "type": "convert",
  "model_urls": {
      "fbx": "https://assets.meshy.ai/.../model.fbx?Expires=...",
      "stl": "https://assets.meshy.ai/.../model.stl?Expires=..."
  },
  "progress": 100,
  "status": "SUCCEEDED",
  "created_at": 1699999999000,
  "started_at": 1700000000000,
  "finished_at": 1700000001000,
  "task_error": null,
  "consumed_credits": 1
}
```

### 4.10 缩放 Resize

`POST https://api.meshy.ai/openapi/v1/resize`，`Content-Type: application/json`。

把模型缩放到真实尺寸（单位：米）。

| 参数 | 类型 | 必填 | 默认 | 取值与约束 |
| --- | --- | --- | --- | --- |
| `input_task_id` | string | 二选一 | 无 | 产出过 3D 模型的任务 ID。结果总是 GLB |
| `model_url` | string | 二选一 | 无 | 公网 URL 或 data URI。GLB、OBJ、FBX、STL 保持原格式；`.gltf` 或 data URI 返回 GLB |
| `resize_height` | number | 三选一 | 无 | 新高度（米），大于 0，负数返回 `400` |
| `resize_longest_side` | number | 三选一 | 无 | 最长边新长度（米），大于 0，保持比例 |
| `auto_size` | boolean | 三选一 | 无 | 用 AI 视觉估计真实高度 |
| `origin_at` | string | 否 | `bottom` | `bottom` 或 `center` |

`resize_height`、`resize_longest_side`、`auto_size` 必须**恰好传一个**，都不传或传多个返回 `400`。

请求示例：

```bash
curl https://api.meshy.ai/openapi/v1/resize \
  -X POST \
  -H "Authorization: Bearer ${YOUR_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "input_task_id": "018a210d-8ba4-705c-b111-1f1776f7f578",
    "resize_height": 1.8
  }'
```

响应（`202`）：

```json
{
  "result": "0193bfc5-ee4f-73f8-8525-44b398884ce9"
}
```

**任务对象**（`GET https://api.meshy.ai/openapi/v1/resize/{id}`）：`type` 固定 `resize`，其余同 Convert。

```json
{
  "id": "0193bfc5-ee4f-73f8-8525-44b398884ce9",
  "type": "resize",
  "model_urls": {
      "glb": "https://assets.meshy.ai/.../model.glb?Expires=..."
  },
  "progress": 100,
  "status": "SUCCEEDED",
  "created_at": 1699999999000,
  "started_at": 1700000000000,
  "finished_at": 1700000001000,
  "task_error": null,
  "consumed_credits": 1
}
```

### 4.11 UV 展开 UV Unwrap

`POST https://api.meshy.ai/openapi/v1/uv-unwrap`，`Content-Type: application/json`。

为已有模型生成干净、不重叠的 UV。输出是“UV 白模”：形状不变、UV 全新、没有真实贴图（带一个 2×2 灰色占位材质），
并且总是三角网格。

| 参数 | 类型 | 必填 | 默认 | 取值与约束 |
| --- | --- | --- | --- | --- |
| `input_task_id` | string | 二选一 | 无 | 产出过 GLB 的 API 任务 ID，`SUCCEEDED` |
| `model_url` | string | 二选一 | 无 | 只接受 `.glb`，公网 URL 或 data URI。其他格式先用 Convert 转成 GLB |

网格最多 **40,000 个面**，超过返回 `400`，需要先 Remesh 减面。

请求示例：

```bash
curl https://api.meshy.ai/openapi/v1/uv-unwrap \
  -X POST \
  -H "Authorization: Bearer ${YOUR_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
        "input_task_id": "0193bfc5-ee4f-73f8-8525-44b398884ce9"
      }'
```

响应（`202`）：

```json
{
  "result": "019361c6-9b34-7b23-bef2-d0107c4d92e2"
}
```

**任务对象**（`GET https://api.meshy.ai/openapi/v1/uv-unwrap/{id}`）：`type` 固定 `uv-unwrap`，`model_urls` 只有 `glb` 一个键。

```json
{
  "id": "019361c6-9b34-7b23-bef2-d0107c4d92e2",
  "type": "uv-unwrap",
  "model_urls": {
    "glb": "https://assets.meshy.ai/***/tasks/019361c6-9b34-7b23-bef2-d0107c4d92e2/output/model.glb?Expires=***"
  },
  "thumbnail_url": "https://assets.meshy.ai/***/tasks/019361c6-9b34-7b23-bef2-d0107c4d92e2/output/preview.png?Expires=***",
  "progress": 100,
  "status": "SUCCEEDED",
  "preceding_tasks": 0,
  "created_at": 1716579120000,
  "started_at": 1716579122000,
  "finished_at": 1716579180000,
  "expires_at": 1716665580000,
  "task_error": {
    "message": ""
  },
  "consumed_credits": 5
}
```

### 4.12 绑骨 Rigging

`POST https://api.meshy.ai/openapi/v1/rigging`，`Content-Type: application/json`。

给人形（双足）角色加骨架并蒙皮。不适用于：没有贴图的网格、非人形资产、肢体结构不清晰的人形。

| 参数 | 类型 | 必填 | 默认 | 取值与约束 |
| --- | --- | --- | --- | --- |
| `input_task_id` | string | 二选一 | 无 | 要绑骨的任务 ID，需是带贴图的人形模型 |
| `model_url` | string | 二选一 | 无 | 只接受 `.glb`，公网 URL（≤400 MB）或 data URI（≤100 MB）。角色面朝 **+Z 轴**。同时传时用 `input_task_id` |
| `height_meters` | number | 否 | `1.7` | 角色大致身高（米），负数返回 `400` |
| `skeleton_template` | string | 否 | `meshyrig` | `meshyrig`、`mixamo`、`ue5_mannequin`、`max_biped`、`unity_humanoid`、`maya_human_ik`、`blender_rigify_basic_human`、`cc5_hd_neutral_base`、`daz_genesis9`。其他值返回 `400`。只用于双足 |
| `include_fingers` | boolean | 否 | `false` | 是否加手指骨骼。只用于双足。不影响积分 |

模型最多 **380,000 个三角面**（四边面算 2 个），超过返回 `400`。官方建议先 Remesh：`target_polycount` ≤ `300000`，
或 `topology: quad` 时 ≤ `150000`。

`skeleton_template` 不是 `meshyrig`，或 `include_fingers: true` 时，输出文件单位是米并使用所选骨架的骨骼名；
默认 `meshyrig` 是 24 根骨骼、单位厘米。之后基于这个 rig 的 Animation 任务沿用同一套骨架。
这类文件里的动画 clip 名为 `retarget_clip`，FBX 带末端骨骼（end bones）。Meshy 无法在所选骨架上绑定的模型会让**任务失败**，
官方建议改用 `meshyrig` 加 `include_fingers: false` 重试，或换一个骨架。`include_fingers: true` 而手部无法带手指绑定时任务同样会失败。
`meshyrig` 下手指骨骼用 Mixamo 的命名（如 `LeftHandThumb1`）。

已废弃：`texture_image_url`（PNG，≤20 MB；传了以后它会成为模型唯一贴图，PBR 贴图丢失）。

该接口特有的失败响应：

| 状态码 | 含义 |
| --- | --- |
| `400` | 面数超限；`model_url` 和 `input_task_id` 都没传；`model_url` 不是 `.glb`、下载不到或超过大小限制；`height_meters` 为负；`skeleton_template` 非法或用于四足；`include_fingers: true` 配四足 rig、`texture_image_url` 或四边面拓扑的 `input_task_id`；`input_task_id` 不是有效的 API 任务，或该任务还没 `SUCCEEDED`；`texture_image_url` 不是 PNG 或超过 20 MB |
| `403` | `input_task_id` 是浮雕模型（消息为 `This model type does not support this operation`） |
| `404` | 找不到 `input_task_id` 任务的文件：已过 `expires_at` 被删，或该任务缺少绑骨需要的文件（例如 Convert 任务没有预览图） |
| `422` | 姿态估计失败（可能不是人形，或没面朝 +Z）；该模型只能用 `meshyrig` 骨架；该模型只能用 `meshyrig` 且不带手指。后两种不扣积分 |
| `503` | 没能完成姿态分析，重试该请求 |

请求示例：

```bash
curl https://api.meshy.ai/openapi/v1/rigging \
  -X POST \
  -H "Authorization: Bearer ${YOUR_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "model_url": "YOUR_MODEL_URL_OR_DATA_URI",
    "height_meters": 1.8
  }'
```

响应（`202`）：

```json
{
  "result": "018b314a-a1b5-716d-c222-2f1776f7f579"
}
```

**任务对象**（`GET https://api.meshy.ai/openapi/v1/rigging/{id}`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 任务 ID |
| `type` | string | 固定 `rig` |
| `status` / `progress` | string / integer | 见第 5 节 |
| `created_at` / `started_at` / `finished_at` / `expires_at` | integer | Unix 毫秒 |
| `task_error` | object 或 null | 失败详情 |
| `consumed_credits` | integer | 消耗积分 |
| `result.rigged_character_fbx_url` | string | 绑好骨的角色 FBX。成功前为空字符串 |
| `result.rigged_character_glb_url` | string | 绑好骨的角色 GLB。成功前为空字符串 |
| `result.basic_animations` | object 或 null | 默认的走、跑动画：`walking_glb_url`、`walking_fbx_url`、`walking_armature_glb_url`、`running_glb_url`、`running_fbx_url`、`running_armature_glb_url`。成功前为 `null` |
| `preceding_tasks` | integer | 排队位置，仅 `PENDING` 时有意义；值为 `0` 时该字段被省略 |

注意：绑骨和动画任务的输出在 `result` 对象里，**不是** `model_urls`。

```json
{
  "id": "018b314a-a1b5-716d-c222-2f1776f7f579",
  "type": "rig",
  "status": "SUCCEEDED",
  "created_at": 1747032400453,
  "progress": 100,
  "started_at": 1747032401314,
  "finished_at": 1747032418417,
  "expires_at": 1747291618417,
  "task_error": null,
  "consumed_credits": 5,
  "result": {
    "rigged_character_fbx_url": "https://assets.meshy.ai/0630d47c-84b8-4d37-bc02-69e45d9272c1/tasks/018b314a-a1b5-716d-c222-2f1776f7f579/output/Character_output.fbx?Expires=...",
    "rigged_character_glb_url": "https://assets.meshy.ai/0630d47c-84b8-4d37-bc02-69e45d9272c1/tasks/018b314a-a1b5-716d-c222-2f1776f7f579/output/Character_output.glb?Expires=...",
    "basic_animations": {
      "walking_glb_url": "https://assets.meshy.ai/0630d47c-84b8-4d37-bc02-69e45d9272c1/tasks/018b314a-a1b5-716d-c222-2f1776f7f579/output/Animation_Walking_withSkin.glb?Expires=...",
      "walking_fbx_url": "https://assets.meshy.ai/0630d47c-84b8-4d37-bc02-69e45d9272c1/tasks/018b314a-a1b5-716d-c222-2f1776f7f579/output/Animation_Walking_withSkin.fbx?Expires=...",
      "walking_armature_glb_url": "https://assets.meshy.ai/0630d47c-84b8-4d37-bc02-69e45d9272c1/tasks/018b314a-a1b5-716d-c222-2f1776f7f579/output/Animation_Walking_withSkin_armature.glb?Expires=...",
      "running_glb_url": "https://assets.meshy.ai/0630d47c-84b8-4d37-bc02-69e45d9272c1/tasks/018b314a-a1b5-716d-c222-2f1776f7f579/output/Animation_Running_withSkin.glb?Expires=...",
      "running_fbx_url": "https://assets.meshy.ai/0630d47c-84b8-4d37-bc02-69e45d9272c1/tasks/018b314a-a1b5-716d-c222-2f1776f7f579/output/Animation_Running_withSkin.fbx?Expires=...",
      "running_armature_glb_url": "https://assets.meshy.ai/0630d47c-84b8-4d37-bc02-69e45d9272c1/tasks/018b314a-a1b5-716d-c222-2f1776f7f579/output/Animation_Running_withSkin_armature.glb?Expires=..."
    }
  }
}
```

### 4.13 动画 Animation

`POST https://api.meshy.ai/openapi/v1/animations`，`Content-Type: application/json`。

给已经绑骨的角色套用动作。

| 参数 | 类型 | 必填 | 默认 | 取值与约束 |
| --- | --- | --- | --- | --- |
| `rig_task_id` | string | 是 | 无 | 状态为 `SUCCEEDED` 的 Rigging 任务 ID |
| `action_id` | integer | 三选一 | 无 | 动作库里的预设动作 ID（见 4.14） |
| `action_ids` | integer[] | 三选一 | 无 | 1～10 个预设动作 ID，不能重复。超过 10 个或重复返回 `400`。返回一个文件，每个动作一个 clip，顺序与数组一致。按动作数计费 |
| `motion_task_id` | string | 三选一 | 无 | 状态为 `SUCCEEDED` 的 Text to Motion 任务 ID。rig 必须是双足。Meshy 只保留该 clip 3 天 |
| `post_process` | object | 否 | 无 | 后处理，见下 |
| `post_process.operation_type` | string | 否 | 无 | `change_fps`（改帧率）、`fbx2usdz`（转 USDZ）、`extract_armature`（导出骨架 FBX）。其他值返回 `400` |
| `post_process.fps` | integer | 否 | `30` | `24`、`25`、`30`、`60`。只在 `change_fps` 时有效，其他值返回 `400` |

`action_id`、`action_ids`、`motion_task_id` 必须**恰好传一个**。

用 `motion_task_id` 时重定向可能只产出 GLB：如果同时传了 `post_process` 而没有 FBX，任务会失败并退积分；
不传 `post_process` 则任务成功，`animation_fbx_url` 为空。

该接口特有的失败响应：

| 状态码 | 含义 |
| --- | --- |
| `400` | 缺 `rig_task_id`；三种动作来源都没传，或传了多个；`rig_task_id` 不是成功的 Rigging 任务；`action_id` 或 `action_ids` 里有无效的动作 ID；`action_ids` 超过 10 个或有重复；`motion_task_id` 的任务还没 `SUCCEEDED`；`motion_task_id` 配四足 rig |
| `403` | `rig_task_id` 的任务是浮雕模型（消息为 `This model type does not support this operation`） |
| `404` | 找不到 `rig_task_id` 任务，或它的文件已过 `expires_at` 被删（需要重新绑骨）；找不到 `motion_task_id` 任务，或动作 clip 已过 3 天保留期 |

请求示例：

```bash
curl https://api.meshy.ai/openapi/v1/animations \
  -X POST \
  -H "Authorization: Bearer ${YOUR_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "rig_task_id": "018b314a-a1b5-716d-c222-2f1776f7f579",
    "action_id": 92,
    "post_process": {
      "operation_type": "change_fps",
      "fps": 24
    }
  }'
```

响应（`202`）：

```json
{
  "result": "018c425b-b2c6-727e-d333-3c1887i9h791"
}
```

**任务对象**（`GET https://api.meshy.ai/openapi/v1/animations/{id}`）：`type` 固定 `animate`；公共字段同 Rigging；
`result` 里有 `animation_glb_url`、`animation_fbx_url`、`processed_usdz_url`、`processed_armature_fbx_url`、
`processed_animation_fps_fbx_url`。`preceding_tasks` 值为 `0` 时省略。

```json
{
  "id": "018c425b-b2c6-727e-d333-3c1887i9h791",
  "type": "animate",
  "status": "SUCCEEDED",
  "created_at": 1747032440896,
  "progress": 100,
  "started_at": 1747032441210,
  "finished_at": 1747032457530,
  "expires_at": 1747291657530,
  "task_error": null,
  "consumed_credits": 3,
  "result": {
    "animation_glb_url": "https://assets.meshy.ai/0630d47c-84b8-4d37-bc02-69e45d9272c1/tasks/018c425b-b2c6-727e-d333-3c1887i9h791/output/Animation_Reaping_Swing_withSkin.glb?Expires=...",
    "animation_fbx_url": "https://assets.meshy.ai/0630d47c-84b8-4d37-bc02-69e45d9272c1/tasks/018c425b-b2c6-727e-d333-3c1887i9h791/output/Animation_Reaping_Swing_withSkin.fbx?Expires=...",
    "processed_usdz_url": "https://assets.meshy.ai/0630d47c-84b8-4d37-bc02-69e45d9272c1/tasks/018c425b-b2c6-727e-d333-3c1887i9h791/output/processed.usdz?Expires=...",
    "processed_armature_fbx_url": "https://assets.meshy.ai/0630d47c-84b8-4d37-bc02-69e45d9272c1/tasks/018c425b-b2c6-727e-d333-3c1887i9h791/output/processed_armature.fbx?Expires=...",
    "processed_animation_fps_fbx_url": "https://assets.meshy.ai/0630d47c-84b8-4d37-bc02-69e45d9272c1/tasks/018c425b-b2c6-727e-d333-3c1887i9h791/output/processed_60fps.fbx?Expires=..."
  }
}
```

### 4.14 动作库

`GET https://api.meshy.ai/openapi/v1/animations/library`，不消耗积分。一次返回完整列表（不分页），按 `action_id` 排序。

| 参数（query） | 类型 | 说明 |
| --- | --- | --- |
| `search` | string | 对 `name` 或 `key` 做不区分大小写的子串匹配，`%`、`_` 不是通配符 |
| `category` | string | 精确匹配：`WalkAndRun`、`BodyMovements`、`DailyActions`、`Fighting`、`Dancing`。未知分类返回空数组 |
| `sub_category` | string | 精确匹配子分类，可单独传。子分类名在不同分类间不唯一 |
| `action_ids` | string | 逗号分隔的 `action_id`，最多 200 个，超过返回 `400`。不存在的 ID 不会出现在结果里 |

多个过滤条件是“且”的关系，没有交集时返回 `[]` 而不是报错。

响应示例：

```json
[
  {
    "action_id": 4,
    "name": "Attack",
    "key": "Attack",
    "category": "Fighting",
    "sub_category": "AttackingwithWeapon",
    "preview_url": "https://cdn.meshy.ai/webapp-assets/feature-demo/animation/preview/biped/Attack.gif"
  },
  {
    "action_id": 92,
    "name": "Double Combo Attack",
    "key": "Double_Combo_Attack",
    "category": "Fighting",
    "sub_category": "AttackingwithWeapon",
    "preview_url": "https://cdn.meshy.ai/webapp-assets/feature-demo/animation/preview/biped/Double_Combo_Attack.gif"
  }
]
```

`action_id` 唯一且稳定，但不连续（下线的动作会留空号）；`name` 不唯一；`key` 是唯一稳定的字符串标识；
`preview_url` 是动图预览。

### 4.15 文生动作 Text to Motion

`POST https://api.meshy.ai/openapi/v1/text-to-motion`，`Content-Type: application/json`。

从文字生成一段独立的动作 clip（不绑定任何角色）。要套到角色上，把任务 ID 作为 `motion_task_id` 传给 Animation。
该接口不在 OpenAPI 规范里，只有文档页；官方 MCP server 源码里用的也是 `/openapi/v1/text-to-motion` 这个路径。

| 参数 | 类型 | 必填 | 默认 | 取值与约束 |
| --- | --- | --- | --- | --- |
| `prompt` | string | 是 | 无 | 最多 400 字符，缺失、空白或超长返回 `400` |
| `mode` | string | 否 | `prime` | `prime`（质量高，输出 FBX）、`swift`（更快更便宜，输出 BVH）。其他值返回 `400` |
| `duration` | number | 是 | 无 | 目标时长（秒），`2`～`10`，步长 `0.5`。其他值返回 `400` |

该接口的失败响应：`400`（见上表）、`401`、`402`、`403`（内容审核拦截了提示词）、`429`。

请求示例：

```bash
curl https://api.meshy.ai/openapi/v1/text-to-motion \
  -X POST \
  -H "Authorization: Bearer ${YOUR_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "a character waving",
    "mode": "swift",
    "duration": 4.5
  }'
```

响应（`202`）：

```json
{
  "result": "018c425b-b2c6-727e-d333-3c1887i9h791"
}
```

**任务对象**（`GET https://api.meshy.ai/openapi/v1/text-to-motion/{id}`）：`type` 固定 `text-to-motion`；
`result` 里有 `motion_url`（每次读取都会重新签名）、`motion_format`（`fbx` 或 `bvh`）、`duration_ms`、`mode`。
成功前 `result` 的字段存在但为空（`""` 或 `0`）。`expires_at` 结束前为 `0`。

```json
{
  "id": "018c425b-b2c6-727e-d333-3c1887i9h791",
  "type": "text-to-motion",
  "status": "SUCCEEDED",
  "progress": 100,
  "created_at": 1787314497437,
  "started_at": 1787314498012,
  "finished_at": 1787314505881,
  "expires_at": 1787573705881,
  "task_error": null,
  "result": {
    "motion_url": "https://assets.meshy.ai/.../output/clip.fbx?Expires=...",
    "motion_format": "fbx",
    "duration_ms": 3000,
    "mode": "prime"
  },
  "consumed_credits": 10
}
```

### 4.16 余额 Balance

`GET https://api.meshy.ai/openapi/v1/balance`，免费。返回 Key 所属账户的积分；团队共享积分池时返回池子的值。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `balance` | integer | 可用积分，通常等于 `monthly_credits` + `permanent_credits`；受成员额度或 Enterprise 工作区额度限制时会更低 |
| `monthly_credits` | integer | 在下次月度刷新（`monthly_resets_at`）时过期的剩余积分 |
| `permanent_credits` | integer | 不过期的积分（购买的积分包、奖励等） |
| `monthly_resets_at` | integer 或 null | 下次月度刷新时间，Unix 毫秒；没有计划刷新时为 `null` |

失败：`401`、`429`。

```bash
curl https://api.meshy.ai/openapi/v1/balance \
  -H "Authorization: Bearer ${YOUR_API_KEY}"
```

```json
{
  "balance": 1000,
  "monthly_credits": 600,
  "permanent_credits": 400,
  "monthly_resets_at": 1793491200000
}
```

### 4.17 Webhook

Webhook 不是按任务传参，而是在控制台登记：`https://www.meshy.ai/developers/webhooks`。
文档和 OpenAPI 规范的创建接口里都没有回调地址参数。

- 回调地址必须是公网 `https://`。每个账户最多 5 个启用中的 webhook，总共 10 个。
- **每个启用的 webhook 都会收到账户下所有 API 任务的状态更新**，不能按任务筛选。
- 任务 `IN_PROGRESS` 时推送一次，到终态再推送一次；任务也可能没有 `IN_PROGRESS` 推送就直接到终态。

每次推送是 `POST`，带这些请求头：

| 请求头 | 值 |
| --- | --- |
| `X-MESHY-API-WEBHOOK-SECRET-KEY` | 该 webhook 的密钥（创建时生成，在控制台可见） |
| `X-MESHY-API-WEBHOOK-USER-ID` | webhook 所属 Meshy 用户的 ID |
| `Meshy-Webhook-Version` | `v1` |
| `Content-Type` | `application/json` |
| `User-Agent` | `MeshyAPIWebhook/1.0.0` |

请求体就是任务对象，与对应 `GET` 接口返回的一样，**只有 `progress` 不同**：`IN_PROGRESS` 时固定 `50`，
成功时 `100`，失败或取消时 `0`。

接收方要求：

- 返回小于 400 的状态码（如 `200`、`202`）表示接收成功。Meshy 等待响应约 25 秒，所以先落库、先响应，再做下载等慢操作。
- 返回 ≥400 或无响应算失败，Meshy 会以递增间隔重试：`IN_PROGRESS` 更新最多 4 次，终态最多 9 次。
  连续 20 个更新全部失败后，webhook 可能被停用，需要在控制台重新启用。
- 推送可能乱序：`IN_PROGRESS` 可能晚于终态到达，不要让它覆盖终态。
- 同一更新可能重复推送：按 `id` + `status` 去重。
- 校验来源的方式是把 `X-MESHY-API-WEBHOOK-SECRET-KEY` 与自己保存的密钥做比较，不匹配就拒绝（不是 HMAC 签名）。
- 终态推送在约两倍典型耗时后还没到，就主动 `GET` 任务。

### 4.18 用量 Usage

`GET https://api.meshy.ai/openapi/v1/usage/tasks`，免费。**只有 Studio / Enterprise 团队成员的 Key 可用**，
其他 Key 返回 `403`（消息 `This endpoint is available on Studio and Enterprise plans`）。

返回团队已结束（`SUCCEEDED` 或 `FAILED`）的 API 任务及其积分消耗，默认最近 30 天、新的在前。
不包含 `PENDING` / `IN_PROGRESS` / `CANCELED` 任务和 Creative Lab 任务，
也不包含已离开团队的成员的任务、Meshy AI agent 跑的任务和网页端的操作；已删除的任务和文件已过期的任务仍然包含。
任务结束后才会出现在记录里（按它的 `created_at` 归入时间窗口），而积分在创建时就扣了，所以对账前要留出延迟。
团队设置了数据保留期时，时间窗口的起点不会早于保留期允许的范围。

| 参数（query） | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `page_num` | integer | `1` | `1`～`255`，更大返回 `400`。一个时间窗口最多 255 页，导出量大时要拆成更短的窗口 |
| `page_size` | integer | `10` | `1`～`100`；`101`～`255` 返回 100 条；更大返回 `400` |
| `sort_by` | string | `-created_at` | `+created_at` 或 `-created_at`（URL 里 `+` 写成 `%2B`） |
| `start_time` | string | `end_time` 前 30 天 | RFC 3339 时间戳（如 `2026-08-01T00:00:00Z`），包含在该时刻及之后创建的任务。窗口最长 366 天，更长返回 `400` |
| `end_time` | string | 请求时刻 | RFC 3339 时间戳，只包含在该时刻之前创建的任务 |
| `endpoints` | string | 全部 | 逗号分隔：`text-to-3d`、`text-to-3d-preview`、`text-to-3d-refine`、`image-to-3d`、`multi-image-to-3d`、`retexture`、`remesh`、`convert`、`resize`、`uv-unwrap`、`rig`、`animate`、`text-to-motion`、`text-to-image`、`image-to-image`、`print-multi-color`、`print-repair`、`print-analyze`、`print-split`、`relief` |
| `status` | string | 两者 | `SUCCEEDED` 或 `FAILED`，其他值返回 `400` |

响应示例：

```json
[
  {
    "task_id": "018a210d-8ba4-705c-b111-1f1776f7f578",
    "endpoint": "image-to-3d",
    "status": "SUCCEEDED",
    "created_at": 1755787000000,
    "finished_at": 1755787045000,
    "consumed_credits": 20,
    "api_key_name": "production",
    "api_key_suffix": "a1b2",
    "metadata": {
      "user": "alex@example.com",
      "team": "fab"
    }
  }
]
```

记录字段：`task_id`；`endpoint`（文生 3D 显示阶段，`text-to-3d-preview` 或 `text-to-3d-refine`）；`status`（`SUCCEEDED` 或 `FAILED`）；
`created_at`、`finished_at`（Unix 毫秒，任务没有完成时间时 `finished_at` 为 `null`）；`consumed_credits`（退款后的数，失败任务和免费任务为 `0`）；
`api_key_name`、`api_key_suffix`（Key 已删除、Key 刚创建几分钟内、或任务从未扣费时为空字符串）；`metadata`（没有标签时为 `{}`）。

补充：`endpoints` 里出现未知名字返回 `400`；`text-to-3d` 这个值同时包含 preview 和 refine。旧记录的 `endpoint` 可能是已下线接口的名字，
`endpoints` 过滤器不接受这些名字。用应用登录（如 Meshy CLI）跑的任务，`api_key_name` 是应用名，`api_key_suffix` 为空字符串。
该接口的失败响应：`400`（参数无效）、`401`、`403`（见上）、`429`。

### 4.19 文件上传

官方文档和 OpenAPI 规范里**没有**文件上传接口，也没有上传后换取 token 的机制。
图片和模型只能以公网 URL 或 base64 data URI 的形式写在 JSON 请求体里，或者用 `input_task_id` 引用之前的 Meshy 任务。
官方 MCP server 的做法与此一致：它把本地图片读出来转成 base64 data URI 再放进请求体，源码里没有任何上传调用。

**本地图片怎么提交**（只有这一种办法，一次请求完成，没有要先拿的 token、文件 ID 或上传地址）

1. 读出文件的原始字节，做 base64 编码。
2. 在前面加上 `data:image/<类型>;base64,` 拼成一个字符串。官方页面上出现过的三种前缀：`data:image/jpeg;base64,`
   （各接口的参数说明）、`data:image/png;base64,`（Image to Image 示例、Relief 页）、`data:image/webp;base64,`（更新日志）。
3. 把这个字符串原样作为 JSON 字符串值填进字段，请求仍是普通的 `POST` + `Content-Type: application/json`：

| 场景 | 字段 | 写法 |
| --- | --- | --- |
| 图生 3D 的输入图 | `image_url` | 一个 data URI 字符串 |
| 多图生 3D 的输入图 | `image_urls` | 数组，1～4 个元素，**每个元素各自**是公网 URL 或 data URI（官方原文 “each as a public URL or a data URI”），第 1 个是正面 |
| 贴图参考图（文生 3D refine、图生 3D、多图生 3D） | `texture_image_url` | 一个 data URI 字符串 |
| 多视图贴图参考图（多图生 3D） | `texture_image_urls` | 数组，1～4 个元素，第 1 个是正面 |
| 本地模型文件（Retexture、Remesh、Convert 等） | `model_url` | `data:application/octet-stream;base64,<数据>`，最多 100 MB |

多图生 3D 的请求体示意（按官方参数说明拼出来的，不是官方原样示例；官方示例里两个元素都是占位符）：

```json
{
  "image_urls": [
    "data:image/png;base64,<第 1 张（正面）的 base64 数据>",
    "data:image/jpeg;base64,<第 2 张的 base64 数据>"
  ]
}
```

- 每张图的限制见第 6 节：JPG / JPEG / PNG / WebP，最多 20 MB，每边至少 32 像素，宽 × 高最多 178,956,970 像素。
- 图片在**创建请求里就校验**：格式不对、超过 20 MB、尺寸不合规、base64 损坏（官方叫 “Invalid data URI: The base64 string is malformed”）
  都返回 `400`，没有创建任务，不扣积分。
- base64 会让请求体比原文件大约三分之一，4 张图都用 data URI 时请求体可能上百 MB。请求体总大小的上限官方文档未说明；
  创建请求的超时按第 3 节的建议值设 60 秒。
- 20 MB 是按解码后的图片还是按 base64 文本计算、data URI 里声明的类型与实际内容不一致会怎样，图生 3D 等页面都没有写（见“未核实”）。

## 5. 状态与进度

`status` 的全部取值：

| 状态 | 含义 | 适配器该做什么 |
| --- | --- | --- |
| `PENDING` | 在队列里等待。`preceding_tasks` 是前面还有多少任务 | 继续等 |
| `IN_PROGRESS` | 正在生成 | 读 `progress`（0～100 的整数百分比） |
| `SUCCEEDED` | 成功，终态 | 立即下载结果 |
| `FAILED` | 失败，终态。积分已自动退还，`consumed_credits` 为 `0` | 读 `task_error`，按第 10 节决定是否新建任务 |
| `CANCELED` | 已取消，终态，不会有结果。官方说只有 Creative Lab 任务会用到这个状态 | 停止等待 |

- 生命周期：`PENDING` -> `IN_PROGRESS` -> `SUCCEEDED` | `FAILED` | `CANCELED`。终态之后状态不会再变。
- **任务可能从 `IN_PROGRESS` 被重新调度回 `PENDING`**（任务 ID 不变，`progress` 从 0 重新开始）。不要把这种回退当成错误。
- 任务通常几秒内离开 `PENDING`，绝大部分时间在 `IN_PROGRESS`。
- `progress`：开始前为 `0`，成功时为 `100`。Webhook 推送里的 `progress` 不是真实进度（固定 `50` / `100` / `0`，见 4.17）。
- 时间字段：`created_at` 总是有值；`started_at`、`finished_at` 在开始 / 结束前为 `0`（Unix 毫秒）。
- 只有 `FAILED` 表示任务失败。查询请求超时、返回 `429` 或 `5xx` 都不代表任务失败。

## 6. 输入限制

**图片**（`image_url`、`image_urls`、`texture_image_url`、`texture_image_urls`、`image_style_url`、`multiview_image_urls`）

| 项目 | 限制 |
| --- | --- |
| 传入方式 | 公网可访问的 `http(s)` URL，或 base64 data URI（如 `data:image/jpeg;base64,<数据>`、`data:image/webp;base64,...`）。**没有**上传接口和上传 token |
| 格式 | `.jpg`、`.jpeg`、`.png`、`.webp` |
| 文件大小 | 每张最多 20 MB |
| 最小尺寸 | 每边至少 32 像素 |
| 最大像素数 | 宽 × 高最多 178,956,970 像素（Retexture 的 `image_style_url` 页面只写了 20 MB 和 32 像素两条） |
| 张数 | 图生 3D：1 张。多图生 3D `image_urls`：1～4 张。`texture_image_urls`：1～4 张。Retexture `multiview_image_urls`：1～4 张 |
| 多视图顺序 | 第 1 张是正面，其余（左、后、右）顺序无所谓。各视图必须是同一物体、同样的颜色 |

Meshy 下载不到图片 URL（返回 `404` 或超时）时，创建请求返回 `400`。

**提示词**

| 字段 | 上限 |
| --- | --- |
| `prompt`（文生 3D） | 800 字符 |
| `texture_prompt` | 800 字符 |
| `text_style_prompt`（Retexture） | 800 字符 |
| `prompt`（Text to Motion） | 400 字符 |

超长返回 `400`。

**模型文件**（`model_url`，用于 Retexture、Remesh、Convert、Resize、UV Unwrap、Rigging）

| 项目 | 限制 |
| --- | --- |
| 传入方式 | 公网 `http(s)` URL，或 data URI（MIME 用 `application/octet-stream`，如 `data:application/octet-stream;base64,<数据>`） |
| 格式 | Retexture / Remesh / Convert / Resize：GLB、glTF、OBJ、FBX、STL。UV Unwrap 和 Rigging：只接受 `.glb` |
| 文件大小 | URL 最多 400 MB；data URI 最多 100 MB |
| 超过 100 MB 的文件 | GLB / glTF / FBX / OBJ 最多 10,000,000 个面（按三角面计，四边面算 2 个）；FBX 必须是二进制 FBX 7.1 或更新；GLB / glTF 不能用 Draco 压缩 |
| 不支持的变体 | ASCII FBX、meshopt 压缩的 GLB、只有骨架 / 相机 / 灯光而没有有效 3D 对象的文件（任务会以 `invalid_input` 失败）。超过 100 MB 的文件如果是 ASCII FBX、Draco 压缩的 GLB / glTF 或早于 7.1 的二进制 FBX，创建请求直接返回 `400` |

**各接口的面数上限**

| 接口 | 上限 |
| --- | --- |
| Rigging | 380,000 个三角面（四边面算 2 个） |
| UV Unwrap | 40,000 个面 |
| `meshy-n1` 贴图（Retexture、refine、`texture_model`） | 7,999,999 个三角面 |

**其他输入约束**

- Rigging：只支持带贴图的标准人形（双足）角色；`model_url` 的角色要面朝 +Z 轴。
- 复杂度：太复杂的输入（成堆的小物体、密集重复结构、整栋建筑、一张图里有多个物体）会以
  `image_too_complex` 失败。官方建议一张图只放一个主体。

## 7. 输出

**模型格式**

| 接口 | 可选格式（`target_formats`） | 不传时的默认 |
| --- | --- | --- |
| 文生 3D、图生 3D、多图生 3D、Retexture | `glb`、`obj`、`fbx`、`stl`、`usdz`、`3mf` | 除 `3mf` 外全部 |
| Remesh | `glb`、`fbx`、`obj`、`usdz`、`blend`、`stl`、`3mf` | `["glb"]` |
| Convert | `glb`、`fbx`、`obj`、`usdz`、`blend`、`stl`、`3mf` | 必填，无默认 |
| Resize | 不可选 | `input_task_id` 总是 GLB；`model_url` 保持原格式（`.gltf` 和 data URI 返回 GLB） |
| UV Unwrap | 不可选 | 只有 GLB |
| Rigging | 不可选 | FBX 和 GLB（在 `result` 里） |
| Animation | 不可选 | GLB 和 FBX；后处理可得 USDZ、骨架 FBX、改帧率后的 FBX |
| Text to Motion | 由 `mode` 决定 | `prime` 出 FBX，`swift` 出 BVH |

- 下载链接在 `model_urls` 里按格式名取。**没生成的格式没有对应的键**，下载前先判断键是否存在。
- OBJ 带贴图时会多一个 `mtl` 键。
- `save_pre_remeshed_model: true` 且 `should_remesh: true` 时多一个 `pre_remeshed_glb`。
- `model_urls` 里的 USDZ 自 2026-10-12 起单位是米（`metersPerUnit = 1`）。更新日志列出的范围是文生 3D、图生 3D、多图生 3D、
  Retexture、Remesh、Convert、Resize 和 Auto Split 的任务；此前它声明的是英尺（`metersPerUnit = 0.3048`）而坐标实际是米。
  这一天之前创建的任务的文件保持原单位，**Rigging 和 Animation 的 USDZ 文件不受这次变更影响**。
- 用 `target_formats` 只要需要的格式可以缩短任务耗时。
- **同一个任务的各格式不需要第二次调用**：创建时生成的所有格式都在这一个任务对象的 `model_urls` 里，换格式只是换一个键。
- **创建时没生成的格式要再建一个任务**：例如创建时只传了 `["glb"]`，或者要 `blend`（生成接口的 `target_formats` 里没有它）。
  做法是建一个 Convert 任务（4.9）：`input_task_id` 填源任务 ID，`target_formats` 填要的格式，1 积分。它返回新的任务 ID，
  要再轮询一次，结果在 Convert 任务自己的 `model_urls` 里。源任务必须是 API 创建且 `SUCCEEDED`；Meshy 删除源任务之后
  `input_task_id` 会返回 `404 Task not found`，这时只能把自己保存的文件用 `model_url` 传回去。
- 贴图放在哪：生成类接口的页面只写了 `mtl` 是“模型有贴图时随 OBJ 返回”，单独的贴图图片在 `texture_urls` 里。
  哪些格式把贴图内嵌在模型文件里，这些页面没有写（见“未核实”）。

**贴图**

`texture_urls` 是对象数组，通常只有 1 个对象：

| 键 | 何时出现 |
| --- | --- |
| `base_color` | 有贴图时总是出现 |
| `metallic`、`roughness`、`normal` | 创建时 `enable_pbr: true` |
| `emission` | 只有 Meshy 6 贴图模型、`enable_pbr: true`、且分辨率是 `2k` 或 `4k` |
| `metallic_roughness` | Remesh / Convert / Resize 的任务对象说明里提到可能出现 |

贴图分辨率：`2k`（2048×2048，默认）、`4k`（4096×4096）、`8k`（8192×8192）。各贴图模型的支持范围见第 8 节。

**缩略图**

- `thumbnail_url`：预览 PNG。
- `alpha_thumbnail_url`：透明背景（RGBA）版本，需要 `alpha_thumbnail: true`。
- `thumbnail_urls`：`front`（0°）、`right`（90°）、`back`（180°）、`left`（270°）四张 512×512 PNG，
  需要 `multi_view_thumbnails: true`。文档页只在图生 3D 和多图生 3D 上列出这个参数。

**面数与拓扑**

| 选项 | 说明 |
| --- | --- |
| `topology` | `triangle`（默认）或 `quad`（四边面为主）。Smart Topology 模型只出三角面 |
| `target_polycount` | 重拓扑 `100`～`300000`（默认 `30000`）；`meshy-t2` `100`～`15000`（默认 `4000`）；`meshy-t2.5` `100`～`30000`（默认 `15000`） |
| `decimation_mode` | `1` ultra、`2` high、`3` medium、`4` low，设置后覆盖 `target_polycount` |
| `should_remesh` | `meshy-6-lite` 默认 `true`（重拓扑到 30,000 面），其他模型默认 `false` |
| `geometry_resolution` | `standard`、`2k`、`4k`。`4k` 网格可达约 1000 万面、490 MB |

官方示例里同一张输入图的面数：Meshy 7.1 为 890,226，Meshy 6 为 678,776，Meshy 6 Lite 为 30,513，
Meshy T2.5 为 15,721，Meshy T2 为 4,353。Meshy 7.1 的面数随输入变化，不固定。
要低面数游戏资产，官方建议直接用 Smart Topology 模型，而不是对 `meshy-7.1` 的网格做重拓扑。

## 8. 模型版本

每个带贴图的模型由两个 AI 模型完成：**几何模型**建网格，**贴图模型**上色。

**几何模型**

| 模型 ID | 状态（2026-11-12） | 说明 |
| --- | --- | --- |
| `meshy-7.1` | 可用 | 当前默认。`latest` 解析为它。支持 `geometry_resolution` 的 `2k` / `4k` |
| `latest` | 别名 | 指向最新的标准模型，新模型发布后输出会变。要稳定输出就写死具体 ID |
| `meshy-6` | 可用 | |
| `meshy-6-lite` | 可用 | 最便宜，默认重拓扑到 30,000 面，贴图只有 2K |
| `meshy-t2.5` | 可用 | Smart Topology，需要 `model_type: "smart-topology"`，是该模式下的默认 |
| `meshy-t2` | 可用 | Smart Topology，更快，部件分离 |
| `meshy-7` | 已废弃 | 作为几何模型在 **2026-12-31** 下线，之后返回 `400`。改用 `meshy-7.1`（参数和价格相同） |
| `meshy-t1`、`model_type: "lowpoly"` | 已废弃 | 自 2026-10-30 起，除官方列出的少数回退组合（仍跑在 Smart Topology 模型上）外，其余请求已经返回 `400`；**2026-11-30** 起全部返回 `400`。不要使用，改用 `smart-topology` + `meshy-t2.5` |
| `meshy-5` | 已下线 | 2026-10-10 下线，返回 `400`，消息 `ai_model meshy-5 has been retired; use meshy-6-lite` |
| `meshy-4`、`meshy-3` | 已下线 | `meshy-4` 于 2026-03-20 下线，`meshy-3` 于 2025 年 7 月下线 |

**贴图模型**

| | `meshy-7` | `meshy-n1` | `meshy-6` | `meshy-6-lite` |
| --- | --- | --- | --- | --- |
| 贴图分辨率 | 2K / 4K / 8K | 2K | 2K / 4K / 8K | 2K |
| PBR 贴图 | 支持 | 不支持，只有底色 | 支持，2K 和 4K 还有 emission | 支持 |
| 文字提示词 | 支持 | 不支持，只能用参考图 | 支持 | 支持 |
| 参考图张数 | 1～4 | 1～4 | 1 | 1 |
| `remove_lighting` | 被忽略 | 不支持 | 支持 | 不支持 |
| 四边面重拓扑 | 支持 | 不支持 | 支持 | 支持 |

`meshy-7` 作为贴图模型**不受** 12 月 31 日下线影响。向贴图模型请求它不支持的选项会返回 `400`。

**各接口怎么选模型**

| 接口 | 几何模型参数 | 贴图模型参数 |
| --- | --- | --- |
| 图生 3D | `ai_model`（Smart Topology 还要 `model_type`） | `texture_model`：`meshy-7`、`meshy-n1`、`meshy-6-lite` |
| 多图生 3D | `ai_model`（不支持 Smart Topology） | `texture_model`：`meshy-7`、`meshy-n1` |
| 文生 3D | preview 任务的 `ai_model` | refine 任务的 `ai_model` |
| Retexture | 无 | `ai_model`（`latest` = `meshy-7`，不接受 `meshy-7.1`） |

**省略 `texture_model` 时的默认贴图模型**（官方说新贴图模型发布后这些默认值不变）

| 几何模型 | 默认贴图模型 |
| --- | --- |
| Meshy 7.1 | Meshy 7 |
| Meshy 6 | Meshy 6 |
| Meshy 6 Lite | Meshy 6 Lite |
| Meshy T2.5 | Meshy 7 |
| Meshy T2 | Meshy 7 |

**官方按用途推荐的组合**

| 用途 | 几何模型 | 贴图模型 |
| --- | --- | --- |
| 高精度主资产（产品渲染、影视道具） | `meshy-7.1` | `meshy-7` |
| 要绑骨做动画的游戏角色 | `meshy-t2.5` | `meshy-n1` |
| 大量游戏场景道具、UGC | `meshy-t2` | `meshy-n1` |
| 2～4 张照片还原真实物体 | `meshy-7.1`（多图生 3D） | `meshy-7` |
| 3D 打印 | `meshy-7.1` | 不贴图，或 `meshy-7` 彩色打印 |
| 低成本大量草稿 | `meshy-6-lite` | `meshy-6-lite` |

## 9. 计费

Meshy API 用预付积分（credits）。**创建任务时扣费**；任务 `FAILED` 自动退还；删除 `PENDING` 任务退还；
`IN_PROGRESS` 之后不能取消也不退。每个任务对象的 `consumed_credits` 是实际扣的数。

**3D 生成**（积分 / 次；含所选贴图选项，贴图模型为该 `ai_model` 的默认值）

| 接口 | 配置 | `meshy-7.1`（`latest`） | `meshy-6` | `meshy-6-lite` | `meshy-t2` | `meshy-t2.5` |
| --- | --- | --- | --- | --- | --- | --- |
| 文生 3D preview | 仅网格 | 20 | 20 | 5 | 5 | 5 |
| 图生 3D | 仅网格 | 20 | 20 | 5 | 5 | 5 |
| 图生 3D | 2K 贴图 | 30 | 30 | 15 | 15 | 15 |
| 图生 3D | 4K 贴图 | 30 | 30 | 不支持 | 15 | 15 |
| 图生 3D | 8K 贴图 | 35 | 35 | 不支持 | 20 | 20 |
| 多图生 3D | 仅网格 | 20 | 20 | 5 | 不支持 | 不支持 |
| 多图生 3D | 2K 贴图 | 30 | 30 | 15 | 不支持 | 不支持 |
| 多图生 3D | 4K 贴图 | 30 | 30 | 不支持 | 不支持 | 不支持 |
| 多图生 3D | 8K 贴图 | 35 | 35 | 不支持 | 不支持 | 不支持 |
| Ultra 几何附加费 | `geometry_resolution` 为 `2k` 或 `4k` | +5 | 不支持 | 不支持 | 不支持 | 不支持 |

`meshy-7` 与 `meshy-7.1` 同价。换用非默认贴图模型不改变计价方式：总价 = 该 `ai_model` 的仅网格价 + 对应分辨率的 Retexture 价，
用了 Ultra 几何再加 5。Pricing 页给出的非默认组合价格（积分 / 次）：

| 接口 | `ai_model` | `texture_model` | 2K | 4K | 8K |
| --- | --- | --- | --- | --- | --- |
| 图生 3D | `meshy-7.1`（`latest`） | `meshy-n1` | 30 | 不支持 | 不支持 |
| 图生 3D | `meshy-7.1`（`latest`） | `meshy-6-lite` | 30 | 不支持 | 不支持 |
| 图生 3D | `meshy-6` | `meshy-7` | 30 | 30 | 35 |
| 图生 3D | `meshy-6` | `meshy-n1` | 30 | 不支持 | 不支持 |
| 图生 3D | `meshy-6` | `meshy-6-lite` | 30 | 不支持 | 不支持 |
| 图生 3D | `meshy-6-lite` | `meshy-7` | 15 | 15 | 20 |
| 图生 3D | `meshy-6-lite` | `meshy-n1` | 15 | 不支持 | 不支持 |
| 图生 3D | `meshy-t2` 或 `meshy-t2.5` | `meshy-n1` | 15 | 不支持 | 不支持 |
| 图生 3D | `meshy-t2` 或 `meshy-t2.5` | `meshy-6-lite` | 15 | 不支持 | 不支持 |
| 多图生 3D | `meshy-7.1`（`latest`） | `meshy-n1` | 30 | 不支持 | 不支持 |
| 多图生 3D | `meshy-6` | `meshy-7` | 30 | 30 | 35 |
| 多图生 3D | `meshy-6` | `meshy-n1` | 30 | 不支持 | 不支持 |
| 多图生 3D | `meshy-6-lite` | `meshy-7` | 15 | 15 | 20 |
| 多图生 3D | `meshy-6-lite` | `meshy-n1` | 15 | 不支持 | 不支持 |

**贴图**

| 接口 | 贴图分辨率 | 积分 / 次 |
| --- | --- | --- |
| 文生 3D refine | 2K / 4K | 10 |
| 文生 3D refine | 8K | 15 |
| Retexture | 2K / 4K | 10 |
| Retexture | 8K | 15 |

文生 3D 的 preview 和 refine 是两次请求、分别计费。例如 `meshy-7.1` 文生带贴图模型 = 20 + 10 = 30。

**绑骨与动画**

| 接口 | 积分 |
| --- | --- |
| Rigging | 5 / 次 |
| Animation | 3 / 动作（一次最多 10 个动作） |
| Text to Motion `prime` | 10 / 次 |
| Text to Motion `swift` | 3 / 次 |

**后处理**

| 接口 | 积分 / 次 |
| --- | --- |
| Remesh | 5 |
| UV Unwrap | 5 |
| Convert | 1 |
| Resize | 1 |

**官方明确写免费的接口**：Balance、Usage、动作库（`/animations/library`）、Analyze Printability。
查询、列表、流接口的页面没有写收费，积分只在创建任务时扣（它们仍计入每秒请求数限流）。

Pricing 页还列了本文没有覆盖的接口的价格（积分 / 次）：Text to Image 按图像模型 3～9，Image to Image 3～12；
Multi-Color Print、Repair Printability、Auto Split 各 10，Relief 20；Creative Lab 分 Prototype / Build 两段计费
（多数产品 6 / 30，Keycap 12 / 50，Lamp 30 / 6，Collapsible Fidget 单段 6）。

Pricing 页写的购买入口是订阅设置页 `https://www.meshy.ai/settings/subscription`（原文 “buy API credits in your subscription settings”）；
批量价格或定制合同要联系销售。Developer Platform 页则写 Playground 和 API 请求用的是套餐积分（“uses your plan credits”）。

**免费额度与套餐**

- API 文档里没有提到 API 免费额度或试用积分。Free 套餐不能创建 API Key，创建任务会返回 `402`。
  Free 套餐只能在 Developer Platform 的 Playground 里试图生 3D（官方说走内置的测试用 Key，消耗账户自己的积分）。
- 积分分两种：月度积分（每月刷新时过期）和永久积分（购买的积分包、奖励，不过期），
  用 Balance 接口可以分别查到。
- 官网定价页（`https://www.meshy.ai/pricing`，营销页面，价格随时可能变）在 2026-11-12 显示的月付套餐：

| 套餐 | 月度积分 | 月付价格 | API |
| --- | --- | --- | --- |
| Free | 100 | $0 | 无 |
| Pro | 1,000 | $20 / 月 | 有 |
| Premium | 3,000 | $40 / 月 | 有 |
| Ultra | 8,000 | $100 / 月 | 有 |
| Studio | 5,500（团队共享） | $70 / 月，另加 $10 / 月 / 席位 | 有 |
| Enterprise | 自定义 | 联系销售 | 有 |

定价页还写着套餐积分每月重置、不累积。单独购买积分包的单价没有在读到的页面上找到（见“未核实”）。
2026-11-12 这一页在 Pro、Premium、Ultra、Studio 上都挂着 “50% Off first month” 的促销，首月显示为 $10、$20、$50、$35，
之后按上表的月付价格计费；促销随时可能撤下。Pro 的权益里写着积分包（Extra Credit Packs）八折。

## 10. 错误与限流

### 10.1 两类错误

1. **请求错误**：Meshy 立即拒绝请求，返回 HTTP 4xx / 5xx。
2. **任务错误**：任务已创建，运行中失败。HTTP 查询仍是 `200`，任务 `status` 为 `FAILED`，原因在 `task_error`。

### 10.2 请求错误

响应体只有一个 `message` 字段：

```json
{
  "message": "Invalid model file extension: .3dm"
}
```

| 状态码 | 含义 | 处理 |
| --- | --- | --- |
| `200` | 成功 | |
| `202` | 已接受，创建任务的请求返回它 | 取 `result` 里的任务 ID |
| `400` | 请求无效（缺参数、参数格式错、组合不支持、文件不合规） | 修正后重发。没有创建任务 |
| `401` | Key 缺失、无效或无权访问该接口 | 检查 `Authorization` 头 |
| `402` | 积分不足；Free 套餐上大多数创建任务的请求也返回它 | 充值或升级 |
| `403` | IP 不在白名单（`ip_not_authorized`）；组织的 IP 过滤拦截了文件读取；套餐不含该接口；内容审核拦截；Key 所属成员已不在团队；账户被封禁 | 按原因处理 |
| `404` | 资源不存在（如任务 ID 不存在或已被删除） | |
| `409` | 资源状态不允许该操作（删除 `IN_PROGRESS` 任务） | 等任务到终态 |
| `422` | 请求合法但无法处理（如 Rigging 找不到人形身体） | 换输入 |
| `429` | 请求太频繁，或排队 / 运行中的任务太多 | 见 10.5 |
| `5xx` | Meshy 服务端错误 | 退避重试；持续出现就看状态页 |

内容审核有三种表现，适配器都要处理：创建时传了 `moderation: true` 且命中，返回 `400`；
创建请求直接返回 `403`；任务创建后以 `task_error.code = moderation_blocked` 失败。

### 10.3 任务错误

`task_error` 的字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | string | 错误大类，失败任务总有。**用它决定是否重试** |
| `message` | string | 给人看的描述，失败任务总有 |
| `code` | string | 具体问题，有更多信息时才有。Meshy 可能新增 code，不认识的 code 按 `type` 处理 |
| `doc_url` | string | 指向文档的链接，有 `code` 时才有 |

带详情的例子：

```json
{
  "id": "018a210d-8ba4-705c-b111-1f1776f7f578",
  "status": "FAILED",
  "task_error": {
    "type": "invalid_input",
    "code": "image_too_complex",
    "message": "The uploaded image is too complex for 3D generation.",
    "doc_url": "https://docs.meshy.ai/en/api/errors#image-too-complex"
  }
}
```

不带详情的例子：

```json
{
  "id": "018a210d-8ba4-705c-b111-1f1776f7f578",
  "status": "FAILED",
  "task_error": {
    "type": "server_error",
    "message": "An internal error occurred. Please retry."
  }
}
```

`type` 取值：

| `type` | 含义 | 处理 |
| --- | --- | --- |
| `invalid_input` | 输入有问题 | 读 `code` 和 `message`，修正输入后新建任务。原样重试没用 |
| `timeout` | 超过服务端时限（处理超时或排队超时），积分已退 | 通常是暂时的，新建任务；持续失败就简化输入 |
| `service_unavailable` | 服务暂时不可用 | 稍等后新建任务 |
| `server_error` | Meshy 内部错误 | 新建任务；持续失败带任务 ID 联系支持 |

`code` 取值：

| `code` | 文档写明的 `type` | 含义 | 处理 |
| --- | --- | --- | --- |
| `image_too_complex` | `invalid_input`（见上例） | 图片或提示词描述的主体几何太复杂 | 一图一物、简化主体、避免场景和密集重复结构 |
| `model_missing_uv` | 未写明 | `enable_original_uv: true` 但模型没有 UV | 给模型加 UV，或不传 / 传 `false` |
| `model_insufficient_uv` | 未写明 | 模型的 UV 覆盖 UV 空间太少 | 重新展 UV，或不传 `enable_original_uv` |
| `model_missing_texture` | 未写明 | Multi-Color Print 的输入模型没有可用颜色 | 先贴图 |
| `textured_split_refused` | 未写明 | Auto Split 带 `keep_texture: true` 时无法保留贴图，积分已退 | 去掉 `keep_texture` |
| `invalid_input` | 未写明 | 输入没通过检查且没有更具体的 code（空文件 / 损坏文件、ASCII FBX、meshopt GLB、没有有效 3D 对象、未通过安全过滤） | 读 `message` |
| `moderation_blocked` | 未写明 | 安全过滤拒绝了提示词或参考图 | 改提示词或换图 |
| `moderation_unavailable` | `server_error` | 审核服务暂时不可用，内容本身没问题 | 新建任务 |
| `timeout` | 未写明 | 超过服务端时限，积分已退 | 新建任务；持续失败就简化输入 |
| `queue_timeout` | `timeout` | 排队太久没开始，积分已退，与输入无关 | 新建任务 |
| `format_conversion_failed` | 未写明 | 模型已生成，但转成所请求的格式失败 | 新建任务；某格式持续失败就换格式 |

### 10.4 重试规则

**创建请求（`POST`）**

| 情况 | 是否已扣费 | 能否自动重发 |
| --- | --- | --- |
| 收到 `4xx` | 否，没有创建任务 | 修正后可以重发（`429` 见表后说明和 10.5） |
| 收到 `202` | 是 | 不要重发 |
| 超时、连接中断、`5xx` | **不确定，任务可能已经创建并扣费** | **不要自动重发** |

Meshy 没有幂等键（idempotency key）。创建请求结果不明时，官方给的做法是：等约 1 分钟，用列表接口
（`sort_by=-created_at`）查最新任务，确认不存在后再新建。

两种 `429` 都属于“没有创建任务”：每秒请求数超限的请求被直接拒绝；并发任务数超限时，Rate limits 页写的是每个创建接口
**在创建任务之前**检查这个限额（“checks this limit before it creates one”）。按 10.5 等待后可以重发同一个请求。

用列表接口核对时要注意：列表按任务类型分开（文生 3D 查 `/openapi/v2/text-to-3d`，图生 3D 查 `/openapi/v1/image-to-3d`，
多图生 3D 查 `/openapi/v1/multi-image-to-3d`）。文生 3D 的任务对象回显 `prompt`；图生 3D 和多图生 3D 的官方字段表里
**没有回显输入图片的字段**，能用来比对的只有 `created_at`（Unix 毫秒）。官方没有说明怎样确认列表里的某个任务就是这一次请求建的
（见“未核实”），同一时刻并发提交多个任务时这种核对并不可靠。

Rigging 的 `503` 是例外：官方明确写“重试该请求”。

**查询请求（`GET`）**

超时、`429`、`5xx` 都可以安全重试，在下一次轮询时再查即可，不代表任务失败。
**不要因为查询失败就重新创建任务**：原任务还在运行且已扣费，再建一个会再扣一次。

**任务失败（`FAILED`）**

- 失败任务的积分自动退还，新建任务是安全的。
- `type` 为 `timeout`、`service_unavailable`、`server_error`：用指数退避新建任务。
- `type` 为 `invalid_input`：先修正输入。
- 只有在看到 `FAILED` 之后才新建任务。

**取消**

运行中的任务不能取消。客户端放弃等待不会停止任务，也不会退费。

### 10.5 限流

Meshy 按账户做两种限制：每秒请求数，以及并发任务数（处于 `PENDING` 或 `IN_PROGRESS` 的任务数）。

| 套餐 | 每秒请求数 | 并发任务数 | 队列优先级 |
| --- | --- | --- | --- |
| Pro | 20 | 10 | 默认 |
| Premium | 20 | 30 | 高于 Pro |
| Ultra | 20 | 100 | 最高 |
| Studio | 20 | 60（部分早期 Studio 套餐为 20） | 高于 Pro |
| Enterprise | 100 | 默认 100，可定制 | 最高 |

优先级不是限额：队列繁忙时，优先级高的任务先开始。Rate limits 页的表里没有 Free 套餐（Free 不能创建 API Key）；
官网定价页写 Free 是 1 个并发任务、低优先级。

- **所有** API 请求都计入每秒请求数，包括查询、列表、流。
- 并发任务数只在创建任务时检查；Balance、Usage、查询、列表、流不计入。
- 团队的所有 API Key 共享团队的一套限额。
- IP 白名单拒绝的请求不计入限流。
- 网页端（web app）的请求不计入每秒请求数；但网页端跑的任务会占用操作者本人的并发任务数，
  团队 owner 在网页端发起的任务还会计入团队的限额。
- Playground 的请求：个人账户计入自己的限额；在团队里计入登录成员本人的限额，不是团队共享的那一套。

超限返回 `429`，靠 `message` 区分是哪一种：

| `message` | 原因 | `Retry-After` | 处理 |
| --- | --- | --- | --- |
| `Rate limit exceeded` | 每秒请求数超限 | 有 | 等 `Retry-After` 秒后重试 |
| 以 `NoMorePendingTasks` 开头 | 并发任务数超限 | **没有** | 等自己的某个任务结束后再创建 |
| 以 `NoMoreConcurrentTasks` 开头 | 不限并发的套餐积分用完 | **没有** | 同上 |

响应头：

| 响应头 | 含义 |
| --- | --- |
| `X-RateLimit-Limit` | 套餐每秒允许的请求数 |
| `X-RateLimit-Remaining` | 当前这一秒还剩多少请求 |
| `X-RateLimit-Reset` | 多少秒后额度恢复 |
| `Retry-After` | 下一次请求前要等的秒数。出现在每秒请求数超限的 `429`，以及查询还在 `PENDING` / `IN_PROGRESS` 的任务时 |

## 11. 未核实

以下内容没有在官方页面上得到确认，或者官方来源互相矛盾。写适配器时不要假定其中任何一条成立。

**没有实测**

- 本文没有调用任何 Meshy 接口。所有请求、响应、状态码都只是文档描述，实际行为未验证。
- 官方示例里的值是占位的（如 `expires_at: 1692771679037` 只比 `created_at` 晚约 28 秒，链接里是 `***`），
  不能据此推断真实的过期时长或链接格式。

**官方来源之间的不一致**

- Key 创建页面：文档页写 `https://www.meshy.ai/developers/keys`，OpenAPI 规范写 `https://www.meshy.ai/settings/api`。本文采用文档页。
- 资产保留期：API 文档写非 Enterprise 一律最多 3 天；官网定价页写 Studio 是 14 天。实际以任务的 `expires_at` 为准。
- 文生 3D 链接是否过期：Asset retention 页说文生 3D 任务没有 `expires_at`、链接不带过期时间；但文生 3D 的响应示例里链接带 `?Expires=***`。
- 成功任务的 `task_error`：多数示例是 `null`，Remesh 和 UV Unwrap 的任务对象示例是 `{"message": ""}`。
- `CANCELED`：Task lifecycle 页说只有 Creative Lab 任务会用到，但每个任务对象的 `status` 都列了它。
- 限流表：`llms.txt` 只列 Pro / Studio / Enterprise，Rate limits 页多了 Premium / Ultra。本文采用 Rate limits 页。
- `DELETE` 成功时的响应体：文档页写空响应体，OpenAPI 规范声明为一个 JSON 对象。
- Retexture 任务对象：字段表列的是 `image_style_url`，查询响应示例里出现的却是 `texture_image_url`。
- Resize 的尺寸参数：文档页写“恰好传一个”，OpenAPI 规范写“至少一个”。本文采用文档页。
- `geometry_resolution: "2k"` 支持的模型：文档页写 `meshy-7.1`、`latest` 和已废弃的 `meshy-7`，OpenAPI 规范只写 `meshy-7.1` / `latest`。
- Usage：时间窗口文档页写最长 366 天，OpenAPI 规范写最长 1 年；`page_size` 文档页写 `101`～`255` 返回 100 条，OpenAPI 规范把上限定义成 `100`。
- 任务 ID：文档页要求当作不透明字符串，OpenAPI 规范把路径参数标成 `uuid` 格式。本文采用文档页。
- `thumbnail_urls`：多图生 3D 的文档页和 OpenAPI 请求 schema 都有 `multi_view_thumbnails`，但 OpenAPI 的任务对象把 `thumbnail_urls` 注成 “image-to-3d only”。
- Balance 的失败状态码：文档页只有 `401`、`429`，OpenAPI 规范多列了 `404`。
- 示例里的过期时长：Rigging、Animation、Text to Motion 示例的 `expires_at` 比 `finished_at` 晚 3 天整，UV Unwrap 示例只晚 1 天。
- 图生 3D 的 `image_url` 与 `input_task_id`：文档页写两个都传时用 `input_task_id`，OpenAPI 规范写“恰好传一个”。适配器只传其中一个。
- `target_formats`：文档页写只生成并返回列出的格式，OpenAPI 规范却把它描述成“额外的导出格式”（Additional export formats）。本文采用文档页。
- 多图生 3D 的 `texture_prompt` 与 `texture_image_url`：文档页写两个都传时用 `texture_prompt`，OpenAPI 规范写两者互斥。适配器只传其中一个。
- 文生 3D 的 `ai_model`：OpenAPI 规范的枚举里没有 `meshy-n1`，但同一字段的说明和文档页都写 refine 接受它
  （规范的解释是 preview 传 `meshy-n1` 会返回 `400`，所以没放进枚举）。按规范生成的客户端可能会拒绝这个值。
- 后处理接口的模型来源（Retexture、Remesh、Convert、Resize、UV Unwrap、Rigging）：文档页写 `input_task_id` 和 `model_url` 都传时用
  `input_task_id`，OpenAPI 规范写“恰好传一个”。适配器只传其中一个。
- Retexture 的风格输入：文档页写 `text_style_prompt` 和 `image_style_url` 都传时用 `image_style_url`，OpenAPI 规范写“恰好一个风格来源”。
  适配器只传其中一个。
- Retexture 的 `model_url` 格式：文档页写 GLB、glTF、OBJ、FBX、STL，OpenAPI 规范的说明写的是“a GLB”。本文采用文档页。
- Retexture 的 `remove_lighting` 默认值：文档页写 `true`，OpenAPI 规范没有声明默认值（类型是 boolean 或 null）。
- 创建接口的失败状态码清单：文档页给 Remesh、Convert、Resize 都列了 `403`（浮雕模型）和 `404`（`input_task_id` 不是你的任务），
  OpenAPI 规范给这三个接口只列 `400`、`401`、`402`、`429`；规范里 Retexture 没有 `404`，UV Unwrap 没有 `403`。
  适配器不要把规范的状态码清单当成穷举。
- `task_error` 的必有字段：Errors 页写失败任务的 `type` 和 `message` 总是存在，OpenAPI 规范只把 `message` 标为必有。
- 流接口遇到不存在的任务：OpenAPI 规范给流接口声明了 HTTP `404`，文档页的流示例则是一个 `event: error` 事件
  （`data` 里带 `status_code: 404`）。实际是哪一种、还是两种都有，没有核实。
- 限流响应头：Rate limits 页写 “API responses include these headers”，OpenAPI 规范只在查询任务的 `200` 响应和 `429` 响应上声明了
  `X-RateLimit-*`；规范给所有 `429` 都声明了 `Retry-After`，Rate limits 页却写并发任务数超限的 `429` 没有这个头。本文采用 Rate limits 页。
- 重新查询任务时下载链接是否变化：Asset retention 页写重新查询得到同一个链接、同一个到期时间；
  Text to Motion 页却写 `motion_url` 每次读取都会重新签名。适配器不要缓存链接字符串做比较。
- API 用哪种积分：Pricing 页写调用 API 前要在订阅设置页 “buy API credits”；Developer Platform 页写请求用的是套餐积分；
  Balance 接口返回的是月度积分加永久积分。三处措辞不同，订阅自带的月度积分能否直接用于 API 没有在文档里找到一句明确的话。

**只在 OpenAPI 规范里出现、文档页没有说明的内容**

- 文生 3D 的 `name`、`seed`、`should_texture`（一次请求出带贴图模型的“fused”路径，规范说未普遍开放）、
  `experimental`（`turbo`、`enable_tsr`、`optimize_texture_seams`）以及 `ai_model` 别名
  `meshy-standard-latest`、`meshy-smart-topology-latest`。
- 规范说 `meshy-7`、`meshy-7.1`、`meshy-t2` 以及 Ultra 几何档位“需要账户权限（entitlement）”。
  文档页没有提这个条件，不清楚哪些套餐默认具备。
- Rigging 的 `animation_type`（`biped` / `quadruped`，默认 `biped`）和 `name`。文档页只在错误说明里提到“四足 rig”，
  没有说明怎么请求四足绑骨。
- Retexture 的 `art_style`（`realistic` / `cartoon`）。
- 任务对象里的 `name`、`model_type`、`seed`、`mode`、`texture_resolution`、`remove_lighting` 等回显字段。
- 响应里 `model_urls` 可能出现的 `gltf`、`vox` 键。
- 图生 3D、多图生 3D 等 v1 任务对象里已废弃的 `model_url`（单数），规范写改用 `model_urls`。文档页的字段表和示例里都没有它。
- 规范把任务对象的 `consumed_credits` 标成可以是 `null`，并且只把 `id`、`status`、`created_at`、`progress` 标为必有字段。
  文档页没有说明哪些字段一定存在，适配器读其他字段时要容忍缺失。
- 多图生 3D 和 Animation 请求里的 `name`。
- Animation 的 `action_id` 取值范围（规范写 `0`～`32767`）。
- `404` 的另一种含义：规范对 `NotFound` 响应的说明是 “Resource not found (or the feature is not available to this account)”，
  文档页只写资源不存在。

**文档提到但没有找到说明的内容**

- “v2 Rigging”（更新日志说它默认 `mixamo` 骨架）和 “v2 Retexture”（`llms.txt` 说它会忽略 `remove_lighting`）。
  没有找到这两个 v2 接口的路径或文档页，OpenAPI 规范里也没有。
- `ip_not_authorized` 这个“错误码”在响应体里的具体位置。文档说请求错误的响应体只有 `message`。
- SSE 流的 `event: error` 事件之后连接是否关闭、是否有心跳、流的最长持续时间。
  只有 UV Unwrap 页写了流在任务到达终态时关闭（OpenAPI 规范的说法是事件一直发到终态），其他接口的流小节没有这句话。
- Task lifecycle 页提到 “On v2, Repair Printability and Analyze Printability …”，同样没有找到这两个 v2 接口的路径。
- Meshy 无法在所选 `skeleton_template` 上绑定、或带手指绑定失败而导致任务失败时，`task_error` 的 `type` / `code` 是什么。
  Errors 页的错误码表里没有对应的条目。
- `Retry-After` 在轮询响应中的典型取值。
- Webhook 重试的具体间隔。
- Rigging 的 `422`“姿态估计失败”是否扣积分。文档只对另外两种 `422` 写了不扣积分；`llms.txt` 又说 `4xx` 表示没有创建任务。
- `402` 里的 “the account reached a credit limit” 具体指哪种上限（Key 的月度积分上限、成员额度还是工作区额度）。
- SSE 请求是否必须带 `Accept: text/event-stream`。
- 查询接口是否按任务类型隔离。官方 MCP server 源码（`dist/utils/endpoints.js`）的注释说：text-to-3d、image-to-3d、multi-image-to-3d、retexture
  的 `GET` 路由会返回调用者的任意任务，并按该路由的形状输出（例如用 text-to-3d 路由查 Rigging 任务，会得到没有 `result` 的对象）。
  文档页和 OpenAPI 规范没有这个说法。适配器必须用创建任务时的同一个路径前缀去查询，不要跨类型查询。
- Rigging 的 `skeleton_template` 和 `include_fingers` 是 2026-11-10 才加的参数，文档页和 OpenAPI 规范里都有，
  但官方 MCP server 0.6.11 的源码里还没有，所以这两个参数没有第三个来源可对照。

**完全没有找到的信息**

- 提示词支持哪些语言（是否支持中文）。
- 单独购买积分包的单价、每积分的美元价格。
- 年付价格。定价页的服务端渲染 HTML 里年付和月付显示同一个月均价（Pro $20、Premium $40、Ultra $100、Studio $70），
  页面内的结构化数据（JSON-LD）里 Pro 年付 $240、Studio 年付 $840；浏览器里是否另有年付折扣没有核实。
- 下载链接的确切有效时长（文档只说在任务的 `expires_at` 失效，没有给出时长；Rigging、Animation、Text to Motion 示例里
  `expires_at` 比 `finished_at` 晚 3 天整，UV Unwrap 示例里只晚 1 天）。
- 从中国大陆访问 `api.meshy.ai` 和 `assets.meshy.ai` 的可达性。
- Meshy 抓取 `image_url` / `model_url` 时的出口 IP、超时时间、是否跟随重定向：图生 3D、多图生 3D、文生 3D refine、Retexture 等页面
  官方文档未说明。只有 Creative Lab Keycap 页对它自己的 `image_url` 写了：会跟随 HTTP 重定向；按图片数据而不是 URL 里的扩展名判断格式
  （没有扩展名的 URL 也行）；会应用 EXIF 方向。不能假定其他接口也是这样。
- data URI 图片的 20 MB 上限按什么计算：图生 3D、多图生 3D、文生 3D refine、Retexture 页面官方文档未说明。
  只有 Creative Lab Keycap 页写明 20 MB 是 20,000,000 字节、按**解码后**的图片计算（base64 文本可以大约多三分之一），
  并要求 data URI 是带图片类型的 base64（如 `data:image/png;base64,...`）、解码后是 JPEG、PNG 或 WebP。
- data URI 的细节：声明的类型（如 `image/jpeg`）与实际图片格式不一致时是否报错、base64 里能否有换行、是否接受 URL-safe 字母表。官方文档未说明。
- 生成类接口（文生 3D、图生 3D、多图生 3D、Retexture）返回的各格式是否内嵌贴图：官方文档未说明。能找到的相关说法都不是针对这些接口的：
  Auto Split 页（`keep_texture: true` 时）写 `glb`、`fbx`、`usdz`、`blend` 的贴图在文件里，`obj` 的贴图在 `mtl` 材质文件里，
  `stl` 和 `3mf` 只有几何；文档站首页（`https://docs.meshy.ai`）的格式表写 GLB、USDZ、3MF 内嵌、FBX 是“Separate files”、OBJ 是“MTL + textures”，
  网页端的 Export and file formats 页也写 GLB 内嵌、FBX 和 OBJ 用单独的贴图文件；网页端术语表（`/webapp/glossary`）却写
  “Meshy exports FBX with embedded textures”。后三处出自文档站首页和网页端文档，不是 API 接口页。
- 生成类接口的 `mtl` 文件引用的贴图文件名是什么、下载 OBJ 后要把哪些贴图以什么文件名放在旁边：官方文档未说明
  （Creative Lab Figure 页对它自己的输出写的是把 `mtl` 与 `obj` 和 `texture_urls[0].base_color` 一起用）。
- 创建请求结果不明、用列表接口核对时，怎样认定列表里的某个任务就是那一次请求建的：官方文档未说明。
  图生 3D 和多图生 3D 的任务对象不回显输入图片；可以当作标记的 `name` 参数只出现在 OpenAPI 规范里。
- 下载链接（`assets.meshy.ai`）是否会重定向、是否支持 `Range` 断点续传、有没有下载次数或速率限制：官方文档未说明。
- `5xx` 的具体状态码和响应体形状（除 Rigging 的 `503` 外）。
- 对单个 data URI 请求体总大小的限制（只有图片 20 MB、模型 100 MB 的单文件上限）。

**本次没有逐项阅读的官方页面**

Text to Image、Image to Image、Multi-Color Print、Analyze / Repair Printability、Auto Split、Relief、
全部 Creative Lab 页面、AI Integration（MCP）、更新日志 2026 年 9 月之前的条目。
本文对它们的描述只来自 `llms.txt` 的索引摘要和定价页；例外是“未核实”里引用的 Keycap、Auto Split、Figure 页的个别句子，
这些句子是从对应页面原文读到的（见来源表）。

## 12. 来源

以下页面均在 2026-11-12 读取。

| URL | 提供的内容 |
| --- | --- |
| `https://docs.meshy.ai/llms.txt` | Base URL、鉴权、异步模型、SSE、状态、限流摘要、模型选择规则、常见错误做法（不要自动重发创建请求、没有幂等键）、页面索引 |
| `https://docs.meshy.ai/llms-full.txt` | 全文合集，没有通读。用于检索关键词（v2 路径、multipart、WebSocket、幂等、回调参数、测试 Key 等）；复核时还用它逐个比对了本文的行内代码标识符和代码块 |
| `https://docs.meshy.ai/openapi.yaml` | 路径清单、通用参数（分页、`X-Meshy-Metadata`）、响应头、错误体 schema、各请求 / 任务 schema、仅规范中出现的参数。`https://docs.meshy.ai/openapi.json` 是同一份规范的 JSON 版，路径清单一致 |
| `https://docs.meshy.ai/api/quick-start.md` | Key 创建、付费套餐要求、最小图生 3D 流程、轮询示例、下载方式 |
| `https://docs.meshy.ai/api/authentication.md` | Bearer 头格式、Key 积分上限、IP 白名单规则、HTTPS / 重定向行为 |
| `https://docs.meshy.ai/api/errors.md` | HTTP 状态码、错误体、`task_error` 字段、错误类型与错误码、重试建议 |
| `https://docs.meshy.ai/api/rate-limits.md` | 各套餐限流、`429` 消息、限流响应头 |
| `https://docs.meshy.ai/api/task-lifecycle.md` | 状态含义、典型耗时、超时与轮询建议值 |
| `https://docs.meshy.ai/api/asset-retention.md` | 3 天保留期、签名链接、`expires_at` |
| `https://docs.meshy.ai/api/pricing.md` | 各接口积分价格 |
| `https://docs.meshy.ai/api/models.md` | 几何 / 贴图模型对比、默认贴图模型、按用途推荐 |
| `https://docs.meshy.ai/api/deprecations.md` | 模型状态与下线日期、废弃参数、测试 Key 下线 |
| `https://docs.meshy.ai/api/changelog.md` | 2026 年 9～11 月的变更（`DELETE` 返回 `409`、限流头、`texture_model`、`meshy-7.1`、USDZ 单位等） |
| `https://docs.meshy.ai/api/webhooks.md` | Webhook 配置、请求头、负载、重试、去重要求 |
| `https://docs.meshy.ai/api/metadata.md` | `X-Meshy-Metadata` 头 |
| `https://docs.meshy.ai/api/developer-platform.md` | Playground、Free 套餐限制、Playground 消耗积分 |
| `https://docs.meshy.ai/api/text-to-3d.md` | 文生 3D preview / refine 参数、任务对象、示例、SSE 事件示例 |
| `https://docs.meshy.ai/api/image-to-3d.md` | 图生 3D 参数、任务对象、示例 |
| `https://docs.meshy.ai/api/multi-image-to-3d.md` | 多图生 3D 参数、任务对象、示例 |
| `https://docs.meshy.ai/api/retexture.md` | Retexture 参数、模型文件限制、任务对象、示例 |
| `https://docs.meshy.ai/api/remesh.md` | Remesh 参数、任务对象、示例 |
| `https://docs.meshy.ai/api/convert.md` | Convert 参数、任务对象、示例 |
| `https://docs.meshy.ai/api/resize.md` | Resize 参数、任务对象、示例 |
| `https://docs.meshy.ai/api/uv-unwrap.md` | UV Unwrap 参数、面数上限、任务对象、示例 |
| `https://docs.meshy.ai/api/rigging.md` | Rigging 参数、面数上限、`422` / `503`、任务对象、示例 |
| `https://docs.meshy.ai/api/animation.md` | Animation 参数、后处理、任务对象、动作库接口 |
| `https://docs.meshy.ai/api/animation-library.md` | 动作库说明。动作表本身是动态加载的，没有读到完整列表；该页的 Markdown 版写着完整动作表以 JSON 形式放在 `https://api.meshy.ai/web/public/animations/resources`，本文没有抓取它，也没有核对它的字段 |
| `https://docs.meshy.ai/api/text-to-motion.md` | Text to Motion 参数、任务对象、示例 |
| `https://docs.meshy.ai/api/balance.md` | Balance 响应字段与示例 |
| `https://docs.meshy.ai/api/usage.md` | Usage 参数、套餐限制、响应示例 |
| `https://www.meshy.ai/pricing` | 套餐月度积分与月付价格、Free 套餐无 API、Studio 的 14 天保留期说法、首月五折促销、各套餐的并发任务数与优先级（含 Free） |
| `https://docs.meshy.ai/api/ai.md` | 官方 MCP server 的出处（npm 包名、源码仓库 `https://github.com/meshy-dev/meshy-mcp-server`）。只读了这一部分 |
| `https://docs.meshy.ai/api/creative-lab-keycap.md` | 只读了 `image_url` 的参数说明：20 MB = 20,000,000 字节且按解码后的图片计算、跟随 HTTP 重定向、按图片数据判断格式、应用 EXIF 方向。只用来说明其他接口的页面没有这些话 |
| `https://docs.meshy.ai/llms-full.txt` 里的 Auto Split、Creative Lab Figure、文档站首页、`/webapp/guides/platform/export-formats`、`/webapp/glossary` 各节 | 只读了关于“贴图在文件里还是单独的文件”的几句话，用来说明生成类接口的页面没有写这一点 |
| `https://registry.npmjs.org/@meshy-ai/meshy-mcp-server`（0.6.11 版的发布包） | 复核用的第二来源，只读源码：各任务的路径前缀表、任务 `type` 的别名（`rig`、`animate`、`text-to-3d-preview`、`text-to-3d-refine`）、状态枚举、模型 ID、积分常量（贴图 10 / 8K 15、Ultra +5、Animation 3 / 动作、Text to Motion 10 / 3、Convert 1、Resize 1、UV Unwrap 5）、超时常量（`GET` 30 秒、`POST` 60 秒）、UV Unwrap 的 40,000 面上限、本地文件转 data URI 的做法 |
