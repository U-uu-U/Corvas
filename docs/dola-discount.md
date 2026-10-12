# Dola 2.5 特价渠道

用户指定仅接入 `dola2.5特价`，供应商地址 `http://160.202.238.97:3000`。
用户随后确认成本 4 元/条，art、cart 均按 2.5 倍配置为 10.00 元/次，已部署。
只接入该型号，不使用补充文档的自建豆包池模型名或其 3/4 元分档价格覆盖用户指定的特价型号。

2026-10-08 鉴权 `GET /v1/models` 返回 H3、H3-max、dola2.0fast特价、dola2.5特价。
接口未返回模型规格或金额。两份用户文档使用不同的公开模型名；提交使用该账号实际返回的
`dola2.5特价`，不使用文档中的 `Seedance 2.5` 或内部 `seedance_v2.5`。
H3、H3-max、dola2.0fast特价不在当前接入范围内。

公开 `/api/pricing` 不可用，`/api/ratio_config` 未启用。站点状态中的 USD 展示设置与 7.3
汇率不能代替本型号实际人民币成本。管理成本依据用户确认的 4 元/条，而不是接口自动报价。

适配代码位于 `server/dola-discount/adapter.py` 和 `media.py`：

- 提交 `POST /v1/video/generations`，只发送一次，保存实际 `task_id`。
- 请求按附件将时长转换为整数 `seconds`（4-30），同时发送值相同的 `size/aspect_ratio`，保留精确公开模型名。
- 文档明确的画幅为 16:9、9:16、1:1；最多 10 张参考图片，提示词最多 5000 字符。
  这些约束来自附件，尚未以实际付费任务验证该别名的全部能力。
- 图片经现有公共素材上传流程转为 HTTP(S) 地址；未扩展客户端到任意大 Base64 请求。
- 附件未声明本型号支持音频或视频参考，因此不将其他渠道的能力套用到此型号。
- 查询补充文档的 `GET /v1/video/generations/{task_id}`，HTTP 404/405 时回退旧文档
  `/v1/videos/{task_id}`。兼容顶层或 `data` 包装、processing/in_progress、succeeded/completed。
  查询响应没有 ID 时按精确查询路径关联；存在 ID 时必须匹配。每个账号/任务缓存 60 秒，
  有界缓存最多 1024 条，防止客户端高频查询直接传到上游。网络错误不冒充生成失败。
- 已完成任务从固定同源 `/v1/videos/{task_id}/content` 带原 Bearer 下载，
  跨域重定向后不再发送上游 Key，并拒绝私有地址重定向。参考图采用 JSON 公网 URL，
  不采用补充文档明确指出会丢图的 multipart 上传。
- 视频流式写入两站已有临时媒体目录，校验 MP4 文件头、Content-Type、声明长度及 512 MiB 上限，
  成功后原子替换为 `.mp4` 并返回本站 `/fc-media/files/dola25-<hash>.mp4`。
  未完成下载只报告非终态；下载失败可继续查询原任务，不重提生成或冒充失败退款。
- 上游 Key 仅存在本站渠道和下载请求内存，不进入源码、公开 CONFIG、下载 URL 或磁盘任务缓存。
  成功响应不透传上游费用。没有新增图片模型或长期对象存储；媒体仍受现有过期清理约束。

## 部署与验证

- 两站新增模型 ID 41、mid 310027、渠道 ID 12。art 计费规则 52，cart 计费规则 48。
  两站均为 `requests/fixed`，费率和预扣 10 元，不按时长相乘。
- 服务为 `dola-discount-adapter`，目录 `/opt/corvas-dola-discount/server/dola-discount`，
  Docker 私网端口 3013，无新宿主机公开端口；没有重启现有中转后端。
- art 媒体目录 `/opt/flow-canvas-upload/data`，沿用上传服务清理；
  cart `/var/lib/corvas-channel-media`，沿用 `cart-channel-media-cleanup.timer`。
- 新站当时缺少 `/fc-media/files` 的静态路由，本次只补充 `dola25-[a-f0-9]{64}.mp4`
  文件匹配，配置片段 `/etc/caddy/dola-discount-media.caddy`，原 Caddyfile 仅增加一条 import。
  原有 API、发布页和其他站点配置保留，经 `caddy validate` 后 reload。
- 远端目录在操作期间已由 r52 整理到 r54，备用组并入推荐组。发布沿用最新分组和排序，
  新条目 `ravenhash-video.dola25-discount` 追加到“Seedance 2.5 推荐渠道”，没有重建被合并的分组。
- CONFIG r55：`20261008T091511-r55.json`，stable/preview 共用。公开只显示 10 元售价，
  4 元成本及供应商 IP 仅在私有管理快照。本机 18765 已自动收到 r55。

私有备份：

- art：`/root/flow-canvas-operations/dola-discount-art-20261008T091504652064Z`
- cart：`/root/flow-canvas-operations/dola-discount-cart-20261008T091508473649Z`
- CONFIG：`/var/lib/flow-config/operations/dola-discount-1791450911147`
- 新站 Caddyfile：`/var/backups/corvas-dola-media-20261008T091400072475Z`

13 项 Python 测试、2 项 CONFIG/客户端能力测试及新增 JS 的 ESLint 通过。
两站目录追加均经事务预演回滚、提交和回读，既有模型、价格、余额、账单与渠道未改。
临时测试文件从新容器 UID 1000 写入媒体目录后，通过公网读取验证字节和 `video/mp4` 类型：
art 返回完整文件 HTTP 200，cart 支持 Range HTTP 206；测试文件均已删除。
两站公开价格、能力和 r55 已核对。没有提交收费生成，尚未验证该别名实际出片及上游最终账单。
