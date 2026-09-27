# CONFIG 分组操作台

2026-09-24 管理页操作模式改为三列：渠道分组、所选组内模型、未分组模型。模型参数保留在“表单”模式，卡片编辑按钮可直接进入对应模型。

- 新增分组可先保存空分组；名称、类型和顺序随配置保存。
- 模型拖到左侧分组列空白区域，或点击卡片“独立成组”按钮，可直接创建同名的单模型分组。重复操作不重复建组，同名冲突自动追加编号，启停、价格及参数保持原样。
- 删除分组会移出全部成员，包含隐藏或停用模型，不删除模型、不修改调用开关和计费。未分组视频模型保留在右侧待用区，发布后不在画布显示；重新入组恢复显示。
- 模型可拖到目标分组、组内目标模型的前后或右侧未分组区域。拖到卡片上半部插到前面，下半部插到后面，插入线显示落点；分组卡片也支持同类型内拖动排序，列表边缘支持拖动时自动滚动。卡片箭头、分组选择框和上下移按钮提供替代操作。
- 分组和模型调整沿用撤销/重做、草稿、校验及发布流程。源码版与安装版统一使用现行配置；旧预览地址兼容读取同一版本。

空分组保存在可选 `catalogGroups` 数组，每项包含 `id/kind/label/order/scope/description`。有成员的分组仍以模型 `presentation.routeGroup*` 为准，移动和排序时同步这些既有字段；客户端继续读取原有字段，不需要桌面升级。旧客户端忽略空分组元数据；空组只在管理操作台显示。

2026-09-24 r36 修复：包含 `catalogGroups` 的操作台配置，在编辑写回和服务端保存时统一处理视频展示。未分组的托管视频写入 `presentation.visible:false`，管理员右侧仍显示待用卡片；再次入组恢复可见性。同组成员按分组元数据统一 `routeGroupScope`，修复一个推荐组因部分成员按账户分组、部分跨账户分组而在画布拆成两张卡片的问题。`catalog.enabled`、价格和生成参数不变。

统一发布在存储层完成：`preview` 归一为 `stable`，`/config/preview` 保持兼容但与 `/config` 内容和 ETag 相同。旧预览管理链接和表单也使用统一现行版本，后台移除两通道切换入口。草稿不自动生效，历史文件保留，回滚同样同步所有客户端。旧 `state.preview` 仅作为历史残留，不再参与现行读取。

本轮部署基于用户已发布的 r35，生成 r36；没有拿旧预览 r34 覆盖用户编辑。备份 `/root/flow-config-backups/unified-catalog-20260924T040333Z/`，回执 `output/config-unified-catalog-deployed.json`。原数据文件除 `state.json` 外摘要不变，新增 r36。92 项存储、接口、开关、目录、表单测试，三项浏览器流程和定向 ESLint 通过。回读源码画布 r36，三个未分组山海型号已从 model.list 消失；两个公开地址逐字相同。没有打包桌面客户端或修改中转站。

部署仅更新四个管理模块：`admin-catalog-model.mjs`、`admin-catalog-view.mjs`、`admin-editor.mjs`、`admin-editor-model.mjs`。上线前与 Git 基线逐文件比较，备份于 `/root/flow-config-backups/group-workspace-20260924T030828Z/`。本地回执 `output/config-group-workspace-deployed.json`；部署前后 CONFIG 数据目录全部文件摘要一致。部署后健康接口正常，正式 r33、预览 r34 保持不变。

验证：38 项目录/表单单测、定向 ESLint、三项隔离浏览器流程通过。新流程覆盖空分组、拖动排序、跨组移动、移入移出、删除与撤销、参数编辑、调用开关、发布重载和桌面/手机布局。截图位于 `output/playwright/config-groups-desktop.png` 与 `output/playwright/config-groups-mobile.png`。没有调用收费生成或修改中转站。

后续拖动落点增强另经 16 项目录单测、浏览器前后插入及分组拖动回归、定向 ESLint 验证。远端仅更新三个目录模块，备份 `/root/flow-config-backups/drag-placement-20260924T033516Z/`，回执 `output/config-drag-placement-deployed.json`；数据目录摘要仍保持一致。插入线截图 `output/playwright/config-groups-drag-before.png`。

单模型成组增强通过 17 项目录单测及浏览器拖入左侧空白区、按钮成组、重复操作、撤销、发布重载验证。只热更新三个前端模块，没有重启服务，部署前后主进程 PID 和数据目录摘要均相同，以保留管理会话。备份 `/root/flow-config-backups/single-model-group-20260924T034134Z/`，回执 `output/config-single-model-group-deployed.json`。已打开页面须先保存未提交的草稿，再刷新加载脚本。
