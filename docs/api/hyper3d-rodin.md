# Hyper3D Rodin（Deemos）3D 生成 API

快照时间：2026-11-12。本文全部内容取自当天读取的 Hyper3D 官方文档与官方定价页（见文末“来源”），
并在同一天用各接口页内嵌的 OpenAPI 和官方 GitHub 仓库的源码逐项复核过路径、方法、参数名、取值、默认值和价格，
供不使用 SDK、直接写 HTTP 适配器的工程师使用。官方没有写明的内容一律放在“未核实”，不要按旧版文档或经验补全。

## 1. 概述

- Rodin 是 Deemos（Hyper3D）提供的异步 HTTP API，用图片或文本生成带贴图的 3D 资产。
- 当前文档覆盖的能力：
  - 文生 3D、图生 3D、多图生 3D：`POST /api/v2/rodin`。Gen-2.5、Gen-2、Gen-1/1.5 三个模型家族共用这一个路径，用 `tier` 区分。
  - Rodin Agentic（Beta）：`POST /api/v2/rodin_agentic`，由服务端自动选择生成方式。
  - 仅生成贴图：`POST /api/v2/rodin_texture_only`，给已有模型重新生成贴图。
  - Bang：`POST /api/v2/bang`，把一个模型拆成多个部件。
  - 绑骨与动画：`POST /api/v2/rigging`、`GET /api/v2/rigging_animations`。
  - 查询状态 `POST /api/v2/status`、获取下载链接 `POST /api/v2/download`、查询余额 `GET /api/v2/check_balance`。
  - 同步生成/编辑图片：`POST /api/v2/images`，可用于准备参考图。
- 官方文档入口：
  - 英文 `https://docs.hyper3d.ai/en`，中文 `https://docs.hyper3d.ai/zh`。
  - 旧地址 `https://developer.hyper3d.ai` 现在 301 跳转到 `https://docs.hyper3d.ai/`。更新日志写明 2026 年 7 月文档整体迁移到新站。
  - 每个文档页都有 Markdown 原文：`https://docs.hyper3d.ai/en/llms.mdx/<页面路径>/content.md`。它只有正文，不含参数表；
    参数表在页面 HTML 内嵌的 OpenAPI 3.2 片段里，本文的参数表以那份 OpenAPI 为准。
  - 定价页：`https://hyper3d.ai/pricing?lang=en`。

## 2. 接入

| 项目 | 内容 |
| --- | --- |
| Base URL | `https://api.hyper3d.com/api/v2`（文档首页原文：All API v2 endpoints use this base URL） |
| 服务器 | 各接口页内嵌的 OpenAPI 只声明一个 server：`https://api.hyper3d.com`（Production server） |
| 鉴权 | 请求头 `Authorization: Bearer YOUR_RODIN_API_KEY`，所有受保护接口相同 |
| Key 创建位置 | `https://hyper3d.ai/workspace/api-dashboard`（API dashboard） |
| 版本 | 路径中的 `/api/v2`。文档没有版本请求头，也没有日期版本号 |
| 请求格式 | 提交类接口（`/rodin`、`/rodin_agentic`、`/rodin_texture_only`、`/bang`、`/rigging`）在 OpenAPI 里都只声明 `multipart/form-data`，包括不带文件的 `asset_id` 请求；`/status`、`/download` 用 `application/json`；`/images` 文生图用 JSON、图片编辑用 multipart；响应均为 JSON |
| 测试 / 沙箱 Key | 文档没有提供 |

当前文档里没有出现 `hyperhuman.deemos.com`，现行主机是 `api.hyper3d.com`。
官方 GitHub 仓库的源码给出同样的结论：`DeemosTech/hyper3d-cli`（最后提交 2026-11-12）、`ComfyUI-Rodin`、`rodin3d-skills`、`rodin3d-bang-skills`
都用 `api.hyper3d.com`；只有较旧的 `rodin-api-mcp`（最后提交 2025-04）和 fork 来的 `blender-mcp-rodin-integration`（最后提交 2026-10-30）还写着
`https://hyperhuman.deemos.com/api/v2/...`。适配器只用 `api.hyper3d.com`。

API 访问级别（Quick Start 原文）：

- **Basic API access**：可调用 Rodin `Gen-2.5-Extreme-Low`、`Gen-2.5-Low` 和 rigging。Creator 订阅包含 Basic。
  必须显式传 `tier`，因为默认 tier 需要 Full 级别。
- **Full API access**：可调用所有 API 和所有 Rodin tier。Business、Unlimited 订阅包含 Full。预览功能的单独要求仍然适用。
- 状态查询和下载接受任一级别；下载仍受任务归属和文件权限约束。

各接口页内嵌的 OpenAPI 对访问级别的标注：

| 接口 | OpenAPI 的标注 |
| --- | --- |
| `POST /api/v2/rigging` | Requires Basic or Full API access |
| `POST /api/v2/download` | Requires Basic or Full API access；任务归属和文件权限仍然适用 |
| `POST /api/v2/rodin_texture_only` | Requires Full API access |
| `GET /api/v2/check_balance` | Requires Full API access |
| `/rodin`、`/rodin_agentic`、`/bang`、`/images`、`/status` | 接口描述里没有写访问级别，只能按上面 Quick Start 的总述理解，见“未核实” |

按这份标注，只有 Basic 级别的 Key 调不了 `check_balance` 和 `rodin_texture_only`；今天没有用真实 Key 验证。

## 3. 任务流程

1. **提交**：向生成类接口发 `multipart/form-data`。HTTP 201 且响应体没有 `error`（或为空）、顶层 `uuid` 非空，才算提交成功。
2. **轮询**：用提交响应里的 `jobs.subscription_key` 调 `POST /api/v2/status`，直到 `jobs` 里每一项都是 `Done`。
   任何一项为 `Failed` 就立即停止。
3. **下载**：用提交响应的**顶层** `uuid` 作为 `task_uuid` 调 `POST /api/v2/download`，拿到文件名和下载 URL 列表，再逐个下载。

提交响应里有三种 ID，用途不同，不能混用：

| 字段 | 用途 |
| --- | --- |
| 顶层 `uuid` | 任务 UUID。作为 `/download` 的 `task_uuid`；也可作为 Bang、Rigging 的 `asset_id` |
| `jobs.subscription_key` | 只用于 `/status` |
| `jobs.uuids[]` | 各子任务（job）的 UUID。官方示例里它与 `/status` 响应的 `jobs[].uuid` 是同一个值，但文档没有明说两者的对应关系；不能当作 `/status` 或 `/download` 的请求参数 |

把 ID 传错接口会返回 `NO_SUCH_TASK`：`/status` 只认 `subscription_key`，`/download` 只认顶层 `uuid`。

轮询节奏（官方建议）：首次查询至少等 5 秒；之后逐步退避，间隔最多 30 秒；收到 HTTP 429 时按 `Retry-After` 等待；
客户端自己设总超时（官方 Python 示例用 20 分钟）。
Quick Start 的 Python 示例的具体做法：提交后先等 5 秒做第一次查询，之后每次查询前的等待加 5 秒（5、10、15、20、25、30），
到 30 秒后不再增加；每个请求的超时是 60 秒（状态页和下载页的单独示例用 30 秒）。文档只给了这组建议值，
没有给“最小允许间隔”的硬性数值，超出时以 HTTP 429 和 `Retry-After` 为准。

其他通知方式：当前文档只描述轮询，没有 webhook、SSE、WebSocket 的任何说明。

结果有效期：

- 下载 URL：是带签名的短期 URL。文档原文为“Download URLs can expire, so fetch files promptly rather than storing the URLs”，
  schema 里的说明为“The URL is short-lived”，都没有给具体时长。拿到 URL 后立即下载并自行保存文件，不要持久化 URL。
  文档之外唯一的数字来自官方 `rodin3d-skills` 的 SKILL.md（“URLs expire in 10 minutes”），不是文档承诺，见“未核实”第 1 条。
- 数据保留政策（2026-08-03 生效）：API 请求内容和生成结果在线上系统保留固定 **7 天**，到期删除。
- 错误码 `NO_SUCH_TASK` 的含义里包含“任务不存在或已过期”。

## 4. 接口

所有路径都接在 `https://api.hyper3d.com` 之后。POST 接口成功时返回 **HTTP 201**，`GET /api/v2/check_balance` 返回 HTTP 200。

### 4.1 生成 3D：`POST /api/v2/rodin`

- Content-Type：`multipart/form-data`
- 文生 3D、图生 3D、多图生 3D 都用这个接口：
  - 图生 3D：传 1～5 个 `images`。`prompt` 可选，省略时服务端从图片推导；官方建议图生 3D 不传 `prompt`。
  - 文生 3D：传 `prompt`，不传 `images`。
  - 多图：重复 `images` 表单字段，表单顺序就是图片顺序。Gen-2.5 页面写明第一张图用于材质生成。
- **`tier` 必须显式传。** 省略时服务端回退到 `Regular`，生成的是 Gen-1/1.5 资产。

#### 请求参数

“适用”列：2.5 表示 Gen-2.5 页面列出，2 表示 Gen-2 页面列出，1 表示 Gen-1/1.5 页面列出。

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 适用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| `images` | 文件数组 | 图生 3D 必填 | 1～5 个文件 | 无 | 2.5 / 2 / 1 | 重复同名字段上传；文生 3D 不传 |
| `prompt` | string | 文生 3D 必填 | 长度 ≤ 1024 | 无 | 2.5 / 2 / 1 | 文生 3D 时先被渲染成图片，所以纯文本请求也可能返回 `IMAGE_CONTENT_VIOLATION` |
| `tier` | string | 是 | 见“模型版本” | `Regular` | 2.5 / 2 / 1 | 决定模型家族和细节档位，可能影响计费 |
| `seed` | integer | 否 | 0～65535 | 无 | 2.5 / 2 / 1 | 网格和贴图生成的随机种子 |
| `mesh_mode` | string | 否 | `Quad`、`Raw` | Gen-2.5 为 `Raw`，其余为 `Quad` | 2.5 / 2 / 1 | `Raw` 为三角面，`Quad` 为四边面 |
| `geometry_file_format` | string | 否 | `glb`、`usdz`、`fbx`、`obj`、`stl` | `glb` | 2.5 / 2 / 1 | 输出几何文件格式 |
| `material` | string | 否 | `PBR`、`Shaded`、`All`、`Hybrid`、`None` | `PBR` | 2.5 / 2 / 1 | 见“输出” |
| `quality` | string | 否 | `high`、`medium`、`low`、`extra-low` | `medium` | 2.5 / 2 / 1 | 目标面数预设，见下表 |
| `quality_override` | integer | 否 | 见下表 | 无 | 2.5 / 2 / 1 | 自定义目标面数，优先于 `quality` |
| `bbox_condition` | integer 数组 | 否 | 恰好 3 个整数，每个 1～2048 | 无 | 2.5 / 2 / 1 | 包围盒控制，顺序为宽 X、高 Y、长 Z，见 4.2 |
| `addons` | string 数组 | 否 | `HighPack` | `[]` | 2.5 / 2 / 1 | 提高打包贴图分辨率，见“输出” |
| `TAPose` | boolean | 否 |  | `false` | 2.5 / 2 / 1 | 人形主体以 T-pose 或 A-pose 生成，便于后续动画；`false` 时按输入姿态重建 |
| `use_original_alpha` | boolean | 否 |  | `false` | 2.5 / 2 / 1 | 预处理时保留并使用上传图片的 alpha 通道；图片没有 alpha 时无效 |
| `preview_render` | boolean | 否 |  | `false` | 2.5 / 2 / 1 | Gen-2.5 页面说明：下载列表里额外提供一张高质量渲染图，触发 Fast mode 时被忽略。Gen-2、Gen-1/1.5 页面只列出字段，没有文字说明 |
| `hd_texture` | boolean | 否 |  | `false` | 2.5 / 2 | 额外的贴图超分与增强，可能引入瑕疵；不决定最终 2K 还是 4K |
| `soft` | boolean | 否 |  | `false` | 2.5 / 2 | 给几何生成提示追加平滑边缘；官方建议不传 |
| `detail_level` | integer | 否 | 1～3 | 无 | 2.5 / 2 | 最终几何细化阶段中使用 RGB 图像条件的阶段数；官方建议不传 |
| `is_symmetric` | string | 否 | `symmetric`、`balanced`、`asymmetric`、`unknown` | `unknown` | 2.5 / 2 | 期望的几何对称性；`unknown` 由系统推断 |
| `quad_normal` | boolean | 否 |  | `false` | 2.5 / 2 | 网格细化时把高模细节烘焙到法线贴图 |
| `texture_mode` | string | 否 | `legacy`、`extreme-low`、`low`、`medium`、`high`、`extreme-high` | 取决于 `tier`，见下表 | 2.5 | 贴图生成力度，可能影响计费 |
| `uhd_texture` | boolean | 否 |  | `false` | 2.5 | 额外锐化贴图细节，可能影响贴图分辨率 |
| `texture_delight` | boolean | 否 |  | `false` | 2.5 | 生成贴图前去除参考图的高光和烘焙光照；官方建议不传 |
| `geometry_instruct_mode` | string | 否 | `faithful`、`creative` | `creative` | 2.5 | `faithful` 是实验选项，可能下线，不建议生产使用；可用性取决于 `tier`；官方建议不传 |
| `is_micro` | boolean | 否 |  | `false` | 2.5 | 微尺度表面细节。只允许 `tier=Gen-2.5-Extreme-High`，其他 tier 返回 `INVALID_REQUEST`；官方建议不传 |
| `image_label` | string 数组 | 否 | `F`、`FL`、`FR`、`L`、`R`、`B`、`BL`、`BR`、`U`、`D`、`?` | `[]` | 2.5 | 各图片的视角，按位置与 `images` 对应；不足的补 `?`；数量多于图片数返回 `IMAGE_LABEL_LENGTH_TOO_LONG` |
| `condition_mode` | string | 否 | `concat`、`fuse` | `concat` | 1 | 多图模式，只对 Gen-1/1.5 生效。`concat`：多张图是同一物体的多视角；`fuse`：融合多张图（可包含不同物体）的特征 |
| `mesh_simplify` | boolean | 否 |  | `true` | 1 | 只对 Gen-1/1.5 且 `mesh_mode=Raw` 生效；官方建议不传 |
| `mesh_smooth` | boolean | 否 |  | `false` | 1 | 只对 Gen-1/1.5 且 `mesh_mode=Quad` 生效；官方建议不传 |

`image_label` 取值含义：`F` 正面、`FL` 左前、`FR` 右前、`B` 背面、`BL` 左后、`BR` 右后、`L` 左、`R` 右、`U` 上、`D` 下、`?` 未知。

`quality` 预设对应的目标面数：

| 家族 | `mesh_mode` | `high` | `medium` | `low` | `extra-low` |
| --- | --- | --- | --- | --- | --- |
| Gen-2.5 | `Quad` | 50000 | 18000 | 8000 | 4000 |
| Gen-2.5 | `Raw` | 1000000 | 500000 | 60000 | 20000 |
| Gen-2 | `Quad` | 50000 | 18000 | 8000 | 4000 |
| Gen-2 | `Raw` | 500000 | 150000 | 20000 | 2000 |
| Gen-1/1.5 | `Quad` | 50000 | 18000 | 8000 | 4000 |
| Gen-1/1.5 | `Raw` | 50000 | 18000 | 8000 | 4000 |

`quality_override` 范围：

| 家族 | 范围 | 附加限制 |
| --- | --- | --- |
| Gen-2.5 | 500～2000000 | `Gen-2.5-High`、`Gen-2.5-Extreme-High` 最高 2000000；其他 Gen-2.5 tier 最高 1000000；`Quad` 模式最高 200000 |
| Gen-2 | 500～1000000 | `Quad` 模式最高 200000；`Raw` 模式最高 1000000 |
| Gen-1/1.5 | 500～200000 | 无 |

Gen-2.5 的 `texture_mode` 默认值：

| `tier` | 默认 `texture_mode` |
| --- | --- |
| `Gen-2.5-Extreme-Low` | `extreme-low` |
| `Gen-2.5-Low` | `low` |
| `Gen-2.5-Medium` | `medium` |
| `Gen-2.5-High` | `high` |
| `Gen-2.5-Extreme-High` | `high` |

Gen-2.5 Fast mode：同时满足以下条件时自动触发，生成更快，此时 `preview_render` 被忽略。

- `tier` 不是 `Gen-2.5-Extreme-High`；
- `geometry_file_format` 是 `glb`、`fbx` 或 `usdz`；
- `mesh_mode` 是 `Raw`；
- `quality_override` ≤ 20000。

#### 表单的写法（本地文件、标量、数组）

请求体是一个 `multipart/form-data`，每个参数是一个 part。

- **本地图片**：每张图一个文件 part，字段名固定是 `images`（示例里没有下标，也没有 `[]`），内容是图片文件的原始字节。
  - 官方 cURL 示例是 `--form 'images=@./input.png'`。Quick Start 的官方 Python 示例是
    `files={"images": ("input.png", image_file, "image/png")}`，即这个 part 带 `filename="input.png"` 和 `Content-Type: image/png`。
  - 内嵌 OpenAPI 把 `images` 的每一项声明为 `type: string`、`format: binary`、`contentMediaType: application/octet-stream`。
  - 文档没有说明服务端是否读取文件名、扩展名或 part 的 Content-Type。按官方 Python 示例发最稳妥：
    文件名带真实扩展名，Content-Type 用图片真实的 MIME。两个官方客户端的不同写法见“未核实”第 30 条。
- **多张图**：重复发多个 `images` part，最多 5 个。OpenAPI 原文说明表单请求会保留图片顺序
  （“the form data request will preserve the order of the images”），所以 part 的先后就是图片顺序。
- **文生 3D**：不发任何 `images` part，只发文本 part；官方示例仍然用 `--form`，即 `multipart/form-data`。
- **标量参数**：每个参数一个文本 part。布尔值写小写的 `true` / `false`（官方 Rigging cURL 示例 `in_place=true`；
  官方 `rodin3d-skills`、`ComfyUI-Rodin` 的源码都发 `str(x).lower()`）；整数写十进制文本（官方 Bang 示例 `strength=5`）。
- **数组参数** `addons`、`bbox_condition`、`image_label`：文档没有 multipart 示例，写法未核实，见“未核实”第 3 条。

#### 响应字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `error` | string | 提交被拒时的错误码。**与 HTTP 201 一起返回**；成功时不出现 |
| `message` | string | 成功信息（示例为 `Submitted.`）或错误详情 |
| `uuid` | string(uuid) | 任务 UUID |
| `submit_time` | string(date-time) | 服务器受理时间。schema 里有，官方手写示例里没有 |
| `jobs.uuids` | string(uuid) 数组 | 各 job 的 UUID |
| `jobs.subscription_key` | string | 查询状态用的 key |
| `consumed` | number | 本次请求消耗的积分 |
| `prompt` | string | 实际用于生成的提示词。schema 里有，官方手写示例里没有 |

#### 请求示例（官方原文）

图生 3D，Gen-2.5：

```bash
curl --fail-with-body --request POST 'https://api.hyper3d.com/api/v2/rodin' \
  --header "Authorization: Bearer ${RODIN_API_KEY}" \
  --form 'images=@./input.png' \
  --form 'tier=Gen-2.5-Medium' \
  --form 'mesh_mode=Raw' \
  --form 'quality=medium'
```

文生 3D，Gen-2.5：

```bash
curl --fail-with-body --request POST 'https://api.hyper3d.com/api/v2/rodin' \
  --header "Authorization: Bearer ${RODIN_API_KEY}" \
  --form 'prompt=A small wooden treasure chest with brass trim' \
  --form 'tier=Gen-2.5-Medium' \
  --form 'mesh_mode=Raw' \
  --form 'quality=medium'
```

Gen-2：

```bash
curl --fail-with-body --request POST 'https://api.hyper3d.com/api/v2/rodin' \
  --header "Authorization: Bearer ${RODIN_API_KEY}" \
  --form 'images=@./input.png' \
  --form 'tier=Gen-2' \
  --form 'mesh_mode=Raw' \
  --form 'quality=medium'
```

Gen-1/1.5：

```bash
curl --fail-with-body --request POST 'https://api.hyper3d.com/api/v2/rodin' \
  --header "Authorization: Bearer ${RODIN_API_KEY}" \
  --form 'images=@./input.png' \
  --form 'tier=Regular' \
  --form 'mesh_mode=Quad' \
  --form 'quality=medium'
```

#### 响应示例（官方原文）

```json
{
  "message": "Submitted.",
  "uuid": "123e4567-e89b-12d3-a456-426614174000",
  "jobs": {
    "uuids": ["223e4567-e89b-12d3-a456-426614174000"],
    "subscription_key": "subscription-key-from-generation-response"
  },
  "consumed": 0.5
}
```

提交被拒，仍是 HTTP 201：

```json
{
  "error": "API_INSUFFICIENT_FUNDS",
  "message": "The fund in your wallet is insufficient to perform this operation."
}
```

### 4.2 包围盒控制 `bbox_condition`

`/api/v2/rodin` 的附加参数，用长宽高约束生成模型的比例，让模型落在指定盒子内。

- 恰好 3 个值，固定顺序 `(x, y, z)`：宽（X 轴）、高（Y 轴）、长（Z 轴）。
- 每个值是 1～2048 的整数。
- 坐标系：+x 为宽，+y 为高，+z 为长。

官方给出的取值写法：

```json
{
  "bbox_condition": [100, 100, 100]
}
```

### 4.3 Rodin Agentic（Beta）：`POST /api/v2/rodin_agentic`

由 AI 自动判断最合适的生成方式，结果有不确定性。只支持图片输入。

- Content-Type：`multipart/form-data`

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `images` | 文件数组 | 是 | 1～5 个，每个最大 25 MiB | 无 | 参考图 |
| `prompt` | string | 否 | 长度 ≤ 1024 | `""` | 省略或为空时由服务端从图片推导 |
| `tier` | string | 否 | `basic`、`standard`、`pro` | `standard` | 见下表 |
| `export_type` | string | 否 | `glb`、`usdz`、`fbx`、`stl` | `glb` | 最终导出格式，没有 `obj`。schema 说明：两种 producer 都按这个格式导出，走 Rodin 路径时使用 `All` 材质和 `High` 贴图分辨率 |

| `tier` | 说明 | 官方标注耗时 | 计费 |
| --- | --- | --- | --- |
| `basic` | 较低思考强度，优先速度 | 3 分钟 | 0.5 credits |
| `standard` | 思考强度与速度平衡，适合大多数场景 | 5 分钟 | 1.0 credits |
| `pro` | 更强思考强度，耗时更长，质量更高 | 10 分钟 | 2.0 credits |

响应字段。注意这里是 `job`，不是 `jobs`，而且没有 `consumed`、`message`、`error`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `uuid` | string(uuid) | 任务 UUID，用于 `/download` |
| `job.uuids` | string(uuid) 数组 | 各 job 的 UUID |
| `job.subscription_key` | string | 用于 `/status` |
| `producer` | string | `high-poly` 表示走 Rodin 路径，`n-gons` 表示走 agentic 路径 |

请求示例：

```bash
curl --fail-with-body --request POST 'https://api.hyper3d.com/api/v2/rodin_agentic' \
  --header "Authorization: Bearer ${RODIN_API_KEY}" \
  --form 'images=@./input.png' \
  --form 'tier=standard' \
  --form 'export_type=glb'
```

响应示例：

```json
{
  "uuid": "123e4567-e89b-12d3-a456-426614174000",
  "producer": "high-poly",
  "job": {
    "uuids": ["223e4567-e89b-12d3-a456-426614174000"],
    "subscription_key": "subscription-key-from-generation-response"
  }
}
```

### 4.4 仅生成贴图：`POST /api/v2/rodin_texture_only`

给上传的 3D 模型按参考图生成贴图。恰好上传一张参考图和一个模型，两者都必填。OpenAPI 标注本接口需要 Full API access。

- Content-Type：`multipart/form-data`

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `image` | 文件 | 是 | 恰好 1 个 | 无 | 贴图参考图。格式：JPEG、PNG、WebP、TIFF、GIF、AVIF、HEIC、HEIF、BMP、JPEG 2000 |
| `model` | 文件 | 是 | 恰好 1 个 | 无 | 待贴图模型。格式：OBJ、STL、glTF/GLB、FBX、USDZ |
| `prompt` | string | 否 | 长度 ≤ 1024 | 无 | 描述期望的颜色、材质和表面细节，与参考图共同引导 |
| `escore` | number | 否 | 0～10 | 3.5 | 贴图复杂度和丰富度；越高细节和变化越多，越低越干净平坦 |
| `reference_scale` | number | 否 | 0.5～1 | 1 | 贴图跟随参考图的强度 |
| `seed` | integer | 否 | 0～65535 | 随机 | 随机种子 |
| `geometry_file_format` | string | 否 | `glb`、`usdz`、`fbx`、`obj`、`stl` | `glb` | 输出几何文件格式 |
| `material` | string | 否 | `PBR`、`Shaded`、`All`、`Hybrid` | `PBR` | 输出的材质类型，本接口没有 `None`。枚举取自内嵌 OpenAPI；同一页的正文只写了“accepts `PBR`, `Shaded`, or `All`”，没有提 `Hybrid`，见“未核实” |
| `resolution` | string | 否 | `Basic`、`High` | `Basic` | 输出贴图分辨率，见下表 |
| `hd_texture` | boolean | 否 |  | `false` | 贴图超分增强细节，与最终打包分辨率无关 |
| `texture_delight` | boolean | 否 |  | `false` | 生成前去除参考图的高光和烘焙光照 |
| `texture_mode` | string | 否 | `legacy`、`extreme-low`、`low`、`medium`、`high`、`extreme-high` | `high` | 贴图生成力度，可能影响计费 |

输出贴图分辨率：

| `texture_mode` | `resolution` | 输出分辨率 |
| --- | --- | --- |
| `legacy`、`extreme-low`、`low`、`medium`、`high` | `Basic` | 2K |
| `legacy`、`extreme-low`、`low`、`medium`、`high` | `High` | 4K |
| `extreme-high` | `Basic` | 6K |
| `extreme-high` | `High` | 12K |

响应字段与 4.1 相同：`error`、`message`、`uuid`、`submit_time`、`jobs`、`consumed`，没有 `prompt`。ID 用法也相同。

请求示例：

```bash
curl --fail-with-body --request POST 'https://api.hyper3d.com/api/v2/rodin_texture_only' \
  --header "Authorization: Bearer ${RODIN_API_KEY}" \
  --form 'image=@./reference.png' \
  --form 'model=@./model.glb' \
  --form 'material=PBR' \
  --form 'resolution=Basic'
```

响应示例：

```json
{
  "message": "Submitted.",
  "uuid": "123e4567-e89b-12d3-a456-426614174000",
  "jobs": {
    "uuids": ["223e4567-e89b-12d3-a456-426614174000"],
    "subscription_key": "subscription-key-from-generation-response"
  },
  "consumed": 0.5
}
```

### 4.5 Bang（拆分部件）：`POST /api/v2/bang`

把模型拆成多个部件。两种输入方式二选一：`asset_id` 或 `model`。两个都传或都不传会被拒绝。

- Content-Type：`multipart/form-data`
- **Rodin 资产输入**：`asset_id` 填一个已完成的 Rodin 生成任务的顶层 `uuid`。此时必须省略 `model`、`image`、`prompt`。
  请求里的 `escore`、`reference_scale` 会覆盖该资产保存的设置。
- **自定义模型输入**：上传一个 `model`。除非 `material=None`，否则必须同时上传参考 `image`，
  缺少时返回 `INVALID_REQUEST`。此时必须省略 `asset_id`。

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `asset_id` | string(uuid) | 与 `model` 二选一 |  | 无 | 已完成的 Rodin 生成任务的顶层 `uuid` |
| `model` | 文件 | 与 `asset_id` 二选一 | `obj`、`glb`、`stl`、`fbx`、`usd`、`usda`、`usdz`、`usdc` | 无 | 待拆分的模型 |
| `image` | 文件 | 视情况 |  | 无 | 自定义模型的参考图。用 `model` 且 `material` 不是 `None` 时必填；用 `model` 且使用 `instruction` 时必填 |
| `prompt` | string | 否 |  | 无 | 附加参考提示，只在使用 `model` 时生效 |
| `strength` | integer | 否 | 1～12 | 5 | 拆分强度，越大部件越多 |
| `escore` | number | 否 | 0～10 | 3.5 | 贴图复杂度和丰富度，两种输入方式都生效 |
| `reference_scale` | number | 否 | 0～1 | 0.5 | 贴图跟随参考图的强度，两种输入方式都生效 |
| `seed` | integer | 否 | 0～65535 | 随机 | 随机种子 |
| `geometry_file_format` | string | 否 | `glb`、`usdz`、`fbx`、`obj`、`stl` | `glb` | 输出几何文件格式 |
| `material` | string | 否 | `PBR`、`Shaded`、`All`、`Hybrid`、`None` | `PBR` | 材质类型 |
| `resolution` | string | 否 | `Basic`、`High` | `Basic` | 贴图分辨率，`Basic` 为 2K，`High` 为 4K |
| `instruction` | string | 否 |  | 无 | 非空时启用指令模式，按指令拆分模型 |
| `quality_override` | integer | 否 | 500～2000000 | 无 | 所有输出部件合计的目标面数，不是每个部件的面数，会覆盖源资产的设置。省略时用 Gen-2 medium：Quad 18000，Raw 150000。Raw 网格只在超过目标时才简化；Quad 模式上限 50000 |
| `mesh_mode` | string | 否 | `Quad`、`Raw` | `Raw` | 网格拓扑 |

响应字段与 4.4 相同。

请求示例，Rodin 资产输入：

```bash
curl --fail-with-body --request POST 'https://api.hyper3d.com/api/v2/bang' \
  --header "Authorization: Bearer ${RODIN_API_KEY}" \
  --form 'asset_id=123e4567-e89b-12d3-a456-426614174000' \
  --form 'strength=5' \
  --form 'geometry_file_format=glb'
```

请求示例，自定义模型输入：

```bash
curl --fail-with-body --request POST 'https://api.hyper3d.com/api/v2/bang' \
  --header "Authorization: Bearer ${RODIN_API_KEY}" \
  --form 'model=@./model.glb' \
  --form 'image=@./reference.png' \
  --form 'prompt=Separate the main structural parts' \
  --form 'strength=5' \
  --form 'geometry_file_format=glb'
```

响应示例：

```json
{
  "message": "Submitted.",
  "uuid": "123e4567-e89b-12d3-a456-426614174000",
  "jobs": {
    "uuids": ["223e4567-e89b-12d3-a456-426614174000"],
    "subscription_key": "subscription-key-from-generation-response"
  },
  "consumed": 0.5
}
```

### 4.6 绑骨与动画：`POST /api/v2/rigging`

给 Rodin 资产或上传的模型绑定骨骼，可选附带动画。需要 Basic 或 Full API 访问级别。
两种输入方式二选一：`asset_id` 或 `model`。两个都传或都不传会被拒绝。

- Content-Type：`multipart/form-data`

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `asset_id` | string(uuid) | 与 `model` 二选一 |  | 无 | 当前 API Key 用户名下 Rodin 任务的顶层 `uuid`，见下方限制 |
| `model` | 文件 | 与 `asset_id` 二选一 | `obj`、`glb`、`stl`、`fbx`、`usd`、`usda`、`usdz`、`usdc` | 无 | 自包含、资源内嵌的模型。保留几何拓扑、材质和贴图，不重拓扑、不生成贴图。整个文件当作一个角色 |
| `image` | 文件 | 否 | JPG、PNG、WebP | 无 | 参考图。上传的图片优先于源资产的图片 |
| `bone_template` | string | 否 | `auto`、`human`、`quadruped`、`bird`、`dragon`、`kaiju`、`custom` | `auto` | 骨骼模板，区分大小写 |
| `skinning_method` | string | 否 | `shell`、`core` | `shell` | `shell` 表面优先、更通用；`core` 结构优先，专门针对人形角色优化 |
| `hierarchy` | JSON 数组字符串 | `custom` 时与 `skeleton_description` 二选一 | 1～256 个节点 | 无 | 自定义骨架，见下方 |
| `skeleton_description` | string | `custom` 时与 `hierarchy` 二选一 | 非空白 | 无 | 用自然语言描述身体结构和四肢 |
| `animation_preset` | string 数组 | 否 | 最多 10 个，不可重复 | 无 | 预置动画 ID，取自 `GET /api/v2/rigging_animations` 的 `animation_id`。与 `animation_files` 互斥 |
| `animation_files` | 文件数组 | 否 | 最多 10 个 FBX，每个最大 25 MiB | 无 | 每个文件恰好包含一个动画片段（Take）。与 `animation_preset` 互斥 |
| `in_place` | boolean | 否 |  | `false` | 循环的预置动画原地导出；非循环动画不变。不能和 `animation_files` 一起用 |
| `export_skeleton_type` | string | 否 | `rodin`、`ue5`、`unity`、`actorcore` | `rodin` | FBX 导出骨架，不区分大小写，见下表 |
| `material` | string | 否 | `PBR`、`Shaded`、`All`、`None` | 见说明 | 上传 `model` 时忽略。用 `asset_id` 时：已有确认贴图则默认 `PBR` 并复用，否则默认 `None` |
| `geometry_file_format` | string | 否 | `glb`、`fbx`、`usdz` | `glb` | 绑骨后模型的格式 |

`asset_id` 的限制：模型必须已确认，任务必须处于 ModelRefine、TextureGenerate 或 TextureRefine 阶段。
不支持导入的模型，也不支持由“仅生成贴图”接口创建的资产。源资产不会被修改。
用上传 `model` 创建的 Rigging 任务，其返回的 `uuid` 不能再作为任何后续任务（包括另一次 Rigging）的 `asset_id`。

`bone_template` 规则：

- `auto` 或省略：从图片里选出 `human`、`quadruped`、`bird`、`dragon`、`kaiju` 中最接近的一个。
  上传的 `image` 优先于源资产的输入图；两者都没有时，从模型渲染一张预览图用于选模板。不要传 `hierarchy` 或 `skeleton_description`。
- 预置模板 `human`、`quadruped`、`bird`、`dragon`、`kaiju`：不要传 `hierarchy` 或 `skeleton_description`。
- `custom`：必须且只能传 `hierarchy` 或 `skeleton_description` 中的一个。

`material` 与贴图：用 `asset_id` 且贴图未确认时，要在绑骨前生成贴图，需把 `material` 设为 `PBR`、`Shaded` 或 `All`，
并且源资产没有参考图时要上传 `image`。自动渲染的预览图不能代替这张贴图参考图。只传 `image` 不会触发贴图生成。上传的模型永远不会生成新贴图。

`hierarchy` 节点字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 是 | 非空白，且在列表内唯一 |
| `parent` | number | 是 | 父节点的从 0 开始的下标，根节点为 `-1`。不能以自己为父节点，不能成环 |
| `transform` | number 数组 | 否 | 文档没有给出说明 |
| `length` | number | 否 | 沿节点本地 +Y 轴的骨骼长度，单位是输入模型的坐标单位。必须为正且有限；省略则自动计算；`0` 和 `null` 无效 |

`export_skeleton_type`：

| 取值 | 导出骨架 |
| --- | --- |
| `rodin`（默认） | 保留原始骨架 |
| `ue5` | Manny/Quinn 命名，89 根骨骼，Z 轴向上，厘米 |
| `unity` | Unity Humanoid，59 根骨骼 |
| `actorcore` | ActorCore/CC，101 根骨骼，Y 轴向上，厘米 |

非 `rodin` 取值要求：使用 `asset_id`（不支持上传模型）、`geometry_file_format=fbx`，并且本次请求生成的是标准人形骨架。
这些导出始终对齐地面，带不带动画都支持。骨架不兼容会导致任务被取消。

动画规则：

- `animation_preset` 的 ID 小写且区分大小写，例如 `human_000093`、`canine_000001`，要选与目标骨架兼容的动画。
  可以传一个 ID、重复该表单字段传多个 ID，或传一个 JSON 数组字符串。
  schema 对每个 ID 的格式约束是 `^(?:[A-Za-z][A-Za-z0-9_]*\/[A-Za-z0-9_-]+|[A-Za-z]+_\d{6})$`。
- `animation_files` 必须已经匹配目标骨架，按原样使用，不做自动重定向。
- 两个字段都不传时导出不带动画。

响应字段与 4.4 相同，其中 `consumed` 的含义不同：提交时预留，打包成功后扣费，任务失败或被取消时释放。
schema 里它的示例值是 `0`，页面手写示例是 `0.5`。

请求示例，Rodin 资产加预置骨架和预置动画：

```bash
curl --fail-with-body --request POST 'https://api.hyper3d.com/api/v2/rigging' \
  --header "Authorization: Bearer ${RODIN_API_KEY}" \
  --form 'asset_id=123e4567-e89b-12d3-a456-426614174000' \
  --form 'bone_template=human' \
  --form 'animation_preset=human_000069' \
  --form 'in_place=true' \
  --form 'geometry_file_format=fbx'
```

请求示例，上传模型加自定义骨架：

```bash
curl --fail-with-body --request POST 'https://api.hyper3d.com/api/v2/rigging' \
  --header "Authorization: Bearer ${RODIN_API_KEY}" \
  --form 'model=@./model.glb' \
  --form 'image=@./reference.png' \
  --form 'bone_template=custom' \
  --form 'hierarchy=[{"name":"root","parent":-1},{"name":"spine","parent":0},{"name":"head","parent":1}]' \
  --form 'geometry_file_format=glb'
```

响应示例：

```json
{
  "message": "Submitted.",
  "uuid": "123e4567-e89b-12d3-a456-426614174000",
  "jobs": {
    "uuids": ["223e4567-e89b-12d3-a456-426614174000"],
    "subscription_key": "subscription-key-from-generation-response"
  },
  "consumed": 0.5
}
```

轮询要等到所有 job（包括打包）都是 `Done`，再用**新任务**的顶层 `uuid` 调 `/download`。
不要用源 `asset_id` 或单个 job 的 UUID 去下载。

### 4.7 动画目录：`GET /api/v2/rigging_animations`

列出可用的预置动画，鉴权方式与生成接口相同。返回扁平数组，顺序与源目录一致。

| 查询参数 | 类型 | 必填 | 取值 | 说明 |
| --- | --- | --- | --- | --- |
| `category` | string | 否 | `human`、`canine`、`bird`、`fish`、`heavyhooved`、`leanhooved`、`lizard`、`rodentia`、`seaturtle` | 小写且区分大小写；省略则返回全部分类 |

响应数组元素：

| 字段 | 说明 |
| --- | --- |
| `animation_id` | 永久 ID，传给 `animation_preset` |
| `category` | 分类 |
| `display_name` | 显示名 |
| `content_description` | 内容描述 |
| `frames` | 30 FPS 下的采样数，包含首尾两端 |
| `duration_seconds` | 采样时长 |
| `loop.kind` | `none`、`in_place` 或 `travel` |
| `loop.alignment` | `none`、`duplicate` 或 `next` |
| `loop.period_frames` | 循环周期帧数，可能为 `null` |
| `loop.displacement` | 每次循环的世界空间位移，单位米，顺序 `[x, y, z]` |

请求示例：

```bash
curl "https://api.hyper3d.com/api/v2/rigging_animations?category=human" \
  -H "Authorization: Bearer $RODIN_API_KEY"
```

响应示例：

```json
[
  {
    "animation_id": "human_000017",
    "category": "human",
    "display_name": "flare",
    "content_description": "Breakdance flare spin",
    "frames": 31,
    "duration_seconds": 1.0,
    "loop": {
      "kind": "in_place",
      "alignment": "duplicate",
      "period_frames": 30,
      "displacement": [0.0, 0.0, 0.0]
    }
  },
  {
    "animation_id": "canine_000002",
    "category": "canine",
    "display_name": "run",
    "content_description": "Galloping at full speed",
    "frames": 24,
    "duration_seconds": 0.7666666666666667,
    "loop": {
      "kind": "in_place",
      "alignment": "duplicate",
      "period_frames": 23,
      "displacement": [0.0, 0.0, 0.0]
    }
  }
]
```

### 4.8 查询状态：`POST /api/v2/status`

- Content-Type：`application/json`
- 成功查询返回 HTTP 201。

| 请求参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `subscription_key` | string | 是 | 提交响应里的 `jobs.subscription_key`（Agentic 为 `job.subscription_key`）。不要传顶层 `uuid` 或 `jobs.uuids` 里的值 |

| 响应字段 | 类型 | 说明 |
| --- | --- | --- |
| `jobs[]` | 数组 | 任务下的各个 job |
| `jobs[].uuid` | string(uuid) | job 的 UUID |
| `jobs[].status` | string | `Waiting`、`Generating`、`Done`、`Failed` |
| `jobs[].queue_length` | integer | 只在排队时可能出现，表示前面大约还有多少个 job；离开队列后不再返回 |
| `error` | string | 只可能是 `NO_SUCH_TASK`；成功时不出现 |
| `message` | string | 附加的状态或错误说明 |

请求示例：

```bash
curl --fail-with-body --request POST 'https://api.hyper3d.com/api/v2/status' \
  --header "Authorization: Bearer ${RODIN_API_KEY}" \
  --header 'Content-Type: application/json' \
  --data '{"subscription_key":"subscription-key-from-generation-response"}'
```

响应示例（官方原文）：

```json
{
  "jobs": [
    {
      "uuid": "223e4567-e89b-12d3-a456-426614174000",
      "status": "Done"
    }
  ]
}
```

排队中的形态。这是文档页按 schema 自动生成的样例里的 job 结构，不是官方手写示例：

```json
{
  "jobs": [
    {
      "uuid": "123e4567-e89b-12d3-a456-426614174000",
      "status": "Waiting",
      "queue_length": 0
    }
  ]
}
```

### 4.9 获取下载链接：`POST /api/v2/download`

- Content-Type：`application/json`
- HTTP 201 返回当前可用的文件。只在所有 job 都是 `Done` 之后调用；接口**不保证**会拒绝尚未完成的任务，
  所以不能用“download 返回了内容”来判断任务完成。

| 请求参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `task_uuid` | string(uuid) | 是 | 提交响应的顶层 `uuid`，不是 `jobs.subscription_key` |

| 响应字段 | 类型 | 说明 |
| --- | --- | --- |
| `list[]` | 数组 | 可下载的文件列表 |
| `list[].name` | string | 结果文件的可读文件名 |
| `list[].url` | string | 带签名的下载 URL，短期有效，应立即下载而不是保存 URL |
| `error` | string | `NO_SUCH_TASK` 或 `INVALID_REQUEST`；成功时不出现 |

实现时要注意的几点：

- 请求体只有 `task_uuid` 一个字段，不能指定格式，也不能只取某一个文件；返回的是这个任务当前可下载的全部文件。
- 列表项只有 `name` 和 `url`，没有类型、大小、角色字段。哪个是主模型、哪些是贴图或预览图，只能靠 `name` 的扩展名判断；
  列表里有什么文件、顺序如何，文档没有写，见第 7 节和“未核实”第 14 条。
- 取文件：文档只说 `url` 是带签名的 URL。两个官方客户端（`ComfyUI-Rodin`、`rodin3d-skills`）都是对它直接发 `GET`，
  不带 `Authorization` 头；`ComfyUI-Rodin` 保存前只取 `name` 里最后一个 `/` 之后的部分。适配器同样不要把 API Key 发给下载地址，
  并且不要把 `name` 原样当作本地路径。
- 重复调用 `/download` 是否返回新签发的 URL，文档没有说明，见“未核实”第 31 条。

请求示例：

```bash
curl --fail-with-body --request POST 'https://api.hyper3d.com/api/v2/download' \
  --header "Authorization: Bearer ${RODIN_API_KEY}" \
  --header 'Content-Type: application/json' \
  --data '{"task_uuid":"123e4567-e89b-12d3-a456-426614174000"}'
```

响应示例：

```json
{
  "list": [
    {
      "name": "model.glb",
      "url": "https://example.invalid/download/model.glb"
    }
  ]
}
```

### 4.10 查询余额：`GET /api/v2/check_balance`

- 成功返回 HTTP 200。
- OpenAPI 标注本接口需要 Full API access。按这份标注，只有 Basic 级别的 Key 不能用它查余额。

| 查询参数 | 类型 | 必填 | 取值 | 说明 |
| --- | --- | --- | --- | --- |
| `usage_page` | number | 否 | ≥ 1 | 从 1 开始的用量历史页码。传了才返回 `usage`，每页最多 20 条，从新到旧 |

| 响应字段 | 类型 | 说明 |
| --- | --- | --- |
| `balance` | number | 账户剩余积分。并发任务会同时扣减，只能当作某一时刻的读数，不是预留额度 |
| `usage[]` | 数组 | 只在传了 `usage_page` 时返回 |
| `usage[].time` | string(date-time) | 用量记录时间 |
| `usage[].item` | string 或 null | 计费项，示例值 `api_generation_rodin` |
| `usage[].amount` | number | 这条记录消耗的积分 |
| `usage[].task_uuid` | string(uuid) 或 null | 关联的任务 UUID，有则返回 |
| `usage[].api_key_id` | integer、uuid 字符串或 null | 产生这笔用量的 API Key 的 ID；Key 被删除后仍保留。schema 示例值 `123` |
| `usage[].api_key_description` | string 或 null | 来源 API Key 当前的描述；来源未知或 Key 已删除时为 null。schema 示例值 `Production` |
| `error` | string | 错误码；成功时不出现 |

请求示例：

```bash
curl --fail-with-body 'https://api.hyper3d.com/api/v2/check_balance?usage_page=1' \
  --header "Authorization: Bearer ${RODIN_API_KEY}"
```

响应示例（官方原文；schema 里 `usage` 元素还有 `api_key_id`、`api_key_description` 两个字段，手写示例没有列出）：

```json
{
  "balance": 10,
  "usage": [
    {
      "time": "2026-08-05T08:30:00.000Z",
      "item": "api_generation_rodin",
      "amount": 5,
      "task_uuid": "123e4567-e89b-12d3-a456-426614174000"
    }
  ]
}
```

### 4.11 同步生成 / 编辑图片：`POST /api/v2/images`

不是 3D 接口，但可以用来准备参考图。**同步**返回，HTTP 201 直接带回一张 base64 图片，不需要轮询或下载。每次 0.5 credits。
内嵌 OpenAPI 的接口摘要写的是“Generate or edit images with Qwen Image 2.0”。

| 模式 | Content-Type | 用途 |
| --- | --- | --- |
| 文生图 | `application/json` | 只用提示词生成图片 |
| 图片编辑 | `multipart/form-data` | 编辑或变换一张或多张参考图 |

| 参数 | 类型 | 必填 | 取值 / 范围 | 默认 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `prompt` | string | 是 |  | 无 | 生成或编辑指令 |
| `size` | string | 否 | `WIDTHxHEIGHT`，总像素在 512×512 到 2048×2048 之间 | 文生图为 `2048x2048`；编辑时与最后一张输入图一致 | 输出尺寸 |
| `images` | 文件数组 | 否 | 最多 3 个，每个最大 10 MiB，PNG、JPEG、WebP | 无 | 只能用 multipart 上传；文生图不传 |

| 响应字段 | 说明 |
| --- | --- |
| `created` | 请求的 Unix 时间戳，单位秒 |
| `data[0].b64_json` | base64 图片字节，没有 data URL 前缀。`data` 恰好 1 个元素 |
| `data[0].revised_prompt` | 模型改写后的提示词，可能不存在 |
| `consumed` | 本次消耗的积分，固定 `0.5` |
| `error` | 失败时的错误码；成功时不出现 |
| `message` | 失败时的说明；成功时不出现 |

请求示例，文生图：

```bash
curl --fail-with-body --request POST 'https://api.hyper3d.com/api/v2/images' \
  --header "Authorization: Bearer ${RODIN_API_KEY}" \
  --header 'Content-Type: application/json' \
  --data '{
    "prompt": "A majestic snowy owl perched on a frost-covered branch, soft golden hour lighting, hyper-detailed feathers",
    "size": "1024x1024"
  }'
```

请求示例，图片编辑：

```bash
curl --fail-with-body --request POST 'https://api.hyper3d.com/api/v2/images' \
  --header "Authorization: Bearer ${RODIN_API_KEY}" \
  --form 'prompt=Add a glowing crescent moon behind the castle, atmospheric fog' \
  --form 'size=1024x1024' \
  --form 'images=@./castle.png'
```

响应示例：

```json
{
  "created": 1728547200,
  "data": [
    {
      "b64_json": "iVBORw0KGgoAAAANSUhEUgAA...",
      "revised_prompt": "A majestic snowy owl perched on a frost-covered branch, soft golden hour lighting, hyper-detailed feathers, photorealistic, 4k"
    }
  ],
  "consumed": 0.5
}
```

### 4.12 文档里不存在的接口

当前文档没有以下接口，适配器不要假设它们存在：

- 取消任务。
- 任务列表或按任务 UUID 查询任务详情。唯一接近的是 `check_balance?usage_page=N` 的用量记录。
- 单独的文件上传接口或上传 token。图片和模型都是在提交请求里直接以 multipart 文件上传。
- 独立的 refine、remesh、格式转换接口。面数、拓扑和导出格式都是提交时的参数。
- webhook 或回调注册。

两个容易混淆的官方来源：

- 官方 CLI（`DeemosTech/hyper3d-cli`）走的不是本文的 REST 接口，而是另一套 MCP 接口（默认 `https://api.hyper3d.com/api/mcp`，
  OAuth Device Flow 登录，不用 API Key）。它的工具里有预签名上传（`rodin_create_uploads`）、分阶段进度（`stage`）、
  带 `role` 和 `mime_type` 的结果文件列表，这些在 REST 文档里都没有对应的接口或字段，不要把两套混用。
- 官方 ComfyUI 插件（`DeemosTech/ComfyUI-Rodin`，最后提交 2026-05）里调用了 `POST /api/v2/polygen`。
  今天的文档站没有这个接口的页面（`/en/api-specification/polygen` 返回 404），见“未核实”。

## 5. 状态与进度

状态是按 job 给出的，一个任务有一个或多个 job。

| `status` | 含义 | 是否终态 |
| --- | --- | --- |
| `Waiting` | 排队中，或在等它依赖的 job | 否 |
| `Generating` | 有 worker 正在执行 | 否 |
| `Done` | 这个 job 的结果可以下载 | 是 |
| `Failed` | job 已停止，不会产出结果。OpenAPI 描述为“the job was cancelled and will not produce results” | 是 |

- 任务成功的判定：`jobs` 非空，且**每一项**都是 `Done`。
- 任务失败的判定：**任一项**为 `Failed`，立即停止轮询。
- 进度：没有百分比进度字段。唯一的进度信息是 `Waiting` 时可能出现的 `queue_length`（前面大约的 job 数）。
- `/status` 响应里没有失败原因字段，只有可选的顶层 `message`。

## 6. 输入限制

| 项目 | 限制 | 出处 |
| --- | --- | --- |
| `/rodin` 图片数量 | 1～5 张 | Gen-2.5、Gen-2、Gen-1/1.5 页面 |
| `/rodin` 提示词长度 | ≤ 1024 | 同上 |
| `/rodin` 图片格式、单图大小、分辨率 | 文档没有写 | 见“未核实” |
| `/rodin_agentic` 图片 | 1～5 张，每张最大 25 MiB；提示词 ≤ 1024 | Agentic 页面 |
| `/rodin_texture_only` 参考图 | 恰好 1 张；JPEG、PNG、WebP、TIFF、GIF、AVIF、HEIC、HEIF、BMP、JPEG 2000 | Generate Texture 页面 |
| `/rodin_texture_only` 模型 | 恰好 1 个；OBJ、STL、glTF/GLB、FBX、USDZ；提示词 ≤ 1024 | 同上 |
| `/bang` 模型 | `obj`、`glb`、`stl`、`fbx`、`usd`、`usda`、`usdz`、`usdc` | Bang 页面 |
| `/rigging` 模型 | 同 Bang 的 8 种格式；必须自包含、资源内嵌 | Rigging 页面 |
| `/rigging` 参考图 | JPG、PNG、WebP | 同上 |
| `/rigging` 动画文件 | 最多 10 个 FBX，每个最大 25 MiB，每个文件恰好一个片段 | 同上 |
| `/rigging` 自定义骨架 | 1～256 个节点 | 同上 |
| `/images` 参考图 | 最多 3 张，每张最大 10 MiB，PNG、JPEG、WebP | Generate Images 页面 |
| `seed` | 0～65535 | 各页面 |
| `bbox_condition` | 3 个整数，每个 1～2048 | BBOX Control 页面 |

图片的传入方式：所有接口的图片和模型字段在 schema 里都是二进制文件（`format: binary`），示例全部是 multipart 文件上传。
文档没有提到用 URL、base64 data URI 或预上传 token 传图。适配器要自己取到图片字节再上传。

内容审核：输入图片可能返回 `IMAGE_CONTENT_VIOLATION`（“not allowed in your region”）。
文生 3D 的提示词会先渲染成图片，所以纯文本请求也可能返回这个错误。
图片里检测不到物体或图片不受支持时返回 `API_OBJECT_NOT_FOUND_ON_IMAGE`。

## 7. 输出

模型格式：

| 接口 | 参数 | 可选格式 | 默认 |
| --- | --- | --- | --- |
| `/rodin`、`/rodin_texture_only`、`/bang` | `geometry_file_format` | `glb`、`usdz`、`fbx`、`obj`、`stl` | `glb` |
| `/rodin_agentic` | `export_type` | `glb`、`usdz`、`fbx`、`stl` | `glb` |
| `/rigging` | `geometry_file_format` | `glb`、`fbx`、`usdz` | `glb` |

这些参数都是单个字符串，一次提交对应一种格式。`/download` 的请求体只有 `task_uuid`，没有格式参数，
文档里也没有对已完成任务换格式导出的接口（见 4.12）。按文档，要另一种格式只能带上新的 `geometry_file_format` 重新提交一次：
那是一个新任务，有自己的 `uuid` 和 `consumed`。用相同 `seed` 重新提交能否得到同一个模型，文档没有说明，见“未核实”第 32 条。

材质（`material`）：

| 取值 | 含义 |
| --- | --- |
| `PBR` | 基于物理的材质：base color、metallicness、normal、roughness 四张贴图 |
| `Shaded` | 只有带烘焙光照的 base color 贴图，偏风格化 |
| `All` | 同时交付 PBR 和 Shaded |
| `Hybrid` | PBR 贴图组，但 base color 带烘焙光照 |
| `None` | 不带材质，生成更快 |

`/rodin_texture_only` 不接受 `None`；`/rigging` 不接受 `Hybrid`。

拓扑与面数：`mesh_mode` 选 `Raw`（三角面）或 `Quad`（四边面）；面数由 `quality` 预设或 `quality_override` 决定，数值见 4.1。

贴图分辨率：

- Gen-2 和 Gen-1/1.5：默认 2K，加 `addons=HighPack` 升到 4K。
- Gen-2.5：由 `texture_mode`、`uhd_texture`、`addons` 共同决定。

| `texture_mode` | `addons` | `uhd_texture` | 分辨率 |
| --- | --- | --- | --- |
| `extreme-low`、`low`、`medium`、`high` | `[]` | `false` | 2K |
| `extreme-low`、`low`、`medium`、`high` | `[]` | `true` | 4K |
| `extreme-low`、`low`、`medium`、`high` | `HighPack` | `false` | 4K |
| `extreme-low`、`low`、`medium`、`high` | `HighPack` | `true` | 8K |
| `extreme-high` | `[]` | `false` | 6K |
| `extreme-high` | `[]` | `true` | 6K |
| `extreme-high` | `HighPack` | `false` | 12K |
| `extreme-high` | `HighPack` | `true` | 12K |

- 仅生成贴图接口的分辨率表见 4.4；Bang 的 `resolution` 为 `Basic`（2K）或 `High`（4K）。

`HighPack` 对几何的影响：

- Gen-2.5、Gen-2：只改贴图分辨率，不改几何，也不额外生成高模。
- Gen-1/1.5：`Sketch`、`Regular` 在 `Quad` 模式下，如果显式传了不超过 100000 的 `quality_override`，
  还会额外请求一个面数约为该值 16 倍的高模；`Detail`、`Smooth` 只改贴图分辨率。

额外产物：

- `tier=Gen-2.5-Extreme-High` 额外返回一个最多 1000 万面的网格。
- `preview_render=true`（Gen-2.5，且未触发 Fast mode）在下载列表里额外提供一张高质量渲染图。

下载列表的每一项只有 `name` 和 `url`。内嵌 OpenAPI 对 `geometry_file_format` 枚举的说明是
“glb, usdz and fbx will pack textures in the model if exists”，即 `glb`、`usdz`、`fbx` 会把贴图打包进模型文件；
`obj`、`stl` 的贴图怎么交付，文档没有写。文档也没有列出文件命名规则。

下载列表里有什么，官方文档写明的和没写的：

| 条件 | 官方文档写明的 | 官方文档未说明的 |
| --- | --- | --- |
| `geometry_file_format` 为 `glb`、`usdz`、`fbx` | 有贴图时贴图打包在模型文件里 | 列表里是否另有独立的贴图文件；模型文件的文件名 |
| `geometry_file_format` 为 `obj`、`stl` | 无（上面那句只点名了三种格式） | 贴图是否作为独立文件出现在列表里、`obj` 是否附带 `.mtl`、文件名 |
| `material=PBR` | 含 base color、metallicness、normal、roughness 四张贴图 | 四张贴图是否各自作为列表项出现 |
| `material=All` | PBR 和 Shaded 都会交付 | 是一个文件还是两个模型文件、如何从 `name` 区分 |
| `material=None` | 资产不带材质 | 列表是否只有一个模型文件 |
| `tier=Gen-2.5-Extreme-High` | 额外返回一个最多 1000 万面的网格 | 它的文件名、格式，以及如何与主模型区分 |
| `preview_render=true` | 列表里多一张高质量渲染图 | 图片格式和文件名 |

官方唯一的响应示例是只有一项的 `{"name": "model.glb", "url": ...}`。适配器要按扩展名在整个列表里找模型文件，
不能假设列表只有一项、主模型排在第一位或文件名固定；其余文件原样保留给用户。

## 8. 模型版本

`/api/v2/rodin` 的 `tier` 今天在文档页面上列出的取值：

| 家族 | `tier` | 定位 |
| --- | --- | --- |
| Gen-2.5 | `Gen-2.5-Extreme-Low` | 快速生成简单资产 |
| Gen-2.5 | `Gen-2.5-Low` | 干净的资产和小型硬表面道具 |
| Gen-2.5 | `Gen-2.5-Medium` | 结构和细节均衡 |
| Gen-2.5 | `Gen-2.5-High` | 更丰富的结构、更平滑的表面 |
| Gen-2.5 | `Gen-2.5-Extreme-High` | 高频细节还原；额外返回最多 1000 万面的网格 |
| Gen-2 | `Gen-2` | 图生 3D、文生 3D |
| Gen-1/1.5 | `Sketch`、`Regular`、`Detail`、`Smooth` | 支持多图 `concat` / `fuse`；文档没有逐个说明四个 tier 的差别 |

- **默认值是 `Regular`**（Gen-1/1.5）。要用 Gen-2 或 Gen-2.5 必须显式传 `tier`。
- Basic API 访问级别只能用 `Gen-2.5-Extreme-Low` 和 `Gen-2.5-Low`。
- 更新日志记录：2026 年 6 月把 `geometry_instruct_mode=creative` 限制在 `Gen-2.5-Medium` 及以上；
  2026 年 7 月把 Gen-2.5 的默认 `geometry_instruct_mode` 从 `faithful` 改为 `creative`。
- `/api/v2/rodin_agentic` 的 `tier` 是另一套：`basic`、`standard`（默认）、`pro`。

## 9. 计费

各文档页写明的积分消耗：

| 操作 | 积分 |
| --- | --- |
| Gen-2.5 基础生成 | 0.5 credits |
| Gen-2.5 且 `tier=Gen-2.5-Extreme-High` | 再加 0.5 credits |
| Gen-2.5 且 `texture_mode=extreme-high` | 再加 2.0 credits |
| Gen-2 基础生成 | 0.5 credits |
| Gen-1/1.5 基础生成 | 0.5 credits |
| Rodin Agentic `basic` / `standard` / `pro` | 0.5 / 1.0 / 2.0 credits |
| 仅生成贴图，基础 | 0.5 credits |
| 仅生成贴图，`texture_mode=extreme-high` | 2.0 credits |
| Bang | 每次 0.5 credits，与输入方式和选项无关 |
| Rigging | 每次提交 0.5 credits，同一资产重复提交也各算一次 |
| 生成 / 编辑图片 | 每次 0.5 credits |

- Gen-2.5、Gen-2、Gen-1/1.5 页面都写明：费用是累加的，表中没有列出的参数不额外收费。
- 每次被接受的提交都在响应的 `consumed` 里报告本次费用，应以它为准记账。
- Rigging 的 `consumed` 是提交时预留，打包成功后才扣费，任务失败或被取消时释放。
- 官方说明价格和积分单价由定价页维护，可能独立于文档变化；提交付费任务前应到定价页确认。

定价页（2026-11-12 读取）上的积分价格。各档数字取自页面内嵌的档位数据；年付单价对应页面标注的“Save 20%”：

| 方案 | 月付价格 | 每月积分 | 积分单价 |
| --- | --- | --- | --- |
| Free | $0 | 页面没有列出 | 直接购买 $1.5 / credit |
| Creator | $30、$60、$120、$180、$240 | 30、60、120、180、240 | 月付 $1 / credit，年付 $0.8 / credit |
| Business | $120、$240、$480、$720、$1,200 | 208、416、832、1,248、2,080 | 月付 $0.58 / credit，年付 $0.46 / credit |
| Enterprise | 面议 | 面议 | 面议 |

- 定价页写明订阅积分每个计费周期更新；直接购买的积分更贵，但可保留更久。
- 定价页按每个模型 0.5 credit 估算产出（例如 30 credits 标注“About 60 models”），与文档的基础生成价一致。
- 定价页还有 Education 方案，需要认证，FAQ 称它包含 Creator 级权益；页面没有列出它的价格和积分。
- 免费额度：定价页和文档都没有写明 API 的免费调用额度。定价页的“Generate for free before confirmation”和
  “pay by result”描述的是网页工作台里确认前可免费预览的流程。

## 10. 错误与限流

### 错误出现的两个位置

客户端必须两处都检查。

1. **传输层**，用 HTTP 状态码：

| HTTP | 含义 |
| --- | --- |
| 201 | POST 接口已处理请求。**不代表提交被接受**，还要看响应体 |
| 200 | `GET /api/v2/check_balance` 成功 |
| 400 | 请求格式错误、字段或文件无效、输入方式冲突 |
| 401 | 缺少鉴权或鉴权无效 |
| 429 | 被限流，带 `Retry-After` 响应头。Errors 页面写的是等待秒数；Quick Start 的 Python 示例同时兼容 HTTP 日期格式 |
| 5xx | 服务端错误 |

2. **应用层**，用响应体，HTTP 仍是 201：`error` 是错误码，`message` 是可读说明。
   哪些校验走 400、哪些走 201 加 `error`，各页说法不完全一样：Bang 页面把“输入方式冲突、不支持的文件”归在 HTTP 400；
   Rigging 页面写明业务校验失败（输入方式冲突、不支持的模型格式、资产不可用、积分不足）可能以 HTTP 201 加 `error` 返回，
   HTTP 400 只覆盖请求解析和字段校验错误。所以两种形态都要处理，不能假设某类错误一定是 400。
   只看 HTTP 状态码的客户端会把被拒绝的提交当成成功，然后去轮询一个根本没创建的 ID。

```json
{
  "error": "API_INSUFFICIENT_FUNDS",
  "message": "The fund in your wallet is insufficient to perform this operation."
}
```

提交成功的判定：HTTP 201，且 `error` 不存在或为空，且顶层 `uuid` 非空。

### 提交类接口的错误码

适用于 `/rodin`、`/rodin_texture_only`、`/bang`；`/rigging` 和 `/images` 的 schema 使用同一组枚举。

| 错误码 | 含义 |
| --- | --- |
| `INVALID_REQUEST` | 请求格式错误、缺少参数或取值无效，详见 `message` |
| `API_NO_ACTIVE_SUBSCRIPTION` | 账户没有该接口或该 Rodin tier 要求的 API 访问级别 |
| `API_SUBSCRIPTION_PLAN_TOO_LOW` | 订阅方案不允许 API 访问 |
| `API_PARALLELISM_LIMIT_REACHED` | 账户正在运行的任务太多；等其中一个结束后再重试 |
| `API_INSUFFICIENT_FUNDS` | 余额不足 |
| `API_OBJECT_NOT_FOUND_ON_IMAGE` | 输入图片里没有检测到物体，或图片不受支持 |
| `IMAGE_CONTENT_VIOLATION` | 输入图片在所在地区不被允许；换一张图 |
| `IMAGE_LABEL_LENGTH_TOO_LONG` | `image_label` 的数量多于上传的图片数 |
| `NO_SUCH_TASK` | 引用的任务不存在或已过期 |
| `ASSET_NOT_AVAILABLE` | 引用的资产不处于可操作的状态 |
| `PERMISSION_DENIED` | 账户无权执行该操作 |
| `API_UNKNOWN` | 意外的服务端错误，详见 `message` |

### 状态与下载接口的错误码

| 接口 | 错误码 | 含义 |
| --- | --- | --- |
| `/status` | `NO_SUCH_TASK` | subscription key 对应不到可用的任务 |
| `/download` | `NO_SUCH_TASK` | 任务 UUID 对应不到当前用户名下的任务 |
| `/download` | `INVALID_REQUEST` | 该任务没有当前用户可下载的文件 |

### 限流与并发

- 限流按接口、按账户分别计算；轮询 `/status` 的额度远高于提交生成任务的额度。
- 定价页（2026-11-12）标注 Business 方案：前三档 120 RPM，更高档位 240 RPM。官方说明这个数值随订阅档位变化且可能调整，不要写死在代码里。
- HTTP 429 带 `Retry-After`，以它为准，不要立即重试。
- 账户有同时运行任务数的上限，超出时提交被拒并返回 `API_PARALLELISM_LIMIT_REACHED`。文档没有给出具体数值。

### 重试建议

| 情况 | 处理 |
| --- | --- |
| HTTP 429 | 按 `Retry-After` 等待后重试 |
| HTTP 5xx | 退避重试。官方原文是“Retry `429` and `5xx` responses with backoff”，没有区分提交和查询；对提交请求见下方“提交结果的分类” |
| 响应体带 `error` | **不要原样重试**。官方说明这是确定性的拒绝，重新提交结果相同，还会再占用一次限流额度 |
| `API_PARALLELISM_LIMIT_REACHED` | 例外：等一个在途任务结束后再提交 |
| `/status` 里某个 job 为 `Failed` | 停止轮询，任务不会产出结果 |

关于“失败的提交是否已扣费”：

- 官方的拒绝示例里只有 `error` 和 `message`，没有 `uuid` 和 `consumed`；按文档，带 `error` 的提交没有被接受。文档没有明说这类请求一定不扣费。
- 被接受的提交用 `consumed` 报告费用。只有 Rigging 页面明确写了任务失败或被取消时会释放预留的积分；
  其他接口在 job `Failed` 后是否退还，文档没有写。
- 提交请求超时或连接中断时无法从文档判断任务是否已创建，文档也没有幂等键。
  不要自动重复提交；可用 `GET /api/v2/check_balance?usage_page=1` 的最近用量记录（带 `task_uuid`）人工核对。

### 提交结果的分类

适配器要把一次提交的结果分成两类：A 是“没有创建任务，可以重新提交”，B 是“任务可能已创建、可能已计费，不能自动重新提交”。
“依据”列只写官方来源里读到的内容；官方没有写的地方照实标出。

| 提交后看到的结果 | 分类 | 依据 |
| --- | --- | --- |
| HTTP 201，`error` 不存在或为空，顶层 `uuid` 非空 | 任务已创建 | 文档给出的接受条件；`consumed` 是本次费用 |
| HTTP 201，`error` 非空，没有 `uuid` | A | Errors 页：这是被拒绝的提交，只看状态码的客户端会去轮询“an identifier that was never created”。除 `API_PARALLELISM_LIMIT_REACHED` 外原样重发结果相同，要先改请求或账户状态。官方拒绝示例里没有 `consumed`，但文档没有明说不扣费 |
| HTTP 400 | A | Errors 页归为传输层失败（请求格式错误、字段或文件无效）；Gen-2.5 页写“HTTP 201 means the endpoint handled the request”。改正请求后再提交 |
| HTTP 401 | A | 同上，缺少鉴权或鉴权无效。换 Key 后再提交 |
| HTTP 429 | A | Quick Start 的官方 Python 示例对任何请求（包括提交）在 429 时按 `Retry-After` 等待后把同一个请求重发 |
| 请求没有发出去（域名解析失败、连接被拒绝） | A | 服务端没有收到请求；这一条是客户端自己能确定的事实，与文档无关 |
| HTTP 5xx | B | 官方建议退避重试，但没有说明 5xx 的提交是否可能已经创建任务；文档没有幂等键，重发可能得到两个计费任务。官方文档未说明，见“未核实”第 33 条 |
| 请求超时、连接中断、响应体不是 JSON | B | 文档没有描述；无法证明任务没有创建 |
| HTTP 201 但既没有 `error` 也没有 `uuid`，或者 `error` 和 `uuid` 同时出现 | B | 文档没有描述这种响应；按接受条件它不算被接受，但无法证明任务没有创建 |
| HTTP 201，`error` 为 `API_UNKNOWN` | 文档归入 A | Errors 页把它和其他错误码一起列为提交被拒，含义是“Unexpected server-side error”。文档没有单独说明此时是否可能已创建任务；要保守可以按 B 处理 |

B 类的核对手段只有一个：`GET /api/v2/check_balance?usage_page=1` 的用量记录带 `task_uuid`（这个接口需要 Full API access）。
文档没有任务列表接口。拿到 `task_uuid` 后可以调 `/download`，但调不了 `/status`：`/status` 只认 `subscription_key`，
而 `subscription_key` 只出现在提交响应里，文档没有别的途径取回它。

## 11. 未核实

以下内容今天在官方来源里找不到答案，或官方来源之间不一致。写适配器前需要用真实 Key 小额验证，或向官方确认。

1. **下载 URL 的有效时长**：官方文档未说明，只说是短期有效的签名 URL、会过期。
   线索：官方 `rodin3d-skills` 的 SKILL.md（最后提交 2026-05-25）两处写“URLs expire in 10 minutes”。它不是 REST 文档的承诺，
   今天没有验证；适配器按“拿到就立刻下载”处理，不要依赖 10 分钟这个数。
2. **`/rodin` 的图片格式、单图大小上限、分辨率上限**：三个生成页面都没有写。只有 Agentic 写了 25 MiB，仅生成贴图接口列了格式清单。
   文档之外的官方来源互相不一致，只能当线索：`rodin3d-skills` 的 SKILL.md（最后提交 2026-05）写“JPEG/PNG/WebP, max 16MB, 512x512-4096x4096”；
   `hyper3d-cli` 的 MCP 上传约定是图片每张最大 25 MiB，格式 JPEG、PNG、WebP、GIF、TIFF、AVIF、HEIC。两者都不是 REST 文档的承诺。
3. **数组型表单字段的编码方式**：`addons`、`bbox_condition`、`image_label` 在 multipart 里该怎么传
   （重复字段、JSON 字符串还是逗号分隔），文档没有示例。只有 Rigging 的 `animation_preset` 明确写了
   “一个 ID、重复字段或 JSON 数组字符串”，以及 `hierarchy` 是 JSON 数组字符串。
   BBOX Control 页面只说“Set `bbox_condition` to a JSON array”，给的是 JSON 片段，不是表单示例。
   官方客户端的写法也不统一：`rodin3d-skills` 把 `bbox_condition` 和 `addons` 用逗号拼接成一个字段（`100,100,100`、`HighPack`）；
   `ComfyUI-Rodin` 把 `bbox_condition` 作为一个字符串字段发送，值是 Python 的 `str([Width, Height, Length])`，
   即 `[100, 100, 100]` 这样的文本（恰好也是合法的 JSON 数组），它不发 `addons`。
   两个客户端都没有用“重复同名字段”的写法发这几个数组，也都不发 `image_label`，所以 `image_label` 没有任何官方写法可参照。
   `addons` 目前只有 `HighPack` 一个取值，重复字段写法和逗号拼接写法发出的都是同一个 part `addons=HighPack`；
   `bbox_condition` 有三个值，三种写法（三个同名 part、`100,100,100`、`[100, 100, 100]`）在线上互不相同。
   两个仓库都停在 2026-05，今天没有实际验证哪种写法被接受。
4. **图片是否支持 URL 或 base64**：文档只描述了 multipart 文件上传，没有明确说不支持其他方式。
5. **`HighPack` 是否额外收费**：Gen-2 和 Gen-1/1.5 的参数说明称它是“paid add-on”，
   但这两页的计费表只有基础 0.5 credits 并写明“未列出的参数不额外收费”；Gen-2.5 页面称它是“add-on”且计费表同样没有列。
   更新日志 2026 年 8 月提到“更新了 add-on 价格”，但没有给数字。以响应里的 `consumed` 为准。
   线索：官方 `rodin3d-skills` 的 SKILL.md（2026-05）的 Addons 表写 `HighPack` 为“+1 credit”，早于 8 月那次调价，不能当作现价。
6. **仅生成贴图接口 `texture_mode=extreme-high` 的费用**：计费表写的是 `2.0 credits`，没有加号，
   不能确定是总价 2.0 还是在基础 0.5 之上再加 2.0。
7. **`/rodin`、`/rodin_texture_only`、`/bang` 的 job `Failed` 后是否退还积分**：文档没有写。
8. **`/rodin_agentic` 被拒绝时的响应形态**：它的响应 schema 没有 `error`、`message`、`consumed` 字段，也没有列在错误页的适用接口里。
9. **400、401、429 响应体的结构**：文档只给了状态码含义，没有给响应体示例。
10. **并发任务数上限的具体数值**，以及各接口各自的限流数值（定价页只有 Business 的 120 / 240 RPM）。
11. **Creator 订阅的 API 权限**：文档 Quick Start 写 Creator 包含 Basic API access；定价页对比表里 Free 和 Creator 的“API access”一栏都是“—”，只有 Business 标了 Full access（Enterprise 为 Custom）。
    Quick Start 提到的 Unlimited 订阅在定价页上没有作为方案出现。
12. **API 是否有免费额度或测试 Key**：官方文档未说明，文档站和定价页都没有。
    官方 `rodin3d-skills`（2026-05）的 SKILL.md 和 `generate_3d_model.py` 里内置了一个“free test API key”，未提供 Key 时自动使用，
    并注明有用量和限流限制。它不在 REST 文档里，今天没有使用也没有验证是否仍有效；适配器不要内置它。
13. **各 tier 的典型生成耗时**：只有 Agentic 页面给了 3 / 5 / 10 分钟；Rodin 各 tier 没有。
14. **下载列表的文件命名规则、`obj` / `stl` 的贴图如何交付、是否包含缩略图**：文档示例只有一个 `model.glb`；
    schema 只说明 `glb`、`usdz`、`fbx` 会把贴图打包进模型文件。逐项的“写明 / 未说明”见第 7 节的表。
    官方文档未说明的有：各格式和各 `material` 下列表里的文件个数、文件名、顺序，`obj` / `stl` 的贴图是否是独立文件。
    线索：`ComfyUI-Rodin` 把列表里的每个文件都下载下来，并把**第一项**当作要预览的模型；它保存前取 `name` 最后一个 `/` 之后的部分，
    说明 `name` 可能带路径。`rodin3d-skills` 也是逐项全部下载，直接用 `name` 作文件名。两者都不是文档承诺。
15. **`Gen-2.5-Extreme-Low`、`Gen-2.5-Low` 下 `geometry_instruct_mode` 的实际默认值**：
    参数表写默认 `creative`，但更新日志写 `creative` 只限 `Gen-2.5-Medium` 及以上。官方建议不传这个参数。
16. **`preview_render` 在 Gen-2、Gen-1/1.5 上的行为**：这两页只列出字段，没有说明。
17. **Rigging 自定义骨架节点的 `transform` 字段**：schema 只标注为 number 数组，没有说明元素个数和含义。
18. **组件枚举里出现但页面允许值里没有的取值**：内嵌 OpenAPI 的公共枚举里还有 `tier` 的
    `Fast`、`Vurse`、`Bambu`、`Amazon`、`Gen-2.5-Minimum`，`texture_mode` 的 `minimum`，
    `bone_template` 的 `human_UE`、`human_Unity`、`human_ActorCore`。各页面的参数允许值都不包含它们。
    其中只有 `bone_template` 的三个值在公共枚举的描述里有一句说明（“Human variants select the Unreal Engine, Unity, or ActorCore skeleton template”），
    官方 CLI 的 MCP 工具也接受它们；但 REST 的 `/rigging` 参数枚举不含这三个值，页面改用 `export_skeleton_type` 选导出骨架。
    其余取值没有任何说明。都不要使用。
19. **`hyperhuman.deemos.com` 是否仍可用**：当前文档里没有出现这个主机，今天也没有对它发起任何请求。
    官方 GitHub 上较旧的 `rodin-api-mcp`（最后提交 2025-04）和 fork 来的 `blender-mcp-rodin-integration`（最后提交 2026-10-30）仍写着这个主机，
    只能说明它曾经是 API 主机、可能仍被保留，不能当作文档承诺。
20. **任务过期时间与 7 天数据保留的关系**：`NO_SUCH_TASK` 提到任务会过期，保留政策写 7 天，但文档没有明说两者是同一个期限。
21. **`GET /api/v2/rigging_animations` 的成功状态码和错误响应**：Rigging 页面只给了请求和响应体示例，这个接口没有出现在内嵌 OpenAPI 里。
22. **`/rodin_texture_only` 的 `material` 是否接受 `Hybrid`**：内嵌 OpenAPI 的枚举是 `PBR`、`Shaded`、`All`、`Hybrid`，
    同一页的正文写的是“accepts `PBR`, `Shaded`, or `All`”。
23. **`/rodin_agentic`、`/bang`、`/images` 要求的 API 访问级别**：OpenAPI 的接口描述没有写。Quick Start 说 Basic 只允许
    `Gen-2.5-Extreme-Low`、`Gen-2.5-Low` 和 rigging，Full 允许所有 API，据此推断这三个接口需要 Full，但没有逐个接口的明文。
24. **提交接口是否接受 `application/x-www-form-urlencoded`**：OpenAPI 只声明 `multipart/form-data`，cURL 示例都用 `--form`；
    但 Bang 和 Rigging 用 `asset_id` 的官方 Python 示例是 `requests.post(..., data={...})`，不带 `files`，实际发出的是 urlencoded。
    适配器按 multipart 发。
25. **官方插件里出现、文档里没有的接口和字段**：`ComfyUI-Rodin`（最后提交 2026-05）调用 `POST /api/v2/polygen`，
    并向 `/rodin` 发送 `ta_pose`、`model_early_export`、`height` 字段（文档里的字段名是 `TAPose`）；
    `hyper3d-cli` 的 MCP Bang 工具有 `explode_strength`。今天的文档都没有这些，不要使用。
26. **`Quad` 模式的面数上限**：REST 文档写 Gen-2.5、Gen-2 的 `quality_override` 在 `Quad` 模式最高 200000（Bang 为 50000）；
    `hyper3d-cli` 的 MCP 生成工具写的是“Quad accepts 1,000 to 50,000”。两者是不同的接入面，REST 的实际上限今天没有验证。
27. **上传模型文件的大小上限**：`/rodin_texture_only`、`/bang`、`/rigging` 的 `model` 都没有写大小上限。
    `hyper3d-cli` 的 MCP 上传约定是模型最大 128 MiB，不是 REST 文档的承诺。
28. **Bang 的 `strength` 下限**：文档和内嵌 OpenAPI 写 1～12；官方 `rodin3d-bang-skills` 的客户端（最后提交 2026-04）拒绝小于 2 的值。本文按文档写 1～12。
29. **定价页数字是否适用于所有地区**：第 9 节的价格和积分数是定价页 HTML 里的静态美元数据。页面脚本在浏览器里还会按访问者所在市场
    再请求一份价格目录并替换显示（请求失败时显示“Prices can’t be shown right now”）。今天只读取了静态 HTML，没有读到那份目录，
    其他币种或地区的实际售价没有核实。
30. **`images` 文件 part 的文件名和 Content-Type 是否影响解析**：官方文档未说明。OpenAPI 只把每一项声明为
    `format: binary`、`contentMediaType: application/octet-stream`。三个官方写法互不相同：Quick Start 的 Python 示例发
    `("input.png", image_file, "image/png")`（文件名加图片 MIME）；`rodin3d-skills` 发 `(os.path.basename(path), bytes)`，
    只给文件名、代码里没有指定 Content-Type；`ComfyUI-Rodin` 调 `form_data.add_field("images", file_content)`，
    文件名和 Content-Type 都没有指定（节点里的图片先转成 PNG 字节再上传）。今天没有验证服务端对缺少文件名或类型不符的 part 如何处理。
31. **重复调用 `/download` 是否返回新签发的 URL**：官方文档未说明。文档只写 HTTP 201 返回“the files currently available”
    和 URL 会过期；URL 过期后在 7 天保留期内能否再调一次 `/download` 拿到新 URL，没有明文。
32. **用相同 `seed` 和相同输入重新提交是否得到同一个模型**：官方文档未说明。`seed` 的说明只有
    “A seed value for randomization in the mesh and texture generation”。所以“换一种格式重新导出同一个模型”没有文档保证的做法。
33. **HTTP 5xx 或超时的提交是否可能已经创建任务并计费**：官方文档未说明。Errors 页只说对 429 和 5xx 退避重试，
    没有区分提交和查询；文档没有幂等键，也没有按请求去重的说明。
34. **下载 URL 是否需要鉴权头**：官方文档未说明，只称它是“signed URL”。`ComfyUI-Rodin` 和 `rodin3d-skills` 都不带 `Authorization` 头直接 `GET`。

## 12. 来源

全部于 2026-11-12 读取。只读取了公开页面和公开仓库的源码，没有注册、登录、使用 API Key，也没有调用任何生成接口，没有运行下载的代码。
各接口页的参数表取自页面 HTML 内嵌的 OpenAPI 3.2 片段（`info.title` 为 Hyper3D Developer API，`servers` 只有 `https://api.hyper3d.com`）。

| URL | 提供的内容 |
| --- | --- |
| `https://developer.hyper3d.ai/` | 301 跳转到 `https://docs.hyper3d.ai/`，确认文档站已迁移 |
| `https://docs.hyper3d.ai/en`（Markdown：`/en/llms.mdx/content.md`） | Base URL、鉴权和请求格式概述、API dashboard 地址、文档页面清单 |
| `https://docs.hyper3d.ai/en/llms.mdx/get-started/quick-start/content.md` | Basic / Full 访问级别、鉴权头、三步流程、两种 ID 的用途、轮询节奏、完整 Python 示例 |
| `https://docs.hyper3d.ai/en/llms.mdx/get-started/features/content.md` | 任务流程、三个模型家族、`consumed` 与余额、并发上限 |
| `https://docs.hyper3d.ai/en/llms.mdx/get-started/changelog/content.md` | 文档迁移时间、参数增删历史、`geometry_instruct_mode` 默认值变更 |
| `https://docs.hyper3d.ai/en/api-specification/rodin-gen2-5`（及其 `content.md`） | Gen-2.5 参数表与内嵌 OpenAPI、tier 表、Fast mode、贴图模式与分辨率矩阵、计费、响应示例 |
| `https://docs.hyper3d.ai/en/api-specification/rodin-gen2`（及其 `content.md`） | Gen-2 参数表与内嵌 OpenAPI、面数预设、计费 |
| `https://docs.hyper3d.ai/en/api-specification/rodin-gen1-1-5`（及其 `content.md`） | Gen-1/1.5 参数表与内嵌 OpenAPI、`condition_mode`、`mesh_simplify`、`mesh_smooth`、HighPack 高模规则、计费 |
| `https://docs.hyper3d.ai/en/api-specification/rodin-agentic`（及其 `content.md`） | Agentic 参数、tier 与计费、响应结构 |
| `https://docs.hyper3d.ai/en/api-specification/bbox-control`（及其 `content.md`） | `bbox_condition` 的顺序、范围和坐标系 |
| `https://docs.hyper3d.ai/en/api-specification/generate-texture`（及其 `content.md`） | 仅生成贴图接口的参数、输入格式、分辨率表、计费 |
| `https://docs.hyper3d.ai/en/api-specification/bang`（及其 `content.md`） | Bang 的两种输入方式、参数、计费 |
| `https://docs.hyper3d.ai/en/api-specification/rigging`（及其 `content.md`） | Rigging 参数、骨架模板、自定义骨架、动画目录接口、导出骨架类型、计费与预留规则 |
| `https://docs.hyper3d.ai/en/api-specification/images`（及其 `content.md`） | 图片生成 / 编辑接口的参数、限制、响应 |
| `https://docs.hyper3d.ai/en/api-specification/check-status`（及其 `content.md`） | 状态接口的请求、响应、四种 job 状态、`queue_length`、轮询建议 |
| `https://docs.hyper3d.ai/en/api-specification/download-results`（及其 `content.md`） | 下载接口的请求、响应、URL 会过期的说明 |
| `https://docs.hyper3d.ai/en/api-specification/check-balance`（及其 `content.md`） | 余额接口的参数、响应、用量记录字段 |
| `https://docs.hyper3d.ai/en/llms.mdx/api-specification/errors/content.md` | 错误返回方式、错误码表、限流与重试建议 |
| `https://docs.hyper3d.ai/en/llms.mdx/legal/data-retention-policy/content.md` | 7 天数据保留、不用于训练、运营主体 Deemos Corporation |
| `https://docs.hyper3d.ai/zh` 及 `/zh/llms.mdx/api-specification/{rodin-gen2-5,check-status,download-results,errors}/content.md` | 确认中文文档存在；只用于按关键词交叉核对有效期、限流、回调相关表述，没有新增事实 |
| `https://hyper3d.ai/pricing?lang=en` | 订阅方案、每月积分和积分单价、Business 的 120 / 240 RPM、API 访问级别对比、计费 FAQ |
| `https://github.com/DeemosTech/hyper3d-cli`（`main`，最后提交 2026-11-12；`packages/cli/src/endpoints.ts`、`operations.ts`、`upload-contract.ts`、`base_schema.json`，`README.md`，`docs/architecture.md`） | 第二来源：默认主机 `https://api.hyper3d.com/api`；MCP 工具的参数枚举，用于交叉核对 Agentic、Rigging、Bang 的取值和默认值；确认 CLI 走 MCP 加 OAuth，不是 REST 加 API Key |
| `https://github.com/DeemosTech/rodin3d-skills`、`https://github.com/DeemosTech/rodin3d-bang-skills`（`scripts/api_client.py`、`scripts/generate_3d_model.py`、`scripts/image_utils.py`、`SKILL.md`） | 第二来源：REST 路径、表单字段名、`uuid` / `jobs.subscription_key` / `task_uuid` 的用法、四种 job 状态；数组字段的逗号拼接写法；`images` part 的写法、布尔值的小写文本写法；“URLs expire in 10 minutes”、`HighPack` “+1 credit”、内置测试 Key 的出处；下载时不带鉴权头 |
| `https://github.com/DeemosTech/ComfyUI-Rodin`（`modules/Rodin_Mainsite.py`、`hyper3d_nodes.py`） | 第二来源：主机 `https://api.hyper3d.com` 和 `/api/v2/rodin`、`/status`、`/download` 路径；文档里没有的 `/api/v2/polygen` 和额外表单字段；`images` part 和 `bbox_condition` 的写法；下载列表的处理方式（逐项下载、取 `name` 的最后一段、不带鉴权头） |
| `https://github.com/DeemosTech/rodin-api-mcp`、`https://github.com/DeemosTech/blender-mcp-rodin-integration` | 只用于确认旧主机 `hyperhuman.deemos.com` 的出处 |

无法访问的地址：`https://docs.hyper3d.ai/llms.txt`、`/llms-full.txt`、`/sitemap.xml`、`/robots.txt`、`/openapi.json`、`/api/openapi.json` 返回 404；
文档页脚指向的 GitHub 仓库 `DeemosTech/hyper3d-docs` 返回 404（未公开）。
