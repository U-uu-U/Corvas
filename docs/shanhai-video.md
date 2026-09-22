# 山海视频渠道

山海渠道使用独立的公开 API 协议，不是 OpenAI 兼容的视频路径。

- Base URL：`https://shanhai.vnshu.cn/api/v1`
- 鉴权：`Authorization: Bearer oc_live_...`
- 创建：`POST /generations`
- 查询：`GET /tasks/{taskId}`
- 下载：使用任务返回的 `output.url`，并携带同一枚 Bearer Key

本次加入「备用分组2」的模型如下：

| 模型 | 山海 API ID | 前端售价 |
| --- | --- | --- |
| dola（9图15秒） | `oc-model-qbdmeb` | ¥4/次 |
| sd-2.0（官渠）-极稳 | `oc-model-1iq31f` | ¥5/秒 |
| S-2.0 官转933 | `oc-model-bkb50q` | ¥7/次 |
| S-2.0 满血933（不卡人脸） | `oc-model-c6ws7e` | ¥7/次 |

API 请求使用文档规定的 `media_type: "video"`、`inputs` 和 `options` 字段。图片和视频输入必须是山海服务器可访问的 HTTPS 地址；本地素材会先经过临时公开上传。音频参考按山海的 `POST /uploads/audio` 上传，限制 25MB、MP3/WAV。

API Key 不写入源码、默认配置或前端构建产物。首次使用时，在 Corvas 设置的 API 表单选择「Shanhai Video」，确认端点为 `https://shanhai.vnshu.cn/api/v1`，填入账户中心创建的 `oc_live_...` Key，并保留四个模型 ID。没有 Key 时，模型可以显示在目录中，但提交会明确提示未配置 Key。

任务结果不明时不会自动重新提交；保留任务 ID，恢复操作只查询原任务。失败、轮询超时和鉴权下载错误均不会把结果当成成功产物。
