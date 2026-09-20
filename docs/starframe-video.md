# StarFrame API / XZAPI

供应商：`https://api.xzapi.vip`。模型：`ch0107-sd-2.5-720p`。Key 沿用 Corvas 加密凭据仓库保存。

售价按用户在 2026-09-20 指定的 **CNY 1.06/秒**展示，仅精确匹配 `api.xzapi.vip`。公开价格 API 的 `model_price` 是平台内部计价字段，不用于覆盖用户指定售价。任务计划按生成时长乘以条数计算预计费用，例如 5 秒 x 2 条 = CNY 10.60；实际账单以供应商扣费为准。

## 已接入

- `POST /v1/videos` 创建任务，固定 `mode: references`。纯文本请求不传空 references。
- 单个素材使用 `references.image/video/audio`，两个及以上使用 `references.images/videos/audios`；不发送空数组或单元素数组。
- 固定 720p，4-30 秒整数；最多 30 图、10 视频、10 音频，合计最多 50。仅使用公网 URL，沿用现有临时上传服务，不回退 Base64。
- `client_task_id` 来自持久化客户端任务 ID；不合规格的本地 ID 使用稳定哈希转换，不在重试时随机变更。客户端 ID 与供应商返回的 `task_id` 分开保存和使用。
- `GET /v1/videos/{task_id}` 查询任务；完成后解析同源同任务的 `metadata.url`，带 Bearer Key 下载 `/content`。失败读取 `metadata.fail_reason`。
- 任务恢复只查询、下载原任务；提交断线或供应商 409/410 返回需要核对的状态，不用客户端 ID 冒充上游任务 ID，不自动生成新订单。
- 下载发生跨源 CDN 重定向时不转发 API Key，包括 HTTP/1.1 兼容回退路径。

## 当前边界

公开文档没有列出此模型的完整画幅枚举、提示词长度和媒体文件限制。界面先提供文档示例的 16:9；调用层可接收其他明确指定的正数宽高比，但不保证供应商支持。素材沿用 Corvas 既有文件格式与上传大小保护，其余约束由供应商校验。

文档提到 frames 模式，但未确认目标模型是否开放；本次保持默认 references 模式，1-2 张图片也作为参考素材发送，不自动改为首尾帧。不发送文档未列出的生成音轨、水印、固定镜头或联网搜索参数。

## 验证

`starframe-video.test.cjs` 覆盖参数、参考数量、稳定客户端 ID 和下载地址校验；`starframe-generation.test.cjs` 通过实际生成桥接入口验证模拟上传、提交、查询、鉴权下载、任务恢复及跨源凭据隔离。费用测试覆盖 5 秒 x 2 条和原按次价格行为。本次只进行真实 Key 的只读检查，不提交收费生成。

来源：[开发者文档](https://docs.xzapi.vip/)、[错误码](https://docs.xzapi.vip/errors.html)、[公开定价目录](https://api.xzapi.vip/pricing)，核对日期 2026-09-20。
