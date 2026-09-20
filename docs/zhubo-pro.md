# Seedance 2.5 Pro

2026-09-20 接入 `seedance-2.5-pro`。已完成 Corvas 和老站 `art.ravenhash.org`；随后按用户要求将模型同步到新站 `cart.ravenhash.org`，客户端已适配两个站点的展示、分组和已确认售价。

- 上游：`https://video.zhubo.asia`，沿用老站渠道 3 的已有凭据。
- 接口：POST `/v1/videos`，GET `/v1/videos/{task_id}`；客户端经老站原有转发规则 37 调用。
- 参数：`model`、`prompt`、`seconds`、`ratio`、`resolution`、`image_urls`、`video_urls`、`audio_urls`。
- 支持 4-30 秒整数、480p/720p、最多 30 图/10 视频/10 音频；上游要求参考视频时长不得超过输出时长。
- 用户确认售价 1.06 元/秒，480p 和 720p 相同。老站以 USD 记账，部署时汇率为 6.75，单价为 `1.06 / 6.75`，使用 duration/video_resolution 计费。
- Corvas 的“Seedance 2.5 推荐渠道”依次显示 `sd2.5`（电商效果优化）、Pro（满血满参）、`seedance_v2.5` 和 `seedance_v2.0-933`。`sd2.5-route1` 放在“Seedance 2.5 备用渠道”，名称标注“过人脸”。
- Seedance 2.0 Fast、Mini、Pro 放在“Seedance 2.0 推荐渠道”并置底；MiniMax H3 保持独立。每个渠道组下方显示“当前使用：xxx”。
- 新站同步后有 9 个启用模型；两条 HM 规格 `seedance_v2.5-101010`、`seedance_v2.5-301010` 在两个站点均暂停新生成，原有账号和任务恢复仍保留。
- 客户端仅对 `art.ravenhash.org`、`cart.ravenhash.org` 两个精确主机显示这组已确认售价：Pro 为 1.06 元/秒，固定 30 秒渠道为 6 元/次，HM 2.5 为 5 元/次，HM 2.0 933 为 6.5 元/次；其它站点不继承这些价格。

官方模型目录 `/api/video/models` 与鉴权 `/v1/models` 均确认 Pro 可用。前者标示的 0.25 元/秒是上游价格，未用作老站售价。

部署由 `server/seedance-hm/add-pro.sql` 和 `deploy-pro.py` 完成。数据库备份、迁移 SQL、前后配置及核对报告保存在老站私有目录 `/opt/tokensbyte-backups/zhubo-pro-20260920T122600Z/`。事务预演回滚通过；正式执行后核对现有计价、转发和凭据未变。回退应只停用新模型，并按备份恢复本次分组字段，不恢复整库覆盖后续业务数据。

已通过请求参数、模拟提交与任务恢复、模型配置校验和 Electron 模型选择器验证；未发起付费生成。客户端已通过 `electron scripts/configure-seedance-route.cjs --pro --apply` 将 Pro 追加到现有加密 API 配置，需重新加载客户端读取。

相关验证：`node --test electron-main/hm-video-generation.test.cjs electron-main/openai-image-request.test.js src/video-model-profiles.test.js shared/model-config.test.cjs shared/video-generation-availability.test.mjs`；界面冒烟 `node scripts/zhubo-pro-smoke.cjs`（需 Playwright，可用 `PLAYWRIGHT_MODULE` 指定路径）。
