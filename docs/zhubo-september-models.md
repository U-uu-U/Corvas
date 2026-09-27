# 主播五款 Seedance 2.5

2026-09-24 两站新增以下5个精确型号，并发布统一 CONFIG r38，追加到当前“Seedance 2.5 推荐渠道”。既有模型的开关、排序、分组及价格保留。

- `LongXia-video-seedance2_5-standard-480p-express-PerSecond`：480p、4-25秒；上游0.42元/秒，老站0.80元/秒，新站0.92元/秒。
- `LongXia-video-seedance2_5-standard-720p-express-PerSecond`：720p、4-25秒；上游0.56元/秒，老站1.06元/秒，新站1.22元/秒。
- `seedance-2.5-480p`：480p、4-30秒；上游4元/次，老站8元/次，新站9.15元/次。
- `seedance-2.5-720p`：720p、4-30秒；上游5元/次，老站10元/次，新站11.43元/次。
- `seedance-2.5-1080p`：1080p、4-30秒；上游6元/次，老站12元/次，新站13.72元/次。

初次接入按老站售价为上游价2倍计算；用户随后明确将LongXia老站覆盖为0.80/1.06元每秒，新站继续按老站价乘8/7向上保留两位，即0.92/1.22元每秒。三条按次售价不变。两站都按CNY记账，不再除以6.75。按秒型号预扣4秒费用现为老站3.20/4.24元、新站3.68/4.88元；按次型号预扣一次售价。预扣沿用中转系统固定门槛，不代表每次根据所选秒数动态预扣。

后续调价由 `server/seedance-hm/reprice-longxia.py` 完成，事务预演、提交后回读均通过，只有两条计费规则的金额/说明与两条模型预扣/说明变化。画布销售价快照同步更新，成本价、模型目录、用户余额及历史任务未改。回执 `output/longxia-price-{art,cart,config}-receipt.json`；老站备份 `/root/flow-canvas-operations/longxia-price-20260924T085914Z`，新站备份 `/root/flow-canvas-operations/longxia-price-20260924T085908Z`。首装脚本保留原始r38定价记录，不能重跑来覆盖本次调价。

## 参数契约

统一支持30张图片、0个视频、10段音频参考。公共接口 `POST /v1/videos`，参数为 `model/prompt/seconds/ratio/resolution/image_urls/audio_urls`；`seconds`必须为范围内整数，固定各型号分辨率。参考素材先上传公网URL；不将站点内部Data URL用法套到公共API。查询为 `GET /v1/videos/{task_id}`，任务恢复只查询原任务，不重复上传或提交。

比例按公共API文档的 `16:9/9:16/1:1/4:3/3:4`；画布自动比例根据首图转换，未带首图默认16:9。当前工作台LongXia额外提供21:9、其他型号有通用更多比例菜单，但没有公共API契约确认，本次未增加这些比例。

参考图片按工作台限制单张20MiB；LongXia音频仅MP3、每段15MiB；三款按次音频保守采用工作台声明的MP3/WAV、每段20MiB。客户端和Agent在上传或创建输出节点前检查超量、失联、格式和大小。严格上传失败直接阻止提交，不回退Base64。

参数/价表依据：`https://video.zhubo.asia/api/video/models`、`https://video.zhubo.asia/assets/DocsPage-W8h8eE17.js` 和 `https://video.zhubo.asia/assets/VideoPage-JdtWvzUL.js`。LongXia描述中的0.4/0.58为旧文案，采用结构化rates的0.42/0.56。两站现有渠道Key的鉴权 `/v1/models` 均能看到5型号，未输出或修改凭据。

## 部署与验证

`server/seedance-hm/add-zhubo-september.py` 在两站复用现有主播渠道及原生转发：老站渠道3/规则37，新站渠道2/规则48。新增每站5条模型及5条独立计费规则，模型id29-33、mid310015-310019；老站计费40-44，新站36-40。数据库中原 `models/model_mapping` 为双重JSON编码，追加时正常化为单层JSON，并逐项保留原绑定。

默认仅事务预演并回滚；`--apply` 先私有整库备份，再在事务锁内验证配置未变、新增规则和模型、更新渠道映射、比较预期目录、推进序列后提交。没有重启中转后端，也没有修改用户余额、Key、插件或原模型状态。

`server/seedance-hm/publish-zhubo-september.mjs` 增量发布目录及管理价表、成本、上游来源快照。正式和旧preview入口共享r38，34条CONFIG模型；售价格式继续仅显示“售价”，由当前API地址选择双站金额。没有新增本地硬编码模型目录。

备份：老站 `/root/flow-canvas-operations/zhubo-september-art-20260924T073319263602Z`；新站 `/root/flow-canvas-operations/zhubo-september-cart-20260924T073224859436Z`；CONFIG `/var/lib/flow-config/operations/zhubo-five-1790235239653`。本地回执为 `output/zhubo25-{art,cart}-applied.json` 和 `output/zhubo25-config-applied.json`，脱敏检查资料为同目录inspection/preview记录。

客户端builder/bridge/Agent共133项定向测试通过，数据库脚本6项测试通过，两站事务预演与提交回读通过；相关ESLint和diff检查通过。源码版在无活动生成任务时正常重启，运行时回读5型号的分辨率、时长、30/0/10和销售价格均正确。未提交收费生成，未验证供应商实际出片；安装版仍需后续打包才包含新素材与分辨率适配。
