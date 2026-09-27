# 客户错误提交

## 使用入口

源码版的失败/断连生成任务中有“提交错误”，设置的“诊断日志”中也有同名入口。客户可以选择错误、填写问题说明和联系方式，再主动提交。不会自动上报，也不会因此重新提交生成。

CONFIG 后台 `/admin` 的“客户错误提交”栏目接收报告，可按状态和关键词筛选，查看客户端诊断及关联服务端记录，写管理员备注、标记处理状态、补查记录或下载脱敏 JSON。客户端只收到 `er_` 回执，不会收到上游详情或账务数据。

## 信息范围

- 客户端：版本与运行环境、CONFIG 状态、当前错误及任务编号、模型、参数、参考素材数量、最近 1500 条日志和最多 200 项任务。已记录的错误堆栈、HTTP 状态、阶段、耗时和响应编号一并保留。
- 服务端：按关联的 `rh_` / `fc_` 编号精确读取网关快照和中转站账务记录，包括渠道、模型、用户编号、数字令牌编号、请求/完成时间、耗时、原始错误的脱敏内容及账务字段。
- 两端分开保存。客户端传来的描述和参数不能作为服务端账户、计费或退款真实性的证据。是否扣费、退款以实际账务记录为准。
- API Key、认证头、密码、提示词正文、媒体内容和素材地址不会作为新增报告内容保存。参考文件已记录的哈希、大小、类型和数量可保留，用于核对上传情况。

普通 UUID 请求编号只作为客户端关联线索，不能冒充服务器任务编号。图片响应事件可将其关联到网关的 `rh_`。站点不明时不跨站猜测；后台显示缺失、不可达或截断状态。

记录完整度受原有日志保留范围限制。上报功能不能恢复早已被覆盖的客户端日志、超过网关保留期的快照，或上游从未返回的详情。缺少日志不代表未发送、未扣费或已经退款。

## 提交与存储

公开接口为 `POST https://artconfig.ravenhash.org/error-reports`，只接受不超过 2 MiB 的 JSON。`submissionId` 为 UUIDv4 幂等标识。公开响应仅包含 `success`、`reportId`、`receivedAt`。

客户端发送前在 Electron userData 下持久保存脱敏后的提交内容与编号；断连或回执丢失后使用同一编号和相同内容重试，重启后也可恢复。成功回执同样保留。客户端最多保存 30 项提交，优先清理已收到回执的旧记录。

服务端保存于 `/var/lib/flow-config/customer-error-reports/`，目录权限 0700，文件 0600，原子写入。默认保留 30 天、最多 10000 份、总容量 512 MiB；达到容量上限时明确拒收，不假装提交成功。每 IP 每小时最多 12 次、全局每小时 300 次，非法输入同样占用限额。

收到报告后先持久保存客户内容，再异步补查最多 6 个相关请求。补查失败不会删除客户内容。管理员读取需要登录，写状态/备注与补查操作还需要同源和 CSRF 校验。公开 CONFIG 不含错误报告及管理员凭据。

## 代码和部署

共用输入合同与脱敏实现为 `shared/error-report-contract.cjs`，通过 `npm run sync:model-config` 同步到 CONFIG 的 `lib/error-report-contract.cjs`，同步守卫会检测漂移。

主要实现：`electron-main/error-report-client.cjs`、`electron-main/diagnostics-electron.cjs`、`src/diagnostics-settings.js`、`configserver/lib/customer-error-reports.mjs`，服务端精确关联由 `server/relay-error-gateway/` 提供。

本功能新增主进程 IPC 与渲染界面，已有安装版需要升级一次。只部署 CONFIG 不会给旧安装版增加按钮；本次未生成安装包，公开模型目录也没有因此改版。

验证命令：`npm run check`；专项界面脚本 `scripts/error-report-client-smoke.cjs` 和 `configserver/customer-error-reports-smoke.mjs` 使用隔离配置与模拟提交，不调用付费生成。部署回执位于 `output/customer-reports-*-deployed.json`。
