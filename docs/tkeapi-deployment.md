# 视频中转站部署记录

## 2026-09-14 升级

- 站点：`https://art.ravenhash.org`；管理入口：`https://art.ravenhash.org/admin1688`。
- 部署：SSH 配置 `hk-direct`，`/opt/tokensbyte`。本次不涉及 `ai.ravenhash.org` 和独立 CONFIG 服务。
- 原前后端镜像分别构建于 2026-07-31 和 2026-07-30；升级到 TkeApi 发布版 `v20260908`。
- 安装来源：官方仓库 tag 对应提交 `ea58706fc3c000f554d36f2549d7d4ba8b7905df` 的 `dockerimage/tkeapi-offline-20260908_104821.tar.gz`。
- 安装文件 SHA256：`de0fa24de4e6a60db2ac4b6d891659cdce180538a479b1154f83384d289fb8d6`；Git blob：`0e1c442f3a4c0de2ce8eddc558c0f2de1b4ec1f0`。
- 新后端镜像：`corvas-relay/backend:v20260908`，ID `sha256:6428636a63a8810cfd48b3d373c91464d0677060d553e515e8dc9e8175b5d45f`。
- 新前端镜像：`corvas-relay/frontend:v20260908`，ID `sha256:2f2ed07d2d6acebd4e150d6f7a80da35684de343c67d05a71c48217dc636dda6`。
- 官方镜像内的构建提交为 `474c324553a5214ebb142215f3b2cf86553f8b6e`，构建日期 2026-09-08。后台关于页显示的 `v1.0.10` 是它自己的提交序号，并非发布 tag；判断版本应同时看日期、提交和镜像 ID。

## 保留的配置

保持原 `docker-compose.yml`、`.env`、数据库版本、网络、挂载与密钥不变，通过自动加载的 `docker-compose.override.yml` 固定新版前后端镜像，禁止自动拉取浮动版本。增加 `CORS_ORIGINS=https://art.ravenhash.org`。

已有 10 个启用模型、4 条渠道及关联的转发规则保留。新版迁移自动新增的三个 Doubao 模型保持停用，没有向客户上架新模型；原模型的 `feature_attributes` 保留，避免未经确认地改成首尾帧能力。

SD 双线路与 HM 的人民币售价不变：固定 30 秒双线路 6 元/次，`seedance_v2.5` 5 元/次，HM 933 / 101010 / 301010 分别为 6.5 / 7 / 10 元/次。原有账户、余额、API 令牌、渠道密钥、模型映射及汇率配置逐字段比较通过。

H3 计费规则 17 原有档位名称为 `786p`、`2k超分`、`4k超分`，与客户端发送的 `768p`、`2k`、`4k` 不匹配。新增这三个兼容别名，复制对应旧档位的单价、启用状态及其他属性；旧名称也保留，不修改历史任务含义或费用。

`seedance968-adapter`、`minimax-h3-adapter`、上传服务和 MinIO 未重建。服务器源码目录里的旧 `backend/src/relay/forward.rs` 本地修改已备份并保留；实际服务使用上述固定镜像，不要从这份旧源码执行 `--build` 覆盖新版。

## 核对结果

先在无外网的独立 Docker 网络中恢复数据库备份，运行新版迁移。迁移记录由 72 条增加到 204 条。通过模拟上游验证 SD 双线路、独立可调时长线路、三个 HM 规格，以及 H3 的 768p / 2k / 4k 提交和失败查询；错误原因保留，失败后模拟余额不变。没有向真实上游提交付费生成。

切换前确认没有未完成任务；停止入口与后端后再次备份，再升级和校正配置。切换窗口：2026-09-14 08:05:35 至 08:05:47 UTC，约 12 秒。

上线后验证公网健康接口、管理页面及 JS/CSS 资源均返回 200；鉴权模型列表仍为原 10 个模型。用已有成功和失败任务分别查询，原任务 ID 保留，成功返回 completed，失败带明确原因，账户余额未因查询改变。前后端与 PostgreSQL 健康，两个适配器容器 ID 未改变。

临时测试容器、独立网络及数据库副本已清理。此次没有重新发布 Corvas 安装包，也不代表客户旧安装包已包含本地尚未发布的错误提示修复。

## 运维与回退

备份目录：`/opt/tokensbyte-backups/upgrade-v20260908-20260914T075124Z/`，仅管理员可读。保留原始 `before.dump`、正式切换前 `cutover.dump`、部署文件与数据目录备份、旧二进制、镜像信息、配置快照、迁移比较和上线核对报告；目录内含私密配置，不上传仓库。

正常从 `/opt/tokensbyte` 运行 Docker Compose，会自动读取 override。显式指定文件时必须同时指定 `docker-compose.yml` 与 `docker-compose.override.yml`，否则可能重新启用旧镜像。

升级已执行数据库迁移。回退前先备份最新数据并停止业务写入，检查旧程序与现有数据库的兼容性；不能只换回旧镜像就认定回退完成，也不能拿升级前整库直接覆盖上线后的余额与任务。旧镜像以 `corvas-rollback/tokensbyte-backend:20260914T075124Z` 与 `corvas-rollback/tokensbyte-frontend:20260914T075124Z` 保留。
