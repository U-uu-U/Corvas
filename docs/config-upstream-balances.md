# CONFIG 上游余额

管理页在模型编辑区与版本记录之间显示余额表。打开页面时读取；页面可见且未编辑阈值时每 5 分钟刷新一次。手动刷新有 30 秒最短查询间隔，避免重复请求。该功能只在管理页显示低余额状态，不发送外部通知、不自动充值，也不改变模型启停或计费。

当前自动接入主播视频 `GET https://video.zhubo.asia/v1/billing/balance`。文档说明有限 Token 返回 Token 可用额度，无限 Token 回退到绑定用户或组织余额，所以表内保留“账户 / Token 可用余额”口径。币种为 CNY，默认预警线 50 元，可直接编辑；留空关闭。负余额保留，失败时展示上次成功金额并标记过期，首次失败或未接入显示 `--`，不会假装余额为零。

2026-09-23 只读实测：主播接口返回 `billing:true`、`balance:44.35`。StarFrame 和 Yueqi 的 `/v1/dashboard/billing/subscription` 返回 100000000 的额度上限；`/api/usage/token/` 返回 `unlimited_quota:true`，不能视为账户钱包余额。现有生成 Key 调用 `/api/user/self` 无法获得账户资料。968API 和 ArtsMCP 的兼容 subscription 路径返回 404；其他供应商尚未完成余额接口验证。Chrome 连接器已发现浏览器，但当前 Codex API Key 认证方式不受其控制接口支持，尚未通过 Google 账号完成上游登录。

## 文件与接口

- `seed/admin-balance-accounts.json`：账户清单、查询适配器、入口、币种和默认阈值。`CONFIG_DATA_DIR/admin-balance-accounts.json` 可整体覆盖。
- `CONFIG_DATA_DIR/admin-balance-credentials.json`：私有查询凭据，当前结构为 `{"zhubo-art":{"key":"..."}}`。仅服务器保存，文件权限 600、属主 flowconfig；不得放入仓库、浏览器或公开 CONFIG。
- `CONFIG_DATA_DIR/admin-balance-settings.json`：已保存的预警线，键为账户 ID，值为金额或 null。
- `GET /admin/balances`：需登录，返回脱敏后的余额表，响应 `no-store`。
- `POST /admin/balances/refresh`：需登录、同源和 CSRF，只查询余额。
- `POST /admin/balances/threshold`：需相同保护，JSON 为 `{id, threshold}`。

上游查询 URL 固定在服务端适配器中，禁止跟随重定向。查询错误不回显供应商原文或凭据。缓存按账户 ID 和 Key 摘要隔离，换 Key 后不会沿用另一账户的余额。新站账号尚未逐个核对，不把两个站的余额相加；当前条目标明“老站绑定账号”。

验证：`node --test configserver/admin-balances.test.mjs configserver/server.test.mjs`；`node configserver/admin-balances-smoke.mjs`（可通过 `PLAYWRIGHT_MODULE` 指定 Playwright）。UI 检查使用临时数据和模拟余额，覆盖阈值保存、刷新、桌面与手机布局，不调用付费生成。
