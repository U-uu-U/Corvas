# ai 站 Seedance 2.0 15秒

2026-10-09 按用户要求，将画布中的“Seedance 2.0 15秒”接入 `https://ai.ravenhash.org/v1`。

- 服务器：154.12.57.162:22，与 CONFIG 同机。New API 为 `calciumion/new-api:v1.0.0-rc.41`，不是 art/cart 的 tokensbyte 后端。
- 对外模型名：`b_seedance_v2.0`；上游鉴权模型列表当前返回 `seedance_v2.0`（数字 ID 3），15秒、最多9图。
- 新增渠道 106，类型 61，插件 `ravenhash-seedance20`，分组 `Seedance 2.0`。
- ModelPrice=2，分组倍率=1，本站 USDExchangeRate=1、显示币种 CNY，因此配置售价为 2 元/次。未修改已有模型价格、用户余额或历史账单。
- 将新分组追加到 UserUsableGroups 和 AutoGroups；使用此专用分组或 auto Key。已有固定在其他分组的 Key 不会自动获得新分组。
- 公开协议：`POST /v1/videos`、`GET /v1/videos/{task_id}`。插件返回本站签名产物地址，服务端以无凭据请求下载 CDN 视频，不向 CDN 发送渠道 Key。

## 服务与配置

私有适配器目录 `/opt/corvas-ai-seedance20`，容器 `seedance-direct-adapter`，仅加入 `new-api_new-api-network`，无公开端口。复用已修复的查询逻辑：临时404、查询网络异常和媒体解析未准备好保持非终态，避免 New API 直接按轮询404失败退款。

环境为 `UPSTREAM=http://38.76.169.86:8080`、`UPSTREAM_MODEL=seedance_v2.0`；公开请求仍校验 `b_seedance_v2.0`。`UPSTREAM_MODEL` 只在提交到上游时替换，不修改客户端或轮询标识。art/cart 的已部署实例没有改动，未提供该环境变量的适配器仍保留原默认值。

插件源码、部署管理脚本、CONFIG 发布脚本分别位于 `server/seedance-direct/newapi-plugin.mjs`、`newapi-configure.py`、`newapi-publish.mjs`。部署脚本只从 stdin 接受上游 Key，复用服务器已有管理员 API 凭据，通过管理 API 写入，不将密钥纳入源码或 CONFIG。首次部署脚本拒绝重复添加已有模型。

CONFIG r58：`20261009T080752-r58.json`，新增 `ravenhash-ai-video.seedance20-direct`，仅绑定 ai 主机。原有条目保持不变，新增条目通过精确 endpoint 匹配避免覆盖 art/cart。售价通过该条目的独立 pricing 元数据保存。

客户端 `buildVideoGenerationEndpoint` 已增加该模型与 ai HTTPS origin 的精确匹配，将 `/v1` 转为 `/v1/videos`。旧客户端默认使用 `/v1/video/generations`，无法调用此插件；需要包含本次路由修改的客户端。此次未打包。源码版需要重启主进程。部署时本机桥接返回 `MODEL_CONFIG_UNAVAILABLE`，未把发布成功当作画布已收到。

## 验证与备份

- 本站 Key 鉴权 `/v1/models` 返回新模型。
- 对 `/v1/videos` 提交故意错误的4秒参数，返回400与“requires exactly 15 seconds”，在插件参数校验阶段终止，没有触发上游收费生成。
- 管理 API 的插件 dryrun 验证9图请求转换和查询异常非终态；适配器健康及名称映射已回读。
- 62项相关 JS 测试、12项适配器测试及相关 ESLint 通过。未验证新提交任务的真实出片、扣费与客户端下载全流程。
- ai 管理配置备份：`/root/flow-canvas-operations/ai-seedance20-20261009T080553Z`。
- CONFIG 备份：`/var/lib/flow-config/operations/ai-seedance20-1791533272175`。
- 适配器名称映射前源码：`/opt/corvas-ai-seedance20/adapter.py.before-model-map`。

不要用备份整包覆盖后续运营修改。回退只处理本次新渠道、插件、分组成员、模型价格和新增 CONFIG 条目。

## 2026-10-13 对外接入文档

已将 `docs/api/newapi-seedance-2.0.md` 发布到 New API 模型元数据 `b_seedance_v2.0`
的 description，模型元数据 ID 为 3。通过管理 API 创建，未修改渠道 106、模型售价或分组倍率。
公开 `/api/pricing` 已回读完整说明及 `openai-video` 的 `POST /v1/videos` 文档入口。
New API 仍可能保留按渠道类型推导的通用 OpenAI 标签；本型号以专用视频接口说明为准。

发布脚本：`scripts/publish-newapi-sd20-doc.py`，默认预演，`--apply` 写入。
脚本核对服务器已启用的插件 source_hash，备份原模型元数据，回读文档并确认渠道及计费配置未变。
备份：`/root/flow-canvas-operations/newapi-sd20-doc-20261013T142706Z`。
文档 SHA-256：`3b60f2bfe9feaaafd932a09c0c83e27748265cfc01dddd352fc2b7dfc17cdc44`。
两份 JSON 示例已通过当前插件的 decodeRequest 校验，未提交收费生成任务。
当时画布 CONFIG 中该模型为 disabled/hidden，本次没有重新启用。
