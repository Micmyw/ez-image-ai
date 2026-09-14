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

| 名称                                            | 类型     | 值或来源                                                           |
| ----------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `NODE_VERSION`                                  | 普通变量 | `22`                                                               |
| `PNPM_VERSION`                                  | 普通变量 | `11.3.0`                                                           |
| `CLOUDFLARE_PRODUCTION_ENV`                     | 机密     | 短配置可直接使用 dotenv 全文；长配置使用下述命令生成的分段校验信息 |
| `CLOUDFLARE_PRODUCTION_ENV_PART_1` 至 `_PART_N` | 机密     | 长配置的各个分段，由下述命令生成                                   |

Cloudflare 单个构建变量最多接受 5,000 字符。生产配置超过这个限制时，在仓库根目录执行：

```powershell
pnpm cloudflare:git:secrets
```

命令默认读取 `.env.production.local`，将待写入的变量映射保存到被 Git 忽略的
`.wrangler/ci/build-variables.json`。也可以在命令后指定另一个经过核对的生产配置文件。
生成的每段最多 4,500 字符，全部标记为机密；主变量保存分段数量和完整性校验值。
构建会先还原原始 dotenv 内容并验证完整性，缺段或内容不匹配都会停止。

自动配置时，将生成的 JSON 作为 Cloudflare 构建变量 API 的请求体，分别写入两个服务：
`PATCH /accounts/{account_id}/builds/triggers/{trigger_uuid}/environment_variables`。
该文件含生产密钥，不属于可公开的配置示例。准备命令只生成文件，不修改 Cloudflare。

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
  配置，以及占位的数据库、认证和邮件值，不继承生产配置全文、任何机密分段或 Cloudflare API 令牌。
  同时移除 OpenNext 内嵌的 dotenv 回退配置。
- 网站发布前先填充远程 R2 缓存；使用生成的机密文件部署对应服务，并将当前提交 SHA 作为
  版本标签。
- 检查线上版本标签和 100% 流量归属。网站还会检查 `/api/health`、`/`、`/docs`、`/create`
  是否返回 HTTP 200。

两个服务的原生构建独立运行，没有保证的先后顺序，也不是一次共同成功或失败的操作。
如果一个成功、另一个失败，应修复错误后重试同一提交，并确保这段时间内网站和后台任务
能够兼容。混合模式切换和回滚方式见[部署模式操作说明](cloudflare-workers-profiles.md)。

## 五、模型验收与发布前检查

发布检查按实际启用的模型判断，与网站运行时使用相同规则。未满足验收条件的启用模型会在
修改线上 Worker 之前报错 `PRODUCTION_CATALOG_NOT_CERTIFIED`，错误中列出对应产品。

目录 `2026-09-13.1` 对原有 Nano Banana 2 Lite、Seedream 4.5、Seedream 5 Lite 和
Seedream 5 Pro 保留 `2026-09-07.2` 的既有生产启用范围。2026 年 9 月 14 日已重新核对
这四个模型的真实成功任务、积分结算和全部 8 档输出的供应商参数；具体记录与未完成项目见
[目录兼容性复核](evidence/kie-catalog-compatibility-2026-09-14.md)。生产认证列表无需改成
新版本，新增或其他未复核模型不能使用这条兼容规则，后续目录版本也不会自动继承。

新增模型仍需按照[AI 生图运行手册](ai-media-runbook.md)核对真实执行、计费、输出来源、
审核、恢复和回滚证据。构建命令不会填写认证版本或修改功能开关。需要调整生产配置时，
更新本地忽略文件、重新生成分段机密，并同步到两个服务的构建变量。

官方参考：[Cloudflare Workers 构建配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)。
