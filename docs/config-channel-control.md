# CONFIG 快捷开关

适用于本项目 CONFIG 模型/分组的启用和停用，不控制 art/cart 两站后台数据库。按用户当前上下文确定预览、正式配置或中转站；没有明确要求正式配置时，当前源码试验流程使用 `preview`。不要把“已关闭 CONFIG 模型”说成“两站渠道已下架”。

## 管理卡片入口

已纳入目录的模型卡片右上方都有“允许调用”开关，修改 `catalog.enabled`。切换后点击“发布配置”，生效范围是当前选择的正式或源码预览通道。停用保留普通灰色卡片，以开关和“已停用”文字表示状态，整组停用也保留组卡片；开启不改价格、参数或分组。右侧重复的“目录状态”下拉框已移除。`presentation.visible` 仅表示显隐，日常关闭调用不要再用隐藏来代替。未补全模型 ID 与 API 主机的旧模板没有调用开关。

这项开关由画布远程目录和提交前检查执行，暂停新请求，保留已有任务恢复。它不关闭供应商账户，也不拦截绕过画布直接发往中转站的请求。模型在中转站或上游本身不可用时，打开 CONFIG 开关不能修复该上游。

远端工具已安装到 `/srv/flow-config/catalog-control.mjs`。本机包装器是 `scripts/config-channel-control.py`，使用 Paramiko、SSH `154.12.57.162:22`，以 `flowconfig` 身份调用。认证读取 `CONFIG_SSH_PASSWORD` 或 `CONFIG_SSH_KEY`，复用当前会话的有效凭据；脚本和规则中不保存密码。

## 操作

先按名称查简表，确定精确模型或分组。语义明确、凭据可用时直接执行，不重复询问已经确定的范围。

```powershell
python -B scripts/config-channel-control.py list --query "Seedance 2.0"
python -B scripts/config-channel-control.py disable --group seedance20-recommended
python -B scripts/config-channel-control.py enable --group seedance20-recommended
python -B scripts/config-channel-control.py disable --id minimax-video.minimax-h3-seconds
python -B scripts/config-channel-control.py restore --receipt <receiptId>
```

- 默认通道为 `preview`；正式配置要明确传 `--channel stable`。
- 分组 ID：推荐 `zhubo-video`，2.5 备用 `seedance25-backup`，2.0 推荐 `seedance20-recommended`，山海 `shanhai-backup-2`。
- `--id` 是 CONFIG 条目 ID，`--model` 是精确 wire model；同名匹配多条时改用 `--id`。分组只操作已纳入 `catalog` 的视频条目。
- 命令会先读取当前版本，再检查版本并发布；重复开关不产生新版本。遇到版本冲突重新读取，核对目标后再执行。
- 默认主动刷新本机 `18766` 上、确实连接该远端通道的源码实例；不需要等待轮询。可以用 `--bridge` 指定其他实例或 `--no-refresh` 仅发布。
- 返回 `receiptId`、发布版本、目标状态、耗时及画布刷新结果。刷新失败不等于发布失败，先查询现行状态，避免盲目重发。
- `restore` 只恢复该回执改动的 `catalog.enabled` 字段，保留随后修改的名称、分组、价格及其他模型；目标状态已被他人更改时拒绝恢复，不整包回滚。
- 显隐 `presentation.visible` 与启用状态独立。已隐藏模型即使启用也不会自动取消隐藏；两站后台启用状态同样独立。

## 已测结果

2026-09-23 用户确认在正式、预览均恢复山海。既有 CLI 发布预览 r14 和正式 r15，仅打开四条 `catalog.enabled`，回执分别为 `fc694734-085b-450a-9edd-74d7572641c1`、`e41b8c69-a980-4981-b03d-d43343eca7c1`。随后单独将四条 `presentation.visible` 恢复为 true，预览 r16、正式 r17；其他模型、参数、价格逐字段比较不变。注意 CLI 回执只恢复调用状态，不恢复后续显隐修改。

两站山海四条模型 `is_active=1`、山海渠道 `status=1` 已独立恢复，计费和其他模型/渠道摘要在事务内比较不变。备份分别为老站 `/root/flow-canvas-operations/enable-shanhai-20260922T175859Z/`、新站 `/root/flow-canvas-operations/enable-shanhai-20260922T175901Z/`。本地回执 `output/shanhai-relays-enabled.json` 和 `output/shanhai-config-visible.json`。山海旧两个 933 型号当前未见于上游目录，启用本地路由不代表已验证上游生成成功；没有提交收费请求。

卡片开关隔离浏览器验证覆盖四条全部关闭、分组保留、发布后提交拦截、单条重新开启、键盘及桌面/移动布局；相关测试 16 项通过。源码实例 `18766` 已自动读取预览 r16。

2026-09-22 在真实远端源码预览上完成两次 2.0 分组停用/恢复和一次 MiniMax 快捷停用/恢复，最终全部恢复原状态。首次测试暴露后台定时器延迟，已改为主进程心跳触发源码 CONFIG 检查，并以请求开始时间计算 10 秒周期。

修复后，自动同步停用为 8.17 秒、恢复为 9.20 秒；快捷路径主动刷新总耗时分别为 4.05 秒、3.42 秒（含 SSH 连接和发布）。这些是本次实测值，实际耗时受网络影响。

最终预览为 r10、正式配置仍为 r3，山海保持停用。没有调用生成 API。分组自动同步测试可用 `python -B scripts/test-config-channel-control.py`，仅针对源码预览并在 `finally` 中恢复；运行回执在远端 `data/operations`，结果摘要在 `output/config-control-live-test.json`。
