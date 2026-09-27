# Yueqi 视频渠道

## 2026-09-27 远程规则接管

后续已发布 CONFIG r41，以 `parameterRules` 控制 SD2 Fast 的分辨率与时长联动。新版客户端优先采用远程条件规则，`shared/sd2-fast-validation.cjs` 只用于缺少规则的旧配置回退。480p 为 1-15 秒，720p 为 1-12 秒；基础配置设为最多 12 秒以兼容旧客户端。已验证运行中放宽与回滚限制会同步更新打开的参数面板，源码应用也已正常重启。媒体错误网关与管理员排查入口已部署到两站和 CONFIG；完整说明见 [远程参数规则与结构化报错](remote-rules-and-errors.md)。

## 2026-09-27 SD2 Fast 时长联动

截图中720p/15秒提交被本地适配器拒绝，但前端仍显示15秒滑块且将具体错误转换成通用重试提示。现已将SD2 Fast的分辨率时长约束集中到 `shared/sd2-fast-validation.cjs`，画布控件、提交前校验、Agent及请求适配器共用：480p为1-15秒整数，720p为1-12秒整数，仅作用于精确sd2-fast与art/cart/yueqi主机。

选择分辨率时重建时长控件；旧15秒配置切到720p调整为12秒，并提醒检查提示词时间安排，提示词不自动改写。受远端更严格限制的时长选项不被扩大。非法输入会在提交前拒绝，固定本地错误码 `LOCAL_SD2_FAST_DURATION_OUT_OF_RANGE` 对应明确提示，不回显上游原文、不建议原参数重试。

已通过相关参数/Agent测试85项、错误展示/适配器测试70项，前端构建与ESLint通过；隔离Electron验证480p15秒→720p12秒→480p可选15秒以及提示词保持原样，桌面和窄窗口截图已检查。未调用收费生成。当前用户有进行中的视频任务，本次不为加载主进程模块而中断任务；前端控件已由源码更新，主进程错误码在下次正常重启生效。本次没有远端CONFIG、计费或安装包发布。

## 2026-09-23 SD2 Fast 参考参数修复

用户转述上游并确认 `sd2-fast` 的“930”表示最多 9 张图片参考、3 个视频参考、0 个音频参考。公开价格接口和老站模型描述当时仍写 9/3/3，此处以用户提供的上游确认为准；只限制输入参考，不据此推断成片是否有声音。

老站日志 759-762（2026-09-23 13:31-13:37 UTC）均返回 HTTP 400：`json: cannot unmarshal object into Go struct field .Alias.images of type string`，费用 0、无任务 ID。客户端此前将该模型送入通用视频分支，发送 `images` 对象数组和 `ratio: adaptive`。脱敏证据见本地 `output/sd2fast-art-inspection.json`。

现在仅对 art/cart/yueqi 三个精确主机上的 `sd2-fast` 使用专用适配：上传参考素材为公网 URL，发送 `image_urls`、`video_urls` 字符串数组、具体 `aspect_ratio`、数字 `duration`、字符串 `seconds`。自动比例按首图尺寸解析，未带首图时默认 16:9。480p 最长 15 秒，720p 最长 12 秒；超量、音频参考以及失联或格式不支持的素材均在上传和提交前拒绝。上游示例外层的 `action/platform/request` 没有作为公开接口字段发送。

art/cart 继续使用 `/v1/video/generations`，既有规则 37 将请求透传至 `/v1/videos`；直连 yueqi 使用 `/v1/videos`。任务恢复只查询原任务，不重新上传或提交。

正式 CONFIG r25、预览 r26 已发布 9/3/0 能力和请求字段，回执见本地 `output/sd2fast-config-receipt.json`。后续正式 r27 仍保留该修复。没有修改计费、渠道开关或中转规则。

已通过适配器及桥接模拟 62 项、Agent 预检 61 项测试和定向 ESLint。补充失联素材检查后，三站桥接回归 8 项再次通过。源码主进程已在无活动生成任务时正常重启；未提交收费生成，尚未验证供应商实际出片。本次未发布新安装包。

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
