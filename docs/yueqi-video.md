# Yueqi 视频渠道

## Pro 720 停用

2026-09-23 按用户要求在正式、预览 CONFIG 关闭 `ravenhash-video.seedance-2.5-pro-720` 的 `catalog.enabled`，保留管理卡片、原有任务恢复、价格和其他渠道。正式 r21 回执 `94fbfe63-9a8c-4def-94e6-6fb1e6ed1322`；预览 r22 回执 `62c916fb-9b74-4c51-bfe8-48e571e88cd3`。当前画布读取正式源，已主动刷新并确认可用模型列表不再含该型号。本次停用范围为画布 CONFIG，没有修改 art/cart 数据库或供应商账户。

## 2026-09-23 Pro 720 排查

目标为 `seedance-2.5-pro-720`，经 `art.ravenhash.org` / `cart.ravenhash.org` 使用 `/v1/video/generations`；Yueqi 公开接口为 `/v1/videos`。已有转发规则将两者连通，公开示例使用 `seconds`、`ratio`、`resolution`、`image_urls`，没有证据要求改成 multipart。

本次存在两个独立问题：

- 老站日志 737（2026-09-23 03:43:47 UTC）显示供应商 HTTP 503，`model_not_found`，原因为 `No available channel for model seedance-2.5-pro-720 under group default (distributor)`，费用 0、无上游任务 ID。请求排查号 `202609230343480510083498268d9d62U0GG9P6`。不能用修改时长或重试证明已恢复，需要供应商恢复该账号分组的渠道。
- 本机 03:45:24 UTC 的带视频参考请求被旧 Seedance 分支拦为“最多支持 0 个参考视频”。精确型号现在按现有远端能力配置允许 30 图、10 视频、10 音频，固定 720p、1-60 秒、默认 10 秒；仅匹配 art/cart/yueqi 三个精确主机，其他旧渠道约束保持原状。这些是参数契约校正，没有验证供应商全部边界的实际生成成功率。

03:47 的另一次提交连接中断后使用本地排查 ID `fc_5a34e942a90b4f0c864a477991a1b38c` 尝试恢复，最终查询 HTTP 400；未在老站日志找到对应条目，不能把它当作真实上游任务，也没有重发。

代码修复在 `electron-main/video-provider-adapters.js` 与 `electron-main/mcp-bridge.js`，单参 helper 对旧调用兼容。提交 JSON 继续保留原 `seconds/ratio/resolution` 和引用 URL 字段。已完成模拟上传、请求体、已有任务恢复测试，以及错误映射回归；未调用收费生成，也未更改两站计费或开关。

客户端对明确 `model_not_found` + `No available channel for model` 且没有任务 ID 的完整响应按模型不可用处理；普通 5xx、传输失败或已有任务 ID 仍按提交结果未知处理，避免自动重发。已由服务端转换成通用错误的旧响应无法从客户端还原，运维应以原始日志为准。

本次没有重启用户正在运行的源码主进程，因为另一个视频恢复请求仍在运行。任务结束后重启源码画布才会加载主进程适配改动；beta.8 安装包不包含该补丁。
