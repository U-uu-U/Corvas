# CONFIG 管理页的模型来源

每个模型卡片在老站、新站价格下面显示两行 11px 小字：`上游：名称` 和 `URL：供应商 API 地址`。操作模式和表单列表使用同一份资料；分组卡片不标单一供应商。

来源资料由登录后的 `GET /admin/model-sources` 读取，默认文件为 `configserver/seed/admin-model-sources.json`。部署时可以在 `CONFIG_DATA_DIR/admin-model-sources.json` 放完整的替代资料；刷新管理页即可重新读取，不需要改前端或重启服务。文件不参与 `/config`、`/config/preview` 的发布与客户端同步，也不改变渠道路由或计费。

每个 `entries` 条目包含 `ids`（CONFIG 条目 ID）、`models`（具体 API 模型 ID）、`hosts`（允许使用该来源说明的 API 主机）、`name` 和 `url`。可以另加 `evidence` 记录核对依据，它不会发送给浏览器。URL 使用供应商 API 地址，不放账号密码、Key、查询参数或片段。新建、复制或改绑模型后，必须补充与新绑定一致的来源资料，未匹配的条目显示“待确认”。读取失败会显示“读取失败”，不影响其他配置操作。

2026-09-22 通过老站 `art.ravenhash.org` 后台数据库只读核对 `models`、`channels` 和 `channel_configs`，并追踪适配器实际 `UPSTREAM`。渠道的空 `base_url` 需继承预设；个别 `models` 字段经过双层 JSON 编码，查询时先解码再关联，不能误报为未绑定。

老站已绑定的视频模型来源已补齐：SD2.5 线路二和 HM 模型接主播视频；`seedance-2.5-pro` 当前接 Yueqi，不再按历史记录标为主播；2.0 Fast/Mini/Pro 接 ArtsMCP；MiniMax H3 经过适配器连接 `http://122.228.216.60:3000`；968 和山海也显示适配器的实际外部上游。StarFrame、GlobalAiOpc 及未在后台出现的旧条目仍保留既有供应商文档依据。图片/MJ、文字模型和未纳入当前中转路由的原生 MiniMax H3-c1 条目尚未核实，不用模型品牌或 RavenHash 中转站地址代替。

RavenHash 条目的来源标注以本次老站核对为准，不代表两站实时同步；后续切换供应商时需更新来源资料。核对仅查询模型、渠道和适配器地址，没有改动中转站配置、启停状态、计费或凭据。
