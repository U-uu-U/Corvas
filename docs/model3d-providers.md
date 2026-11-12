# 3D 生成服务接口

本文说明 Corvas 主进程里的 3D 生成接口层。它把 Meshy、Tripo、Hyper3D Rodin 三家的官方 API 包成同一套
请求、任务记录和状态结构。三家的官方接口说明见：

- [Meshy](api/meshy-3d.md)
- [Tripo](api/tripo-3d.md)
- [Hyper3D Rodin](api/hyper3d-rodin.md)

这三份说明是 2026-11-12 从官方文档整理的快照。接口会变，改适配器之前先核对官方文档。

## 现状

- 接口层只在主进程里，可以被 `require` 调用，也可以用命令行工具调用。**还没有接到画布界面、IPC、MCP 工具或 API 配置里。**
- **没有用真实 Key 调过任何一家的接口。** 所有请求格式都来自官方文档。验证方式是单元测试（注入假的 `fetch`），
  加上一次本机 HTTPS 模拟服务的实测（真实 `fetch`，核对实际发出的字节）。第一次用真实 Key 时，先用命令行工具跑
  `balance`，再跑一次最便宜的生成。
- 三份官方接口说明里各有一节“未核实”，列出官方文档没写清或互相矛盾的地方。适配器在这些地方都按保守方式处理。

## 文件

| 文件 | 内容 |
| --- | --- |
| `electron-main/model3d-common.cjs` | 三家共用：HTTP 请求、错误分类、轮询、参考图读取、multipart 编码、模型下载 |
| `electron-main/meshy-3d.cjs` | Meshy 适配器 |
| `electron-main/tripo-3d.cjs` | Tripo 适配器 |
| `electron-main/hyper3d-rodin.cjs` | Hyper3D Rodin 适配器 |
| `electron-main/model3d-providers.cjs` | 统一入口：提交并等待、续跑、查询、取消、查余额 |
| `scripts/model3d-cli.cjs` | 命令行工具，用真实 Key 手动验证 |

## 统一入口

```js
const { generateModel3d, resumeModel3d, queryModel3d, cancelModel3d, getModel3dBalance,
    listModel3dProviders } = require('./model3d-providers.cjs');

const result = await generateModel3d({
    provider: 'tripo',
    config: { apiKey, region: 'cn', fetchImpl: (...args) => net.fetch(...args) },
    request: { mode: 'image', images: ['C:/图/chair.png'], format: 'fbx' },
    saveDir: 'D:/models', baseName: 'chair',
    onHandle: handle => saveTaskRecord(handle),   // 每次任务记录变化都会调用，必须落盘
    onProgress: ({ status }) => showProgress(status),
    signal
});
// result: { provider, handle, status, outputs, primary, files }
```

| 函数 | 作用 |
| --- | --- |
| `generateModel3d({ provider, config, request, ...选项 })` | 提交新任务，等到最终结果，按需下载 |
| `resumeModel3d({ provider, config, handle, ...选项 })` | 从保存的任务记录继续。**不会重新提交第一步** |
| `queryModel3d({ provider, config, handle })` | 查一次状态 |
| `cancelModel3d({ provider, config, handle })` | 取消任务。只有 Meshy 支持，而且只能取消还在排队的任务 |
| `getModel3dBalance({ provider, config })` | 查积分余额 |
| `listModel3dProviders()` | 三家的信息对象 |

`config`：`apiKey` 必填；`baseUrl` 可选，必须是 HTTPS；`fetchImpl` 可选，主进程里传 `net.fetch` 以走系统代理；
Tripo 另有 `region`（`global` 或 `cn`）。Tripo 的 Key 只在自己所属的区域有效。

`generateModel3d` 和 `resumeModel3d` 的选项：

| 选项 | 说明 |
| --- | --- |
| `onHandle(handle)` | 任务记录每次变化时调用。调用方必须把它存下来 |
| `onProgress({ provider, handle, status, recovering })` | 每次查询后调用。`recovering` 为真表示这次查询失败、稍后会重试 |
| `signal` | 中断信号 |
| `saveDir`、`baseName` | 给了 `saveDir` 才下载。文件保存为 `<saveDir>/<baseName>.<格式>`，同名时加 `-2`、`-3` |
| `download` | 默认 `model`，只下载主模型文件。`all` 把模型、贴图、预览图都下载到 `<saveDir>/<baseName>/`，文件保留服务商给的名字 |
| `resubmitUnknownStage` | 只用于 `resumeModel3d`，见下一节 |

`result.primary` 是调用方要的格式对应的模型文件；`result.outputs` 是全部可下载文件；`result.files` 是已下载到本地的文件
`[{ path, bytes, format, role }]`。结果链接有时效（Tripo 约 5 分钟，Meshy 最多 3 天），所以任务一成功就先下载主模型。
`download: 'all'` 时主模型以外的文件下载失败会被跳过，不影响结果。

### 防止重复扣费

三家都没有幂等键。同一个创建请求发两次，就会扣两次积分。接口层按下面的规则处理：

- 一次调用只发一次创建请求。超时、连接中断、`5xx` 都不重发，报 `MODEL3D_SUBMISSION_UNKNOWN`。
- 只有两种情况算“确定没有创建任务”：服务商明确拒绝了请求；或者连接根本没建立（连接被拒绝、域名解析失败）。
  其他网络错误，包括各种超时，都按“结果未知”处理，因为套接字在请求发出之后也可能报这些错。
- 查询失败不等于任务失败。查询遇到网络错误、`408`、`425`、`429`、`5xx` 时继续轮询，连续失败 5 次才放弃，放弃时报的错误也不是“任务失败”。
- 有些流程要再提交一次收费任务（Meshy 的贴图阶段、Tripo 的格式转换）。提交之前，接口层先把带 `advancing` 标记的
  任务记录交给 `onHandle` 保存。如果这次提交结果未知，或者程序在这时崩溃，标记会留在记录里。
- `resumeModel3d` 看到 `advancing` 标记会直接报 `MODEL3D_SUBMISSION_UNKNOWN`，不发任何请求。用户到服务商后台确认
  那一步没有创建任务之后，再用 `resubmitUnknownStage: true` 续跑。
- 提交被明确拒绝时，标记会清掉，直接续跑就行。
- 用户在创建请求发出后、收到响应前中断，抛出的是 `AbortError`，并带 `submissionUnknown: true`：任务可能已经创建，
  但没有任务 ID 可存。请求发出之前就中断的，`submissionUnknown` 为 `false`。
- `onHandle` 自己抛错时（比如磁盘写不进去），错误上会带着刚创建的任务记录 `handle`，任务 ID 不会丢。
- 后续阶段的任务在服务商那边失败时，错误上另带 `retryHandle`，是上一阶段的任务记录。用它调 `resumeModel3d` 只会重新
  提交失败的这一步，不用再为前面已经成功的阶段付费。

每个错误都带 `handle`（如果已经有任务记录）。调用方要看 `submissionUnknown` 这个标志，不要只看错误码：除了
`MODEL3D_SUBMISSION_UNKNOWN`，缺少任务 ID 的成功响应（`MODEL3D_INVALID_RESPONSE`）和发出后的中断也会带它。
这类错误要单独提示给用户，不要提供“重试”按钮。

### 轮询

- 刚创建的任务不会马上查询，先等一个轮询间隔（Hyper3D 官方要求首次查询至少等 5 秒）。续跑的任务立即查询。
- 两次查询之间至少隔 1 秒。服务商返回 `Retry-After` 时按它等待，最长 5 分钟。
- 每个阶段的最长等待时间是信息对象里的 `maxWaitMs`。超时报 `MODEL3D_WAIT_TIMEOUT`，任务可能还在跑，用 `resumeModel3d` 继续等。

## 统一请求

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `mode` | string | 必填 | `text` 文生 3D、`image` 单图生 3D、`multiview` 多视图生 3D |
| `prompt` | string | 无 | `text` 必填 |
| `images` | array | 无 | `image` 传 1 张，`multiview` 传多张。每项是本地路径、`http(s)` 地址、data URI，或 `{ path }`、`{ url }`、`{ buffer, name }`、`{ dataUri }`。多视图可以写成 `{ source, view }`，`view` 取 `front`、`left`、`back`、`right`；不写时按顺序分配，`front` 必须有 |
| `model` | string | 各家默认 | 服务商自己的模型标识，原样传给服务商 |
| `texture` | boolean | `true` | 是否生成贴图 |
| `pbr` | boolean | 同 `texture` | 是否生成 PBR 材质贴图。`texture` 为 `false` 时不能为 `true` |
| `topology` | string | 不传 | `triangle` 或 `quad` |
| `targetFaces` | integer | 不传 | 目标面数 |
| `format` | string | `glb` | 想要的模型格式 |
| `seed` | integer | 不传 | 随机种子。Meshy 不支持，传了会报 `MODEL3D_UNSUPPORTED` |
| `providerOptions` | object | `{}` | 原样并入第一步请求的服务商参数。统一字段的值会覆盖其中同名的参数 |
| `stageOptions` | object | `{}` | 按阶段名给后续阶段的服务商参数，如 `{ refine: {...} }`（Meshy）、`{ convert: {...} }`（Tripo） |

`normalizeModel3dRequest(request, limits, providerName)` 负责校验并填默认值，返回的 `images` 是
`[{ source, view }]`，多视图已按 `front`、`left`、`back`、`right` 排好。它从 `limits.formats` 读可用格式，
所以适配器调用时要传 `{ ...info.limits, formats: info.formats }`。

读取本地参考图的路径由调用方负责授权（`mediaAccess`）。接口层拿到什么路径就读什么路径。图片类型按文件头判断，不看扩展名。

## 三家的差异

| 项目 | Meshy | Tripo | Hyper3D Rodin |
| --- | --- | --- | --- |
| 默认 API 地址 | `https://api.meshy.ai/openapi` | 国际 `https://openapi.tripo3d.ai/v3`，大陆 `https://openapi.tripo3d.com/v3` | `https://api.hyper3d.com/api/v2` |
| 默认模型 | `latest`（当前是 Meshy 7.1） | `v3.1-20260211`（接口要求必填） | `Gen-2.5-Medium`（不传会退回旧的 Regular） |
| 本地参考图怎么发 | 转成 base64 data URI 写进请求体 | 先上传换 `file_token`。JPEG、PNG 走 `/files`，WebP 走预签名上传 | 作为 multipart 文件直接随请求上传 |
| 参考图能否用网络地址 | 能 | 能 | 不能，只接受本地文件 |
| 多视图张数 | 1 到 4 | 2 到 4，必须有正面 | 2 到 4（官方接口最多 5 张，统一请求只有 4 个视角） |
| 文生 3D 带贴图 | 两个收费任务：先 `preview` 出白模，再 `refine` 贴图 | 一个任务 | 一个任务 |
| 要 GLB 以外的格式 | 同一个任务直接出 | 生成任务只出 GLB，其他格式要再提交一个收费的转换任务。H 系列加 `quad` 时直接出 FBX | 提交时指定，一个任务 |
| 输出 | 模型、各张贴图、缩略图分开给链接 | 一个模型文件加一张预览图 | 下载列表，文件名由服务商定 |
| 进度百分比 | 有 | 有 | 没有，`progress` 为 `null` |
| 取消 | 只能取消排队中的任务，会退积分。运行中的不能取消 | 没有取消接口 | 没有取消接口 |
| 随机种子 | 不支持 | 支持 | 支持，0 到 65535 |
| 最长等待 | 60 分钟 | 20 分钟 | 20 分钟 |

统一字段到各家参数的对应：

| 统一字段 | Meshy | Tripo | Hyper3D Rodin |
| --- | --- | --- | --- |
| `model` | `ai_model`；`meshy-t2`、`meshy-t2.5` 时另加 `model_type: smart-topology` | `model` | `tier` |
| `texture` | 图生、多图：`should_texture`。文生：决定是否提交 `refine` | `texture` | `false` 时 `material: None` |
| `pbr` | `enable_pbr` | `pbr` | `material`：`PBR` 或 `Shaded` |
| `topology` | `topology`，并加 `should_remesh: true` | `quad: true`（三角面时不传） | `mesh_mode`：`Quad` 或 `Raw` |
| `targetFaces` | `target_polycount`，并加 `should_remesh: true` | `face_limit` | `quality_override` |
| `format` | `target_formats: [格式]` | 非 GLB 时提交转换任务 | `geometry_file_format` |
| `seed` | 不支持 | `model_seed` | `seed` |

Hyper3D 的 `material` 还有 `All` 和 `Hybrid` 两个值。要 PBR 时，通过 `providerOptions.material` 传这两个值会被保留。

## 命令行工具

Key 只从环境变量读取：`MESHY_API_KEY`、`TRIPO_API_KEY`、`HYPER3D_API_KEY`（或 `RODIN_API_KEY`）。

```powershell
node scripts/model3d-cli.cjs providers
node scripts/model3d-cli.cjs balance tripo --region cn
node scripts/model3d-cli.cjs generate meshy --mode image --image D:\图\chair.png --format glb --yes
node scripts/model3d-cli.cjs status output\model3d\meshy-<时间>.task.json
node scripts/model3d-cli.cjs resume output\model3d\meshy-<时间>.task.json
```

- `balance` 和 `status` 不消耗积分。`generate` 会消耗积分，必须加 `--yes`。
- 任务记录保存在 `--out` 目录（默认 `output/model3d`）。中断后用 `resume` 续跑。
- 需要代理时用 `node --use-env-proxy scripts/model3d-cli.cjs ...`，并设置 `HTTPS_PROXY`。

## 适配器约定

每个适配器模块导出一个只读的信息对象和一个工厂函数，另外导出构造请求体的纯函数供测试使用。

```js
const { MESHY, createMeshyProvider } = require('./meshy-3d.cjs');
const provider = createMeshyProvider({ apiKey, baseUrl, fetchImpl });
```

信息对象（`MESHY`、`TRIPO`、`HYPER3D`）：

| 字段 | 说明 |
| --- | --- |
| `id` | `meshy`、`tripo`、`hyper3d` |
| `name` | 显示名，也用在错误信息里：`Meshy`、`Tripo`、`Hyper3D` |
| `docs` | 对应的接口说明文件路径 |
| `baseUrl` | 默认 API 地址。Tripo 另有 `regions: { global, cn }` |
| `modes` | 支持的 `mode` |
| `formats` | `format` 可取的值 |
| `defaultModel`、`models` | 默认模型标识，以及 `[{ id, label }]` 列表 |
| `limits` | `{ promptMax, multiview: [min, max], targetFaces: [min, max], seedMax, imageMaxBytes, imageFormats }`。没有官方数值的项不写。`imageFormats` 写成 `jpeg`、`png`、`webp` 这样的短名 |
| `maxWaitMs` | 单个阶段最长等待时间 |
| `supportsCancel`、`supportsImageUrl` | 能否取消；参考图能否直接传网络地址 |

`limits.targetFaces` 只能表达一个范围。面数上限随模型变化时（Meshy 的低面数模型、Tripo 的各个模型），
更细的检查在适配器里做，或者交给服务商校验。

工厂函数的参数：`apiKey`（必填，只接受可打印的 ASCII 字符）、`baseUrl`（可选，必须是 HTTPS）、
`fetchImpl`（可选，默认 `globalThis.fetch`），Tripo 另有 `region`（`global` 或 `cn`，默认 `global`；给了 `baseUrl` 时 `region` 仍然必须是这两个值之一）。返回的对象：

| 成员 | 说明 |
| --- | --- |
| `info` | 上面的信息对象 |
| `submit(request, { signal })` | 校验请求、准备参考图、提交第一步。返回任务记录。**只发一次创建请求，任何情况下都不自动重发** |
| `query(handle, { signal })` | 发一次查询，返回状态。失败时抛 `queryFailure` 构造的错误 |
| `nextStage(handle, status)` | 纯函数，不发请求。当前阶段成功后如果还需要再提交一步，返回 `{ stage }`，否则返回 `null` |
| `advance(handle, status, { signal })` | 提交 `nextStage` 指出的那一步，返回新的任务记录。同样只发一次、不重发 |
| `cancel(handle, { signal })` | 返回 `{ supported, canceled, detail }`。服务商没有取消接口时返回 `supported: false`，不发请求。**不能删除已经完成的任务**：Meshy 的删除接口对已完成的任务也会成功，并且永久删掉结果文件 |
| `balance({ signal })` | 返回 `{ balance, unit: 'credits', detail }`，`detail` 是服务商返回的其他余额字段。失败时抛 `readFailure` 构造的错误 |
| `pollDelayMs(attempt, lastStatus)` | 两次查询之间等多久。`pollDelayMs(0)` 也是新任务首次查询前的等待时间 |

适配器遇到服务商不支持的统一字段时，报 `unsupported`，不要悄悄忽略。

### 任务记录

任务记录是可以直接 `JSON.stringify` 的普通对象，用来在重启后续跑。里面不能有 API Key、图片数据或带签名的下载地址。

| 字段 | 说明 |
| --- | --- |
| `provider` | 服务商 `id` |
| `taskId` | 当前阶段的任务 ID |
| `stage` | 当前阶段名，如 `generate`、`preview`、`refine`、`convert` |
| `format` | 调用方要的模型格式 |
| `next` | 下一步要提交的内容 `{ stage, body }`，没有就是 `null`。在 `submit` 时就确定好，重启后不依赖原始请求。`stageOptions` 会存进这里，所以其中不能有图片数据或密钥 |
| `history` | 已完成阶段的 `[{ stage, taskId }]` |
| `baseUrl` | 创建任务时用的 API 地址。只用来比对，不用来拼请求地址 |
| 其他 | 服务商自己需要的字段：Meshy 的 `kind`，Tripo 的 `expectedFormat`，Hyper3D 的 `subscriptionKey` 和 `creditsConsumed` |
| `advancing` | 由统一入口写入，适配器不要写。表示某个后续阶段的提交已经发出但结果没有记录下来 |

任务记录只能用在创建它的 API 地址上。换了区域、换了中转地址，查询会直接报错，不会把 Key 发到别的地址。
要继续旧任务，得先把 API 地址配回原来的。

### 状态

| 字段 | 说明 |
| --- | --- |
| `state` | `queued`、`running`、`succeeded`、`failed`、`canceled`、`unknown`。`unknown` 表示服务商返回了不认识的状态，轮询会继续 |
| `progress` | 0 到 100 的数，服务商不提供时为 `null` |
| `remoteStatus` | 服务商原始状态字符串 |
| `outputs` | 用 `model3dOutput` 构造的 `[{ role, format, url, name }]`。`role` 取 `model`、`texture`、`thumbnail`、`image`、`file`。调用方要的格式排在最前 |
| `error` | 失败时为 `{ code, message, retryable }`，否则为 `null`。`retryable` 表示不改输入、新建一个任务有可能成功 |
| `creditsConsumed` | 服务商报告的本任务积分消耗，没有就是 `null` |
| `expiresAt` | 结果过期时间（Unix 毫秒），没有就是 `null` |
| `retryAfterMs` | 服务商要求的下次查询间隔，没有就是 `null` |

### 错误

所有错误都用 `model3dError(kind, name, extras)` 构造，或者用 `submitFailure`、`queryFailure`、`readFailure` 按 HTTP 结果映射。
每个错误带三个标志：

| 标志 | 含义 |
| --- | --- |
| `confirmedFailure` | 这次尝试已经确定结束，服务商那边没有在跑的任务。重新提交不会重复扣费 |
| `submissionUnknown` | 任务可能已经创建并扣费。不能自动重新提交，要先核对 |
| `retryable` | 不改输入，稍后重复同一个调用有可能成功 |

| `kind` | `code` | 何时使用 |
| --- | --- | --- |
| `invalid` | `MODEL3D_INVALID_REQUEST` | 本地校验没通过，没有发请求。任务记录损坏或不匹配时也用它，这时 `confirmedFailure` 为假，因为原任务可能还在跑 |
| `unsupported` | `MODEL3D_UNSUPPORTED` | 服务商没有这项能力 |
| `auth` | `MODEL3D_AUTH_FAILED` | Key 缺失、无效或无权访问 |
| `credits` | `MODEL3D_INSUFFICIENT_CREDITS` | 积分不足 |
| `forbidden` | `MODEL3D_FORBIDDEN` | 套餐或权限不允许 |
| `content` | `MODEL3D_CONTENT_REJECTED` | 内容审核拦截。只在服务商的响应能区分出审核拦截时使用 |
| `rejected` | `MODEL3D_REQUEST_REJECTED` | 服务商明确拒绝了请求，没有创建任务 |
| `rateLimited` | `MODEL3D_RATE_LIMITED` | 限流或并发已满，没有创建任务。带 `retryAfterMs` |
| `network` | `MODEL3D_NETWORK_UNAVAILABLE` | 连接没有建立，请求确定没有发到服务商 |
| `unavailable` | `MODEL3D_SERVICE_UNAVAILABLE` | 与任务无关的读取（如余额）遇到服务端错误 |
| `upload` | `MODEL3D_UPLOAD_FAILED` | 参考文件上传失败，还没有创建任务 |
| `submissionUnknown` | `MODEL3D_SUBMISSION_UNKNOWN` | 创建请求超时、连接中断，或返回 `408`、`425`、`5xx` |
| `invalidResponse` | `MODEL3D_INVALID_RESPONSE` | 响应缺少必要字段 |
| `statusUnavailable` | `MODEL3D_STATUS_UNAVAILABLE` | 查询失败。带 `transient: true` 时轮询会继续 |
| `taskNotFound` | `MODEL3D_TASK_NOT_FOUND` | 任务不存在或已过期 |
| `taskFailed`、`taskCanceled` | `MODEL3D_TASK_FAILED`、`MODEL3D_TASK_CANCELED` | 任务在服务商那边失败或被取消。由统一入口抛出 |
| `waitTimeout` | `MODEL3D_WAIT_TIMEOUT` | 等待超过 `maxWaitMs`，任务可能还在跑 |
| `download` | `MODEL3D_DOWNLOAD_FAILED` | 模型文件下载失败，任务本身是成功的 |

创建请求（`submit` 和 `advance`）的规则：

- 一次调用只发一次创建请求。超时、连接中断、`408`、`425`、`5xx` 一律按 `submissionUnknown` 抛出，不重发。
- 服务商文档明确说明“请求没有被受理”的情况（如 `429`）用 `rateLimited`，由调用方决定何时再提交。
- 创建请求之前的步骤（读图、上传参考图）失败时，任务还不存在，用 `invalid` 或 `upload`。
- 请求体在发出前先序列化。不能写成 JSON 的参数算本地错误，不算“结果未知”。
- 错误信息、错误对象的属性和任务记录里都不能出现 API Key。

## 已知限制

- 下载地址只检查是不是公网 HTTPS 地址，没有像 `public-media-download.cjs` 那样把 DNS 结果固定到连接上。
  下载地址来自服务商的接口响应，下载时不带 API Key。
- 下载的单个文件上限是 2 GB，超时 15 分钟。
- Meshy 的 `403` 有六种原因（IP 白名单、套餐、审核、账户被封等），响应里只有一段文字，区分不出来，一律报 `forbidden`。
- Hyper3D 的 `/status` 不返回失败原因，任务失败时只能提示“服务商没有返回失败原因”。
- Hyper3D 的默认模型 `Gen-2.5-Medium` 和余额接口都需要 Full API 权限。只有 Basic 权限的 Key（Creator 订阅）要把 `model`
  设成 `Gen-2.5-Low` 或 `Gen-2.5-Extreme-Low`，查余额会报 `MODEL3D_FORBIDDEN`。
- Hyper3D 多视图没有发送视角标注 `image_label`，服务商只知道图片顺序（正面在前）。原因是官方没有说明数组参数在表单里
  怎么写，两个官方客户端的写法也不一样。出于同样的原因，`providerOptions` 里不接受数组，`bbox_condition`、`image_label`
  这类参数要自己写成字符串传入。
- Hyper3D 的 `Gen-2.5-Extreme-High` 会多返回一个最多 1000 万面的网格。下载列表的顺序和文件名官方没有说明，
  `primary` 取的是第一个格式匹配的文件，可能不是想要的那个。这时看 `outputs` 自己挑。
- Hyper3D 提交时返回 `5xx`，官方建议退避重试。这里仍按“结果未知”处理，不自动重发。
- Tripo 的 P2 模型加 `quad` 时返回什么格式，官方文档没写。链接里看不出扩展名时按 GLB 处理，可能多提交一次转换。
- 没有实现 Webhook、SSE、绑骨、动画、重新贴图、重拓扑这些接口。官方说明里有它们的参数，需要时再加。
