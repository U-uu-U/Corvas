# Seedance 2.0 视频生成

更新时间：2026-10-13。本文适用于 `https://ai.ravenhash.org` 的 New API 接口。

## 模型与计费

- 模型名：`b_seedance_v2.0`。请求中保留完整拼写。
- 支持文生视频、图片参考生成视频。
- 视频时长固定为 **15 秒**，最多 **9 张参考图片**。
- 支持 `16:9` 横屏、`9:16` 竖屏；默认竖屏。
- 标准售价 **2 元/次**，按次计费，不按秒相乘。账号分组或优惠以站点实际账单为准。
- API Key 需要有 `Seedance 2.0` 分组的调用权限。可先查询 `GET /v1/models`，确认列表包含 `b_seedance_v2.0`。

## 接口

- Base URL：`https://ai.ravenhash.org/v1`
- 提交任务：`POST /v1/videos`
- 查询任务：`GET /v1/videos/{task_id}`
- 鉴权：`Authorization: Bearer YOUR_API_KEY`
- 提交格式：`Content-Type: application/json`

这是异步视频接口。提交后先取得任务 ID，再用相同账号查询结果；不是聊天或图片生成接口。
不要将其他站点的 `/v1/video/generations` 路径直接套用到本接口。

## 请求参数

- `model`：必填字符串，固定为 `b_seedance_v2.0`。
- `prompt`：必填、非空字符串。描述主体、动作、场景、镜头及参考图的用途。
- `seconds`：推荐显式填写整数 `15`。省略时按 15 秒处理，不支持 4、5、10、30 等其他时长。
- `aspect_ratio`：可选字符串，`16:9` 或 `9:16`，默认 `9:16`，不支持 `1:1`。
- `reference_images`：可选字符串数组，0～9 个图片 HTTP(S) 直链。文生视频时可省略。

兼容字段：`duration` 等价于 `seconds`，`ratio` 等价于 `aspect_ratio`；
图片也可使用 `image_urls` 或 `images`，数组元素支持 URL 字符串或 `{ "url": "..." }`。
建议每类参数只使用一种写法；同时传入多个别名时，内容必须一致。
单张参考图还可使用 `input_reference`，但不能和上述图片数组同时使用。

此模型不支持视频、音频参考。不要提交 `videos`、`video_urls`、`reference_videos`、
`audios`、`audio_urls` 或 `reference_audios`。当前接口没有可选择的输出分辨率，
不使用 `resolution`、`size` 指定 720p、1080p 或 4K。

参考图按数组顺序提交。提示词中的本地文件名不会自动上传；请将图片上传为可从公网读取、
在任务处理期间有效的直链，并描述“第 1 张参考图”“第 2 张参考图”的用途。
本接口使用 JSON，不接受本地路径、图片 Base64 或 multipart 文件上传。

## 文生视频示例

将以下内容保存为 `request.json`：

```json
{
  "model": "b_seedance_v2.0",
  "prompt": "一间明亮的现代展厅，镜头缓慢向前推进，窗外自然光照亮展台，画面稳定、运动连贯，无字幕。",
  "seconds": 15,
  "aspect_ratio": "16:9"
}
```

将 `YOUR_API_KEY` 替换为本站 API Key。以下命令只提交一次：

```bash
curl -sS "https://ai.ravenhash.org/v1/videos" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @request.json \
  -o submit.json
```

## 参考图示例

用以下内容替换 `request.json`。`example.com` 是示例地址，调用前必须换成实际图片直链。

```json
{
  "model": "b_seedance_v2.0",
  "prompt": "第1张参考图用于确定主体外观，第2张参考图用于确定场景。主体缓慢走入场景，保持外观一致，固定镜头，光影自然，动作连贯，无字幕。",
  "seconds": 15,
  "aspect_ratio": "9:16",
  "reference_images": [
    "https://example.com/subject.png",
    "https://example.com/scene.jpg"
  ]
}
```

使用上面的提交命令即可。添加参考图不会改变 15 秒时长，也不会改变按次计费方式。

## 查询与下载

1. 保存提交响应中的任务 ID，后续一直使用这个 ID。将它视为字符串，不要自行推算、截断或替换。
2. 将下面的 `TASK_ID` 替换为返回的 ID，以同一个 API 账号查询。建议每 5～10 秒查询一次。

```bash
curl -sS "https://ai.ravenhash.org/v1/videos/TASK_ID" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -o task.json
```

3. 任务排队或处理中时继续查询。成功完成后，从响应的 `video_url` 读取视频下载链接；
   失败时读取 `error`，保留任务 ID 和请求编号供排查。
4. 将返回的完整 `video_url` 替换到下面的命令中，包含链接原有的签名参数。尽快下载保存。

```bash
curl -fL "VIDEO_URL_FROM_RESPONSE" -o result.mp4
```

不要把提交或查询返回的 JSON 文件当作视频。签名下载链接无需附加 API Key，
也不要把 API Key 拼接到视频链接中。

## 常见问题

- **找不到模型或没有可用渠道**：核对完整模型名和 API Key 的分组权限；其他分组的 Key 不会自动获得本模型权限。
- **时长不支持**：`seconds` 或 `duration` 只能为 15。两者同时出现时必须一致。
- **比例不支持**：只支持 `16:9`、`9:16`，不要传 `1:1` 或“自适应”。
- **参考素材不符合要求**：图片最多 9 张，必须为可访问的 HTTP(S) 直链，不支持视频或音频参考。
- **内容审核拒绝**：按接口返回的原因检查提示词与参考图片，不能通过修改接口路径解决。
- **提交超时或连接中断**：结果可能尚未确认，先检查本站任务记录。有任务 ID 时继续查询原任务，不要自动重复提交。
- **查询暂时失败或尚无下载链接**：保留原任务 ID，稍后查询；一次查询失败不等于视频生成失败。

本文说明接口参数与调用方式，不承诺固定生成耗时、输出分辨率或具体生成效果。
