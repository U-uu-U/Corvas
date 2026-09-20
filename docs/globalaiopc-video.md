# GlobalAiOpc 视频渠道

模型 `sd_2.5_discount_v1` 使用 GlobalAiOpc 原生任务中心协议。供应商 API 地址可填写 `https://zcbservice.aizfw.cn`、其 `/kyyReactApiServer` 前缀或完整的 `/kyyReactApiServer/v2/model-center/tasks` 地址。API Key 使用现有 `ApiConfigStore` 加密存储，不包含在默认配置或仓库中。

## 生成流程

1. 验证时长、画幅、分辨率和素材数量。支持 4-30 秒、480p/720p/1080p、16:9/9:16/1:1/4:3/3:4/21:9/adaptive，生成音频可开关。
2. 将本地素材通过 Corvas 现有临时存储上传，获得公网 URL。该渠道不允许上传失败后回退 Base64。
3. 使用 `asset/seedance2/assetUpload` 提交素材，模型族为 `sd_2.5`；等待 `assetDetail` 返回 `ACTIVE`。
4. 使用 `assetId://...` 引用创建视频任务，持久化上游返回的真实 ID。只有 1-2 张图片且没有音视频参考时按首尾帧提交，其余情况使用 `reference_images/reference_videos/reference_audios`。
5. 按原生任务路径查询，读取明确的 `completed` 状态后下载结果。查询恢复不会重新上传素材或提交生成。

素材 ID 缓存在用户目录 `data/reference-cache/globalaiopc-assets.json`，按接口、账号 Key 的哈希、媒体类型及 URL 隔离。缓存不保存 Key 或原始 URL，复用前会再次查询素材状态。审核失败或超时不会提交视频任务；超时保留已取得的素材 ID。

提交响应丢失时返回 `VIDEO_SUBMISSION_UNKNOWN`。此接口未声明支持 `X-Log-Id` 恢复，不能将本地日志 ID 当作任务 ID 轮询，也不会自动重发生成。

## 输入边界

- 最多 30 张图片、10 个视频、10 段音频。图片小于 30 MB，宽高均在 (300, 6000) 像素，宽高比在 (0.4, 2.5)。这些图片尺寸按最终上传内容验证。
- 文档要求参考视频和音频单个 2-30 秒、每类合计不超过 30 秒。现有 Corvas 文件输入未提供统一时长探测，这部分由素材审核及供应商校验，不能把数量限制当作时长校验。
- 画布沿用现有可导入媒体格式和上传大小保护，不因供应商支持更多格式而扩宽共享图片编辑入口。
- 请求使用参数表声明的整数和布尔类型。首尾帧使用官方请求示例中的 URL 字符串；官方参数表另标为 image[]，此差异仍需要真实生成联调确认。
- 种子默认 -1，调用层支持 `seed`；现有视频节点未新增种子编辑控件。接口价格与并发额度未从示例响应推算。

## 验证

`globalaiopc-video.test.cjs` 验证原生请求、审核缓存、账号隔离、失败和取消。`globalaiopc-generation.test.cjs` 通过真实桥接生成入口串起模拟上传、审核、提交、持久化、查询、下载和恢复；不调用真实收费接口。

参考：[模型接口](https://docs.globalaiopc.com/api-reference/model-center/video-gen/sd_2.5_discount_v1)、[素材提交](https://docs.globalaiopc.com/api-reference/video/seedance-assets/seedance-asset-upload)、[素材详情](https://docs.globalaiopc.com/api-reference/video/seedance-assets/seedance-asset-detail)。
