# 视频渠道选择

2026-09-20 调整 Corvas 视频菜单：MiniMax H3 保持独立；原“主播视频”改为“Seedance 2.5 推荐渠道”；`sd2.5-route1` 单独收进“Seedance 2.5 备用渠道”；海外 2.0 Fast、Mini、Pro 收进“Seedance 2.0 推荐渠道”，排在最后。

2026-09-21 所有渠道组的小字统一为“当前使用：模型名称”。选中组内模型后显示所选模型的完整名称，未选中的组显示组内首项。模型参数和价格继续显示在展开后的模型条目中；2.0 的“可NSFW 无限制”保留为搜索关键词。

备用渠道 `sd2.5-route1` 的显示名称为“Seedance 2.5 固定 30 秒（过人脸）”。

2026-09-21 后续调整：画布与侧栏模型说明只显示能力参数，不显示价格；Agent 计划卡也不显示单价、预计费用或未知费用。结构化计费元数据保留，新站单价以本次代理分成调价为准，见 `docs/tkeapi-deployment.md`。

2026-09-21 重新启用已保存的 StarFrame 直连账号（`api.xzapi.vip`，模型 `ch0107-sd-2.5-720p`），显示名称为“2.5pro 备用（满参）”，放入“Seedance 2.5 备用渠道”。该备用组使用明确的 `routeGroupScope: catalog` 合并不同供应商的展示，条目仍保留原 `sourceProviderId`、模型 ID 和请求端点，选择时不会混用凭据。其它组继续按账户隔离。鉴权模型列表已返回 200 并包含该模型；此次未发起真实视频生成。

推荐组依次显示 `sd2.5`（电商效果优化）、`seedance-2.5-pro`（满血满参）、`seedance_v2.5`、`seedance_v2.0-933`。模型 ID、参数和账户绑定不变。2026-09-22 起，展示由当前生效 CONFIG 的 `presentation` 最后覆盖，本地 `getVideoModelGroup` 只补未声明字段。分组、排序、合组范围、显隐均可配置；只有 `routeGroupScope: catalog` 明确允许跨账号展示。

`shared/video-generation-availability.mjs` 暂停以下主机与模型的新提交，并同步过滤画布菜单和 Agent 模型列表：

- `art.ravenhash.org`：`seedance_v2.5-101010`、`seedance_v2.5-301010`。
- `zcbservice.aizfw.cn`：`sd_2.5_discount_v1`。

GlobalAiOpc 为直连供应商，只停用 Corvas 的新生成入口。保存的账户、凭据、历史任务及恢复接口不删除。恢复上架时移除对应暂停项；不要通过删除 API 配置来停用渠道。StarFrame 已按上述记录恢复新生成入口。

老站已运行 `server/seedance-hm/pause-models.py`，仅将两条 HM 模型的 `is_active` 改为 `0`。前后模型配置及定向回退 SQL 位于服务器私有目录 `/opt/tokensbyte-backups/pause-hm-20260920T155206Z/`。鉴权 `/v1/models` 已确认返回其余九个原有视频模型。恢复老站时使用该目录的 `restore.sql`，不用整库恢复。新站 `cart.ravenhash.org` 于 2026-09-21 同步了模型目录，详见 `docs/tkeapi-deployment.md`。

验证：`node --test src/video-model-profiles.test.js electron-main/video-generation-availability.test.cjs`；`node scripts/video-channel-picker-smoke.cjs`。界面检查覆盖分组顺序、单条备用分组、暂停过滤、搜索、模型绑定和窄窗口定位；没有提交付费生成。
