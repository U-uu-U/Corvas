# Generation Health

画布只在具体模型卡片上显示两站全用户的近期图片/视频任务统计，大分组入口不显示指示灯或平均时长。模型按 API 的精确域名选择数据，不能混用 art/cart。数据只反映经过这两站的任务，不涵盖用户在上游网站独立生成的任务。

## 数据链路

`logs` -> `read-generation-records.py` -> `generation-health.cjs` -> 私有 `/internal/generation-health` -> CONFIG 缓存 -> 公开模型条目的 `generationHealth` -> 画布。

- 两站的异步任务最终状态会回写 `logs.response_content`。读取最近 7 天、最多 5000 条媒体提交记录；排除查询路径，按用户/渠道/模型/任务组合摘要去重。没有任务 ID 时按请求日志 ID 去重。
- 每次查询只读事务、8 秒 SQL 超时，不调用生成、任务重试或计费接口，不依赖客户端上报。两站各自查询，并发查询合并为一次，缓存 60 秒。
- 图片/视频日志路径白名单在读取脚本中。日志若被删除、未进入这些路径、响应超过 64 KiB，或上游结果不具备已识别的终态，只能提供不完整证据。不会由 HTTP 200 或账单推定视频已经生成。
- 窗口默认 24 小时，每模型取最近 10 条非排除任务；3 个有效终态样本起判定整体健康，最近终态超过 6 小时变灰。成功占有效终态的比例 >= 80% 为近期可用，否则近期不稳定。指示灯固定 2px 宽、14px 高、2px 间隔，共 10 个位置，不足时左侧灰色补位；4px 周期避免 Windows 常用 125%/150%/175% 缩放下交替出现不同粗细。成功且实际耗时严格超过 1800 秒显示黄色，仍计入成功；失败红色、未知灰色。样本不足时仍逐格显示已确认结果，整体提示“状态待确认/有效样本不足”；过期或统计不可用时整条灰色。
- 参数、素材、认证/额度/权限、限流、审核拒绝和取消从健康率中排除。来源无法确认的账户或限流错误也保守排除，不推断是客户还是供应商账户；其完整证据仍在现有管理员诊断中。未确认的异步超时保持未知。
- 平均耗时只取样本内成功且有合法完成时间的任务，优先计算 `completed_at - logs.created_at`，包含排队。异步任务缺少完成时间不使用 HTTP 提交耗时补齐。同步图片仅在确认产物、完成状态且无异步任务 ID 时可使用 `latency_ms`。
- 2026-10-06 核对两站已部署 Rust 后端：`relay/task.rs` 的 `execute_settlement_tx` 在终态更新时将 `latency_ms` 改为 `CURRENT_TIMESTAMP - created_at`，两站运行二进制也包含该表达式。读取器仅对有任务 ID、`is_completed=1`、HTTP 成功且响应明确成功的视频，投影 `completionElapsedMs` 与私有来源标记 `relay_terminal_elapsed`。聚合器只接受该明确来源，缺少它仍不把通用 `latencyMs` 当生成时长。该耗时含排队和服务端确认完成的等待，不能解释为视频成片时长。不得把该契约直接套到未核对的其它后端。

## 隐私与刷新

私有接口复用 `CORVAS_DIAGNOSTICS_KEY`，缺少凭据或方法错误返回 404。CONFIG 使用 `/var/lib/flow-config/admin-diagnostics-credentials.json`，固定 HTTPS 域名，不跟随重定向，每 60 秒缓存一次，失败不阻塞目录读取。

公开数据逐字段投影，仅含站点域名、状态、任务结果序列、计数、平均耗时和新鲜度时间。没有用户、任务 ID、素材、提示词、错误原文、上游域名或价格。客户端缓存超过 3 分钟自动变灰，不能因断网保留绿色。无近期数据显示灰色和 `平均 --`。

每次成功任务的耗时通过模型级 `generationHealthTimings` 按站点及样本顺序公开，缺失时间为 null。它与原 `generationHealth` 分开，以兼容已对旧健康对象做严格校验的客户端。旧客户端仍可加载整个目录，新客户端将超 30 分钟的成功样本显示为黄灯。

`/config` 和 `/config/preview` 使用同一目录和指标，动态统计变化影响 ETag，不创建新目录 revision。当前 r41 无需重新发布。客户端首次需要升级 UI；以后统计策略在服务端调整即可。

## 运维

两站可通过 `/etc/corvas-generation-health-policy.json` 调整 `windowHours`、`sampleSize`、`minimumSamples`、`staleHours`、`healthyRate`。字段均有限值校验，下一次统计读入，默认值由 `generation-health.cjs` 定义。错误分类继续使用现有私有错误映射。

部署脚本 `scripts/deploy-generation-health.py` 只复制本功能文件，要求审核后的 Caddyfile，密码由 `FLOW_TASK_SSH_PASSWORD` 临时传入。部署前备份至 `/var/backups/corvas-generation-health-*`，有活动网关连接时拒绝重启；不修改目录、模型开关和账单。CONFIG 代码在 `/srv/flow-config`，网关在 `/opt/corvas-relay-error-gateway`。非敏感回执保存在 `output/generation-health-*-deployed.json`。

`--code-only` 在两站只更新统计聚合器和日志投影脚本，不替换网关入口或 Caddy 路由。耗时修复可由服务端生效；样本不足时逐格显示颜色属于客户端展示修改，已有安装版需要后续升级，不能把发布 CONFIG 当作更新 JS。

活动网关不可重启时使用 `--reader-only --deploy`：仅对每次查询都会重新执行的 Python 投影脚本做备份、语法检查和原子替换，不重启服务。该脚本把已核实的终态 elapsed 时间转换为既有私有投影 `response.completedAt`，旧聚合进程也能直接读到。原始数据库记录和上游响应未被改写。

2026-10-06 两站投影修复已部署。老站网关有活动连接，采用 reader-only；新站先更新聚合器，随后同步 reader-only。备份分别为 `/var/backups/corvas-generation-health-20261006T145617Z`（art）和 `/var/backups/corvas-generation-health-20261006T145714Z`（cart）；新站聚合器备份为 `/var/backups/corvas-generation-health-20261006T145423Z`。公开 CONFIG r45 已回读 `seedance_v2.0-933` 的 art 数据：successCount=1、durationSamples=1、averageSeconds=406、单样本耗时405.916秒。目录版本未由本次操作发布，模型、售价和账务没有改动。

验证：42 项 Node 定向测试、4 项 Python 投影测试通过；隔离 Electron 模型卡片测试验证单条成功仍为绿色、整体健康保持“样本不足”、平均6分46秒、站点隔离以及固定灯宽/不同缩放的像素检查。截图 `output/playwright/generation-health-single-success.png` 为模拟数据；线上值另由公开 CONFIG 回读核实。本次未提交新生成任务或打包安装程序。

验证：`node --test shared/generation-health.test.cjs configserver/generation-health.test.mjs server/relay-error-gateway/gateway.test.cjs`；`python server/relay-error-gateway/test_read_generation_records.py`；界面使用隔离 profile 的 `scripts/canvas-sale-prices-smoke.cjs`，覆盖站点隔离、当前分组、同 revision 更新及桌面/窄窗口，不产生付费请求。
