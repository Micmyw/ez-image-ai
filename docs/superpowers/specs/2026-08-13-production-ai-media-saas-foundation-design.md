# 生产级 AI 图片/视频 SaaS 基座设计

状态：已确认

日期：2026-08-13

主仓库：`D:\AIProject\Gefei\SaaSTool\ai-supastarter-template`

参考实现：`D:\AIProject\Gefei\SaaSTool\ai-shipany-template-two`

## 1. 目标

在 Supastarter 上建设一套可以直接用于生产、并能重复复制为不同图片/视频类 SaaS 的内部基座。首个版本必须同时具备生成、订阅、积分、资产、异步任务、运营控制、安全和恢复能力，而不是只完成生成演示。

基座的成功标准是：新建同类 SaaS 时，品牌、页面文案、套餐、已认证模型和功能组合主要通过强类型配置完成；新增 Provider、支付协议、复杂编辑器或新的计费语义时，仍通过明确的代码扩展点开发和测试。

## 2. 已确定的产品范围

### 2.1 首版包含

- 文生图、图生图、文生视频和图生视频。
- 营销页轻量生成器与登录后的完整创作工作台。
- 图片/视频直传、私有资产库、任务历史、预览、下载和再次创作。
- 个人月付、年付订阅，以及个人积分账户。
- 生成前报价、积分预占、结算、释放、退款反向流水和积分负债。
- Replicate、Fal、Kie、Gemini Provider Adapter。
- Trigger.dev 异步任务、Provider Webhook 和定时对账恢复。
- S3 兼容对象存储；官方支持 AWS S3 与 Cloudflare R2。
- Stripe 订阅闭环；其他现有支付 Provider 不标记为本基座生产可用。
- 强类型站点配置、服务端模型/套餐目录和带审计的运行时运营开关。
- 内容安全、限流、成本保护、结构化监控、告警和生产级测试。

### 2.2 首版不包含

- 团队订阅、团队积分和共享资产 UI。
- 一次性积分包的官方认证流程。
- 在线图片编辑器和视频时间轴编辑器。
- 公开社区、作品广场和公开分享链接。
- 用户自带 Provider Key。
- 任意 Provider、模型、模型 ID 或参数的后台热接入。
- 任意远程 URL 导入。
- SOC 2、HIPAA 等正式合规认证。

数据层从第一天保留 `ownerType`、`ownerId`、`submittedByUserId`，以后可以增加团队能力而不重写任务、资产和账本的归属模型。首版业务规则只允许 `ownerType = USER`。

## 3. 总体方案

Supastarter 是主框架，继续承担 Next.js 应用、Better Auth、oRPC、PostgreSQL、支付、邮件、多语言和基础 UI。ShipAny 只作为选择性参考实现：复用质量合格的 Provider 请求方式、参数转换、状态映射、结果解析，以及上传控件中的拖拽、粘贴、预览、替换和失败重试交互。

以下 ShipAny 设计不得迁入：

- 客户端传任意 Provider、模型 ID 或供应商参数。
- 固定积分与任意模型组合。
- Provider 任务先创建、本地任务后落库。
- 浏览器轮询承担业务可靠性。
- 将上传或 Provider 输出完整读入服务器内存。
- 仅相信文件扩展名或客户端 MIME。
- 直接把 Provider 临时 URL 当成永久用户资产。
- 现有积分 offset/batch 扣减算法。
- 支付成功页面直接发积分。
- 缺少资源级二次鉴权的后台操作。

官方生产技术路径：

| 领域       | 决策                                              |
| ---------- | ------------------------------------------------- |
| Web        | Supastarter 的 Next.js App Router，Vercel 部署    |
| API        | Supastarter oRPC/Hono 边界                        |
| 数据库     | PostgreSQL，Prisma 为本基座官方 ORM 路径          |
| 异步任务   | Trigger.dev                                       |
| 对象存储   | 私有 S3/R2，浏览器直传，服务端签名访问            |
| 支付       | Stripe                                            |
| 异常与追踪 | Sentry 为官方实现，业务指标保留可替换接口         |
| 业务真相   | PostgreSQL，而不是 Trigger.dev、浏览器或 Provider |

## 4. 模块边界

### 4.1 `packages/ai`

负责：

- Provider Adapter 接口与实现。
- 产品模型目录和真实 Provider 路由。
- Zod 输入 Schema、参数标准化与 Provider 参数转换。
- Provider 状态、进度、错误、成本和输出标准化。
- 路由、熔断、能力匹配和兼容备用线路。

它不负责用户身份、积分扣减、数据库事务、支付或页面状态。

### 4.2 `packages/database`

负责：

- Prisma Schema、生产迁移、约束和索引。
- 任务状态转移、积分预占/结算、资产归属和 Outbox 的事务函数。
- 支付事件、Provider 事件和运营配置审计。

应用代码不能自行实例化 ORM Client，也不能绕过这里的事务函数直接修改账本或任务终态。

### 4.3 `packages/api`

负责：

- 报价、任务、资产、积分、订阅和后台管理的 oRPC Procedures。
- 鉴权、所有权校验、参数校验、限流与用户可见错误映射。
- Provider/支付 Webhook 入站端点。

Webhook 端点只完成验签、事件持久化和快速应答；耗时业务交给 Trigger.dev。

### 4.4 `packages/storage`

负责：

- S3/R2 Client、签名上传、分片上传、HEAD、流式复制、删除和签名读取。
- 对象键生成、访问策略和 Storage Adapter 合约。

它不负责资产所有权与配额；这些由 API 和数据库层决定。

### 4.5 Trigger.dev 任务

负责短时、可重试的后台步骤：

- 提交 Provider。
- 处理 Provider Webhook。
- 查询恢复与超时对账。
- 流式转存、媒体元数据提取和安全审核。
- 积分结算、Outbox 投递与异常修复。

生成在 Provider 内运行，Trigger.dev 任务提交成功后立即退出，不持续等待 Provider。

### 4.6 应用层

- `apps/saas`：工作台、历史任务、资产库、订阅和管理后台。
- `apps/marketing`：营销页、SEO 内容和轻量生成器。
- 两个入口共用同一模型目录公共投影、表单组件和服务端生成 API，不复制 Provider 或定价逻辑。

## 5. Provider 抽象与模型目录

统一接口：

```typescript
interface MediaProviderAdapter {
	readonly provider: ProviderKey;
	submit(input: ProviderSubmitInput): Promise<ProviderSubmission>;
	retrieve(input: ProviderRetrieveInput): Promise<ProviderTaskSnapshot>;
	cancel?(input: ProviderCancelInput): Promise<ProviderCancelResult>;
	verifyWebhook?(request: Request): Promise<VerifiedProviderEvent>;
	normalizeResult(snapshot: ProviderTaskSnapshot): Promise<NormalizedResult>;
}
```

标准结果至少包含：

- `providerTaskId`
- `status`
- `progress`
- `outputs`
- `providerCostMicros`
- `failureCode`
- `failureMessage`
- `isRetryable`
- `isProviderCharged`

Provider 状态统一映射为 `QUEUED`、`RUNNING`、`SUCCEEDED`、`FAILED`、`CANCELED`、`UNKNOWN`。只有 Provider 返回真实进度时才写入 `progress`。

首版能力矩阵：

| Provider  | 图片 | 视频 |
| --------- | ---- | ---- |
| Replicate | 是   | 是   |
| Fal       | 是   | 是   |
| Kie       | 是   | 是   |
| Gemini    | 是   | 否   |

每个 Provider 最多认证 2–3 个服务端模型。具体真实模型 ID 属于服务端目录，不成为公共 API 合约。

公共产品使用稳定键，例如：

```text
image.fast
image.quality
video.fast
video.quality
video.image-to-video
```

每个目录项声明：

- 产品键、版本和用户可见名称。
- 支持的生成模式与输入 Zod Schema。
- 真实 Provider、模型 ID、主线路和兼容备用线路。
- 最大 Provider 成本、预占积分、结算模式和 `pricingVersion`。
- 文件类型、大小、尺寸、时长和输出数量限制。
- Webhook、取消、进度和幂等提交能力。
- 预计耗时范围和套餐可见性。

Provider 不决定本站定价。客户端只能获得裁剪后的 `PublicProductCatalog`，其中不含 Provider、真实模型 ID、成本、路由权重和凭据。

故障切换只发生在明确未被 Provider 接收的提交上。连接中断或超时导致提交结果不确定时，Attempt 进入 `SUBMISSION_UNKNOWN` 恢复路径，通过幂等键或查询对账确认，禁止盲目切换线路。

## 6. 生成任务与可靠性

### 6.1 核心实体

- `GenerationJob`：用户的一次生成意图和对外状态。
- `GenerationAttempt`：每次 Provider 提交、恢复或安全重试。
- `ProviderWebhookEvent`：验签后的 Provider 原始事件信封。
- `OutboxEvent`：数据库事务与后台任务之间的可靠投递记录。

`GenerationJob` 保存所有权、产品模型键、目录版本、定价版本、规范化输入快照、报价、预占积分、实际扣费、当前状态、当前 Attempt、创建/开始/完成时间和配置指纹。

`GenerationAttempt` 保存 Provider、真实模型 ID、路由版本、Provider 任务 ID、幂等键、提交状态、标准化快照、Provider 成本、错误分类和重试次数。Provider 任务 ID 在同一 Provider 内唯一。

### 6.2 状态机

```text
RESERVED
DISPATCH_QUEUED
SUBMITTING
PROVIDER_QUEUED
PROVIDER_RUNNING
FINALIZING
SUCCEEDED
FAILED
CANCELED
EXPIRED
```

所有状态转换都使用“任务 ID + 前置状态 + version”条件更新。Webhook、轮询、取消、超时和人工恢复不能覆盖已经出现的终态，也不能把任务倒退到早期状态。

### 6.3 创建任务事务

正式创建任务必须在同一个 PostgreSQL 事务内完成：

1. 再次校验用户、套餐、并发、输入资产、模型版本和报价有效期。
2. 锁定积分账户和可用积分批次。
3. 创建积分预占。
4. 创建 `GenerationJob`。
5. 绑定输入 `MediaAsset`。
6. 写入 `OutboxEvent(JOB_CREATED)`。

事务提交后立即调用 Trigger.dev 投递。调用失败不回滚已创建的任务；Outbox 扫描器负责恢复投递。正常路径的内部排队 P95 目标小于 5 秒，恢复扫描是异常兜底而不是正常调度方式。

### 6.4 Webhook 和对账

Provider Webhook 流程：

1. Adapter 验证签名、时间窗口和必要 Header。
2. 在同一事务中按 `provider + providerEventId` 幂等写入事件及处理 Outbox。
3. 返回 2xx。
4. Trigger.dev 读取持久化事件，锁定 Attempt，执行条件状态转换。
5. 终态进入转存与结算；非终态只更新真实进度和 Provider 快照。

对不支持 Webhook、Webhook 丢失或长期无更新的任务执行低频查询。对账频率按任务年龄逐步降低，并受 Provider 查询配额控制。

浏览器轮询只读取 PostgreSQL 并刷新界面，不调用 Provider，不触发结算，也不参与恢复。

### 6.5 重试与取消

- 用户输入问题不自动重试。
- 明确未提交的瞬时网络错误可以指数退避重试。
- Provider 明确返回的可重试错误，可以在模型目录允许的线路内建立新 Attempt。
- 转存、元数据提取、审核和结算失败只重试对应阶段，不重新生成。
- 用户手动重试创建新 Job，重新报价和预占；旧 Job 不可变。
- Provider 提交前取消立即释放积分。
- Provider 支持取消时发出取消请求并等待最终确认。
- Provider 不支持取消时记录取消意图，最终按真实结果和计费策略结算。

## 7. 积分、成本与定价

### 7.1 数据模型

- `CreditAccount`：个人积分汇总、预占总额和 `creditDebt`。
- `CreditLot`：每次发放的积分批次、来源、剩余量和过期时间。
- `CreditReservation`：任务预占及其最终状态。
- `CreditLedgerEntry`：不可变积分流水。

所有积分变动必须写账本；不能直接修改余额而没有流水。账户汇总是账本与批次的可校验投影。

### 7.2 并发与幂等

- 预占和结算使用 PostgreSQL 行锁。
- 消耗按最早过期批次 FIFO。
- 每个发放、预占、结算、释放和退款动作都有唯一 `referenceKey`。
- 重复请求返回原结果，不重复扣费或发放。
- 定时不变量检查比较账户、批次、预占与账本；不一致立即告警并冻结受影响账户的新生成。

### 7.3 报价与结算

报价返回：

- `quoteId`
- `productModelKey`
- `catalogVersion`
- `pricingVersion`
- 公开参数摘要
- 预计积分
- 最大预占积分
- 短期有效期

创建任务时重新计算并验证报价。价格变更生成新的 `pricingVersion`，不会影响已报价有效期内成功创建的任务，也不会改变运行中任务。

系统同时记录 `providerCostMicros` 与 `chargedCredits`。目录为每种模型声明结算模式：

- 视频等单结果调用：至少一个有效、审核通过的输出才按任务价格结算。
- 图片批量：按审核通过的有效输出数量结算，上限不超过预占。
- 没有可用输出：用户扣费为零并全额释放预占；Provider 已产生的费用记为平台损失。

这一“无有效结果不扣用户积分”是首版固定产品策略。以后改变策略必须新增策略版本，不能重算历史任务。

## 8. 订阅与支付闭环

### 8.1 数据模型

- `BillingPlan`：套餐、周期、权益和 Stripe Price 映射。
- `Subscription`：本站订阅状态与 Stripe 引用。
- `BillingPeriod`：积分权益的内部发放周期。
- `PaymentEvent`：持久化、可重放的支付事件信封。

支付状态与积分状态分离。Stripe 是支付事实来源，PostgreSQL 是本站订阅权益和积分事实来源。

### 8.2 Webhook 规则

支付 Webhook 必须先验签并持久化，再异步处理。唯一约束至少包括：

- `provider + providerEventId`
- `provider + transactionId`
- `provider + subscriptionId + billingPeriodStart`

前端 Checkout Return 页面只能查询状态和显示结果，不能发放积分。

### 8.3 权益规则

- 月付按每个 Stripe 月度周期发放积分。
- 年付完成后按内部月度 `BillingPeriod` 分 12 次发放，避免首日发完后退款套利。
- 内部月度边界以订阅起始日和 UTC 计算；月底订阅使用该月最后一个有效日期。
- 取消订阅保留已支付周期内的权益；年付取消后仍按月发放到年度到期日。
- 升级和降级默认在下一个 Stripe 计费周期生效，不做首版按比例即时变更。
- 套餐过期不删除历史作品；用户失去新增额度和超出免费层的生成能力。

退款不修改历史账本，而是追加反向流水。未消费积分优先扣回；不足部分形成 `creditDebt`。存在债务时禁止新任务，后续积分发放先偿还债务。

Supastarter 中其他支付 Provider 可保留接口，但只有通过同一套 Webhook、幂等、退款、订阅周期和积分合约测试后，才可以标记为生产可用。

## 9. MediaAsset、上传与存储

### 9.1 核心实体

- `MediaAsset`：所有权、来源、媒体类型、状态、存储对象、大小、Hash、尺寸、时长和审核状态。
- `MediaUploadSession`：上传预留、签名、分片状态和过期时间。
- `GenerationJobAsset`：任务与输入、输出、缩略图的关系。
- `AssetModerationResult`：审核 Provider、规则版本、结果和原因。
- `StorageUsageReservation`：并发上传时的配额预留。

资产状态：

```text
UPLOADING
VERIFYING
MODERATING
READY
QUARANTINED
FAILED
DELETED
```

只有 `READY` 资产能作为任务输入或被用户访问。输出在审核完成前保持不可访问。

### 9.2 上传流程

```text
申请上传
→ 校验身份、套餐、配额和模型限制
→ 创建资产、上传会话和配额预留
→ 浏览器直传 S3/R2
→ 完成上传
→ 服务端 HEAD、文件头和元数据验证
→ 标准化与内容审核
→ READY
```

- 图片使用短期签名直传。
- 大视频使用 S3 Multipart Upload，支持断点续传和中止清理。
- 默认允许 JPEG、PNG、WebP、MP4、WebM、MOV。
- 全局默认上限为图片 25 MB、视频 500 MB；模型目录可以收紧限制。
- 客户端验证只改善体验；服务端重新验证大小、真实 MIME、尺寸、像素总量、时长和所有权。
- 默认拒绝 SVG、可执行内容、伪造 MIME、压缩炸弹和超大分辨率。
- 图片标准化版本清除 EXIF、GPS 和不需要的元数据。
- 正式任务只接受本站 `assetId`，不接受浏览器传入的任意远程 URL。

### 9.3 Provider 输出转存

```text
Provider 临时输出
→ 域名和重定向安全校验
→ 流式读取
→ S3 Multipart 流式写入
→ Hash、大小、真实类型和媒体元数据校验
→ 内容审核
→ 正式 MediaAsset
→ 积分结算
```

视频不得完整载入 Vercel 或 Trigger.dev 进程内存。下载设置连接、首字节、总时长、重定向次数和最大字节数限制。Provider 输出域名必须由对应 Adapter 声明；每次重定向重新执行协议、域名、DNS/IP 和端口检查以阻止 SSRF。

### 9.4 访问与删除

- 对象存储默认私有。
- 应用鉴权后返回短期签名 URL；可选签名 CDN，但不由 Next.js 代理视频流量。
- 视频读取必须支持 Range 请求、断点播放和下载。
- 签名 URL 不进入普通日志、数据库业务字段或第三方分析事件。
- 用户删除后立即标记 `DELETED` 并拒绝访问，24 小时内物理删除对象。
- 失败或过期上传会话在 24 小时内清理。
- 账务和任务审计只保留必要的非内容元数据。

存储配额和生成积分分开。上传前使用 `StorageUsageReservation` 硬性预留；生成输出允许完成当前已付费任务所需的小范围软超额，随后阻止新上传和新生成，直到用户清理或升级。

## 10. 内容安全

使用统一 `MediaSafetyAdapter`，覆盖：

- Prompt 提交前审核。
- 用户输入图片/视频审核。
- Provider 输出审核。
- Provider 自带安全配置保持开启。

生产环境开启生成能力时必须配置可用的安全 Adapter，否则启动校验失败；只有开发和测试环境可以显式使用 Mock/Disabled Adapter。

审核拒绝属于用户输入问题时不调用 Provider、不扣积分。输出被拒绝时不给用户展示；若没有可用输出，按“无有效结果不扣费”处理，同时保留最少必要审核原因用于申诉和审计。

## 11. 工作台、历史任务与资产库

### 11.1 双入口

- 营销页展示轻量生成表单，用于 SEO 和转化。
- 未登录用户可以填写 Prompt、选择模式和上传本地草稿；生成时要求登录，登录后恢复草稿。
- SaaS 工作台提供完整生成、队列、历史、资产和失败恢复能力。
- 两者使用同一公共模型目录投影和服务端 API。

Provider 名称默认对普通用户隐藏，只展示“快速”“高清”“专业”等产品档位、预计积分、预计耗时和支持参数。

### 11.2 工作台结构

桌面端左侧为生成模式、Prompt、素材和参数，右侧为当前状态与结果；最近任务使用独立队列区域。移动端使用同字段的单列布局。

参数由模型 Zod Schema 驱动，但基座只提供有限的稳定组件：文本、选择器、滑块、比例、数量、图片上传和视频上传。站点可以覆盖布局和文案，不建设任意表单编辑器。

提交使用 `idempotencyKey`。正式创建成功后，用户可以离开页面、关闭浏览器或换设备，任务仍继续执行。

### 11.3 用户状态映射

内部状态映射为：

- 正在准备
- 排队中
- 生成中
- 正在保存
- 已完成
- 失败
- 已取消
- 已过期

只有真实 Provider 进度才展示百分比，否则展示阶段和预计耗时。TanStack Query 自适应轮询 PostgreSQL：终态停止、后台标签降低频率、重新打开页面恢复。以后可加 SSE，但 SSE 不承担可靠性。

### 11.4 历史与资产

任务历史按游标分页，支持媒体类型、状态、模式和日期筛选。任务详情包含输入、输出、公开参数、状态时间线、预占/扣除/释放、用户可理解错误和“使用相同设置再次创作”。Provider 原始响应、堆栈和成本只对管理员可见。

资产库按图片、视频展示最终文件，支持下载、再次生成、作为后续任务输入、查看来源任务和删除。

图片单次允许 1–4 个输出；视频默认 1 个，只有目录明确认证时才允许更多。超出账户并发时任务进入本站等待队列，不由浏览器反复提交。

## 12. 三层模板配置

### 12.1 强类型站点配置

`packages/config` 管理品牌、域名、Logo、主题、语言、导航、功能开关、免费试用、上传限制、存储策略、邮件品牌、SEO、客服和 Analytics 开关。

配置使用 TypeScript 和 Zod；构建或启动时失败即阻止部署。敏感值只使用服务端环境变量引用。

### 12.2 服务端模型和套餐目录

`packages/ai/catalog` 保存模型、路由、成本、定价版本和限制。套餐目录保存月/年价格、月度积分、并发、提交频率、存储配额、可用档位和上传限制。

Provider Key、Stripe Secret、数据库、存储和 Trigger.dev 凭据只来自部署环境。Stripe Price ID 保持服务端可见。

### 12.3 运行时运营配置

数据库只保存需要即时生效的运营控制：

- 模型或 Provider 紧急停用。
- 图片、视频、上传或注册暂停。
- 路由权重和 Provider 并发上限。
- 新定价版本及其生效时间。

每次修改记录操作者、旧值、新值、原因、时间和版本，并支持回滚。运行时变化只影响新任务；Job 保存提交时的目录、定价、配置和部署指纹。

### 12.4 快速建站边界

只改配置和内容即可完成：品牌、域名、页面文案、图片/视频组合、已认证模型启停排序、套餐、积分、限额、语言、导航、邮件、SEO、Analytics、客服和法律信息。

必须写代码并通过测试的变化：新 Provider、新 Webhook/认证协议、新参数组件、新支付 Provider、复杂编辑器、新任务阶段和新结算语义。

## 13. 安全和成本保护

所有任务、资产、积分和订阅接口同时校验：登录身份、所有权、代表所有者的权限、资产状态、服务端 Schema、套餐权益、积分、存储和并发额度。

首版必须具备：

- 账号与 IP 分层限流。
- 报价、上传、任务创建和登录的独立限额。
- 资源级二次鉴权；管理员角色不替代资源校验和审计。
- Webhook 验签、时间窗口、事件持久化和幂等。
- 严格 CORS、来源校验、CSP 和安全响应头。
- 日志与错误响应自动脱敏。
- 数据库、对象存储、Trigger.dev 使用不同的最小权限凭据。
- 管理员配置、退款、赠送积分、重跑和修复的审计记录。

成本保护分四层：

```text
账号套餐限制
→ 单用户并发与提交速率
→ Provider/模型队列与熔断
→ 全站每日成本预算与紧急停机
```

Provider 错误率达到配置阈值时自动断路；恢复使用半开探测。达到每日预算时先停用高成本档位，再按运营策略暂停新生成，已经提交的任务继续恢复和结算。

## 14. 可观测性、告警与恢复

结构化日志和追踪字段至少包含：

- `requestId`
- `traceId`
- `generationJobId`
- `attemptId`
- `provider`
- `productModelKey`
- `pricingVersion`
- `deploymentVersion`

日志不得包含 Prompt、密钥、完整支付信息、Webhook 签名或签名资产 URL。用户标识使用内部 ID 或不可逆摘要。

核心指标：

- 报价、上传、任务创建的延迟与错误率。
- 队列深度、等待时间和最老任务年龄。
- Provider 提交率、完成率、P95 延迟、超时率和成本。
- Webhook 延迟、重复数和验签失败数。
- 转存速度、失败率、对象大小和存储量。
- 积分预占、结算、释放、债务和账本不变量。
- 用户收入、Provider 成本和单任务毛利。
- 状态卡住任务、Outbox 积压和对账修复数量。

立即告警：账本不平衡、重复结算、支付 Webhook 持续失败、数据库不可用、Outbox 持续积压、已生成输出无法转存、实际成本超过目录上限、生产关键配置缺失。

预警：Provider 失败率或 P95 明显升高、内部排队 P95 超过 5 秒、卡住任务增加、对账频繁修复、存储或每日成本接近预算。

`/health` 仅用于存活检查。另设无副作用的就绪检查，验证配置、数据库和必要服务连接；管理后台提供诊断视图，但不会把密钥或原始敏感响应暴露给前端。

## 15. 容量与 Trigger.dev 队列

首版验收目标：

- 1,000 个同时活跃生成用户。
- 稳态 200 个任务/分钟，持续 30 分钟。
- 400 个任务/分钟突发，持续 5 分钟。
- Provider 配额允许时，本站内部排队 P95 小于 5 秒。
- 创建任务 API P95 小于 800 ms。
- 页面关闭不影响完成、转存和结算。
- 无重复任务、重复扣费、积分超卖或 Outbox 丢失。

保守按 Trigger.dev Pro 基础 100 个活跃执行并发设计，不把突发并发当作长期容量。队列至少按图片提交、视频提交、资产转存/审核、结算/恢复分开；每个 Provider 再施加模型级并发限制。AI 生成时间不占 Trigger.dev 执行槽。

容量测试使用模拟 Provider 注入快速响应、长运行、重复/丢失 Webhook、超时和慢转存。真实上线容量还必须核对各 Provider 账户配额；不能仅根据 Trigger.dev 或模拟测试宣称实际可承载量。

## 16. 测试策略

### 16.1 单元测试

- 模型目录、Schema 和参数转换。
- Provider 状态、结果和错误标准化。
- 任务状态机允许/禁止转移。
- 报价、定价和结算策略。
- Webhook 验签与解析。
- 文件类型、URL、SSRF 和内容安全策略。

### 16.2 PostgreSQL 集成测试

- 创建任务、积分预占和 Outbox 的同事务性。
- FIFO 批次、并发预占、释放、退款和债务。
- 重复 Webhook、提交、结算、发放和退款。
- Webhook、轮询、取消和恢复同时发生的竞争。
- 转存失败只重试转存。
- 数据库约束、索引、迁移和回滚兼容性。

### 16.3 合约与端到端测试

Provider 合约测试使用固定样本和模拟服务，覆盖 Replicate、Fal、Kie、Gemini，不在普通 PR 中调用付费模型。

关键 E2E：

```text
注册/登录
→ 订阅或测试发放积分
→ 上传与审核素材
→ 报价
→ 提交任务
→ 模拟 Provider Webhook
→ 转存与输出审核
→ 结算积分
→ 历史和资产库可见
→ 下载或再次生成
```

同时覆盖余额不足、重复点击、重复支付事件、Provider 失败、审核拒绝、转存失败、取消、页面刷新和退出浏览器。

少量真实 Provider 冒烟测试只在受预算控制的定时或手动发布检查中执行。

## 17. CI 与发布

现有 lint、格式、类型检查、Vitest 和 Playwright 保留，并增加：

- 站点配置、套餐和模型目录静态校验。
- 临时 PostgreSQL 上的迁移与集成测试。
- Schema 漂移检查。
- Trigger.dev 任务构建检查。
- 依赖漏洞和秘密扫描。
- SaaS 与 Marketing 生产构建。
- 模拟 Provider、存储、内容审核和 Stripe 的关键 E2E。

数据库变更采用向前兼容的 expand-contract 策略。发布顺序：

```text
CI 全通过
→ Vercel Preview
→ Staging 迁移与冒烟
→ Production 迁移
→ 应用部署
→ Trigger.dev 任务发布
→ 发布后就绪和关键链路检查
```

状态机、积分和账务变化不能只依赖人工页面检查。

## 18. 粗粒度实施方式

实施连续推进，不为小改动反复设置用户审核点。只保留三个内部工作块：

1. 核心数据、任务、Provider、存储和积分引擎。
2. 支付闭环、工作台、历史、资产库和模板配置。
3. 安全加固、监控告警、容量验证和生产发布准备。

这些工作块用于组织依赖关系，不作为逐块请求用户批准的门槛。常规代码审查、测试失败修复和验证由实施过程内部完成。只有产品方向变化、需要新的外部权限/账户、不可逆操作或超出本规格的范围扩张才暂停请求用户决策。

## 19. 最终验收标准

基座只有同时满足以下条件才算完成：

- 四种生成模式通过统一产品模型键工作，客户端无法越过模型目录。
- 首版 Provider 通过合约测试，至少各产品档位有一条已认证生产线路。
- 任务可在浏览器关闭后完成，Webhook 丢失时可以对账恢复。
- 输入和输出均形成私有、可鉴权、可删除的 MediaAsset。
- 大视频上传、转存和播放不经过 Vercel 内存缓冲。
- 所有积分动作可审计且幂等，并通过并发和不变量测试。
- Stripe 月付、年付按月发放、取消、退款和重复事件通过集成测试。
- 工作台、任务历史、资产库和营销页轻量入口完成关键 E2E。
- 安全、限流、成本熔断、日志脱敏、监控和告警具备可验证实现。
- CI、迁移、生产构建和目标容量测试通过。
- 复制基座后，可以通过配置完成品牌、内容、套餐和已认证模型组合的替换。

本规格没有未决的产品或架构选项。实施计划可以在不改变上述不变量、范围和验收标准的前提下决定文件拆分、内部函数命名和测试组织方式。
