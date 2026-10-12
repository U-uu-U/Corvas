# 飞拓视频渠道

2026-10-08 按用户指定的三个型号接入 art、cart，初始按上游成本乘 3 设置两站统一售价。
同日后续单独将 30 图特惠的新站售价改为 4.50 元/次，老站仍为 3.60 元/次。
本次只新增服务端适配与远端目录，没有修改客户端、发布安装包、重启现有中转后端或提交收费生成。

## 型号与价格

- `ft-video-v1-fe82aee0b8ce5ee1d790a56291dc5563`：Seedance 2.5（30图特惠）。
  720p、4-30 秒整数、30 图/0 视频/0 音频。成本参考 1.20 元/次，art 售价 3.60、cart 售价 4.50 元/次。
- `ft-video-v1-bdf45387433ac0a9042ebab3fae0299d`：Seedance 2.5（全参30秒）。
  720p、固定 30 秒、30 图/10 视频/10 音频、提示词最多 6000 字符。
  成本参考 2.50 元/次，两站售价 7.50 元/次。供应商的“不保售后”说明保留在私有管理成本备注。
- `ft-video-v1-b92bdf13b031fea6d7e80431def22584`：Seedance 2.0（933全参特惠）。
  720p、4-15 秒整数、9 图/3 视频/3 音频。成本参考 1.20 元/次，两站售价 3.60 元/次。

前两条支持 16:9、9:16、1:1、4:3、3:4、21:9；933 不支持 21:9。
三个型号的实时目录均为 `real_person_support=unsupported`，没有标记可过真人。
未声明提示词上限的型号不自行声明无限制。素材大小与其他服务端约束仍由上游校验。
全参 30 秒型号有单文件和总量限制；当前客户端通用上传也有独立大小限制，
本次没有放宽客户端文件大小上限。

## 协议与恢复

代码在 `server/feituo-adapter/`。标准上游地址为 `https://feituokuajing.com/api/open/v1`。
上游 Key 只保存在两站新渠道中，通过请求 Bearer Header 传入私有适配器；源码、镜像和公开 CONFIG 不含 Key。

- 现有画布通用提交 `/v1/video/generations` 经原有转发规则到适配器 `/v1/videos`。
- 适配器映射 `images[].url/videos/audio_urls` 等已用字段到标准 `imageUrls/videoUrls/audioUrls`。
  保留数组顺序与重复素材，拒绝冲突字段、非法时长、比例、画质和参考数量。
- 提交上游 `POST /video/generate`，附带 `X-Public-Model-Ids: 1`，只发送一次，不自动重发 POST。
- 将 `jobId` 保存为中转的 `id/task_id`。忽略供应商另一个可能缺失或不同的 `taskId`。
- 查询 `/video/status?jobId=...`。`success=true` 与 HTTP 200 都不是任务完成依据，必须检查 `status`。
- 标准 `submitted/success/failed` 映射到 `in_progress/completed/failed`，返回不少于 30 秒的查询间隔提示。
- HTTP 查询失败、任务编号不匹配、未知状态、成功但无可用地址保持非终态，携带既有
  `corvas_query_state=unavailable`，由错误网关处理成可重试查询，避免误终结并退款。
- 明确失败的错误字段保留给既有错误网关分类、脱敏及管理员排查。
  正常输出不透传供应商费用、余额、配额等字段。
- 结果保留完整 HTTPS 签名地址和所有查询参数，不下载或归档二进制。
  出片、最终账务、文件下载未进行收费端到端验证。

这三个型号当前全部按次收费，不是带视频参考改按 Token 收费的四个官方型号。
如未来目录价格或能力变化，迁移前的实时目录校验会拒绝继续；不能直接替换成官方型号。
中转已有终态缓存，过期签名能否重新刷新仍取决于中转实际重新查询适配器，不能仅凭旧缓存保证刷新。

## 部署记录

- 两站新增 Docker 服务 `feituo-adapter`，容器内端口 3012，无宿主机公开端口。
- 文件目录 `/opt/corvas-feituo/server/feituo-adapter`；art 网络 `tokensbyte-network`，cart 网络 `tkeapi-network`。
- 两站模型 ID 38/39/40、mid 310024/310025/310026、渠道 ID 11。
- art 计费规则 49/50/51，cart 计费规则 45/46/47。均为 `requests/fixed`，预扣等于单次售价。
- 复用原 933 的转发规则，原目录、原价格、用户余额和历史账务未改。
- CONFIG r51：`20261008T051356-r51.json`；发布前为 r50。stable 与 legacy preview 共用目录。
- 两个 2.5 型号放入 `seedance25-backup`；933 放入 `seedance20-backup`。
- 公开目录仅投影销售价格。成本和来源记录在私有管理快照。
- 本机 18765 已自动收到 r51，刷新间隔 10 秒，没有手动重启画布。

私有备份：

- art：`/root/flow-canvas-operations/feituo-art-20261008T051340889762Z`
- cart：`/root/flow-canvas-operations/feituo-cart-20261008T051353367087Z`
- CONFIG：`/var/lib/flow-config/operations/feituo-1791436436308`

备份包含渠道凭据，不可公开分发。恢复应仅撤销本次三个型号及其新渠道、价格项，
不能用整库旧快照覆盖后续模型变动。客户端源码工作区的其他未提交改动未纳入本次修改。

## 运维与验证

`configure.py` 默认在事务中预演并回滚，`--apply` 才备份及提交；使用既有快照保护函数，
提交前后检查原有目录未变。`publish.mjs` 默认仅验证，`--apply` 发布；型号已存在时拒绝重复追加。
`deploy.py` 的 `stage` 仅用于首次部署，目录已存在时停止，后续更新应先核对并备份已有文件。
凭据通过 `FEITUO_API_KEY`、`FLOW_TASK_SSH_PASSWORD`、`CONFIG_SSH_PASSWORD` 临时环境变量传入；
art 复用 `hk-direct` SSH 配置。凭据不写入脚本。

已通过 14 项 Python 定向测试、2 项 CONFIG/客户端能力测试和新增 JS 的 ESLint。
验证覆盖请求转换、素材顺序、上下限、固定 30 秒、jobId 与 taskId 区分、断线不重提、
失败详情、签名地址、费用剥离、同源鉴权、重定向拒绝、按次计费和追加式迁移。
两站事务预演/提交回读、容器内鉴权模型查询、公开双端点 r51、两站售价和敏感字段边界均已核对。
没有提交付费任务，不能据此断言上游真实生成成功率或售后退款行为。

## 2026-10-08 下载地址兼容修复

老站日志 924、任务 `cmuz3cygk050s1ga6auy9v8vl` 已完成，缓存返回
`feituokuajing.com/api/video/cache/{jobId}?exp=...&sig=...`。
现有安装版把所有以任务 ID 结尾的路径当成查询地址过滤，因而错误报告
“视频已完成，但上游尚未返回产物地址”。实际文件可用，本机与老站均可读取 MP4 数据，
不是已证实的网络速度问题。

适配器现在对飞拓标准 `/api/video/cache/{jobId}` 和 `/api/video/result/{jobId}`
解析最多 5 跳 HTTPS 重定向，只允许飞拓主站与 `media.feituokuajing.com`，
每跳不携带账号认证，使用 `Range: bytes=0-0` 并读取 1 字节验证可用。
返回上游实际给出的媒体地址，完整保留其查询参数，不自行拼接 CDN 文件路径。
非媒体响应、尚未归档或 HTTP 409 保持可恢复查询状态，不误记为生成失败。
没有新增存储桶转存，现有安装版可直接使用新返回的 `.mp4` 地址。

源码 `getVideoResultUrl` 同时修正：明确 `video_url/result_url/output_url/download_url`
字段允许文件路径以任务 ID 结尾；明确 `status_url`、已知查询路径与未完成状态仍拦截。
通用 `url` 字段保留原有防误下载规则。没有发布新的客户端安装包。

两站更新前确认飞拓没有未完成生成或活动适配器连接，仅重启飞拓适配器。
运行代码 SHA256：`1b38282a3e17ecf3a7003ad9bf400703714f8b69313e11175563c7472d2867fd`。
原适配器文件备份：

- art：`/var/backups/corvas-feituo-download-art-20261008T063429503956Z`
- cart：`/var/backups/corvas-feituo-download-cart-20261008T063453314040Z`

`repair-download.py` 对精确日志与任务做缓存修复，只修改 `response_content.video_url`，
事务前后核对其他字段完全相同，账单、状态、耗时不变。默认事务回滚，`--apply` 正式写入。
本任务修复前备份：
`/root/flow-canvas-operations/feituo-download-cmuz3cygk050s1ga6auy9v8vl-20261008T063542485316Z`。
两站后续新任务走更新后的适配器，无需更新 CONFIG。其他历史任务仅在逐条核实后修复缓存。

安装版使用原恢复检查点 `2fe3e59b-3f9d-4879-aaf3-69d5fdcc9113` 已成功下载并回填，
状态 `attached`，原节点 `media-composer-1791436996589-ghbor0`，文件 47,727,780 字节，
文件头与服务器声明大小相符。临时调用权限已移除；没有重新生成、追加扣费或修改 API 设置。
本次通过 17 项适配器/迁移测试、58 项客户端解析及相关测试和所改 JS 的 ESLint。

## 2026-10-08 新站 30 图特惠调价

用户指定 `ft-video-v1-fe82aee0b8ce5ee1d790a56291dc5563` 在 cart 改为 4.50 元/次。
仅更新模型 38 的预扣与计费规则 45 的 `fixed_rate`，同时校正对应名称和备注。
计费保持 `requests/fixed`；art 的 3.60 元/次、其他型号、渠道和历史账单未改变。
操作前该型号没有进行中任务，事务预演、提交和目录对比通过。
初始接入脚本是历史的追加操作，拒绝重复添加，不可用于覆盖现有价格。

CONFIG r52：`20261008T065708-r52.json`。定向更新 cart 销售价快照和私有成本备注，
上游参考成本仍为 1.20 元/次，目录参数和启用状态保持不变。

- 新站备份：`/root/flow-canvas-operations/feituo-price-cart-20261008T065535819797Z`
- CONFIG 备份：`/var/lib/flow-config/operations/feituo-cart-price-1791442628051`

## 2026-10-12 Seedance 2.0 两条线路

用户指定截图中的特价 933 与长期特惠，售价按上游价格乘 3，art/cart 一致。

- 既有 `ft-video-v1-b92bdf13b031fea6d7e80431def22584`：恢复画布显示，名称仍为 `Seedance 2.0（933全参特惠）`，720p、4-15 秒整数、9图/3视频/3音频，3.60 元/次。
- 新增 `ft-video-v1-a4e45199f67ed84790ec03dfc2768a01`：`Seedance 2.0 满血（长期特惠）`，720p、仅 5/10/15 秒、9图/3视频/3音频，提示词最多 6000 字符，7.50 元/次。
- 长期特惠支持 16:9、9:16、1:1、4:3、3:4、21:9；两条上游均标记不支持真人。上游“不保售后”说明保存在管理员成本备注。
- 两条放入当前 `hm-seedance20`（Seedance 2.0）分组；保留其他模型的显示名、位置和开关，尤其不恢复已停用的 2.5 30图渠道。

复用两站飞拓 channel 11 及既有凭据、转发规则。933 仍是模型 40、mid 310026，art/cart 计费规则仍为 51/47；新增模型 43、mid 310029，art/cart 计费规则 54/50。均为 `requests/fixed`，预扣与单次售价一致。

适配器增加离散时长校验，目录控件同样仅提供 5/10/15 秒。更新前确认两站飞拓没有进行中任务与活动连接，仅重启飞拓适配器，不重启中转后端。

使用 `add-seedance20.py` 做事务预演及追加式迁移；`seedance20-catalog.mjs` 恢复旧卡片并新增新卡片；`publish-seedance20.mjs` 更新目录和私有价表；`deploy-seedance20.py` 校验既有文件摘要并定向部署。首次安装脚本 `configure.py` 不可用于重跑已有站点。

CONFIG r62：`20261011T201708-r62.json`，stable 与 legacy preview 共用发布。无需客户端更新。

- art 目录备份：`/root/flow-canvas-operations/feituo20-art-20261011T201644716958Z`。
- cart 目录备份：`/root/flow-canvas-operations/feituo20-cart-20261011T201657768950Z`。
- CONFIG 备份：`/var/lib/flow-config/operations/feituo20-1791749828245`。
- art 适配器备份：`/var/backups/corvas-feituo20-art-20261011T201428447023Z`。
- cart 适配器备份：`/var/backups/corvas-feituo20-cart-20261011T201513426717Z`。

上游鉴权目录、双站事务预演/回读、私网适配器健康、公开 r62 双端点及售价已验证。20 项 Python 测试、3 项 Node 目录/参数测试和 ESLint 通过；未提交收费生成，不把接入检查当作真实出片成功率证明。

## 2026-10-12 参考素材读取失败排查

art 日志 955、`fc_db3b9c8e7f7b42c8b7ef427bbba5c20b`、飞拓任务 `cmv4a0b0x1cftjsmgx3t8to7x`，北京时间 04:28:57 提交。上游明确返回 failed，原因是参考素材不可读取；本地日志 cost=0。用户报告 `er_abac0d423080da8db2d2964ad0785f43` 和本机诊断均确认提交了 1 图、1 视频、1 音频，并非音频只写在提示词里。

本机恢复记录和上传缓存对应的三个公网链接，在 art、cart 服务器上均可免认证 HEAD/GET，返回 200 和正确文件长度；视频为 3 秒 H.264，音频为 71.745 秒 PCM WAV、13,775,186 字节。上游目录音频单文件上限 15 MiB，但 `reference_audio_duration_seconds` 为 null，不能据此断言时长超限。

确定发现图片格式标注错误：本地文件名 `17.png`，真实内容是 JPEG，5504x3072、5,465,158 字节。客户端原先按后缀标为 `image/png`，上传后公网也返回该错误 MIME。上一条成功任务使用另一张已压缩 JPEG，不能作为当前素材格式正常的证据。

源码 `collectVideoReferenceImages` 改为通过 Sharp 检测实际格式；上传缓存身份包含 MIME，避免同一内容仍命中旧的错误格式地址。`video-reference-mime.test.cjs` 覆盖错后缀 JPEG 的实际 multipart 类型/文件名、旧缓存隔离、正确缓存复用及原文件不变。修复尚未打包，源码版须重启 Electron 主进程；未修改用户原素材、线上素材或重提生成。

上游错误没有指出具体失败链接和原始读取状态。此次修正的是确定的格式识别缺陷，尚未通过重新付费生成证明它是该任务失败的唯一原因；两台服务器当下可读取也不能证明上游当时已成功抓取素材。
