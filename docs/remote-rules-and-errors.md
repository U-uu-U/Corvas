# 远程参数规则与结构化报错

## 已部署状态

2026-09-27：art、cart 已接入媒体错误网关，CONFIG 管理端已加入“请求排查”和条件规则编辑。公开 CONFIG 为 r41，stable 与旧 preview 地址共用同一发布目录。本次未发布安装包。

SD2 Fast 的基础时长范围为 1-12 秒；条件规则将 480p 放宽到 1-15 秒，720p 保持 1-12 秒。未升级的客户端忽略新字段后仍得到保守的 12 秒上限。

2026-09-29：商家确认 SD2 Fast 支持最多9张图片、3段音频参考，不支持视频参考。r42 先按示例纠正参考类型，随后按用户确认将音频上限从1段改为3段。两站共用目录同步，售价、时长、比例和其他模型未改变。本地 `/v1/videos` 兼容适配使用 `image_urls` / `audio_urls`，不把视频静默转换成音频，也不在未确认原生 POST 地址时替换为商家网页的 action/platform/request 封装。上传和组包以隔离 fixture 验证，没有提交付费生成。

## 参数维护

模型编辑器的“条件参数规则 / 规则 JSON”接收数据规则：

```json
{
  "version": 1,
  "rules": [
    {
      "when": { "resolutionTier": "720p" },
      "options": { "duration": { "type": "range", "min": 1, "max": 12, "integer": true, "default": 10 } }
    }
  ]
}
```

条件支持 `resolutionTier`、`ratio`、`duration`、`quality`、`n` 的精确匹配，按数组顺序应用。匹配后的 `options` 或 `capabilities` 替换相应完整约束；未匹配字段继续采用基础配置。支持范围、固定值、枚举及图片/视频/音频参考数量限制，不支持脚本或表达式。

修改后保存并发布，客户端在下一次拉取时应用。当前发布配置的刷新周期为 10 秒；已打开的生成面板也会更新。超出新范围的当前选值会调整并提示，提示词里的分镜时间码不会被自动改写。

规则由 `shared/model-parameter-rules.cjs` 执行；CONFIG 的副本通过 `npm run sync:model-config` 同步。管理端拒绝非法范围、可执行字段和未知版本，客户端同样拦截未知规则版本。

现有安装版需要先升级一次，才能使用条件控件和完整 v2 错误显示。完成升级后，受支持的参数规则和服务端错误代码映射可远程更新。新增认证方式、上传协议、轮询协议或新的控件类型仍可能需要客户端适配。

## 客户错误与管理员排查

公开 v2 错误包含固定类别、数值约束、失败阶段、受理状态、建议动作、排查编号及可选的 `customerMessage`。具体原因由 `shared/customer-error-message.cjs` 从错误字段提取并脱敏，客户端再次清洗后优先显示；没有安全详情才使用数值约束或类别文案。上游账户余额不足仍显示服务异常，不会要求客户给自己的账户充值。

2026-09-29：MiniMax H3 的图片宽高/宽高比失败已纳入参数错误，并保留 256~5760 像素、0.4~2.5 等具体限制。提取支持 error/message/detail/fail_reason、嵌套结构和字符串化 JSON，不读取提示词、素材或生成正文。网址（含无协议域名/IP）、凭据、路径、供应商标识及价格/成本/余额子句被隐藏；普通数字、时长、尺寸、比例、格式和 HTTP 状态码保留。只对错误分支应用，不改正常生成结果。

`customerMessage` 不替代受理状态；不确定的提交、网络中断和上游账户错误保持原来的保守操作建议。图片/视频主进程、异常返回、任务持久化和渲染端共用协议，字符串二次显示也不再丢失经过清洗的具体原因。新显示需要客户端升级一次；源码版应重启 Electron 主进程。旧客户端仍能读取 v2 类别，但可能忽略新详情和新参数字段。

客户提供 `rh_` 排查编号后，在 `https://artconfig.ravenhash.org/admin` 的“请求排查”选择站点并查询。管理员可以查看脱敏后的服务错误、实际参数摘要，并通过对应中转站的 `log_id` 获取原始错误记录与账务字段。提示词、原始素材地址、密钥和认证头不记录到新增诊断文件。

`fc_` 是客户端编号。管理员私有查询现支持按该编号精确关联 `relayLogId` / `clientRequestId` 及中转站日志；若请求从未到服务器，则需要客户的本地诊断。旧客户端传入的合法 `X-Log-Id` 会保留到中转站，网关另建 `rh_` 并私下关联，避免破坏原有任务恢复。客户可从失败任务或诊断页直接上报，详见 [客户错误提交](customer-error-reports.md)。

超时或连接中断不能证明提交失败；系统不自动重发 POST，也不根据缺少日志、零成本或失败状态推断未扣费/已退款。`billingState` 保持 `unknown`，管理员以账务证据为准。单次查询失败同样不证明原任务已经受理。

## 服务运维

未知错误自动分析的配置、缓存、预算和客户端回执见 [错误分析](error-analysis.md)。分析结果以建议单独展示，不改变原任务状态。

- 网关：`corvas-relay-error-gateway`，监听 `127.0.0.1:18089`，只转发到本机 `127.0.0.1:8080`。
- Caddy 接入范围：`/v1/videos*`、`/v1/video/*`、`/v1/images/*`、`/v1/tasks/*`。
- 代码：`/opt/corvas-relay-error-gateway`；环境配置：`/etc/corvas-relay-error-gateway.env`。
- 私有记录：`/var/lib/relay-error-gateway`，最多 7 天或 10000 条失败记录。部署前的失败不会自动补录。
- 私有映射：`/etc/corvas-relay-error-rules.json`，格式为 `[{"upstreamCode":"...","publicCode":"RH_MEDIA_TOO_LARGE"}]`。替换有效文件后下次错误自动加载，只能选择已有公开错误码。
- 私有脱敏词：`/etc/corvas-customer-error-policy.json`，格式为 `{"privateTerms":["供应商内部名称"]}`。只接受最多 200 项、每项 3~160 字符的字面量，不执行正则或脚本。有效文件自动热加载，损坏文件保留上次有效策略；不进入公开 CONFIG。`update-customer-error-terms.py --site art|cart` 可从本站渠道名称补充词表，保留手工词，不输出名称或凭据。URL/凭据/价格等基础规则不可由词表关闭。
- 新失败快照保存 `classificationError`（用于分类的脱敏证据）和 `customerMessageAudit`（来源字段、处理规则、保留/脱敏/回退结果、是否待适配）。管理员“请求排查”显示服务原因、客户原因和处理记录。无法安全展示的错误进入“查看该站待适配错误”，使用已有私有诊断路径 `?review=1`，仅管理员可访问，沿用 7 天/10000 条保留上限，列表最多 50 条。历史记录不会伪造新的审计或覆盖原文案。
- CONFIG 私有连接凭据：`/var/lib/flow-config/admin-diagnostics-credentials.json`。不得加入公开 CONFIG。精确的 `/internal/diagnostics` HTTPS 路径要求服务端密钥，未授权请求返回 404；CONFIG 查询入口要求管理员登录。

媒体 JSON 必须先检查再返回。视频/任务 JSON 和非 2xx 错误默认限额 1 MiB；`/v1/images/*` 的 2xx JSON 默认 64 MiB，可用 `RELAY_GATEWAY_IMAGE_JSON_MAX_BYTES` 调节，上限 128 MiB。压缩前后均受限；超限、解压或解析失败时返回安全错误，提交结果保留未知。二进制媒体和 SSE 正常透传，其内部流式错误不在当前归一化范围内。

错误规则无法从完全缺失的上游信息中恢复原因。未识别错误先返回安全类别与排查编号；管理员通过私有记录补充映射。当前条件规则编辑为 JSON，尚未实现完整可视化条件编排器。

## 验证

`npm run check` 覆盖 lint、单元测试与 renderer 构建。相关功能检查另有 `scripts/sd2-fast-duration-smoke.cjs`、`configserver/admin-request-diagnostics-smoke.mjs` 及 `server/relay-error-gateway/` 中的 Node/Python 测试。桌面与后台 smoke 使用独立临时配置和模拟服务，不提交付费生成。

部署回执保留在 `output/rules-errors-*-deployed.json`、`output/rules-errors-*-hardened.json` 和 `output/sd2-remote-rules-published.json`。代码部署不修改已发布目录指针；回滚代码和回滚 CONFIG 版本是两项独立操作。
