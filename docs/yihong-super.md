# Seedance 2.5 Super

2026-10-07 按用户要求新增到 art/cart，两个站点统一售价 CNY 0.78/秒，
不对 cart 额外乘历史代理系数。两站均按 CNY 记账。

## 线路与计费

- 公开模型：`seedance-2.5-super`；上游精确名称：`seedance2.5 super`，含空格。
- 上游：`https://yihongapi.com`；凭据仅保存于两站新建渠道，不进入源码、公开 CONFIG 或客户端。
- 提交：`POST /v1/videos`；查询：`GET /v1/videos/{task_id}`。
- 两站复用现有 OpenAI 异步视频透传规则，渠道模型映射及 `original_id` 均指向上游精确名称。
- 720p；5-30 秒整数；30 张图片、10 段视频、10 段音频参考。
- 比例：16:9、9:16、1:1、3:4、4:3、21:9；画布自动比例按首图转换。
- 素材必须使用公网 HTTPS 链接。上传失败直接中止，不降级为 Base64 提交。
- 计费规则为 `duration/video_resolution`，720p 费率 0.78，最低 5 秒预扣 3.90。
  这是既有固定预扣门槛；最终按原有时长结算流程执行，并非动态预扣所选全部秒数。
- 上游公开价表表达式按每秒 0.052054794520547946、展示汇率 7.3 折合 0.38 元，
  仅作为 CONFIG 私有管理成本参考，未以实际付费任务验证结算。

## 已部署

- art：模型 ID 34、mid 310020、渠道 9、计费规则 45。
- cart：模型 ID 34、mid 310020、渠道 9、计费规则 41。
- CONFIG：r46，`20261007T115505-r46.json`，新增到 `zhubo-video`（Seedance 2.5 推荐渠道）。
- CONFIG 条目：`ravenhash-video.seedance25-super`；stable 和 legacy preview 共用目录。
- 本机 18765 已主动刷新并返回 r46；18766 当时未监听。

只追加新渠道、模型和计费规则，事务内比较现存目录未变化。没有重启中转服务，
没有修改用户额度、历史账单、现有渠道、原模型或已运行生成任务。

私有备份与回执：

- art：`/root/flow-canvas-operations/yihong-super-art-20261007T115414483906Z`
- cart：`/root/flow-canvas-operations/yihong-super-cart-20261007T115422322255Z`
- CONFIG：`/var/lib/flow-config/operations/yihong-super-1791374105005`

数据库备份包含渠道凭据，不可公开分发。配置脚本为 `server/seedance-yihong/configure.py`，
使用同目录树的 `server/seedance-hm/add-zhubo-september.py` 快照及事务保护函数；默认事务回滚预演，
`--apply` 才备份并提交，凭据通过 stdin JSON 传入。已有型号时拒绝重复执行。
目录发布脚本为 `server/seedance-yihong/publish.mjs`，默认仅预演，`--apply` 才发布。

## 客户端与验证

远端目录和售价可直接同步。当前安装包 beta.16 对未知 Seedance 型号仍套用旧的
10 图、无音视频参考及五种比例限制。源码已在 `video-provider-adapters.js` 补齐本型号，
`mcp-bridge.js` 对本型号强制使用公网素材上传；需重启源码版或后续发布新版安装包才加载。
本次没有打包、创建 tag、重启用户画布或提交付费生成。

已完成：两台服务器使用新渠道凭据查询上游模型列表；数据库事务预演和提交后回读；
公开 CONFIG 两站售价、参数与敏感信息边界检查；58 项相关请求适配测试及所改 JS 的 ESLint。
完整参考数量、时长上下限、21:9、HTTPS 素材要求和其他线路不受影响均有定向覆盖。
真实视频生成、上游任务轮询结果和视频下载尚未进行付费端到端验证。
