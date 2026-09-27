# 画布销售价格

2026-09-24 按用户要求恢复画布售价显示。模型选择列表和当前模型的生成面板统一写“售价”，界面及悬停明细不标“新站/老站”。实际金额按 API URL 的精确 hostname 匹配：`art.ravenhash.org` 使用老站价，`cart.ravenhash.org` 使用新站价。不能根据 API 昵称、模型显示名、URL 子串或本地历史价格决定售价。

## 数据来源

CONFIG 服务读取现有 `admin-model-prices.json` 的已校验销售价快照，在公开响应中为每个已纳入目录的模型附加 `salePrices`。每条记录包含 `host/status/currency/kind/source/updatedAt/prices`，其中 `prices` 保留分辨率、参考视频条件和计费单位。只按 `catalog.model` 精确关联，并限制到 `catalog.hosts` 包含的站点。供应商成本、账号、凭据和原始计费证据不进入此投影。

投影只改变公开响应，不改版本仓库或管理页编辑正文。ETag 包含售价数据，因此价表变更即使没有新的 CONFIG revision，也可随现有轮询被画布感知。失效、缺失或非法快照下发明确的未知状态，不回退到本地过期价格。旧客户端仍可读取新增字段，显示此功能需要包含新UI代码的版本。

`shared/model-presentation.mjs` 负责按站点读取价格和格式化，`src/agent-sidebar.js` 向画布传递结构化售价，`src/canvas.js` 显示价格。单价显示两位小数；按次、按秒、按张和每百万Token分别显示，不把Token价格当成按秒价格。已选模型会按分辨率及有无视频参考缩小价格档位；条件不充分时显示范围，悬停可看完整档位。未知价格显示“售价待配置”，不伪造0元。

本地旧 `profile.price` 仍有历史兼容用途，但新价格行只使用 `salePricing`。远端同站点售价存在时覆盖旧的结构化单价；多种不同档位不会被冒充成单一内部估价。Agent计划卡的总费用显示未恢复。

## 验证与部署

定向服务测试覆盖精确模型/站点、变价ETag、未知快照、私有字段不下发、版本仓库不变。共享层覆盖零价、伪造域名、重复站点、分档、Token单位、旧配置兼容及schema一致性。相关测试、ESLint和前端构建通过。

`scripts/canvas-sale-prices-smoke.cjs` 使用隔离Electron资料目录和本地CONFIG，验证老站/新站同模型不同价格、切换模型和分辨率、同revision价表更新、未知状态和不显示站点标签；桌面1440及窄窗口820布局已检查。该脚本不提交生成请求，不改用户API资料。截图位于 `output/playwright/canvas-sale-prices-desktop.png` 和 `canvas-sale-prices-compact.png`。

远端只部署 `server.mjs`、售价投影模块和新增schema字段。备份 `/root/flow-config-backups/canvas-sale-prices-20260924T063744Z/`，回执 `output/canvas-sale-prices-deployed.json`。核对部署前后版本指针完全不变，公开CONFIG仍为r37，20个模型条目有双站售价；Pro为9.80/11.20元每次，dola30为5.00/5.72元每次。

源码前端已更新且远端售价已刷新到当前画布。因用户有正在恢复的视频任务，本次没有重启源码主进程；主进程内已缓存的MCP估价模块在下次正常启动后采用新投影。画布前端售价不依赖这一重启。本次未发布安装包。
