# 视频渠道选择

2026-09-20 调整 Corvas 视频菜单：MiniMax H3 保持独立；原“主播视频”改为“Seedance 2.5 推荐渠道”；`sd2.5-route1` 单独收进“Seedance 2.5 备用渠道”；海外 2.0 Fast、Mini、Pro 收进“Seedance 2.0 推荐渠道”，排在最后。

2026-09-21 所有渠道组的小字统一为“当前使用：模型名称”。选中组内模型后显示所选模型的完整名称，未选中的组显示组内首项。模型参数和价格继续显示在展开后的模型条目中；2.0 的“可NSFW 无限制”保留为搜索关键词。

备用渠道 `sd2.5-route1` 的显示名称为“Seedance 2.5 固定 30 秒（过人脸）”。

推荐组依次显示 `sd2.5`（电商效果优化）、`seedance-2.5-pro`（满血满参）、`seedance_v2.5`、`seedance_v2.0-933`。模型 ID、价格、参数和账户绑定不变。展示由 `shared/video-model-profiles.mjs` 的 `getVideoModelGroup` 统一覆盖旧 CONFIG 展示；同组仍按 API 账户隔离，单条备用渠道也保留分组。排序和组说明是本地菜单元数据，不改变远端 CONFIG schema。

`shared/video-generation-availability.mjs` 暂停以下主机与模型的新提交，并同步过滤画布菜单和 Agent 模型列表：

- `art.ravenhash.org`：`seedance_v2.5-101010`、`seedance_v2.5-301010`。
- `zcbservice.aizfw.cn`：`sd_2.5_discount_v1`。
- `api.xzapi.vip`：`ch0107-sd-2.5-720p`。

后两项为直连供应商，只停用 Corvas 的新生成入口。保存的账户、凭据、历史任务及恢复接口不删除。恢复上架时移除对应暂停项；不要通过删除 API 配置来停用渠道。

老站已运行 `server/seedance-hm/pause-models.py`，仅将两条 HM 模型的 `is_active` 改为 `0`。前后模型配置及定向回退 SQL 位于服务器私有目录 `/opt/tokensbyte-backups/pause-hm-20260920T155206Z/`。鉴权 `/v1/models` 已确认返回其余九个原有视频模型。恢复老站时使用该目录的 `restore.sql`，不用整库恢复。新站 `cart.ravenhash.org` 于 2026-09-21 同步了模型目录，详见 `docs/tkeapi-deployment.md`。

验证：`node --test src/video-model-profiles.test.js electron-main/video-generation-availability.test.cjs`；`node scripts/video-channel-picker-smoke.cjs`。界面检查覆盖分组顺序、单条备用分组、暂停过滤、搜索、模型绑定和窄窗口定位；没有提交付费生成。
