# StarFrame API / XZAPI

## 2026-09-23 CH1401 画幅

官方工作台 `https://web.xzapi.vip/` 当前引用 `assets/index-vY2NTUf5.js`，其精确 CH1401 能力为 `YT="ch1401-sd-2.5-720p"`、`aspects: HU`、`HU=["16:9","9:16"]`、`resolutions:["720p"]`，并在界面及提交前用该枚举校验。已将 CH1401 的 `options.ratio` 从 `unknown` 改为这两个值，正式 r23、预览 r24；其他参数和模型不变。原始未知配置在严格远程目录下不生成比例选项，因此此前缺少画幅控件。

当前画布已收到 r23，并通过模型列表回读确认 ratios 为 16:9/9:16。720p 清晰度不变；已打开的参数面板重新打开即可重建控件。官方工作台时长固定30秒，但公开定价目录仍写4-30秒，保留现有时长范围并记录差异，未以收费生成探测边界。

## 2026-09-23 CH1401

`ch1401-sd-2.5-720p` 已接入 art/cart 两站，显示“2.5pro 备用（卡人脸）”，位于“Seedance 2.5 备用渠道”。老站 5.00 元/次，新站 5.72 元/次；720p、4-30 秒，最多 30 张图片参考，不支持视频或音频参考。

复用现有 StarFrame channel 6、forward rule 50 和上游凭据。两站新模型 ID 均为 27、MID 为 `310013`；老站计费规则 38，新站 34。CH0107 的计费和映射保持不变。正式和预览 CONFIG 已有启用条目，无需新发目录版本或桌面安装包；管理页独立价格快照已补齐两站价格。

`server/seedance-hm/deploy-starframe-variant.py` 已修正双站差价、TEXT JSON 编码、时区比较、并发保护及定向停用脚本。两站事务预演、实际写入和逐字段复核通过，供应商认证模型列表均包含 CH1401；老站使用本机既有 Key 请求 `/v1/models` 返回 200 并包含 CH1401。新站本机未保存 Key，因此只完成数据库、渠道、上游与转发验证，未提交收费生成任务。

正式备份：老站 `/opt/tokensbyte-backups/starframe-ch1401-20260922T172042Z/`；新站 `/root/tkeapi-backups/starframe-ch1401-20260922T172049Z/`。备份包含私有整库数据、前后快照、迁移及只移除 CH1401 的停用 SQL。价格快照备份为 CONFIG 服务器 `/root/ch1401-admin-prices-20260922T172238Z.json`。

供应商：`https://api.xzapi.vip`。模型：`ch0107-sd-2.5-720p`。Key 沿用 Corvas 加密凭据仓库保存。

2026-09-21 已同步到 art/cart 两站，显示名称“2.5pro 备用（满参）”。新站售价 1.25 元/秒，老站 1.06 元/秒；两站使用 `/v1/video/generations` 提交/查询入口。直连供应商仍使用 `/v1/videos`。归一化结果的 `data[].url` 与原生 `metadata.url` 均可识别经校验的 StarFrame 签名存储链接。详情见 `docs/tkeapi-deployment.md`。

售价按用户在 2026-09-20 指定的 **CNY 1.06/秒**展示，仅精确匹配 `api.xzapi.vip`。公开价格 API 的 `model_price` 是平台内部计价字段，不用于覆盖用户指定售价。任务计划按生成时长乘以条数计算预计费用，例如 5 秒 x 2 条 = CNY 10.60；实际账单以供应商扣费为准。

## 已接入

- `POST /v1/videos` 创建任务，固定 `mode: references`。纯文本请求不传空 references。
- 单个素材使用 `references.image/video/audio`，两个及以上使用 `references.images/videos/audios`；不发送空数组或单元素数组。
- 固定 720p，4-30 秒整数；最多 30 图、10 视频、10 音频，合计最多 50。仅使用公网 URL，沿用现有临时上传服务，不回退 Base64。
- `client_task_id` 来自持久化客户端任务 ID；不合规格的本地 ID 使用稳定哈希转换，不在重试时随机变更。客户端 ID 与供应商返回的 `task_id` 分开保存和使用。
- `GET /v1/videos/{task_id}` 查询任务；完成后校验任务 ID。实际响应可能包含 StarFrame 对象存储签名链接（`starframe-sh.tos-s3-cn-shanghai.volces.com`），识别到时直接下载且不携带 API Key；其他情况使用配置 API 的 `/v1/videos/{task_id}/content` 鉴权下载。签名过期时重新查询原任务获取新链接。失败读取 `metadata.fail_reason`。
- 任务恢复只查询、下载原任务；提交断线或供应商 409/410 返回需要核对的状态，不用客户端 ID 冒充上游任务 ID，不自动生成新订单。
- 下载发生跨源 CDN 重定向时不转发 API Key，包括 HTTP/1.1 兼容回退路径。

## 当前边界

CH0107 的公开文档没有列出完整画幅枚举、提示词长度和媒体文件限制。CH1401 的画幅已按上述官方工作台补齐 16:9/9:16。调用层可接收其他明确指定的正数宽高比，但不保证供应商支持；远端目录校验按各型号声明的枚举执行。素材沿用 Corvas 既有文件格式与上传大小保护，其余约束由供应商校验。

文档提到 frames 模式，但未确认目标模型是否开放；本次保持默认 references 模式，1-2 张图片也作为参考素材发送，不自动改为首尾帧。不发送文档未列出的生成音轨、水印、固定镜头或联网搜索参数。

## 验证

`starframe-video.test.cjs` 覆盖参数、参考数量、稳定客户端 ID 和下载地址校验；`starframe-generation.test.cjs` 通过实际生成桥接入口验证模拟上传、提交、查询、鉴权下载、任务恢复及跨源凭据隔离。费用测试覆盖 5 秒 x 2 条和原按次价格行为。本次只进行真实 Key 的只读检查，不提交收费生成。

来源：[开发者文档](https://docs.xzapi.vip/)、[错误码](https://docs.xzapi.vip/errors.html)、[公开定价目录](https://api.xzapi.vip/pricing)，核对日期 2026-09-20。
