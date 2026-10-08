# HM Seedance 2.0

2026-10-07 用户指定接入截图中的 Fast 813、Mini 503、933，范围为 art/cart 和画布 CONFIG。
售价按上游人民币单价乘 3 得到 art 价，cart 再乘 8/7 向上保留两位。全部按次计费。

## 模型与价格

- `SD2.0FAST813` -> `HM-Seedance V2.0 Fast 813`：720p/1080p/2k，4-15秒，8图/1视频/3音频。
  art 每次 3.90/4.50/5.10 元；cart 每次 4.46/5.15/5.83 元。
- `SD2.0MINI503` -> `HM-Seedance V2.0 Mini 503`：720p，4-15秒，5图/0视频/3音频。
  art 每次 2.70 元；cart 每次 3.09 元。
- `seedance_v2.0-933` -> `HM-Seedance V2.0 933`：720p，4-15秒，9图/3视频/3音频，人脸参考受限。
  复用已有模型及任务关联；art 每次由 6.50 改为 3.00 元，cart 由 7.43 改为 3.43 元。

供货与协议依据为两站已有 HM Key 的 `/v1/models`、`/v1/pricing`，以及公开
`/api/video/models`、`DocsPage-B2YgQimO.js`、`VideoModelStatusIndicator-D_Xq-234.js`。
公开网页 canonical ID 与鉴权请求 ID 不同，转发必须使用箭头右侧精确名称，不要回改为 canonical ID。
上游单次价格为 Fast 1.30/1.50/1.70、Mini 0.90、933 1.00；仅进入 CONFIG 私有成本快照。

协议为 `POST /v1/videos`，字段 `model/prompt/seconds/ratio/resolution/image_urls/video_urls/audio_urls`。
查询 `GET /v1/videos/{task_id}`，上游文档承诺完成后返回 `url/result_url`。
公网参考素材先上传，上传失败不降级为 Base64。常规比例沿用公共文档的五种比例及画布自动比例。
没有接入未被用户选中的 Fast 803，也没有扩展首尾帧界面。

## 计费实现

Fast 813 复用两站原生 `requests/image_resolution` 分辨率按次算法；该名称中的 image
不改变模型的视频类型。使用 720p/1080p/2k 三档单次价格，`duration_rate=0`，不按 seconds 相乘。
该通用算法在缺少分辨率时内部使用 `1k`，因此增加一个同 720p 价格的内部缺省匹配项。
`1k` 不是本模型支持的输出分辨率，不进入公开选项或售价快照。
Mini 503 和 933 使用 `requests/fixed`。模型预扣沿用最低单次价格，终态结算按对应计费规则执行。
源码已确认参考图片数量是独立 `image_ref_count` 字段，不直接当成生成次数。

## 部署记录

- art 原渠道 3：新增模型 35/36，mid 310021/310022，计费规则 46/47；933 保留模型 8、计费规则 20。
- cart 原渠道 2：新增模型 35/36，mid 310021/310022，计费规则 42/43；933 保留模型 9、计费规则 18。
- CONFIG r47：`20261007T153618-r47.json`；新分组 `hm-seedance20`，显示名“Seedance 2.0 HM”，顺序 25。
- 新目录 ID：`ravenhash-video.hm-fast-813`、`ravenhash-video.hm-mini-503`；933 仍为 `ravenhash-video.hm-seedance-933`。
- 两站脚本：`server/seedance-hm/add-hm20.py`，默认事务回滚预演，`--apply` 才备份及提交。
- CONFIG 脚本：`server/seedance-hm/publish-hm20.mjs`，默认仅预演，`--apply` 发布。

私有备份：

- art：`/root/flow-canvas-operations/hm20-art-20261007T153537938062Z`
- cart：`/root/flow-canvas-operations/hm20-cart-20261007T153542329206Z`
- CONFIG：`/var/lib/flow-config/operations/hm20-1791387378650`

事务预演、提交后目录回读及无关配置比较通过；公开 r47 的两站售价和模型参数通过实际客户端
`resolveVideoModelProfile` 解析验证；61 项相关请求测试和 ESLint 通过。
本机 18765 刷新接口当时拒绝连接，未确认当前用户客户端已收到 r47。
没有重启用户画布、发布安装包或提交付费生成；实际出片与最终账务尚未进行端到端测试。

首次接入检查时 Fast 813 的上游状态为 `unavailable/consecutive_failures`，虽仍列为可调用，
不能据此声称已恢复出片。新增 Fast/Mini 的明确请求适配已补到源码，需重启源码版或后续安装包
更新才能加载；CONFIG 目录与售价可独立远程同步。
