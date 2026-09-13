# EzPic

[English](README.md) | [简体中文](README.zh-CN.md)

EzPic 是一款注重隐私的 AI 图片编辑应用。用户先上传图片，再通过文字描述完成编辑。应用提供由服务端控制可用性的 9 种图片产品和 20 种产品规格组合，共用 EzPic Credit 积分余额，并在用户确认任务前展示准确的积分消耗。

项目复用已有的 AI 媒体基础能力，包括任务调度、积分账本、私有存储、内容审核、服务商接入、支付和管理后台。品牌、域名和联系方式通过部署配置提供。

代码具备面向生产环境的设计，但本地构建或模拟测试通过不代表所有外部服务已经完成验收。云账户、密钥、配额、支付回调、告警和负载验证需要分别保留证据。产品边界见 [EzPic 产品约定](docs/product/ezpic-product-contract.md)，部署状态见[生产环境状态记录](docs/operations/cloudflare-production-status.md)。

## 技术栈与部署结构

- **应用与界面：** Next.js App Router、React、TypeScript、Tailwind CSS、Base UI、next-intl。
- **接口与认证：** oRPC、Hono、Better Auth、Zod、TanStack Query。
- **数据库：** PostgreSQL、Prisma、Drizzle；PostgreSQL 是业务状态的唯一事实来源。
- **默认运行环境：** Cloudflare Workers、OpenNext、Workflows、Durable Objects、Hyperdrive 和 Cloudflare Images。
- **私有媒体存储：** 生产环境使用私有 R2，本地开发可使用兼容 S3 的 MinIO。
- **开发工具：** Node.js 22+、pnpm 11、Turborepo、Vitest、Playwright、Oxlint、Oxfmt。

网站、公开内容、访客工作区、登录后的产品功能和 `/docs` 都由 `apps/saas` 提供。默认 `workers` 部署方案使用 Workflows 编排任务，并由私有 Durable Object 执行后台处理；可选的 `hybrid` 方案使用相同的网站运行环境，将后台执行交给 Node Container 和 Sharp。

Supabase 在部署中只承担 PostgreSQL 数据库服务，认证仍由 Better Auth 处理，媒体仍存放于私有 R2。部署方案和运行边界详见 [Cloudflare Workers 部署指南](docs/operations/cloudflare-workers-profiles.md)。

## 图片编辑流程

登录后的 `/create` 工作区可以恢复符合条件的草稿、历史任务或用户自己的素材。提交编辑需要一张归属当前用户且状态为 `READY` 的私有图片，以及非空的编辑描述；可选产品和设置由服务端返回。

1. **查看报价：** 服务端生成本次编辑的积分报价，此时不预留积分。
2. **确认任务：** 使用稳定的幂等键，在同一个数据库事务中创建任务、绑定输入、预留积分并写入 Outbox 事件。
3. **查看结果：** 页面在刷新后继续跟踪任务，展示成功、失败、审核、取消和积分结算状态。对比视图只展示当前任务的输入和审核通过的输出。
4. **继续编辑：** 从符合条件的成功版本发起新编辑，重新经过报价、审核、积分预留和任务创建流程。

图片预览和下载通过有时效限制、且校验所有者权限的地址提供。套餐不支持当前产品时，页面保留已上传图片、描述、产品、输出设置和编辑会话，再打开套餐比较界面。

首次确认编辑会在同一个事务中创建编辑会话。`/edits` 展示当前用户的会话，`/edits/[sessionId]` 展示可追溯的版本时间线。每次“再次编辑”都使用新的报价、审核结果、积分预留、幂等键、任务和 Outbox 事件。

父版本与编辑会话由服务端固定在报价中，确认时不能替换。失败重试同样创建新的任务和结算记录，并保持原有会话及分支关系；恢复流程会拒绝丢失这类关联的结果。

## 套餐、积分与支付

`PLAN_ENTITLEMENTS` 统一控制价格界面，以及运行时的产品权限、并发数和上传大小限制。

| 套餐     | 每月积分 | 并发编辑数 | 可用产品              | 最大上传大小 | 价格（美元）    | 每月可编辑图片数 |
| -------- | -------: | ---------: | --------------------- | -----------: | --------------- | ---------------: |
| Free     |       25 |          1 | Nano Banana 2 Lite    |        10 MB | 免费            |                5 |
| Pro      |      700 |          3 | 全部 9 种公开图片产品 |        20 MB | $19/月，$190/年 |           28–140 |
| Ultimate |    1,800 |          6 | 全部 9 种公开图片产品 |        20 MB | $49/月，$490/年 |           72–360 |
| Max      |    3,000 |         10 | 全部 9 种公开图片产品 |        20 MB | $79/月，$790/年 |          120–600 |

付费套餐的图片数量范围按照每次合法产品规格组合消耗 5–25 积分估算。输出格式和背景设置不改变这项费用。

免费积分由服务端通过不可变的积分账户、积分批次和账本流程发放，每个 UTC 自然月一次，并使用稳定的业务引用键避免重复发放。处于 `ACTIVE` 状态的付费订阅，或仍在有效宽限期内的 `PAST_DUE` 订阅，不会同时领取免费套餐积分。月付和年付订阅均沿用内部按月的积分周期、回调幂等处理、退款、欠款和失败结算规则。

### 积分包

积分包在购买六个月后过期。有效订阅用户购买同价积分包可获得额外 20% 积分。

| 积分包       | 基础积分 | 有效订阅用户所得积分 | 价格（美元） | 有效期 |
| ------------ | -------: | -------------------: | -----------: | ------ |
| Credits 1500 |    1,500 |                1,800 |          $59 | 6 个月 |
| Credits 3000 |    3,000 |                3,600 |         $109 | 6 个月 |
| Credits 5000 |    5,000 |                6,000 |         $169 | 6 个月 |
| Credits 8000 |    8,000 |                9,600 |         $259 | 6 个月 |

### 支付接入与回调

新订阅和积分包结账支持 PayPal 与 Waffo Pancake。启用支付时，至少需要一组完整的服务端支付凭据；每个可售套餐、计费周期和积分包还需要对应的服务商商品或套餐 ID，以及有效的 `BillingPlan` 快照。

浏览器只提交稳定的支付渠道名称、产品选择、计费周期和幂等键。支付返回页面轮询服务端持有的回调处理状态，不自行发放积分。所有已启用的支付渠道都通过 `PaymentEvent` 和 Outbox 保存已验证的事件，再由后台处理业务状态。

Stripe 仅用于维护历史订阅，包括账单门户、取消、退款、回调和对账，不提供新的结账入口。两项 Stripe 密钥都未配置时会跳过历史对账；只配置其中一项时会拒绝继续处理；完整配置后保留历史订阅维护能力。

积分包退款能力因支付渠道而异：经过验证的 PayPal 退款可以按累计退款比例幂等扣回积分；Waffo 的 `refund.succeeded` 和 `refund.failed` 目前进入人工 `REVIEW`，不会自动修改积分账本、购买、履约或调整记录。测试环境的验证结果与真实收款启用状态需要分别确认。

- [PayPal 测试支付配置](docs/operations/paypal-test-payments.md)
- [Waffo 测试支付配置](docs/operations/waffo-test-payments.md)
- [套餐定价与利润记录](docs/product/ezpic-pricing-and-margin.md)

## SEO、产品事件与管理后台

统一的 SaaS 应用负责所有公开路由。`/`、`/pricing`、`/privacy` 和 `/terms` 可以被搜索引擎索引，并出现在同域名站点地图中。博客、更新日志、联系页、文档、登录、访客工作区、编辑器、历史记录、素材、结账、设置和管理路由不在可索引集合内。`NEXT_PUBLIC_SAAS_URL` 是唯一的公开规范域名来源。

18 步编辑流程事件共用严格的数据结构。PostHog 产品事件受现有 Cookie 同意机制控制：只有获得同意且生产配置完整时，浏览器才发送最小化事件，并使用 `sha256:` 匿名会话标识。提示词、文件名、私有或签名地址、原始任务或素材 ID、邮箱、令牌、服务商与模型成本数据，以及原始响应都不能进入该事件传输流程。公开页面通过同源 POST 传递匿名标识，避免放入 URL。

管理后台通过仅限管理员的 oRPC 接口和 PostgreSQL 查询，提供只读汇总信息，包括任务成功率、耗时、服务商成本、审核、失败、积分结算、再次编辑、路由和功能开关状态。

完整索引范围、事件列表、指标和验证要求见[增长、SEO 与运维约定](docs/product/ezpic-growth-operations.md)。

## 本地开发

准备 Node.js 22+、pnpm 11 和 Docker。将 `.env.local.example` 复制为 `.env.local`，配置本地数据库连接、`BETTER_AUTH_SECRET` 和本地应用地址。OAuth、邮件、支付、存储和 AI 的凭据按需要配置；本地模拟适配器只能用于测试环境。

```bash
docker compose up -d
pnpm install --frozen-lockfile
pnpm db:migrate:deploy
pnpm dev
```

默认本地数据库地址为 `postgresql://postgres:postgres@localhost:5432/supastarter`。启动前应确认 `.env.local` 指向本地数据库，因为迁移命令会操作该配置对应的数据库。

应用运行于 [http://localhost:3000](http://localhost:3000)。根目录的 `dev`、`build` 和 `start` 只启动或构建 SaaS 及其依赖任务；需要邮件预览时，单独启动 `apps/mail-preview`。

本地媒体使用 `MEDIA_BUCKET_NAME` 指定的私有存储桶，默认示例为 `media-private`。不要使用旧的 `S3_BUCKET` 变量。密钥保存在被 Git 忽略的本地环境文件中；只有需要公开给浏览器的配置才使用 `NEXT_PUBLIC_` 前缀。

### 本地缓存维护

Git 已忽略 `.turbo` 和 `.next`，`.dockerignore` 也将它们排除在容器构建上下文之外。Turbo 的构建输出排除了 `.next/cache/**` 和 `.next/dev/**`，避免把开发缓存反复打包到每份生产构建缓存中。

这条规则减少重复存储，但不会清除历史缓存，也没有设置自动容量上限。缓存占用较大时，先停止当前项目的开发、构建和测试进程，再从仓库根目录运行：

| 命令                 | 用途                                   |
| -------------------- | -------------------------------------- |
| `pnpm cache:preview` | 查看三个缓存目录及其文件大小，不删除   |
| `pnpm cache:clean`   | 检查范围和运行锁后，清理这三个缓存目录 |

清理范围固定为：

- `.turbo/cache`
- `apps/saas/.next/cache`
- `apps/saas/.next/dev/cache`

脚本会拒绝目录链接、包含 Git 跟踪文件的缓存，以及存在 Next.js 开发或构建锁的情况。源码、依赖、工作树、环境文件和上述目录以外的生产构建产物不会被清理。清理后首次编译需要重新生成缓存，耗时可能增加；统计的文件大小也不一定等于实际释放的磁盘空间。

日常缓存维护使用这两个专用命令。`pnpm clean` 还会删除工作区依赖及生成产物，不适合作为只清缓存的命令。项目没有安装定时清理任务。

## 验证与测试

验证范围应与改动影响相符。小范围文案、样式或配置修改只检查相关文件或工作区；跨工作区修改、认证、支付、数据库、并发、安全和发布验收再运行完整检查。

以下命令覆盖代码质量、类型、业务约定、集成测试、媒体端到端流程和发布证据校验：

```bash
pnpm lint --deny-warnings
pnpm format:check
pnpm type-check
pnpm test:unit:contracts
pnpm test:integration
pnpm e2e:media:ci
pnpm verify:invariants
pnpm launch:evidence:validate
pnpm load:ezpic:syntax
pnpm load:type-check
```

PostgreSQL 集成测试必须显式配置指向本机回环地址的 `TEST_DATABASE_URL`，且数据库名称包含 `test` 或 `testing`；不会回退使用 `DATABASE_URL`。模拟端到端测试需要测试数据库、测试用户、Chromium 和测试适配器。

本地浏览器测试覆盖公开首页与访客转入登录后的流程、图片编辑生命周期、私有编辑会话和分支、积分不足、升级后的恢复、结账返回，以及 SEO 与站点地图边界。测试使用确定性的模拟 AI 和审核适配器、隔离 PostgreSQL 和本地 MinIO；这些结果不能替代真实支付、AI、审核或云存储验证。

### 负载测试

可用负载方案包括 `smoke`、`steady`（每分钟 200 个任务，持续 30 分钟）、`peak`（每分钟 400 个任务，持续 5 分钟）和 `active-1000`。

```bash
pnpm load:ezpic
pnpm load:media
pnpm verify:invariants
```

`pnpm load:ezpic` 默认只输出受约束的计划。实际执行需要满足相应命令的执行确认要求；远程目标还需要 `ALLOW_REMOTE_LOAD_TARGET=true`、精确匹配的 `LOAD_TARGET_CONFIRMATION`、HTTPS、允许列表以及预发布环境身份。`pnpm load:media` 依赖 k6，应先阅读[负载测试说明](tests/load/README.md)。

模拟测试、计划输出和语法检查不代表负载验收通过。高峰、持续负载和 `active-1000` 场景需要在专门的预发布等效环境执行并记录结果。

### AI 图片编辑基准测试

```bash
pnpm provider:benchmark:image-edit
```

该命令默认读取仓库中的占位清单，规划 30 个图片编辑任务，不调用真实 AI 服务商。真实质量、耗时、成本、成功率和路由判断保留为 `NOT_COMPLETED`。

真实执行还需要 `--live`、`--confirm-spend`、大于零的 `--max-budget-micros`、已授权的私有清单和服务商凭据，并通过现有的私有生成、远程 URL 校验、存储及审核链路执行。详见[图片编辑模型基准报告](docs/product/image-edit-model-benchmark.md)。

真实服务商冒烟测试不属于常规 PR CI。受保护的 `Provider smoke` 工作流会先验证全部 20 个产品规格组合、最大调用次数和总体预算上限，再发起调用。

## 部署与上线验收

默认使用 `EZPIC_DEPLOYMENT_PROFILE=workers`；可选的 `hybrid` 只改变后台执行方式。生产配置放在被忽略的 `.env.production.local` 中，预发布配置放在 `.env.staging.local` 中。

```bash
pnpm cloudflare:prepare production
pnpm cloudflare:web:build
pnpm cloudflare:jobs:build
```

`hybrid` 方案还需要对应的 Container 构建条件，参见部署指南中的 `pnpm workflows:build:ci`。以上准备和构建命令不会自动完成部署或验收。最终网站打包使用 Linux 或 WSL，并保留项目的构建包装流程；原生 Windows 的 pnpm 目录链接可能导致打包失败。

Hyperdrive 连接现有 PostgreSQL 时需要校验 TLS，并关闭查询缓存。源数据库凭据保存在 Hyperdrive 中；生成的部署配置和密钥文件保持被 Git 忽略。网站与后台 Worker 共用至少 32 字符的随机 `WORKFLOWS_DISPATCH_SECRET`，生产环境的 `WORKFLOWS_DISPATCH_URL` 必须是 HTTPS，并包含 `/internal/dispatch`。

数据库迁移在部署应用前执行，不在应用启动时自动执行。图片、支付、邮件、审核和 AI 凭据保持服务端私有；生产环境禁止模拟适配器，并通过独立开关控制图片生成、访客生成和支付。

发布证据校验使用环境矩阵、场景验证记录和部署版本：

```bash
pnpm launch:evidence:validate
pnpm launch:certify
```

仓库中的占位证据允许保留 `NOT_COMPLETED`。正式认证要求部署版本、预发布场景、隔离资源、功能开关、预算、告警和外部服务约定全部通过。应分别记录真实数据库、后台任务部署与恢复、支付回调、已启用的 AI 路由、内容审核、私有媒体传输、监控告警、邮件、DNS/SSL、负载和回滚证据；维护历史 Stripe 订阅的环境还需要验证 Stripe 回调。

- [Cloudflare Workers 与混合部署方案](docs/operations/cloudflare-workers-profiles.md)
- [生产环境状态记录](docs/operations/cloudflare-production-status.md)
- [生产运行手册](docs/operations/ezpic-production-runbook.md)
- [上线检查清单](docs/operations/ezpic-launch-checklist.md)
- [回滚流程](docs/operations/ezpic-rollback.md)
- [最终成本模型](docs/product/ezpic-final-cost-model.md)

## 基础能力与运维约束

- **服务端产品目录：** 客户端提交稳定的公开产品键和合法参数；模型 ID、服务商路由、凭据、成本、原始响应和任意远程地址留在服务端。
- **持久化任务：** PostgreSQL 保存业务事实。任务创建、输入绑定、积分预留和首个 Outbox 事件在同一事务中提交；Workflows 负责投递与恢复编排。
- **可追溯积分：** 使用不可变账本和带到期时间的积分批次，实现幂等预留、扣费、释放、订阅发放、退款和欠款处理。
- **私有媒体：** 校验所有者、上传大小、分片与存储配额；使用限时授权地址和流式传输，并保留审核隔离、软删除与对象清理流程。
- **不确定状态保护：** 无法确定服务商是否已接收任务时，继续保留积分预留；经过恢复流程或有审计记录的管理员决策前，不自动切换服务商或取消任务。
- **运行控制：** 保留生成、支付、审核和路由开关，日志脱敏，结构化监控，以及回放、对账、重试、备份恢复、密钥轮换和事故处理流程。

完整运维主题见 [AI 媒体运行手册](docs/operations/ai-media-runbook.md)。涉及运行环境时，以当前 [Cloudflare 部署指南](docs/operations/cloudflare-workers-profiles.md)为准；历史基础文档中的 Trigger.dev 部署说明不能直接套用于当前 Workers 方案。
