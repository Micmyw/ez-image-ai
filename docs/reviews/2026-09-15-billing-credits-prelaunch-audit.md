# 积分、订阅与退款上线前审查

审查日期：2026-09-15（Asia/Shanghai）。审查基线：`main`，`384ecb1b3a8b38ff1358321e27864133b2f8e59f`，同时读取当前工作区源码。原有 `CHANGELOG.md`、`ModelPage.tsx`、`models.css` 修改已保留。本次没有修改支付或积分产品代码。

**结论：暂不开放真实收款。发现 6 类需要处理的问题，已取得 7 个失败场景的本地复现证据。现有相关测试 795 项通过，但它们没有覆盖正确的完整商业结果，有些测试明确把退款事件进入死信且积分不变定义为预期行为。**

## 当前实际支持范围

新订阅和积分包入口均只接受 PayPal、Waffo。Stripe 保留历史订阅、管理、退款及对账能力，不是当前新购入口。仓库里存在其他支付 SDK 或适配文件，不代表它们已接入当前积分闭环。

| 能力                           | PayPal                        | Waffo                         | Stripe 历史订阅            |
| ------------------------------ | ----------------------------- | ----------------------------- | -------------------------- |
| 新购月付/年付订阅              | 有服务端入口                  | 有服务端入口                  | 当前入口不开放             |
| 新购积分包                     | 有；Orders + Capture          | 有；订单完成事件              | 当前入口不开放             |
| 签名验证、事件落库、Outbox     | 有                            | 有                            | 有                         |
| 付款后幂等发放                 | 有本地集成测试                | 有本地集成测试                | 有本地集成测试             |
| 年付分月发积分                 | 有；取消后存在 F2             | 有                            | 有                         |
| 取消续费                       | 有；权益处理存在 F2           | 有                            | 有                         |
| 订阅退款自动回收积分           | **未实现，进入人工复核/死信** | **未实现，进入人工复核/死信** | 有退款状态机及累计退款处理 |
| 积分包部分/全额退款            | 有累计退款、债务处理          | **未实现，进入人工复核/死信** | 不适用当前入口             |
| 从支付平台拉取账单补齐丢失事件 | 未见对应实现                  | 未见对应实现                  | 有                         |

依据：`packages/api/modules/payments/procedures/create-checkout-link.ts:29`、`create-credit-pack-checkout.ts:28`、`packages/payments/provider/runtime-registry.ts:6`、`lifecycle-normalization.ts:57`、`packages/jobs/src/handlers/reconcile-subscriptions.ts:1`。

## 发现的问题

### F1 · P1 · PayPal 订阅和 Waffo 退款尚未形成可执行的资金/积分闭环

**触发：** PayPal 订阅付款退款，或 Waffo 订阅/积分包退款成功。

PayPal 的订阅退款/撤销以及 Waffo 的 `refund.*` 被转换成 `PAYMENT_PROVIDER_REFUND_REVIEW_REQUIRED`。处理器将其归类为终止错误并写入 `DEAD_LETTER`。失败记录会留下审计日志，但不会撤回积分、产生退款债务、冻结该笔积分或终止未来未发放权益。后台可以重放事件，但重放同一事件仍会经过同一个不支持退款的分支。

**本地复现：** 两个渠道各建立已付款的 700 积分订阅，再注入退款事件。结果均为：

```text
outcome = DEAD_LETTER
failureReason = PAYMENT_PROVIDER_REFUND_REVIEW_REQUIRED
spendableCredits: 700 -> 700
creditDebt: 0
```

Waffo 积分包的既有集成测试也明确验证了“退款后账本不变”。用户资金已退款后，积分仍可能继续消费；年付订阅的未来积分也没有在这条退款路径中撤回。

**建议：** 用已验证的退款事实驱动现有 `refundCreditGrant`、累计退款投影和债务逻辑，保持原账本不可变。若暂时保留人工处理，必须有与具体付款绑定的限制消费措施、可执行的审计处理入口和处置流程。退款、撤销和拒付分别定义状态；不能把记录死信本身视为处理完成。

代码证据：

- `packages/payments/provider/lifecycle-normalization.ts:67`、`:184`：拒绝相应退款/撤销事件。
- `packages/payments/provider/processor.ts:184`、`:237`：错误落库与终止错误分类。
- `packages/database/prisma/queries/media/billing.ts:281`：失败分支不调整账户或订阅权益。
- `packages/api/modules/payments/credit-pack-lifecycle.integration.test.ts:783`：Waffo 积分包退款保持账本不变的现有测试。
- `packages/database/prisma/queries/media/admin-operations.ts:352`：已有重放入口不提供新的退款处理语义。

### F2 · P1 · PayPal 取消续费会提前撤销已付费权益，并停止年付后续月度积分

**触发：** 用户已经支付月费或年费，在有效期中取消自动续费。

PayPal `BILLING.SUBSCRIPTION.CANCELLED` 写入 `CANCELED`。`findEffectivePaidSubscription` 只接受 `ACTIVE` 和宽限期中的 `PAST_DUE`，因此用户立即被视为 Free。分月发放函数也只处理 `ACTIVE` 订阅。与此同时，新订阅防重逻辑会继续阻止未到期的 `CANCELED` 订阅再次购买，导致用户既不能使用已买权益，也不能重新订阅解决问题。

**本地复现：** 创建一个仍有近一年付费有效期的 PayPal 年付订阅；取消后：

```text
effectiveAfterCancel = null
第二个月周期状态 = PENDING
第二个月应发积分对应的 GRANT 数量 = 0
```

**建议：** 分离“自动续费已关闭”和“已付费使用权结束”。以已付款且未退款的有效期判定权益，保留年付未退款的后续月度积分；到期再结束权益。

代码证据：`packages/payments/provider/paypal/paypal.ts:62`；`lifecycle-normalization.ts:225`；`lifecycle-reducer.ts:115`；`packages/database/prisma/queries/media/billing.ts:25`；`packages/payments/provider/stripe/reducer.ts:903`、`:929`；`packages/database/prisma/queries/payment-providers.ts:235`。

### F3 · P1 · 同一 EzPic 用户更换 PayPal 付款账户后，新付款可能无法兑现

**触发：** 原订阅结束，用户用同一个 EzPic 账号重新购买，但使用另一个 PayPal 账户付款。

服务端允许创建新的、绑定正确 EzPic 用户的 Checkout。PayPal 创建订阅时没有约束必须使用历史 payer。付款事件到达后，`assertAndPersistCustomer` 强制一个 EzPic owner 在该 provider 下永远匹配原 `providerCustomerId`，不同 payer 会得到 `PAYMENT_PROVIDER_CUSTOMER_MISMATCH`，阻止新订阅和积分落库。

**本地复现：** 将旧订阅明确标为 `EXPIRED`，成功创建新 Checkout，再输入新 payer 的已付款事实，发放事务因 `PAYMENT_PROVIDER_CUSTOMER_MISMATCH` 回滚。这是使用模拟支付事实的本地验证，没有发起真实扣款。

**建议：** 通过已认证的 Checkout owner 和已验证的 provider 订阅/交易绑定确认归属，允许受控新增付款账户绑定；保留历史交易的原 payer，避免直接覆盖历史归属。至少在可能发生真实扣款前阻止无法兑现的 Checkout。

代码证据：`packages/payments/provider/paypal/paypal.ts:84`、`:101`；`packages/payments/provider/lifecycle-reducer.ts:374`，尤其 `:384`。

### F4 · P2 · ACTIVE 不校验已付费期限，PayPal/Waffo 缺少平台侧对账补偿

**触发：** 续费失败/到期事件丢失或处理失败，数据库残留 `ACTIVE`；或付款成功回调未进入本地数据库。

有效订阅查询不会检查 `currentPeriodEnd`。非 Stripe 的周期维护只把满足条件的 `CANCELED`、`PAST_DUE` 改为 `EXPIRED`，不会处理超过有效期的 `ACTIVE`，也没有拉取 PayPal/Waffo 的实际订阅与支付记录进行修复。

**本地复现：** 已付费周期在前一天结束，执行非 Stripe 周期维护后，查询仍返回 `ACTIVE`，积分包 20% 订阅加赠的资格判断也仍成立。它还可能继续阻止用户重新订阅。另一方面，如果真实续费付款没有入账事件，当前实现没有对应平台账单扫描补发机制。

**建议：** 权益根据已验证的付费周期、宽限期和退款状态计算；增加 PayPal/Waffo 主动对账，补齐缺失事件后仍通过现有幂等事务处理。不能简单删除状态或猜测支付成功。

代码证据：`packages/database/prisma/queries/media/billing.ts:25`；`packages/jobs/src/handlers/reconcile-subscriptions-core.ts:20`；`reconcile-subscriptions.ts:27`；`packages/api/modules/payments/procedures/create-credit-pack-checkout.ts:94`。

### F5 · P2 · 放弃 PayPal 订阅付款后，换套餐或换渠道可能一直被拦截

**触发：** 用户打开 PayPal 订阅批准页但没有付款，返回后想改选另一套餐或另一渠道。

PayPal 订阅 Checkout 返回 `expiresAt: null`；未完成的 `PROVIDER_PENDING` Checkout 在订阅防重规则中继续占用该 owner。相同 Checkout 的恢复可以继续原订单，但当前没有面向这个场景的安全放弃、平台确认失效或换单流程。

**本地复现：** 为未付款用户创建并绑定 Checkout，把检查时间推进一个月，仍得到 `PAYMENT_CHECKOUT_INTENT_CONFLICT`。

**建议：** 增加平台确认后的撤销/过期/恢复处理和用户入口，再释放活跃 Checkout 范围。保留“支付接受状态不确定时不能擅自换单”的原有约束，不能仅按本地超时解锁。

代码证据：`packages/payments/provider/paypal/paypal.ts:121`；`packages/database/prisma/queries/payment-providers.ts:268`；`packages/api/modules/payments/procedures/create-checkout-link.ts:131`。

### F6 · P2 · BILLING_ENABLED 并不能停止创建新付款链接

**触发：** 已配置支付凭据和价格后，设置 `BILLING_ENABLED=false`，希望临时停止新收款。

变量在环境解析中存在，但订阅与积分包创建入口只检查 provider 配置和价格快照，没有检查该开关。可用支付方式查询也没有应用它。

**回归复现：** 复用现有 Checkout 测试的身份、价格和 provider mock，仅增加 `BILLING_ENABLED=false`，预期请求被拒绝。实际请求成功返回：

```text
{ checkoutLink: 'https://www.sandbox.paypal.com/approve' }
AssertionError: promise resolved instead of rejecting
```

**建议：** 在服务端的新订阅、新积分包和可用性查询入口统一应用收款开关。关闭新收款时保留已有付款回调、退款、取消和对账处理能力，防止已付订单不能兑现。

代码证据：`packages/config/env.ts:42`、`:256`；`packages/api/modules/payments/procedures/create-checkout-link.ts:55`；`create-credit-pack-checkout.ts:56`；`get-provider-availability.ts:44`。

## 积分扣减与模型规格核对

当前目录版本为 `2026-09-14.1`，计价版本为 `2026-09-13.2`。读取了 12 个图片产品、29 个规格的服务端价格，核对了前端规格选择、报价、冻结快照、Kie 参数构造、任务预占、成功结算和失败释放的调用关系。

| 产品                   | 输出规格 → 每张积分                       |
| ---------------------- | ----------------------------------------- |
| Nano Banana 2 Lite     | 1K → 5                                    |
| Nano Banana            | Default → 5                               |
| Nano Banana 2          | 1K → 9；2K → 13；4K → 19                  |
| Nano Banana Pro        | 1K → 19；2K → 22；4K → 25                 |
| GPT Image 1.5          | Medium → 5；High → 23                     |
| GPT Image 2            | 1K → 7；2K → 11；4K → 17                  |
| GPT Image 2.5 Flare    | 1K → 7；2K → 11；4K → 17                  |
| GPT Image 2.5 Sunburst | 1K → 7；2K → 11；4K → 17                  |
| Seedream 4             | 1K → 6；2K → 8；4K → 10                   |
| Seedream 4.5           | 2K Basic → 8；4K High → 12                |
| Seedream 5 Lite        | 2K Basic → 7；3K High → 10；4K Ultra → 14 |
| Seedream 5 Pro         | 1K Basic → 8；2K High → 15                |

这些是源码中的计价规格。线上是否开放具体规格取决于运行时开关和路由；本次没有对每个规格发起真实付费生成。

没有在本次审查与相关本地测试中发现以下错误：高画质按低档收费、客户端提交任意积分金额、重复回调重复发放、并发预占超出余额、成功任务重复结算、已退款积分通过取消任务恢复、过期积分释放后复活。

代码中的有效保障包括：

- 服务端按产品与 SKU 校验组合、宽高比及参数，客户端不能指定 provider 成本或任意扣费额。
- 报价冻结积分、路由、版本和结算上限。已接受任务结算使用冻结快照。
- Job、输入绑定、积分预占、初始 Outbox 在同一事务内创建；账户与积分批次加锁。
- 优先消耗较早到期的积分；过期积分不恢复成可用余额。
- 退款涉及已消耗积分时形成债务；新的积分先还债，债务未清时限制生成。
- 输出经过验证且可使用后结算；没有可用输出时释放预占。供应商接受状态不明时保留预占并恢复同一 attempt。

依据：`packages/config/product.ts:115`；`packages/ai/media/catalog/catalog.ts:297`；`packages/ai/media/providers/kie.ts:251`；`packages/api/modules/media/lib/quote.ts:18`；`packages/database/prisma/queries/media/jobs.ts:324`；`credits.ts:198`、`:344`、`:629`、`:724`；`packages/jobs/src/runtime.ts:2448`。

## 套餐及积分包规则

| 套餐                | 月付 | 年付   | 每月积分 | 并发生成上限 |
| ------------------- | ---- | ------ | -------- | ------------ |
| Free                | 免费 | 不适用 | 25       | 1            |
| Pro（内部 creator） | $19  | $190   | 700      | 3            |
| Ultimate            | $49  | $490   | 1,800    | 6            |
| Max（内部 studio）  | $79  | $790   | 3,000    | 10           |

年付仍分月发积分，订阅积分在各自月度周期末过期。积分包为 $59 / 1,500、$109 / 3,000、$169 / 5,000、$259 / 8,000；符合资格的订阅用户在创建 Checkout 时锁定 20% 加赠，六个日历月到期。积分包不会自动提升模型权限，因此没有付费订阅的用户仍受 Free 模型范围限制。

仓库对积分包采用 $0.0066/credit 的保守成本假设。最低套餐单位收入是 Max 年付的约 $0.02194/credit，按该假设费用前余量约 69.9%。这只是配置数值核对，不是实际毛利认证；支付费、税、退款/拒付、失败调用和外部实际账单仍需纳入上线核算。

另外发现一处发布耦合：订阅 `BillingPlan.metadata.pricingVersion` 要等于图片的全局计价版本。即使套餐美元价格和月度积分没变，图片调价导致版本变化也会使旧快照的新购入口不可用。应分离套餐计价版本与图片 SKU 计价版本，或把快照重新配置作为明确的发布步骤。本次没有读取生产数据库，因此不判断现网是否已经被该条件拦截。

## 验证证据与边界

| 本次执行范围                                                          | 文件数 | 通过测试数 |
| --------------------------------------------------------------------- | ------ | ---------- |
| payments 单元/合同测试                                                | 21     | 165        |
| API 支付生命周期集成及报价、权限等相关测试                            | 30     | 307        |
| PostgreSQL 积分、免费发放、有效订阅、订阅防重、provider、重试事务测试 | 6      | 109        |
| AI 目录与 Kie 合同相关测试                                            | 9      | 169        |
| Jobs 取消、恢复、最终化、订阅维护相关测试                             | 7      | 27         |
| SaaS 输出设置、价格展示、订阅文案及 plan data 单元测试                | 4      | 11         |
| Config 套餐、积分包测试                                               | 2      | 7          |
| **合计**                                                              | **79** | **795**    |

另有 6 个数据库业务探针均显示预期商业结果未满足，以及 1 个收款开关回归测试失败，共 7 个异常场景。失败复现使用本地 fixture / provider mock，不代表本次发生过真实扣款或退款。

数据库使用本次新建的 PostgreSQL 17 容器，成功应用全部 43 个迁移。Windows 将 55432 放进系统保留端口段，因此使用 `127.0.0.1:15432`；临时 Vitest 配置只将测试文件中的 55432 安全目标检查改为 15432，生产源码未改，仍限制到本次一次性数据库。运行时 `DATABASE_URL` 与测试 URL 使用不同 application_name 表示；均指向此容器。

验证后已删除临时 Vitest 配置和临时失败测试，停止并删除该容器及其卷，确认记录的进程已退出。用户已有的 PostgreSQL、MinIO 容器保持运行。数据库复现脚本保存在本地忽略目录 `.wrangler/billing-audit-20260915/reproduce.ts`，需要重新创建专用测试库后才能执行。

本次未执行完整工作区 type-check/build、浏览器 E2E、CI、部署或生产支付。没有使用本地成功测试代替线上支付证据。

当前本地 `.env.production.local` 的非秘密选择器仍为 `PAYPAL_ENVIRONMENT=sandbox`、`WAFFO_ENVIRONMENT=test`；这不证明远端当前配置。仓库的上线证据文件仍含付款、取消、退款/债务等 `NOT_COMPLETED` 项。

## 建议修复与验收顺序

1. 先修 F1/F2/F3：退款和拒付处理、取消续费后的已付权益、重新购买更换付款账户。对上述业务场景先建立失败回归，再验证修复后通过。
2. 修复过期权益与平台对账、未完成 Checkout 的安全恢复、服务端收款开关，并验证跨渠道、重复、乱序和并发。
3. 在独立沙箱环境完成每个拟上线渠道的月付、年付、续费、取消、积分包、全额/分次部分退款，以及退款与生成预占/结算交错的端到端证据。
4. 切换真实环境时一起核对凭据、产品/计划 ID、Webhook 和不可变 BillingPlan 快照。核实先前沙箱付款产生的积分与真实收款积分已经隔离；不能仅改变环境选择器后直接沿用测试余额。
5. 代码和沙箱验收完成后，再执行经授权的生产小额付款、发放、消费、退款验证，并记录支付交易、Webhook、订阅/积分账本、Jobs 执行及部署版本之间的对应关系。

在上述问题修复和所需外部证据补齐前，生产支付上线状态为 **NOT_COMPLETED**。
