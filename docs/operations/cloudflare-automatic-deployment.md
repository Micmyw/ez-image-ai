# Cloudflare 原生 Git 自动部署配置

在 Cloudflare 中，将现有的两个生产 Worker 连接到 GitHub 仓库 `Micmyw/ez-image-ai`。
连接完成后，每次推送 `main`，Cloudflare 都会自动构建并部署对应服务。应用列表会显示
关联的 GitHub 仓库，构建页面可以查看日志和对应提交。GitHub Actions 继续独立执行代码检查。

## 一、打开现有服务的 Git 配置

进入 Cloudflare 控制台的 **Workers 和 Pages**，点击要配置的现有服务，再进入
**设置 → 构建 → 连接 Git**。如果控制台显示英文，对应入口是
**Workers & Pages → Settings → Build → Connect Git**。

选择 GitHub 账户 `Micmyw` 和仓库 `ez-image-ai`。如果看不到这个私有仓库，需要在 GitHub
已安装的 Cloudflare 应用中，将 `ez-image-ai` 加入该应用可访问的仓库范围。

网站服务和后台任务服务都要各配置一次。两者的根目录均为 `/`，因为 pnpm 工作区、锁文件、
共享包和部署准备命令都位于仓库根目录。

## 二、填写构建和部署设置

| 配置项         | 网站服务                                                              | 后台任务服务                                                       |
| -------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 现有服务名称   | `ezimageai-site-production`                                           | `ezpic-workflows-workers-production`                               |
| GitHub 仓库    | `Micmyw/ez-image-ai`                                                  | `Micmyw/ez-image-ai`                                               |
| 生产分支       | `main`                                                                | `main`                                                             |
| 根目录         | `/`                                                                   | `/`                                                                |
| 构建命令       | `pnpm install --frozen-lockfile && pnpm cloudflare:git:build website` | `pnpm install --frozen-lockfile && pnpm cloudflare:git:build jobs` |
| 部署命令       | `pnpm cloudflare:git:deploy website`                                  | `pnpm cloudflare:git:deploy jobs`                                  |
| 非生产分支构建 | 关闭                                                                  | 关闭                                                               |

旧服务 `ezimageai-web-production` 和 `ezpic-workflows-production` 保留用于回滚，不连接此次
自动部署。后续发布会更新上表中的两个现有服务，每次发布的版本记录可在各服务的
**查看部署**页面中找到。

## 三、填写构建变量和机密

在两个服务各自的 **构建变量和机密** 中填写：

| 名称                        | 类型     | 值或来源                                                                          |
| --------------------------- | -------- | --------------------------------------------------------------------------------- |
| `NODE_VERSION`              | 普通变量 | `22`                                                                              |
| `PNPM_VERSION`              | 普通变量 | `11.3.0`                                                                          |
| `CLOUDFLARE_PRODUCTION_ENV` | 机密     | 经核对的生产环境配置全文，采用 dotenv 格式，以本地 `.env.production.local` 为来源 |

变量名称必须保持原样。生产环境配置含有密钥，只填入 Cloudflare 的机密输入框，不提交到
Git，也不粘贴到聊天中。构建变量与服务运行时变量是两套设置，仓库中的部署命令会根据上述
配置生成并应用对应的运行时机密文件。

部署令牌选择 Cloudflare 托管的构建 API 令牌，或选择已有且适用于当前生产账户的令牌。
Cloudflare 默认生成的令牌包含 Workers 脚本、Workers 路由、KV、R2 的编辑权限，以及账户和
用户的读取权限。后台任务部署还需要更新现有 Workflow 和使用 Hyperdrive 的相应权限。
此流程无需在 GitHub Actions 中配置部署令牌。

保存 Git 连接可能立即触发第一次构建。应先确认命令已推送到 `main`，并处理下文的生产配置
前置条件，再保存连接。之后每次推送 `main` 都由 Cloudflare 自动执行构建和部署。

## 四、命令会执行哪些操作

- 仅接受 `workers` 部署模式。在 Cloudflare 中检查 `WORKERS_CI_BRANCH=main`，并确认检出的
  提交与 `WORKERS_CI_COMMIT_SHA` 一致。
- 复用现有生产环境准备流程，保留功能开关和资源绑定。
- 生成 Node 和 Workers 使用的 Prisma 客户端，通过验证 TLS 的连接执行只读
  `prisma migrate status`。待执行的数据库迁移需要单独处理，构建过程不修改数据库结构。
- 在 Linux 环境通过项目的 OpenNext 构建入口打包网站。网站构建子进程只接收允许公开的
  配置，以及占位的数据库和认证值，不继承生产配置全文或 Cloudflare API 令牌。
  同时移除 OpenNext 内嵌的 dotenv 回退配置。
- 网站发布前先填充远程 R2 缓存；使用生成的机密文件部署对应服务，并将当前提交 SHA 作为
  版本标签。
- 检查线上版本标签和 100% 流量归属。网站还会检查 `/api/health`、`/`、`/docs`、`/create`
  是否返回 HTTP 200。

两个服务的原生构建独立运行，没有保证的先后顺序，也不是一次共同成功或失败的操作。
如果一个成功、另一个失败，应修复错误后重试同一提交，并确保这段时间内网站和后台任务
能够兼容。混合模式切换和回滚方式见[部署模式操作说明](cloudflare-workers-profiles.md)。

## 五、当前首次发布的前置条件

扩展后的模型目录版本是 `2026-09-13.1`。2026 年 9 月 14 日检查本地生产配置时，生图功能
处于开启状态，但 `MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS` 仍为旧版本 `2026-09-07.2`。
这种情况下，构建会在修改线上 Worker 之前报错 `PRODUCTION_CATALOG_NOT_CERTIFIED`，防止
部署后没有可实际执行的模型。

需要先按照[AI 生图运行手册](ai-media-runbook.md)核对已启用模型各项输出规格的真实执行、
计费、输出来源、审核、恢复和回滚证据，再将当前目录版本加入生产环境的认证列表。
构建命令不会自动认证新模型，也不会自动修改这些开关。本地模拟测试通过，不代表真实付费
生图、支付履约、供应商计费或游客安全验证已经完成。

官方参考：[Cloudflare Workers 构建配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)。
