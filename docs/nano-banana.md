# Nano Banana 2.1

## 接口契约

- 站点：`https://ai.ravenhash.org`；请求模型：`gemini-nano-banana-2.1`。
- 2026-10-13 用户提供的 Key 经 `GET /v1/models` 核验，仅返回该模型。
- 生图走 `POST /v1beta/models/gemini-nano-banana-2.1:generateContent`，Bearer 鉴权。
  不使用 `/v1/images/generations` 或 `/v1/images/edits`。
- 文本与参考图放入 `contents[].parts[]`；参考图使用 `inlineData`。
  读取实际图片编码，JPEG、PNG、WebP 保留，其他格式转为 PNG，原文件不变。
- `generationConfig.responseModalities` 为 `TEXT`、`IMAGE`；
  `generationConfig.imageConfig.imageSize` 为 1K、2K 或 4K。
  `aspectRatio` 为远端目录提供的比例；自适应时省略。
- 响应从 `candidates[].content.parts[].inlineData` 提取图片，忽略 thought 图片与文本，
  复用已有保存、恢复记录及画布落图流程。单请求只生成一次，不因未知提交结果自动重发。
- 界面提供原生分辨率与比例控件，隐藏未接入的联网搜索；模型不能用于文字分析。

比例与档位结构参考 Gemini v1beta 官方 discovery schema；该别名每种组合的实际输出尺寸
尚未以收费生成逐一核验。未凭空设置参考图数量上限。

## CONFIG 与本机

- 2026-10-13 发布 CONFIG r69：`20261013T075440-r69.json`，
  新条目 `ravenhash-image.nano-banana-2-1`，仅匹配 ai 站点。
- 发布前备份：`/var/lib/flow-config/operations/nano-banana-1791878080001/before.json`。
  发布脚本核对既有条目不变，未更改 art/cart 中转渠道或钱包。
- 售价元数据为 0.085 CNY/次，来自 ai 当时的模型价格、分组倍率和货币配置。
  未修改后台计费。
- Key 仅保存在本机系统凭据加密的 API 配置中，不写入源码或公开 CONFIG。
- 本机已有 RavenHash Image 账号使用此 Key；校正其默认模型，保留账号 ID、其余账号、
  全局选择和既有节点引用。不要把此 Key 当成其他生图模型的通用 Key。
- 适配包含 Electron 主进程代码，开发服务热更新不会替换已运行的主进程，必须完整重启。
  已发布 beta.22 安装包不含本适配，需要后续版本发布。

## 404 排查记录

`fc_87d37242dd00bf0a660d464184d2fe58` 于北京时间 2026-10-13 16:15 提交。
后台选中了渠道 108，但路径仍是 `/v1/images/edits`，返回
`Images API is not supported for this platform`。本机日志同时记录 multipart 图片请求；
当时主进程仍是 14:44 启动、尚未加载 Nano 适配的旧进程。

该错误是接口协议不匹配，不能以此判断上游生图服务离线。客户端现将其映射为
`RH_MODEL_ENDPOINT_MISMATCH`；v2 保留 HTTP 404、明确拒绝及不可自动重试状态。
网络中断或不确定的 5xx 仍保留提交结果未知的处理。

16:23 已正常重启本机源码版，确认画布与 CONFIG r69 恢复、原失败节点和参考连接保留。
没有重提该生成任务，也没有进行额外收费生成。

## 验证

- 原生请求、图片 MIME、比例及档位、审核和空结果处理的定向测试。
- 实际 Electron 隔离环境中点击生成，用模拟 Gemini 响应验证图片保存及原节点落图；
  检查深色、浅色与窄窗口布局。
- 源码版 Vite 对共享 CommonJS 模块的转换已补齐。
- 404 修正后，错误映射与 Nano 适配的 47 项定向测试通过。

## 账号恢复与权限显示

2026-10-13 随后排查“全部生图不可用”：当前仅剩 Nano Banana 生图 Key，
Sunburst 素材复用节点仍引用已删除的 `api_1791807791004cly0n`，三个旧节点仍引用
`relay-ai-1-image`。远端目录此前把同站点全部图片模型展开到每一个账号，不能证明
该 Key 有相应权限。

通过本机加密备份恢复并只读核验三个独立账号：

- `GPT 生图`：`api_1791807791004cly0n`，Key 模型列表返回 gpt-image-2、flare、sunburst。
  当前 CONFIG 发布其中的 gpt-image-2 与 sunburst；没有擅自上架 flare。
- `Midjourney`：`api_1788084125342a3fnq`，仅 mj_imagine。
- `Nano Banana 2.1`：`api_1791808242292pudix`，仅 gemini-nano-banana-2.1。

本机加密配置 r176，新建生图默认选择 GPT 的 sunburst。恢复原账号 ID 使素材复用节点
重新得到对应 Key；另外用画布事务 `repair-image-accounts-20261013` 更新三个旧绑定，
保留节点内容及连接，撤销令牌 `undo_jrj618`。没有自动提交生成。

手动拉取模型并保存后，账号持久化 `modelAvailability.models/checkedAt`，仅用作
远端目录与已核验 Key 权限的交集；模型参数仍取自 CONFIG。编辑 Key、URL 或 API 类型后
会清除旧权限结果，站点登录更换 Key 同样清除。未核验账号保持原目录行为。
权限发生变更时重新点击“拉取模型”并保存，不将旧快照当作永久服务端授权。

已失效或不支持所选图片模型的绑定在上传前返回 `RH_IMAGE_PROVIDER_UNAVAILABLE`，
明确标注未提交，并提示重新选择模型和账号；不自动借用其他 Key。

Nano 请求 `fc_1f97f3569af691c1a235cb4df47955b0` 已走原生接口，返回 HTTP 400、
“提示词或图片未通过内容审核”，是上游拒绝，不能归为缺少账号或接口 404。
本轮只核验模型权限与本地流程，没有用收费生成替代排查。

相关改动通过完整 lint、1,632 项测试及 renderer build。
