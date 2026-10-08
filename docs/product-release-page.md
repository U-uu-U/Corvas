# Corvas Product Release Page

新站产品发布页：`https://cart.ravenhash.org/corvas`。当前下载版本 `1.6.0-beta.13`，来自源提交 `84ba510ab133357625f984db9cdc15623c9b7cda`，Windows 和 macOS 构建均已通过验证。

老站同款封面：`https://art.ravenhash.org/corvas`。老站由独立的 `/corvas` 路由代理新站发布服务，下载、版本 API 和静态资源均保持老站域名，两站共用一个版本源。“API 控制台”使用相对根路径，仍进入各自的站点。

## Service

- 主机：cart `154.12.57.129:26098`，SSH 凭据从 `FLOW_TASK_SSH_PASSWORD` 读取，不写入源码。
- 服务：`corvas-release-page`，独立用户 `corvasrelease`，仅监听 `127.0.0.1:18091`，由 Caddy 精确代理 `/corvas` 和 `/corvas/*`。
- 代码：`/opt/corvas-release-page/`，依赖只使用 Node 内置模块。
- 版本文件：`/var/lib/corvas-releases/releases/<version>/`。每个版本含安装包及 `release.json`；`current.json` 指向当前版本。
- 发布页由后端渲染，无需前端构建；功能说明、更新记录、安装文件的版本与大小均连接真实数据。
- 现有中转站 `/v1/*`、管理后台及银行等其它域名路由保持原有处理。
- 老站镜像部署：`python -B scripts/deploy-release-page.py --site art --mirror`。使用既有 SSH 密钥连接 `45.192.100.246:24775`，只修改并 reload Caddy 的发布页路由。向新站转发时剥除 Cookie、Authorization、Proxy-Authorization 和 X-Api-Key；发布服务无须用户凭据。镜像依赖新站发布服务可用，不另外存储一套安装包。

## HTTP

- `GET /corvas`：功能和下载页。
- `GET /corvas/api/latest`：公开的版本、发布时间、更新说明、平台安装包路径、精确字节数和 SHA-256；支持 ETag。
- `GET /corvas/SHA256SUMS.txt`：校验文件。
- `GET|HEAD /corvas/releases/<version>/<filename>`：只开放 manifest 中的安装包，支持单段 Range/断点续传，版本路径不可覆盖。
- `GET /corvas/health`：服务状态。没有匿名写入或上传接口，不读取 API Key、用户数据或账务库。

## Publish

确认两个平台来自同一个提交、测试通过，准备本地 `build-provenance.json` 和安装文件，按实际构建内容填写更新说明 JSON 数组，然后执行：

```powershell
python -B scripts/deploy-release-page.py --deploy --release-dir release/v1.6.0-beta.13 --notes-file server/release-page/notes-beta13.json
```

脚本核对本地文件及远端上传后的 SHA-256，完整上传才原子切换 `current.json`。版本已存在时必须与原文件和说明完全一致；禁止用相同版本号替换不同文件。新版本重复使用同一入口即可，页面和 API 随 current 指针读取最新数据。此脚本不自动跟随 GitHub 草稿，不重新构建安装包。

本地上传较慢时加 `--from-github`：本地验证构建 run 的提交和成功状态，仅将短期签名下载地址交给服务器，服务器直接拉取已指定版本的构建产物，校验归档和各安装包 SHA-256。不把 GitHub Token 存在服务器。

部署前备份代理、服务及 current 指针到 `/var/backups/corvas-release-page-*`，回执存于本地 `output/release-page-deployed.json`。回滚时恢复备份的 current 指针/服务文件和代码，重启此独立服务；若撤销路由，再恢复对应 Caddyfile 并验证后 reload。无需重启生成中转服务。

此页目前用于产品下载；此前客户端在线更新功能仍使用 GitHub 发布源，且未包含在 beta.13 安装包中。不要将产品页上线表述为旧客户端已获得自动更新能力。

线上验证：`scripts/release-page-smoke.cjs` 默认检查新站，设置 `CORVAS_RELEASE_TEST_SITE=art` 检查老站；验证桌面/手机布局、安装包 HEAD/Range、字节匹配，以及原 API 仍要求鉴权。
