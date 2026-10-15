# Seedance 2.5 Cheap

2026-10-12 按用户要求接入 art/cart，初始两站售价 CNY 4.00/次；随后按用户要求将 art 调整为 CNY 3.00/次，cart 保持 CNY 4.00/次。两站均按 CNY 记账，不乘历史代理系数。

## 接口与参数

- 公开请求名：`yh-video-v25-cheap`；上游精确请求名：`seedance2.5 cheap`（含空格）。
- 上游：`https://yihongapi.com`，复用各站原有一鸿渠道凭据；凭据未离开服务器，未写入客户端、源码或公开 CONFIG。
- 上游提交 `POST /v1/videos`，查询 `GET /v1/videos/{task_id}`，视频内容 `GET /v1/videos/{task_id}/content`。
- 720p，4-30 秒整数，默认 15 秒；16:9、9:16、1:1、4:3、3:4、21:9。
- 最多 30 张公网 HTTP(S) 参考图。不支持参考视频；音频参考未获公开文档确认，当前关闭。真人照片可能无法通过上游审核。
- 只向上游发送 model、prompt、seconds、resolution、ratio 和可选 image_urls。独立适配器转换画布的 duration/images，避免发送上游拒绝的 size、seed 等额外字段。
- 使用通用请求名，避开旧客户端硬编码的 Seedance 图片数量和比例限制。功能及售价通过 CONFIG 同步，无需客户端改动。

## 已部署

- 独立容器 `yihong-cheap-adapter`，内部端口 3015，无主机公开端口。代码目录 `/opt/corvas-yihong-cheap/server/yihong-cheap`。
- 复用 `server/dola-discount/media.py` 的鉴权下载与过期媒体存储实现，部署时复制至独立目录。生成已完成而下载未结束时返回 downloading / remote_completed；下载完成后返回本站媒体地址，不把上游 API Key 放进 URL。
- art：模型 ID 44，mid 310030，渠道 14，计费规则 55。
- cart：模型 ID 44，mid 310030，渠道 14，计费规则 51。
- 两站 `billing_type=requests`、`billing_rule=fixed`、`duration_rate=0`、渠道倍率 1。art 的 `fixed_rate` 和预扣均为 3；cart 均为 4。
- CONFIG：初次接入 r66，art 调价后为 `20261012T033111-r67.json`；条目 `ravenhash-video.yh25-cheap`，分组 `zhubo-video`（Seedance 2.5 推荐渠道），允许调用且可见。
- 保留发布前 r65 的全部其他模型和分组，包括此前已停用的 Super 条目。
- 本机 `127.0.0.1:18765` 主动刷新成功，revision=66。

## 回执与维护

- art 备份：`/root/flow-canvas-operations/yihong-cheap-art-20261012T032455628696Z`。
- cart 备份：`/root/flow-canvas-operations/yihong-cheap-cart-20261012T032501168316Z`。
- CONFIG 备份：`/var/lib/flow-config/operations/yihong-cheap-1791775580750`。
- 本地回执：`output/yihong-cheap-relay-configured.jsonl`、`output/yihong-cheap-config-published.json`。
- art 调价回执：`output/yihong-cheap-art-price3.json`、`output/yihong-cheap-price3-config.json`。操作脚本 `server/yihong-cheap/reprice-art.py` / `reprice-art.mjs` 只适用于从初始 4 元改为 3 元，已执行后不可重复运行。
- art 调价备份：`/root/flow-canvas-operations/yihong-cheap-art-price3-20261012T033045345921Z`；CONFIG 调价备份：`/var/lib/flow-config/operations/yihong-cheap-art-price3-1791775871521`。
- 部署脚本 `server/yihong-cheap/deploy.py` 复用既有 SSH 连接方式，密码仅从环境读取。`configure`、`publish` 默认预演，`--apply` 才提交；模型已存在时拒绝重复插入。
- 数据库备份含渠道凭据，不可公开分发。恢复时仅撤销本次新增记录，不整体覆盖此后的配置与账务。

## 验证

6 项 Python 适配检查及实际画布桥接模拟通过，覆盖 30 图、21:9、时长边界、字段冲突、上游精确字段、查询故障与结果下载状态。JS 通过 ESLint，公开 CONFIG 通过 schema 验证。

两站现有渠道 Key 均通过上游模型列表检查；数据库事务回滚预演、提交后回读与独立服务健康检查通过。线上使用无效时长确认在上游提交前拒绝，未发起收费生成。尚未验证该新模型的真实生成与完整视频下载。

本次侧对话只新增独立服务器适配文件和远端配置，没有改动主对话正在发布的客户端文件、Git 分支或安装包版本。
