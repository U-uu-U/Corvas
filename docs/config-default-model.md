# 远端默认视频模型

CONFIG 管理页操作工具栏提供“默认视频模型”下拉框，保存为 `defaultModels.video`，值为精确 CONFIG 条目 ID。只有允许调用且在画布可见的托管视频可选；未指定时沿用本地有效默认或可用列表。停用、隐藏、移出分组或删除所选条目后，操作台保存会清理失效默认。选择本身不改变型号、API 主机、密钥、价格或分组顺序。

源码客户端从 `readModelConfig` 保留并缓存默认字段，`resolveCatalogDefaultProvider` 在可用条目中按 ID 解析，优先沿用用户当前 API 账户。仅无节点绑定时应用远端默认；已有节点的 `providerId/sourceProviderId/model` 原样保留，CONFIG 刷新不重写节点。用户在本机显式设置视频默认时记录 `globalConfig.videoProviderSelection=manual`，此后本机选择优先。所选模型停用不会自动把已绑定节点改到其它线路。

2026-09-24 已部署管理模块和 schema，备份 `/root/flow-config-backups/default-video-model-20260924T054954Z/`，回执 `output/config-default-video-deployed.json`。部署前后现行配置及数据目录摘要相同，没有擅自替用户选择某个默认模型。源码已接入；beta.9 安装包的渲染层会忽略新字段，需要后续客户端更新一次，本次未打包。

验证：69 项默认解析、账号绑定、缓存和管理目录测试通过，管理页浏览器流程覆盖选择与发布重载，隔离 Electron 流程覆盖新节点采用远端默认、手动改选、默认变更及所选模型停用后绑定不变。构建、schema 同步检查和定向 ESLint 通过。没有发送收费生成请求。
