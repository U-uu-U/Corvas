# CONFIG 快捷开关

适用于本项目 CONFIG 模型/分组的启用和停用，不控制 art/cart 两站后台数据库。按用户当前上下文确定预览、正式配置或中转站；没有明确要求正式配置时，当前源码试验流程使用 `preview`。不要把“已关闭 CONFIG 模型”说成“两站渠道已下架”。

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

2026-09-22 在真实远端源码预览上完成两次 2.0 分组停用/恢复和一次 MiniMax 快捷停用/恢复，最终全部恢复原状态。首次测试暴露后台定时器延迟，已改为主进程心跳触发源码 CONFIG 检查，并以请求开始时间计算 10 秒周期。

修复后，自动同步停用为 8.17 秒、恢复为 9.20 秒；快捷路径主动刷新总耗时分别为 4.05 秒、3.42 秒（含 SSH 连接和发布）。这些是本次实测值，实际耗时受网络影响。

最终预览为 r10、正式配置仍为 r3，山海保持停用。没有调用生成 API。分组自动同步测试可用 `python -B scripts/test-config-channel-control.py`，仅针对源码预览并在 `finally` 中恢复；运行回执在远端 `data/operations`，结果摘要在 `output/config-control-live-test.json`。
