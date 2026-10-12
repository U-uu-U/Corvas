# 极九 Seedance 2.5 满参线路三

2026-10-12 按用户指定接入 art、cart，两站统一售价 **CNY 11 元/次**，预扣也是 11 元。上游公开参考标价为 5.50 元/次，只写入管理员成本快照。

- 上游：`https://newapi.jijiucanvas.com`，精确模型名 `SD2.5特价30-10-10-线路三`。
- 公开请求名：`jijiu-video-301010-route3`；画布名称：`Seedance 2.5 满参（线路三）`。
- 720p、4-30 秒整数、最多 30 张图片 / 10 段视频 / 10 段音频；当前开放文档明确举例的 16:9、9:16、1:1。
- CONFIG 条目：`ravenhash-video.seedance25-full-route3`，放入线上已有的 `zhubo-video`（Seedance 2.5 推荐渠道）。上线时用户已将原备用模型合入该组，因此保留当前分组、名称和顺序。
- CONFIG 的“上游站点”增加极九入口，不查询余额。

## 请求和恢复

现有客户端对新的 Seedance 型号有 10 图的内部限制。因此采用独立公开请求名走已有通用视频分支，由远端目录提供 30/10/10 限制；服务端适配器将 `images[].url`、`videos`、`audio_urls` 转为上游字符串数组 `images`、`reference_videos`、`reference_audios`。不需要新增客户端代码。

适配器提交 `POST /v1/videos`，读取返回的 `id`，查询 `GET /v1/videos/{id}`。不使用上游已注明大多返回 503 的 `/v1/video/generations`。POST 只发一次，响应中断保留未知受理状态；查询失败、任务编号不一致、未知状态和产物缺失保持可重试查询，只有明确 `failed` 才作为失败终态。

完成后优先返回本站带 `access` 票据的 `content_url`，其次使用上游返回的公开视频直链。需要账号 Key 的无票据 `/content` 不会伪装成可直接下载地址。适配器不下载、转存视频，不向视频地址发送账号凭据；成功响应不透传成本、余额、提示词和参考素材。

首次部署只验证接口与配置，没有主动提交收费生成。后续已通过用户已有任务验证成功结果和视频读取，见下方结果回传修复记录；票据长期有效性仍未验证。错误与退款以实际任务和账务证据为准。

## 部署

- 代码：`server/jijiu-seedance/`；两站目录 `/opt/corvas-jijiu/server/jijiu-seedance`。
- 服务：`jijiu-video-adapter`，Docker 私网端口 3014，加入既有 relay 网络，无公开端口。
- 两站 model ID 42、mid 310028、channel ID 13；art billing rule 53、cart billing rule 49。
- CONFIG r61：`20261011T190716-r61.json`，stable 与 legacy preview 已同步。
- art 备份：`/root/flow-canvas-operations/jijiu-route3-art-20261011T190652700994Z`。
- cart 备份：`/root/flow-canvas-operations/jijiu-route3-cart-20261011T190705924721Z`。
- CONFIG 备份：`/var/lib/flow-config/operations/jijiu-route3-1791745636954`。

凭据从 `JIJIU_API_KEY` 临时环境变量经 stdin 传入，只保存在两站私有渠道。配置脚本默认事务预演并回滚，`--apply` 才提交；既有目录逐字段保护，人民币币种、按次费率与预扣回读验证。备份含私有渠道数据，不可公开。

8 项 Python 定向测试验证字段转换、素材限制、未知提交不重试、查询异常、签名产物及追加式计费；2 项 Node 测试验证目录 schema 和现有客户端完整上传 50 个参考素材、提交、查询、下载的模拟流程。没有重启中转后端、发布安装包或改动其他渠道计费。

接口依据：`https://newapi.jijiucanvas.com/docs/api-docs.md`；上游 Key 鉴权模型列表已确认目标型号可用。

## 2026-10-12 结果回传修复

用户提供排查编号 `fc_a6229fd9d64d42028814eaa65d486f08`，对应 art 日志 953、任务 `task_ZuGOh6AVPonVcOLxn9lWt8nYp2g81IbQ`。上游在北京时间 03:10:42 提交、03:20:14 完成，实际响应是 `video: { duration, url }`，与文档展示的顶层 `content_url` / `video_url` 不同。原适配器遗漏该分支，导致已完成任务被保守保留为查询暂不可用。

已补充 `video.url`、`video.content_url` 等嵌套字段，继续校验同站签名产物的任务编号和 `access` 票据；无票据鉴权地址、其他任务的产物路径仍不返回。两站只更新并重启独立适配器，未重启中转后端，CONFIG r61 和客户端无需更新。

修复后老站原任务被现有轮询自动标记为成功。用原用户令牌 GET 查询已返回 HTTP 200 / completed；视频 Range 读取返回 206、video/mp4、总长 49,795,825 字节，MP4 文件头正常。原日志费用仍为 11 元。没有重新提交生成或人工修改账务、任务数据库。

新增真实响应结构回归、无票据/错任务拒绝、无效候选回退，以及签名地址下载不携带站点 Key 的客户端检查。适配器备份：art `/var/backups/corvas-jijiu-art-20261011T193417526064Z`；cart `/var/backups/corvas-jijiu-cart-20261011T193505634391Z`。
