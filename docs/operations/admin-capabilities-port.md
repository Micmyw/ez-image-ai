# 管理能力融合与迁移审查

参考来源：`Micmyw/shipany-tanstack-template` 固定提交
`36cfedac57fb6bffb35032119a49d025c6962c5c`。附件指南是用户提供的本地文档，
不在该提交内；业务源码使用固定提交只读核对。没有合并源项目历史、复制源环境或数据。
目标开始开发前已按用户要求快进更新至 `67cb174dd12e506921f6e858279043ff5b97dd2f`。

## 目标盘点与适配结果

| 能力         | 原有基础与证据                                                                                                                     | 新增和适配                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 统计         | `packages/auth/lib/registration-attribution.ts`、`packages/database/prisma/queries/payment-attribution.ts`、现有结账/付款/退款记录 | `packages/database/shared/admin-analytics*.ts`、Prisma/Drizzle 查询、`packages/api/modules/admin-analytics`；概览、cohort 与周期报表独立   |
| 机器人与客服 | `packages/notifications/src/create-notification.ts`、两种 payment processor；原反馈仅 mailto                                       | `packages/notifications/src/admin-bots`、`packages/api/modules/support`、`admin-support.ts`；真实工单与加密配置                            |
| Agent        | Better Auth `user.role=admin`、Hono/oRPC、既有 AuditLog                                                                            | `packages/api/modules/admin-agent`、`admin-access.ts`、独立服务账号/key/执行日志、stdio 和可分发 Skill                                     |
| 退款与积分   | 现有 `refund-reducer.ts`、`refund-termination.ts`、credit lots/ledger、Image Pass                                                  | `packages/payments/provider/admin-refunds*`、`packages/database/prisma/queries/admin-{refunds,credits}.ts`；持久退款命令、提供方核验与恢复 |

开发前的判断：

- **已有**：真实注册/归因、结账意图、订阅/账期、积分与权益账本、退款事件投影、管理员角色和组织边界。
- **缺少**：完整注册 cohort 报表、四通道后台机器人配置与测试、持久客服工单、
  独立管理机器身份与多协议执行面、主动整单退款及独立人工扣分入口。
- **需适配**：来源是 TanStack/Drizzle，目标是 Next.js/oRPC/Prisma；目标多租户、
  micros 金额、年付多账期、Waffo 异步退款、积分债务和 Image Pass 必须沿用目标实现。

固定快照的主要对应关系如下；这些是业务参考，不是复制文件：

| 来源入口                                                                                             | 目标实现                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/analytics/service.ts`                                                                   | `packages/database/shared/admin-analytics.ts`、`admin-analytics-reader.ts` 和 `packages/api/modules/admin-analytics`                                                                |
| `src/core/notify/index.ts`、`src/modules/notify/service.ts`、`src/modules/config/service.ts`         | `packages/notifications/src/admin-bots`、`packages/database/prisma/queries/admin-bots.ts`                                                                                           |
| `src/lib/admin-operations.ts`、`src/server/admin/*`、`src/modules/admin-access/service.ts`           | `packages/api/modules/admin-agent`、`packages/database/shared/admin-agent-contracts.ts`、`packages/database/prisma/queries/admin-access.ts`                                         |
| `src/modules/payment/service.ts::refundOrder`、`src/modules/credits/service.ts::planDeductForRefund` | `packages/payments/provider/admin-refunds.ts`、`packages/api/modules/admin-billing/service.ts`、`packages/database/prisma/queries/admin-{refunds,credits}.ts`，复用既有退款 reducer |

后台页面在 `/admin/analytics`、`/admin/payments`、`/admin/notifications`、
`/admin/support`、`/admin/agent`；客户工单在登录后的 `/settings/support`。
使用既有保留的 settings 路径，避免抢占历史组织的单段 slug。
继续使用当前 Next.js、Base UI、next-intl 和 oRPC，不更换产品页面、定价或登录。

## 统计定义

- 人数来自真实非匿名用户；服务身份使用独立表，不会产生普通注册。
- first-touch UTM 保留现有可选同意和 30 天 cookie。新增 term/content；
  国家只在注册时从已信任的托管代理读取，标明 `registration_proxy`，
  不相信客户端提交的国家，不为归因保存 IP，也不伪称首次访问国家。
- 缺少历史来源为 unknown；空字符串表示已记录的直接/未标注来源；未传过滤项表示全部。
- cohort 使用窗口内注册的去重用户，跟踪该注册群截至查询时的 checkout/首次成功付款；
  排除续费，退款后仍保留历史支付转化。
- 周期报表使用各事件实际时间，支持带时区的 from/to、最多 92 天和上一等长周期比较。
  零分母返回 null。概览 30 天净收入按付款窗口选中订单后减其已确认退款；
  周期报表按退款发生时间扣减，二者不能相互替代。
- 默认只计生产付款，测试环境可明确切换；付款环境、支付时间或初次/续费证据
  不足的历史记录单列覆盖缺口。年付的多个月度积分投影只算一笔付款。
  金额统一精确 micros 字符串并按币种分组，绝不把不同币种相加。
- 目标未保存可确认的 trialing 状态，返回不可用/null，不把未知写成 0。
- 新订阅仅在可信 checkout 接纳时冻结 `Subscription.initialPaymentEvidence`；
  历史记录不凭最早本地账期猜测初次付款，不回填伪证据。
- 查询达到实现的记录上限会明确拒绝，避免截断后给出貌似完整的报表。

## 权限与接口

权限码位于 `packages/database/shared/admin-permissions.ts`：
`admin.analytics.read`、`admin.payments.read`、`admin.payments.refund`、
`admin.credits.write`、`admin.tickets.read`、`admin.tickets.write`、
`admin.notifications.read`、`admin.notifications.write`、`admin.notifications.test`、
`admin.audit.read`。

目标原来只有 Better Auth 管理员角色，因此保持该人类角色的权限上限；
不运行来源模板的 RBAC seed，不重置现有角色。服务账号只获得管理员明确勾选的能力，
并固定为 platform、单 organization 或单 user 范围。组织管理员不因此获得平台权限。
控制面只允许同源人类管理员 session；机器 key 不能创建 key、服务身份或提升权限。
普通用户与产品 API key 不属于此管理认证域。

REST 的 `/api/admin/agent/operations`、`openapi`、`execute`、`audit`、
`accounts`、`keys`、`mcp` 与后台 oRPC 共用 catalog/schema/executor。
只有真实 handler 登记的操作才进入发现/OpenAPI/MCP。
每次请求重新验证 key 期限/吊销/账户停用、权限与范围；无效 Authorization 不回退 cookie。
MCP 只接受 Bearer，提供无状态 JSON POST 传输；没有 OAuth discovery，
OAuth-only 远程客户端不能直接使用。

所有管理写操作要求 8–128 位稳定幂等键，允许字母、数字及 `_.:-`。
身份+范围+操作+键定义一次执行，同输入重放、不同输入冲突；
pending/unknown 不自动再执行。换 key 不会绕过同一服务身份的幂等。
审计只保留输入 HMAC、目标和安全摘要/必要写结果，读取结果及明文秘密不入日志。
新 key 仅创建时显示一次，数据库只存 hash；重放发 key 不再返回原明文。
key 必须指定未来到期时间，最长 366 天，支持立即吊销。

本地 stdio：`scripts/admin-mcp.mjs`。可独立分发的 Skill：
`skills/ezpic-admin/SKILL.md` 和其脚本。具体环境变量与命令以这些交付文件为准。
多项目必须显式选择，ID 和 key 不跨站点复用。接通工具不代表授权其自行退款或回复客户。

## 机器人与工单

设置包括开关、语言、时区、模板和四个独立通道。必须配置服务器秘密
`ADMIN_BOT_ENCRYPTION_KEY`（32 字节 base64）才可保存凭据；没有明文退路，
不改动或复用 `BETTER_AUTH_SECRET`。数据库保存 AES-GCM 密文，读取返回脱敏值。
变更端点要求重输关联秘密，包括同一域名的不同 Webhook 路径。

自定义目的地使用 `ADMIN_BOT_ALLOWED_HOSTS` 精确公共 HTTPS 主机允许列表。
Node 做公开地址验证及 DNS 绑定；Workers 使用现有
`global_fetch_strictly_public`、原生公网 fetch 和 manual redirect。
不要将此配置指向内网、服务绑定或凭据转发代理。

付款持久事务成功、结算 claim 胜出后才启动通知；独立 receipt 防止重复发送。
工单提交成功后才通知。多通道失败隔离，不回滚支付或工单。
这是 best effort，一次性 receipt 不是可靠 outbox/持久重试队列；
进程在提交后退出仍可能漏通知。HTTP 2xx 仅证明接收端接受。
通用 Webhook 不是独立 Grok 集成。

工单按用户/组织存储，回复时重新检查当前成员关系。管理员/机器服务的回复有作者类型；
客户不能伪装管理员。只发送操作者配置的业务接收端，不因部署本功能自动向真实频道测试。

## 退款规则与恢复

用户在本次实施中明确选择保留目标政策：
按原付款撤销权益与积分，已消费部分计入 creditDebt，余额不为负；
当前周期 PayPal/Waffo 全退按既有规则自动终止订阅。
不开放来源模板自定义 `deductCredits=0` 绕过回收；人工增减是独立审计动作。
历史 Stripe 保持其现有账务规则。额外可选取消与退款分别报告结果。

`AdminRefundRequest` 是持久命令/提供方回执，不是新账本。
订单号映射现有账期、Credit Pack 和 Image Pass；provider+payment ID 唯一，
年付多个账期不能重复退款。金额和币种由本地付款事实与提供方核验，不由客户端决定。
已部分退款的订单只结清剩余实付，仍是整单退款。

先持久 claim，再使用稳定提供方幂等号；Waffo 的退款工单只是申请/处理中，
只有提供方成功退款事实才进入本地权益撤销。外部受理、本地保存失败或网络结果未知
保持 UNKNOWN/PROCESSING，使用 orders_reconcile 查原提供方，不换号重复申请。
支付完成后的本地退款记录和原账本/权益回收使用数据库事务。
订阅取消失败单独显示，不能把已经发生的退款改写成未发生。
没有发布能任意修改订单 paid/refunded 状态的普通编辑操作。

## 增量迁移审查

结构 SQL：`packages/database/prisma/migrations/20261020010000_admin_capabilities/migration.sql`。
由更新前目标 Prisma schema 到当前 schema 的 `prisma migrate diff --script` 生成。
包含 8 张增量管理/工单表、`ADMIN_DEDUCT` ledger enum 值和
可空 `subscription.initialPaymentEvidence`；不删除表、不重写历史订单、角色或积分。
生产发布复核另补充 `20261020010100_admin_capabilities_private_boundary/migration.sql`：
仅为上述 8 张新表启用 RLS，撤销 PUBLIC 与 Supabase API 角色的直接访问，
保留既有 `ezpic_app` 服务端角色。它不更改其他表、schema 或历史角色的权限。

Prisma 是目标当前 PostgreSQL 业务运行时。三种 Drizzle schema 同步了新管理表；
工单/机器人配置 CRUD 有对应 Drizzle 实现。原项目的媒体付款账本、
PaymentEvent/BillingPeriod/Image Pass 在 Drizzle 替代实现中本就不完整，
退款和付款事实继续使用当前正式 Prisma 实现，不宣称 MySQL/SQLite 全站退款可用。

本地实施阶段仅在全新隔离 PostgreSQL 16 测试库应用全部迁移。
用户随后授权合并主分支、推送远程并包括数据库更新；发布阶段的目标、备份、
迁移核对和执行结果记录在 [生产迁移记录](admin-capabilities-production-2026-10-20.md)。
按仓库
`packages/database/prisma/migrations/README.md` 的已有部署流程执行，
不要向未正确基线化的旧数据库盲目运行完整初始迁移。
网站和后台 Worker 都需相同的机器人加密 key/允许列表；不向浏览器传秘密。
部署准备、生产迁移、真实退款/付款及真实机器人消息均不属于本次本地验收证明。

## 本地验收记录（2026-10-20）

测试使用新建的隔离 PostgreSQL 16 数据库和合成账号；未连接生产数据库，
未向真实支付方申请退款，未向真实机器人接收端发送消息。
以下是分批检查的结果，存在重叠，不应累加为互不重复的测试总数。

| 验证范围                    | 结果与证据                                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 支付包完整回归              | 37 个文件、384 项通过；包含 PayPal/Waffo/Stripe、既有权益回收及新退款适配器                                                                                            |
| 受影响 API                  | payments、admin-agent、admin-billing、admin-analytics、support：28 个文件、335 项通过                                                                                  |
| 数据库包显式单元/契约集     | 37 个文件、547 项通过；3 项既有 guest-global-day 网络集成用例按原条件跳过                                                                                              |
| PostgreSQL 管理与来源查询   | 4 个文件、14 项通过；另有退款集成 7 项通过，覆盖并发、年付去重、未知结果恢复及账本不变量                                                                               |
| 机器人                      | 27 项通知测试、11 项付款触发测试通过；mock 接收端、失败隔离、去重、加密与端点重绑均有覆盖                                                                              |
| Workers 私有配置            | 3 项真实 workerd HTTP/DO 环境检查、66 项部署 profile 契约通过                                                                                                          |
| SaaS 界面与内容             | 管理 UI、文档生成源和公开索引契约共 3 个文件、71 项通过                                                                                                                |
| 已登录浏览器                | `apps/saas/tests/admin-capabilities.spec.ts` 最终 3/3 通过：五个后台页面加载真实查询结果、普通用户拦截、客户工单与管理员回复、积分增加、key 签发及吊销                 |
| REST/OpenAPI/MCP/Skill 实连 | 浏览器测试中使用新签发的单用户只读 key，连接真实 Next 生产构建；远程 MCP initialize/list/call、本地 stdio initialize/list/call、独立 Skill 调用均通过；吊销后 HTTP 401 |
| 类型与静态检查              | 受影响包类型检查、改动文件 lint/format、CI 工作流契约和 `git diff --check` 通过                                                                                        |
| Next 生产构建               | `next build --webpack` 通过，包含新增管理页和 `/settings/support`；保留既有 JSON named export/Hono 构建警告，隔离环境没有配置社交登录凭据                              |
| 最终后台 Worker 产物        | dry-run 生成 `dist-workers/workers.js`；最终产物在 workerd 中完成 WASM/Prisma 加载、实际 PostgreSQL 查询、任务路由与定向继续执行检查，`liveCloudflareVerified=false`   |
| 迁移                        | 隔离库全部 68 个迁移应用成功；schema→测试数据库的 Prisma drift 检查为 `No difference`                                                                                  |

浏览器报告在运行后的
`apps/saas/playwright-report/admin-capabilities/index.html`，包括页面截图。
fixture 删除本次唯一测试用户、登录凭据和管理 key；不可变财务流水保持原约束，
只随隔离测试数据库整体退役，不禁用触发器或修改既有账本。
浏览器 fixture 的无时区列明确写入 UTC，避免受测试数据库本地时区影响；
新增真实 Prisma 集成检查验证非 UTC 数据库会话下的模型/原始查询一致性、
24 小时边界、未来时间排除与带时区报表。浏览器同时断言刚创建的用户计入新增人数。
验收完成后已停止本次测试 PostgreSQL、浏览器/Next 服务和启动失败的任务专属 Docker
进程树；按 PID 与创建时间核验均已退出，3310/55432 端口已关闭。
隔离数据库的合成数据文件保持停止状态，没有删除或改动用户数据库。

复现入口：

- `pnpm --filter @repo/payments test`。
- `pnpm --filter @repo/api exec vitest run modules/payments modules/admin-agent modules/admin-billing modules/admin-analytics modules/support`；
  SQL 集成必须另外提供对应测试文件要求的隔离数据库环境变量。
- `pnpm --filter @repo/database test`；
  SQL 用例使用 `vitest.integration.config.ts` 和明确的 `TEST_DATABASE_URL`。
- `pnpm --filter @repo/workflows test:admin-bots:workerd`；
  `pnpm cloudflare:jobs:build` 后运行 `pnpm --filter @repo/workflows test:artifact:workerd --database`。
- `pnpm --filter saas build --webpack` 后运行 `pnpm --filter saas e2e:admin`。
  后者要求 `E2E_ADMIN_CAPABILITIES=true`、`E2E_USE_PRODUCTION_BUILD=true`、
  显式 loopback `NEXT_PUBLIC_SAAS_URL`，
  `DATABASE_URL=TEST_DATABASE_URL` 指向端口 55432 的 `ezpic_admin_capabilities_test`。
  使用测试 auth secret，关闭真实生成、计费和机器人发送；
  `.github/workflows/validate-prs.yml` 已登记独立 PostgreSQL/Chromium job。

### 未执行与环境限制

- **BLOCKED**：网站最终 OpenNext/Cloudflare 包装的仓库 Linux/Docker wrapper；
  本机 Docker Desktop 启动遇到 `dockerInference` socket 权限错误。没有重置 Docker 数据、
  删除 socket 或绕过仓库包装流程。Next 生产构建与后台最终 workerd 产物通过，
  不能替代网站最终 OpenNext 包装验证。
- **NOT_RUN（本地实施阶段）**：提供方沙盒/真实付款与退款、真实机器人平台送达、OAuth-only MCP 客户端、
  生产迁移、远程 CI、Git push/PR/merge、部署与线上验收；后续发布证据见生产迁移记录。
- 上线前需在网站和后台配置一致的机器人加密 key 与目的地主机列表。
  再按实际账户检查 PayPal/Waffo/历史 Stripe 权限和退款结果核对流程；
  本次代码测试没有证明这些外部账户已可用。
