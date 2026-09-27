# 山海视频渠道

## 2026-09-24 Dola 30 秒

`oc-model-r5cfh8` 已加入两个中转站和 CONFIG 正式 r33、预览 r34，显示为 `dola（9图30秒）`，分组为“备用分组2”。上游鉴权 `GET /api/v1/models` 核实：固定 30 秒、720p，支持 21:9、16:9、4:3、1:1、3:4、9:16；`max_reference_images=10`，`video_reference=false`、`audio_input=false`。名称保留上游的“9图”，实际能力按接口返回的 10 图执行。

上游标价 0.9 山海币/次，与现有 15 秒版相同，未将山海币当作人民币。售价沿用现有 dola：老站 5.00 元/次、新站 5.72 元/次。两站分别新增独立计费规则 39 / 35、模型 id 28 / mid 310014，复用山海渠道 7 和转发规则 51，原有模型、价格和启用状态保持原值。管理页双站售价和成本快照均已增加该型号；公开 CONFIG 的单价只限定新站主机，避免将新站价误用于老站。

两站适配器已部署，SHA256 为 `bfbd5a7fe6bb25954ca059cd4e228143af62db67c028ffdc8809064073f21048`。源码直连山海使用 `inputs/options`，经两站使用 `image_urls/aspect_ratio/duration/resolution` 并由服务端转换。新型号非法时长、分辨率、视频/音频参考、超量或失联素材会在上传及提交前拒绝，恢复只查询原任务。没有增加本地写死的模型目录。

数据库增量脚本为 `server/shanhai-adapter/add-dola30.py`，无 `--apply` 时在事务中预演并回滚；正式执行前备份且校验来源模型、计费及渠道映射。CONFIG 增量发布脚本为 `server/shanhai-adapter/publish-dola30.mjs`，应以 `flowconfig` 用户运行，默认只校验，`--apply` 发布。两脚本发现型号已存在都会拒绝重复新增。

回执：`output/dola30-art-receipt.json`、`output/dola30-cart-receipt.json`、`output/dola30-config-receipt.json`。老站备份 `/root/flow-canvas-operations/dola30-20260924T024848Z`，新站备份 `/root/flow-canvas-operations/dola30-20260924T024955Z`；适配器原文件另有各自回执记录的备份。CONFIG 备份包含发布前数据目录。

定向验证通过 Node 38 项、Python 12 项，以及 ESLint、差异检查、远端适配器健康检查和两站数据库事务核对。源码主进程已在没有活动生成任务时正常重启，模型列表回读为 10/0/0、30 秒、720p。未发起收费生成，尚未验证供应商实际出片；本次没有新安装包。

## 原始接入

山海渠道使用独立的公开 API 协议，不是 OpenAI 兼容的视频路径。

- Base URL：`https://shanhai.vnshu.cn/api/v1`
- 鉴权：`Authorization: Bearer oc_live_...`
- 创建：`POST /generations`
- 查询：`GET /tasks/{taskId}`
- 下载：使用任务返回的 `output.url`，并携带同一枚 Bearer Key

最初加入「备用分组2」的模型如下，表中为初始售价，现行双站价格见 `docs/config-model-prices.md`：

| 模型 | 山海 API ID | 初始售价 |
| --- | --- | --- |
| dola（9图15秒） | `oc-model-qbdmeb` | ¥4/次 |
| sd-2.0（官渠）-极稳 | `oc-model-1iq31f` | ¥5/秒 |
| S-2.0 官转933 | `oc-model-bkb50q` | ¥7/次 |
| S-2.0 满血933（不卡人脸） | `oc-model-c6ws7e` | ¥7/次 |

API 请求使用文档规定的 `media_type: "video"`、`inputs` 和 `options` 字段。图片和视频输入必须是山海服务器可访问的 HTTPS 地址；本地素材会先经过临时公开上传。音频参考按山海的 `POST /uploads/audio` 上传，限制 25MB、MP3/WAV。

API Key 不写入源码、默认配置或前端构建产物。首次使用时，在 Corvas 设置的 API 表单选择「Shanhai Video」，确认端点为 `https://shanhai.vnshu.cn/api/v1`，填入账户中心创建的 `oc_live_...` Key，并保留四个模型 ID。没有 Key 时，模型可以显示在目录中，但提交会明确提示未配置 Key。

任务结果不明时不会自动重新提交；保留任务 ID，恢复操作只查询原任务。失败、轮询超时和鉴权下载错误均不会把结果当成成功产物。
