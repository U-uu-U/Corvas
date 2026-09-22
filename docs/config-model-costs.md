# CONFIG 管理页成本价

模型卡片在老站、新站售价下面独立显示成本行，操作模式和表单模式一致。金额保留至少两位、最多四位小数，避免按秒的小额成本被粗略舍入。分组卡片不写单一成本。数据来自登录保护的 `GET /admin/model-costs`，不进入公开 CONFIG 或画布。

资料由 `configserver/seed/admin-model-costs.json` 保存；部署目录 `CONFIG_DATA_DIR/admin-model-costs.json` 可整体覆盖。每个条目绑定精确 CONFIG ID 和模型 ID，附供应商、报价来源、原单位、状态及说明。`reference` 为上游参考标价，不能等同账户最终账单；`historical` 为已过期的历史文档/查询报价；`unknown` 明确显示待核对与原因。接口通过 `projectAdminModelCosts` 验证并筛选字段，不返回原始证据或其他扩展数据。鼠标停在成本上可查看核对时间和来源。

## 2026-09-23 核对口径

- StarFrame：`/api/pricing` 的 CH0107 为 1.5/秒，CH1401 为 4/次。用户明确指定此次询问的 StarFrame、Yueqi 名义 USD/额度按 1:1 视为人民币，页面标明这一口径。并未读取充值折扣或推算账户实际买入成本。
- Yueqi：`/api/pricing` 的 `sd2-fast` 为 480p/720p 各 0.8/次，`seedance-2.5-pro-720` 为 8.3/次，按上述 1:1 显示 CNY。当前目录只列 `-480`、`-720`，没有精确 `seedance-2.5-pro`，不能用相似模型的报价代替。
- 主播视频：`/api/video/models` 当前列出 `sd2.5` 为 CNY 2/次。旧 HM 933、101010、301010 的 2.5/3/5.5 元来自 2026-09-12 核对，标为历史报价；这些型号和 `seedance_v2.5` 当前均未在目录中出现。
- 968API：2026-09-03 文档报价 USD 1.5/次，依据 `server/seedance968/README.md`，保留 USD 并标记历史报价，未将此前的人民币售价当作成本。
- ArtsMCP：从前端请求模块确认 `/api/v1` 前缀，读取 `/api/v1/marketplace/public`。`billing.extended_config.resolution_rates` 按百万 Token 计费，Fast/Mini/Pro 的全站折扣分别为 0.55/0.4/0.7；`/api/v1/settings` 给出的 USD:CNY 为 1:6.8。展示金额为费率乘全站折扣再乘 6.8，账号额外优惠未核实，不套用中转站自身的 9 折。
- MiniMax H3：直接上游 `http://122.228.216.60:3000/api/pricing` 的 `minimax_video_pricing.service_groups`，采用 `minimaxh3` 标准档 `original_price_per_second`：480p 0.03、768p 0.07、1080p/2K超分 0.12、4K超分 0.15 CNY/秒。当前 API 另含每日00-09三折活动，注明但不把限时价格当固定成本；`assigned:false`，账户专属档位尚未核实。
- 山海：使用老站已保存 Key 只读查询 `/api/v1/models`，dola 为 0.9 积分/次，官渠 480p/720p/1080p 为 0.48/0.78/1.58 积分/秒。保留 `price_credits` 原积分单位，未擅自折算人民币。两个旧 933 型号当前未列出。
- GlobalAiOpc：模型接口文档没有列价格，需账号价表；图片、文字和未明确绑定的旧模板成本亦不猜测。

所有查询均为只读，没有提交付费生成。上游会调整目录、折扣和报价，当前文件是一次核对快照；修改成本资料不会改变任何站点的实际计费。

## 验证

`node --test configserver/admin-model-costs.test.mjs configserver/admin-catalog.test.mjs configserver/server.test.mjs` 验证匹配、单位、历史状态、未知报价、数据筛选、登录保护及公开 CONFIG 不变。`node configserver/admin-costs-smoke.mjs` 覆盖表单/操作模式和桌面/手机的分档长文本。Chrome 密码用临时实例，未向公网保存测试配置。
