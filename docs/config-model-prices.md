# 管理页双站价格

管理页操作模式和表单列表分别显示 `老站价格`、`新站价格`。数据来自两个中转站的 `models.billing_rule_id -> billing_rules` 只读核对，不从 CONFIG 的单份 `pricing` 或模型预扣费推算。按次、按秒、分辨率及参考视频档位分别保留；金额显示两位小数，鼠标停在价格上可查看核对时间。

登录后的 `GET /admin/model-prices` 优先读取 `CONFIG_DATA_DIR/admin-model-prices.json`，否则读取 `configserver/seed/admin-model-prices.json`。接口只输出已允许的展示字段，原始证据和额外字段不会返回给浏览器；文件不进入公开 `/config`，不会改变画布价格显示、模型目录、渠道状态或实际计费。

数据格式为 `checkedAt` 和 `sites`，每站包含 `host`、`label`、`checkedAt`、原计费 `currency`、`exchangeToCny` 以及 `models`。每个模型包含精确 `model`、`status`、`active`、展示 `currency` 和 `prices: [{ label, amount, unit }]`。原站使用 USD 时按该站配置的人民币汇率折算展示，原始计费单位保持不变。可选 `ids` 仅用于已核实的无 `catalog` 历史条目；有 `catalog.model` 的条目始终按精确模型 ID 匹配。

- `known`：已核实的计费规则；模型下架时同时显示“已下架”。
- `missing_rule`：模型存在，但没有有效的规则关联。
- `inactive_rule`：关联的计费规则已停用。
- 其他状态：显示已核实原因或“待核对”，不猜价格。
- 完整站点名单中没有该精确模型：显示“未接入”。
- 历史条目没有可核实的一对一模型绑定：显示“待绑定模型”。

此文件是一次核对快照，更新中转站价格后需重新核对并更新它；不要将旧快照当作实时收费配置。价格展示更新不要求重新打包桌面客户端。

## 2026-09-23 核对

两站各有 21 条模型记录，全部有有效计费规则关联，没有发现 `missing_rule`。之前管理卡片只认 CONFIG 的 `pricing.hosts` 是否包含老站，未继承本地 profile 的价格，也无法同时表达两个站点不同的价格，因此大量“未配置”是展示资料缺失。

已核实的代表值：`sd2.5` 老站 6.00 元/次、新站 6.86 元/次；`seedance_v2.5` 老站 5.00 元/次、新站 5.72 元/次；`ch0107-sd-2.5-720p` 老站 1.06 元/秒、新站 1.25 元/秒。`seedance-2.5-pro` 当前已改为 Yueqi，两站均为 9.80 元/次，不能继续沿用历史主播渠道的按秒价格。

首次核对时，两站均没有 `sd_2.5_discount_v1` 和 `ch1401-sd-2.5-720p` 模型记录，标为“未接入”。用户随后要求接入 CH1401，现已部署并更新价表：老站 5.00 元/次、新站 5.72 元/次；GlobalAiOpc 仍未接入。MiniMax 原生 `minimax-h3-c1` 以及通用 2.0 历史条目没有可核实的一对一目录绑定，保留“待绑定模型”。

海外 2.0 Fast/Mini/Pro 按百万 Token 计费，按分辨率及是否包含参考视频区分费率，两站都已开启全站 9 折。卡片列出全站折后价并标注，账户自身优惠另计。单位与折扣经过老站源码 `backend/src/templates/portal/models.html` 的 `models_unit_1m` / `formatPrice`、`relay/mod.rs` 的百万 Token 除数和 `proxy.rs:resolve_discount` 核实；MiniMax 虽保存了 0.9 数值但开关关闭，不应用该折扣。原始数据库核对记录保留在 `output/config-billing-root-raw.json`。
