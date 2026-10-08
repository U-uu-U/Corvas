# Seedance 2.0 15秒备用渠道

2026-10-08 用户提供 `API对接文档.txt`、实际地址 `http://38.76.169.86:8080` 和账户 Key，
要求接入并卖 2 元。已按 art/cart 两站统一 CNY 2 元/次配置，未对 cart 另乘代理系数。

## 实际模型契约

鉴权 `/v1/models` 仅返回模型 `b_seedance_v2.0`，数据库型号编号 6。
`name` 才是提交请求的模型名，不能用数值 6 或文档示例 `seedance-video` 替代。
该账户实际支持固定 15 秒、16:9/9:16、最多 9 张图片参考，不支持音频；文档示例的
5/10/15 秒和 1:1 不代表当前型号均支持。接口未提供输出分辨率选择，CONFIG 隐藏该控件。

公开 RavenHash 请求名保持 `b_seedance_v2.0`，画布显示“Seedance 2.0 15秒”，
位于 `seedance20-backup`（Seedance 2.0 备用渠道）。
实际成本未获报价，管理成本快照为 unknown，文档示例预扣 2 点未当作实际成本。

## 适配层

代码位于 `server/seedance-direct/`。每站部署私有 Docker 服务 `seedance-direct-adapter`，
路径 `/opt/corvas-seedance-direct`，监听容器内 3011，无公开端口。通过原有 relay 网络接入：
art 使用 `tokensbyte-network`，cart 使用 `tkeapi-network`。
密钥只保存于本站渠道，通过每次请求的 Bearer Header 传入；不写入源码、镜像、环境文件或客户端。

- 入口提交：`POST /v1/videos` 或现有 `/v1/video/generations`。
- 原始上游提交：`POST /v1/videos/generations`。
- 兼容既有客户端的 `duration/ratio/images[].url`，转换成 `seconds/aspect_ratio/reference_images`。
- 上游数值 `task_id` 转为字符串任务标识，查询 `GET /v1/tasks/{id}`；必须与所查询 ID 一致。
- 完成后调用固定同源路径 `GET /v1/tasks/{id}/url`，带原账户 Bearer Header。
  该接口返回 JSON，不能把它下载为 MP4。返回的真实 CDN URL 规范为 relay 的 `video_url`。
- 忽略任务响应中任意 `download_url` 地址及 5 分钟 token，避免向不受信任地址发送密钥。
- 不自动重发 POST；提交响应中断或无有效任务 ID 时，状态保持未知。
- 成功响应不包含供应商 `billing`、预扣点数或实际扣费字段；失败原因交既有错误网关分类与脱敏。
- 不新增二进制缓存；解析出的 CDN 链接仍由现有客户端下载器下载。

中转站终态响应本身有缓存；后续若实际 CDN 链接过期，重新查询适配器可解析新链接，
但只读旧终态缓存不保证重新访问适配器。这是既有中转恢复范围，尚未用真实付费任务验证。

## 已部署

- art：新增模型 37、mid 310023、渠道 10、计费规则 48。
- cart：新增模型 37、mid 310023、渠道 10、计费规则 44。
- 两站计费 `requests/fixed`，金额和预扣均为 2 元，时长不参与相乘。
- 复用既有视频异步转发规则：art 37、cart 48，转发至新适配器。
- CONFIG r48：`20261007T173453-r48.json`；条目 `ravenhash-video.seedance20-direct`。
- 本机 18765 已主动刷新并返回 r48。

私有备份：

- art：`/root/flow-canvas-operations/seedance-direct-art-20261007T173250218169Z`
- cart：`/root/flow-canvas-operations/seedance-direct-cart-20261007T173307791401Z`
- CONFIG：`/var/lib/flow-config/operations/seedance-direct-1791394493288`

上述时间为 UTC；本地日期为 2026-10-08。备份含渠道凭据，不可公开分发。
配置脚本 `configure.py` 默认事务回滚预演，`--apply` 才备份并写入；stdin 接受 `apiKey`。
该脚本依赖同目录树中 `server/seedance-hm/add-zhubo-september.py` 的快照和事务保护函数。
`publish.mjs` 默认仅预演，`--apply` 发布。脚本拒绝重复添加已存在的模型或渠道。

## 验证

6 项定向测试通过，涵盖旧客户端参数转换、图片顺序及重复项、数值任务、两步解析、
同源鉴权、任务错配、供应商计费字段剥离和 POST 不重复提交。HTTP 集成测试使用本地模拟服务。
两站模型发现、适配器健康、Docker 网络、数据库预演及提交回读通过；公开 CONFIG 的
双站售价、固定时长、比例、引用上限和不包含密钥/上游地址均已检查。

已读取 beta.16 安装版 app.asar：远端能力解析代码与当前源码一致，既有通用视频请求
支持本适配器处理的 duration/images 字段，因此本型号无需新增客户端适配或单独打包。
未修改客户端源码、未提交付费生成、未重启现有中转后端或用户画布。
上游真实生成、最终账务和 CDN 视频下载尚未进行收费端到端验证。

## 2026-10-08 查询误判修复

真实任务 `67388` 在老站对应日志 917，提交后首次查询出现 `Task not found`。
中转写成 `status_code=400/is_completed=1` 并缓存失败；网关返回 `RH_TASK_FAILED`、
`confirmedFailure=true/retryable=false`，画布因此结束等待。上游实际继续生成并完成。
已经确认任务 ID、渠道密钥与适配器地址均正确；最初未找到任务的具体原因缺少上游日志，
未将同步延迟假说写成已确认事实。

适配器的 GET 查询和成片解析遇到 HTTP 错误、连接中断、无效 JSON、任务错配或解析尚未准备好时，
现在返回非终态 `in_progress` 和 `corvas_query_state=unavailable`，不输出 failed 或 error。
这样避免原生中转将轮询 HTTP 错误误退款、终结任务。只有匹配任务 ID、明确 failed 且有有效
`completed_at` 的上游失败记录才作为终态失败。POST 仍只发送一次，未改变未知提交处理。

错误网关仅在 GET 的非终态响应带该标识及有效任务 ID 时转换为可重试的 HTTP 503：
`RH_SERVICE_UNAVAILABLE/confirmedFailure=false/retryable=true/action=retry_query`。
标识不会覆盖明确 failed 的任务，也不会改提交响应。现有客户端已能处理这种协议并继续查询
原任务；若中转格式化剥掉该标识，非终态响应仍保留等待状态。

11 项适配器测试、31 项网关测试、23 项客户端恢复测试通过，含首次 404 后同任务恢复成功、
查询超时/503、媒体解析 409、真失败保留，以及全程只查询 GET。现网两站已部署，客户端无需打包。
网关在没有活动连接时重启，未重启现有中转后端或客户画布。

部署前文件备份：

- art：`/var/backups/corvas-query-recovery-art-20261007T190830750314Z`
- cart：`/var/backups/corvas-query-recovery-cart-20261007T190902179443Z`

原任务恢复脚本 `server/seedance-direct/recover-query-failure.py` 限定精确日志和任务 ID，
先使用原渠道鉴权确认上游 completed，再仅修结果缓存、成功状态、错误文案和真实终态耗时。
旧日志已标注“失败已退费”、cost=0；恢复保留这笔退费并追加说明，没有修改余额、额度或再次扣款。
不是一般性失败批量恢复工具，不可用来推断其他任务的退款或成功状态。
日志恢复前备份：`/root/flow-canvas-operations/recover-query-67388-20261007T191336049928Z`。

本机原恢复检查点 `6483c92d-1ad3-40cb-9208-8471da54c3f4` 已通过既有恢复流程回填：
project `1776599981449`，node `op-1791395554445-7jw4p1`。
使用 `restoreToProject=true` 和已有检查点，不提供新提示词，避免入口退化为重新生成。
为这次恢复临时开放的 `flow_canvas.video.generate` 权限已移除，原 MCP 权限列表恢复。
检查点 state=attached、confirmedFailure=false；原节点 runStatus=done、runError 为空、原连线保留。
MP4 14,664,198 字节，经 FFprobe 验证 H.264 1280x720、AAC 音轨、15.104 秒。
该操作未创建新的付费生成，是真实既有任务的查询与下载验证。
