# HM 调用状态与请求名修复

## 故障证据

排查编号 `rh_0b5ef7a74f9279bd78d5949a36cb9bb5` 对应老站在 `2026-09-30T15:56:00.889Z` 收到的 `POST /v1/video/generations`。请求为 `seedance_v2.5-301010`、720p、16:9、25 秒、1 图和 1 视频参考，418ms 返回 404：`No available channels found for model seedance_v2.5-301010`。网关未匹配到中转任务日志，因此不能由缺少日志推断账务结果。

两站 HM 渠道、计费规则和转发规则均启用，但 `seedance_v2.5-101010` 与 `seedance_v2.5-301010` 的 `models.is_active=0`，沿用了 2026-09-20 的停用以及次日同步状态。现行 CONFIG r44 将四款 HM 的 `catalog.enabled` 都设为 true，造成画布允许提交而中转站无可用模型。CONFIG 开关和中转站开关是两个独立层级。

同时上游 `/v1/models` 已改为返回显示名称形式的模型 ID。鉴权 `/v1/pricing` 同时返回 `canonical_id` 和 `model`，提供精确对应关系；不能只根据显示名猜测。供应商文档要求调用时采用实时 `/v1/models` 的 ID。目录和价格接口成功不等于实际生成能力已验证。

## 已部署修复

以下客户端 ID 保留，两站 `models.original_id` 和 HM 渠道 `model_mapping` 同步更新：

- `seedance_v2.5` -> `HM-Seedance V2.5`。
- `seedance_v2.0-933` -> `HM-Seedance V2.0 933`。
- `seedance_v2.5-101010` -> `HM-Seedance V2.5 101010`。
- `seedance_v2.5-301010` -> `HM-Seedance V2.5 301010`。

两条原停用型号恢复 `is_active=1`，对齐已发布 CONFIG r44；其余两条继续启用。未修改价格、用户额度、参数、非 HM 模型、CONFIG 发布版本或安装包。老站渠道 3、新站渠道 2。`docs/video-channel-picker.md` 的 2026-09-20 HM 停用内容为历史状态，本次恢复后不再代表现状。

执行入口为 `server/seedance-hm/repair-hm-availability.py`，需与 `add-zhubo-september.py` 放在同一目录，运行于对应中转站。默认仅事务预演回滚；`--apply` 会先验证 CONFIG 允许调用、上游账号模型清单与 canonical 映射，然后私有备份、加锁比较完整目录、仅更新上述字段、验证后提交。脚本遇到未知映射、CONFIG 停用或上游缺失时中止，不自动换供应商。

两站事务预演、提交后回读均通过；随后使用既有管理员令牌只读请求各站公网 `/v1/models`，均返回 HTTP 200，包含四个原客户端 ID。未提交付费生成，不能据此保证上游成功出片或承诺历史失败任务已退款。历史任务不会自动重试。

回执：`output/hm-availability-{art,cart}-receipt.json` 与 `output/hm-availability-{art,cart}-runtime.json`。私有备份：

- 老站：`/root/flow-canvas-operations/hm-availability-art-20260930T160235117956Z`。
- 新站：`/root/flow-canvas-operations/hm-availability-cart-20260930T160239832488Z`。

备份含渠道凭据，不得发布。需要回滚时只恢复本次目标的 `original_id`、`is_active` 和四条映射，并检查当前字段仍等于本次部署结果；不得用整个目录快照覆盖后续配置。
