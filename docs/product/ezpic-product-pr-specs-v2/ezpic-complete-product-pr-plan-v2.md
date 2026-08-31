# EzPic Prompt Image Editor：完整产品 Pull Request 实施规格 v2

> **用途：** 直接交给 Codex，基于公开仓库 `https://github.com/Micmyw/ez-image-ai` 的当前模板能力，完成一个聚焦的 AI 图片编辑订阅 SaaS。
> **日期：** 2026-08-23
> **目标分支：** 从 `main` 创建独立 worktree/branch，按 PR 1 → PR 8 顺序实施。
> **工作品牌：** EzPic；正式域名、支持邮箱和公司主体必须由环境变量或产品配置提供，禁止散落硬编码。
> **产品参考：** 学习 Raphael 的首屏工具、示例 Prompt、Before/After、credits 和免费转订阅路径；不得复制其品牌、代码、图片、评价或原文案。

---

## 0. 执行口径

这是一份**产品实施计划**，不是基座审计或基座修复计划。

Codex 应接受当前模板已经提供的积分、异步任务、Provider 抽象、私有存储、审核、支付、任务恢复和后台能力，并在其现有接口上开发 EzPic。除非当前 PR 的产品功能确实要求扩展公开接口，否则不得重写这些底层系统。

### 0.1 当前仓库中已确认可复用的入口

- 营销首页：`apps/marketing/app/[locale]/(home)/page.tsx`
- 营销 Hero：`apps/marketing/modules/home/components/HeroSection.tsx`
- 营销草稿生成器：`apps/marketing/modules/generator/components/MarketingGenerator.tsx`
- 营销草稿客户端：`apps/marketing/modules/generator/lib/draft-client.ts`
- 登录后创建页：`apps/saas/app/(authenticated)/(main)/(account)/create/page.tsx`
- 登录后工作区：`apps/saas/modules/media/components/CreatorWorkspace.tsx`
- 通用生成表单：`apps/saas/modules/media/components/GenerationForm.tsx`
- 当前任务结果：`apps/saas/modules/media/components/CurrentGeneration.tsx`
- 任务历史与资产库：`apps/saas/modules/media/components/JobHistory.tsx`、`AssetLibrary.tsx`
- 媒体 API：`packages/api/modules/media/`
- 模型目录和路由：`packages/ai/media/catalog/`
- Provider Registry：`packages/ai/media/registry.ts`
- 产品配置：`packages/config/product.ts`
- 套餐权益：`packages/config/plans.ts`
- Prisma 模型：`packages/database/prisma/schema.prisma`
- 国际化文案：`packages/i18n/translations/{en,de,es,fr}/`

### 0.2 冻结的产品决策

1. **首页主词：** `ai image editor no restrictions`
2. **首页次主词：** `ai image editor with prompt no restrictions`
3. **长期产品母词：** `ai image editor with prompt`
4. **产品本体：** 上传一张图片，用自然语言 Prompt 修改该图片。
5. **MVP 不提供：** 视频、文本生图、公共画廊、图层、画布、蒙版、批量、API、团队共享 credits。
6. **媒体始终私有。**
7. **所有真实 AI 编辑都走现有异步任务、审核、幂等、credits 和 Provider 路由。**
8. **内部稳定产品 ID 保持 `image-fast` 和 `image-quality`。** 不为营销命名大范围迁移 ID；公开名称改为 `Standard Edit` 与 `Quality Edit`。
9. `video-fast` 与 `video-quality` 可以保留在底层目录中，但不出现在 EzPic 的公开 catalog、套餐权益、导航和界面中。
10. **MVP 继续使用现有“匿名草稿 → 登录/注册 → 自动恢复”路径。** 不宣称无需登录即可真实生成。
11. `No Restrictions` 表示更灵活的 Prompt、较少模板锁定、私有上传和透明 credits，不表示 uncensored、无限免费或无安全规则。
12. 首发以英语为唯一可索引语言；现有德语、西语、法语基础设施保留，但语言入口隐藏，未完成产品级翻译的 URL 不进入 sitemap，并设置 `noindex, follow`。

### 0.3 全局工程约束

- PostgreSQL 继续是业务状态唯一真相源。
- 客户端不得提交 Provider ID、模型 ID、模型成本或任意远程 URL。
- 不创建第二套余额、任务或上传系统。
- 每次真实编辑先报价，再由用户确认，随后按既有事务创建 Job、Reservation、Asset 绑定与 Outbox。
- 所有任务异步执行；普通请求不得等待模型完成。
- 所有新功能有明确的未授权、越权、失败、取消、审核拒绝和 credits 不足行为。
- 所有分析事件不得包含 Prompt 原文、图片 URL、签名 URL、Cookie、密钥或 Provider 原始响应。
- 不把固定 KD、DR、外链数、关键词密度、停留时长作为代码验收标准。
- 每个 PR 都必须有业务目标、范围、验收、测试、迁移/回滚和“不包含内容”。
- 每次只实施一个 PR；完成后停止，提交测试证据，等待下一步指令。

### 0.4 目标用户旅程

```text
Google / Direct visit
  → 首页直接看到图片编辑器
  → 上传图片
  → 输入或选择 Prompt
  → 选择 Standard / Quality
  → 创建不产生模型费用的匿名草稿
  → 登录/注册
  → 草稿自动恢复到 /create
  → 查看服务端报价并确认
  → 异步编辑
  → Before/After
  → 下载或 Edit Again
  → 保存到版本历史
  → credits 不足或需要 Quality 时升级订阅
```

---

# PR 1：EzPic 垂直化、品牌配置与 Image-Only 产品合同

**建议标题：** `feat(product): specialize the media foundation for EzPic image editing`
**建议分支：** `codex/ezpic-pr1-product-verticalization`

## 1.1 业务目标

把当前通用图片/视频 SaaS 模板变成一个单一身份清晰的 AI 图片编辑产品，同时不删除底层通用能力。完成后，公开 catalog、套餐和导航只暴露图片编辑，所有品牌和 URL 均可配置。

## 1.2 依赖

无。此 PR 是后续全部产品 PR 的基础。

## 1.3 复用现有能力

- `packages/config/product.ts` 的产品开关、预算、保留期和公开 URL；
- `packages/config/plans.ts` 的套餐权益；
- `packages/ai/media/catalog/catalog.ts` 的稳定产品 ID、credits 和服务端路由；
- Marketing/SaaS 双应用结构；
- next-intl 文案体系；
- 现有 auth、payments、media 页面壳。

## 1.4 主要文件

**修改：**

- `apps/marketing/config.ts`
- `apps/saas/config.ts`
- `packages/config/product.ts`
- `packages/config/plans.ts`
- `packages/ai/media/catalog/catalog.ts`
- `packages/ai/media/catalog/public.ts`
- `packages/ai/media/catalog/catalog.test.ts`
- `apps/marketing/modules/shared/components/NavBar.tsx`
- `apps/marketing/modules/shared/components/Footer.tsx`
- 登录后主导航相关组件（按仓库实际路径）
- `packages/i18n/translations/en/marketing.json`
- `packages/i18n/translations/en/saas.json`
- `packages/i18n/translations/en/shared.json`
- `apps/marketing/app/[locale]/sitemap.ts`
- `apps/marketing/app/[locale]/layout.tsx`
- `apps/saas/app/robots.ts`
- `.env.local.example`

**新增：**

- `docs/product/ezpic-product-contract.md`
- EzPic logo、favicon、OG 占位资产；只使用原创的简单图形，不生成与 Raphael 相似的品牌资产。

## 1.5 功能范围

### A. 品牌与环境配置

- `appName` 统一为 `EzPic`；
- 增加或统一以下配置：
  - `NEXT_PUBLIC_MARKETING_URL`
  - `NEXT_PUBLIC_SAAS_URL`
  - `NEXT_PUBLIC_SUPPORT_EMAIL`
  - `NEXT_PUBLIC_SITE_NAME`
  - `NEXT_PUBLIC_SITE_DESCRIPTION`
- 清除 `supastarter demo`、`example.com` 和通用视频营销文案；
- 生产域名不写死在组件、邮件模板或 schema 中。

### B. 公共产品目录

保持内部 key 不变：

| Internal key    | Public label  | Media kind | Allowed input    | 初始 credits |
| --------------- | ------------- | ---------- | ---------------- | -----------: |
| `image-fast`    | Standard Edit | image      | `image-to-image` |            4 |
| `image-quality` | Quality Edit  | image      | `image-to-image` |           10 |

- 从 EzPic 的 `DEFAULT_PRODUCT_CONFIG.productKeys` 中移除两个视频 key；
- `image-fast` 和 `image-quality` 不再接受 `text-to-image`；
- video catalog 条目可留在底层，但 `getPublicProductCatalog()` 对 EzPic 不返回；
- 公共描述改为图片编辑，而非图片生成；
- 提升 catalog/pricing version；
- 任何 public catalog 响应不得泄露 Provider、模型 ID 或成本。

### C. 套餐初始权益

首版沿用现有 plan IDs：`free`、`creator`、`studio`。

- Free：只允许 `image-fast`；
- Creator：允许两个图片编辑产品；
- Studio：允许两个图片编辑产品；
- 从所有套餐移除 video 产品；
- credits、价格和并发在 PR 2/PR 6 最终冻结；本 PR 保留现值，避免未测成本时拍脑袋重定价。

### D. 导航和索引边界

营销导航只显示：

- Examples
- How It Works
- Pricing
- FAQ
- Sign In / Start Editing

登录后导航只显示：

- Create
- History
- Assets
- Billing/Settings

不显示 Video、Audio、Chatbot、All Models 或公共社区入口。Chatbot 示例路由可以保留代码，但不得出现在 EzPic 导航中。

- `apps/saas` 全站默认不允许搜索引擎索引；
- Marketing 的英文首页、Pricing、Privacy、Terms 可索引；
- 未审校的非英语页面从 sitemap 移除并 `noindex, follow`；
- Locale switch 在首发阶段隐藏，但不删除 i18n 基础设施。

## 1.6 用户故事

- 作为访客，我从任何公开页面都能立即判断 EzPic 是 AI 图片编辑器，而不是通用 AI 平台。
- 作为登录用户，我不会在产品选择中看到视频或文本生图。
- 作为运营者，我能通过配置替换域名、支持邮箱和品牌名，而不修改业务代码。

## 1.7 验收标准

- 全仓库面向用户的页面不再出现 Supastarter/demo/example 品牌；
- public catalog 只返回两个 image-to-image 产品；
- 发送 `text-to-image` 给两个公开图片产品时，服务端报价拒绝；
- Free 不能选择 Quality；Creator/Studio 可以；
- 公共导航没有视频/音频/聊天机器人入口；
- SaaS `robots` 明确阻止索引；
- 英文页面为唯一进入 sitemap 的产品语言；
- 所有配置和 catalog 契约测试通过；
- 原有底层 video Provider/worker 代码未被无关删除或重写。

## 1.8 测试范围

- 更新 `packages/config/config.test.ts`；
- 更新 catalog/public catalog 单元测试；
- 增加套餐允许产品测试；
- 增加 sitemap/robots 测试；
- 增加“禁止 text-to-image”合同测试；
- 运行：
  - `pnpm test:unit:contracts`
  - `pnpm lint --deny-warnings`
  - `pnpm type-check`
  - changed-files format check

## 1.9 迁移与回滚

无数据库迁移。回滚只需恢复产品配置、catalog 文案和导航。不得删除已有 video 数据或历史任务。

## 1.10 不包含

- 首页视觉重做；
- 真实 Provider 基准；
- Before/After；
- Stripe 新价格；
- 真实匿名生成。

---

# PR 2：图片编辑模型基准、Standard/Quality 路由与成本合同

**建议标题：** `feat(ai): certify standard and quality image edit routes`
**建议分支：** `codex/ezpic-pr2-image-edit-routing`

## 2.1 业务目标

使用现有 Provider 抽象和 catalog，为 `image-fast` 与 `image-quality` 选择真正适合 Prompt 图片编辑的路由，并留下可复现的质量、延迟和成本证据。

## 2.2 依赖

PR 1。

## 2.3 复用现有能力

- `packages/ai/media/providers/` 的 Replicate、Fal、Gemini、Kie 适配器；
- `packages/ai/media/catalog/` 的路由和成本字段；
- Provider smoke 工具；
- 服务端预算、circuit breaker 和模型级并发；
- Mock Provider 和合同测试。

## 2.4 主要文件

**修改：**

- `packages/ai/media/catalog/catalog.ts`
- `packages/ai/media/catalog/routing.ts`
- `packages/ai/media/catalog/catalog.test.ts`
- 相关 Provider adapter/config，仅在现有接口缺少目标模型必要字段时做最小扩展
- `.env.local.example`
- 根 `package.json` 或相应 workspace package scripts

**新增：**

- `packages/ai/media/benchmark/image-edit-benchmark.ts`
- `packages/ai/media/benchmark/types.ts`
- `packages/ai/media/benchmark/scorecard.ts`
- `packages/ai/media/benchmark/image-edit-benchmark.test.ts`
- `fixtures/image-edit-benchmark/manifest.json`
- `fixtures/image-edit-benchmark/README.md`
- `docs/product/image-edit-model-benchmark.md`

## 2.5 基准测试合同

至少使用 10 张拥有测试授权的输入图片，覆盖：

1. 商品白底图；
2. 人像；
3. 室内场景；
4. 室外场景；
5. 多物体复杂场景。

每张图至少运行以下任务中的三个，总任务数不少于 30：

- 替换背景；
- 移除常见物体；
- 添加物体；
- 修改颜色/材质；
- 调整光线和氛围；
- 风格转换；
- 局部修改同时保持主体身份。

每次记录：

- Provider 和模型；
- 成功/失败；
- 首次结果是否可用；
- 主体保持评分 1–5；
- Prompt 遵循评分 1–5；
- 视觉质量评分 1–5；
- 延迟 p50/p95；
- Provider 成本；
- 输出尺寸和 MIME；
- 审核拒绝/Provider 拒绝；
- 需要重试次数。

测试素材、评分和原始输出全部私有；报告只引用非敏感汇总。

## 2.6 路由冻结原则

- Standard：优先低延迟和低成本，但可用率必须达标；
- Quality：优先主体保持和 Prompt 遵循；
- 至少一个主路由；备用路由只有在其输入/输出语义与主路由兼容时启用；
- 不允许仅凭模型营销页选择；
- catalog 中 `providerCostMicros` 必须来自实测或 Provider 账单公式；
- credits 若需调整，同时升级 pricing version；
- 客户端仍只看到 Standard/Quality。

建议发布阈值：

- 成功完成率 ≥ 95%；
- 首次可用率：Standard ≥ 70%，Quality ≥ 80%；
- p95 延迟在首页/价格页所述范围内；
- 单次模型成本低于对应 credits 收入预算；
- Provider 返回结果可安全转存到现有私有存储。

## 2.7 验收标准

- `pnpm provider:benchmark:image-edit` 可在显式预算参数下运行；
- 默认 dry-run，不调用付费模型；
- 真跑必须要求 `--confirm-spend` 和最大预算；
- 报告列出 Standard/Quality 的最终选择与弃选理由；
- 两个产品只接受 `image-to-image`；
- public catalog 无 Provider 信息；
- Provider 缺密钥时 fail closed；
- 所有输出继续走远程 URL 安全检查、转存和审核；
- catalog 及 Provider 合同测试通过。

## 2.8 测试范围

- benchmark 参数和预算测试；
- scorecard 聚合测试；
- Provider request mapping fixtures；
- MIME/输出数量/远程 URL 测试；
- catalog 路由和价格版本测试；
- `pnpm provider:smoke` dry-run；
- 标准 unit/contracts、lint、type-check。

## 2.9 迁移与回滚

无数据库迁移。路由和 credits 通过 catalog/pricing version 回滚。已经创建的 Quote/Job 保留其快照，不被新版本回写。

## 2.10 人类输入

执行真实基准前需要：

- 至少一个 Provider 测试账号和密钥；
- 明确最大调用预算；
- 测试图片授权确认；
- 人工评分者。

若这些尚未提供，Codex 先完成 harness、fixtures 和 dry-run 测试，然后停止，不得伪造基准结果。

## 2.11 不包含

- 页面 UI；
- Stripe 定价；
- 批量或蒙版；
- 新 Provider 架构。

---

# PR 3：Raphael 式营销首页、SEO 首屏编辑器与草稿接力

**建议标题：** `feat(marketing): launch the prompt image editor landing experience`
**建议分支：** `codex/ezpic-pr3-marketing-editor`

## 3.1 业务目标

把当前静态 Hero + 通用图片/视频生成器重做为一个首屏即可操作的 AI 图片编辑器。访客可上传图片、输入 Prompt、选择模式并安全接力到登录后工作台，但此 PR 不产生模型费用。

## 3.2 依赖

PR 1；建议在 PR 2 确认模式名称后合并。

## 3.3 复用现有能力

- `MarketingGenerator` 的匿名草稿创建、base64 小图上传和 handoff；
- `/api/media/drafts`、`/draft/continue`、claim token；
- 现有 Hero、Features、Pricing、FAQ 组件；
- consent、analytics provider 和 next-intl；
- Marketing/SaaS 跨域来源限制。

## 3.4 主要文件

**修改：**

- `apps/marketing/app/[locale]/(home)/page.tsx`
- `apps/marketing/modules/home/components/HeroSection.tsx`（可以替换为轻量标题容器）
- `apps/marketing/modules/generator/components/MarketingGenerator.tsx`
- `apps/marketing/modules/generator/lib/draft-client.ts`
- `apps/marketing/modules/generator/lib/draft-client.test.ts`
- `apps/marketing/modules/home/components/FeaturesSection.tsx`
- `apps/marketing/modules/home/components/PricingSection.tsx`
- `apps/marketing/modules/home/components/FaqSection.tsx`
- `packages/i18n/translations/en/marketing.json`
- 首页 metadata/schema 相关文件

**新增：**

- `apps/marketing/modules/image-editor/components/ImageEditorHero.tsx`
- `apps/marketing/modules/image-editor/components/ImageDropzone.tsx`
- `apps/marketing/modules/image-editor/components/SourcePreview.tsx`
- `apps/marketing/modules/image-editor/components/PromptSuggestions.tsx`
- `apps/marketing/modules/image-editor/components/BeforeAfterDemo.tsx`
- `apps/marketing/modules/image-editor/components/ShowcaseSection.tsx`
- `apps/marketing/modules/image-editor/components/NoRestrictionsSection.tsx`
- `apps/marketing/modules/image-editor/components/HowItWorksSection.tsx`
- `apps/marketing/public/examples/*`
- `apps/marketing/public/examples/PROVENANCE.md`

## 3.5 首页 SEO 合同

**Title**

```text
AI Image Editor No Restrictions — Edit Images with Prompts | EzPic
```

**H1**

```text
AI Image Editor With Prompts, Without the Usual Restrictions
```

**Meta Description**

```text
Upload an image and describe the change. Edit backgrounds, objects, colors, lighting and styles with private AI image editing and transparent credits. Start with free credits.
```

不写 `free forever`、`unlimited`、`uncensored`、`no usage limits`、未验证的 `4K`、未验证的 `watermark-free` 或未经法律确认的商用许可。

## 3.6 首屏结构

桌面：左侧输入，右侧 Before/After 示例或上传预览；移动端上下排列。

输入区必须包含：

- 图片上传，JPEG/PNG/WebP；
- 文件大小提示来自服务端配置；
- Prompt；
- Suggested Prompt chips；
- Standard/Quality 选择；
- 模式 credits 提示；
- `Continue to Edit` CTA；
- “真实生成在登录后开始”的明确说明。

营销草稿类型改为：

```ts
{
	productKey: "image-fast" | "image-quality";
	input: {
		kind: "image-to-image";
		prompt: string;
	}
	upload: {
		contentType;
		base64;
	}
}
```

图片和 Prompt 均为必填。营销端只创建草稿，不创建 Quote、Job 或 Reservation。

## 3.7 页面模块顺序

1. 导航；
2. H1 + 首屏编辑器；
3. 可拖动 Before/After 示例；
4. 五类真实编辑 Showcase；
5. What “No Restrictions” Means；
6. How It Works；
7. 隐私/透明 credits/安全说明；
8. 简版 Pricing；
9. FAQ；
10. 最终 CTA；
11. Footer。

Showcase 只使用拥有版权或自行生成的素材，并在 provenance 文件记录来源、生成日期和允许用途。

## 3.8 “No Restrictions”区块

必须准确解释：

- natural-language prompts；
- no template-only workflow；
- private uploads；
- transparent credits；
- fewer unnecessary steps；
- standard safety, legal, provider and usage limits still apply。

## 3.9 用户故事

- 作为访客，我不阅读长文也能在首屏理解产品并开始填写；
- 作为不懂 Prompt 的用户，我能点示例快速开始；
- 作为谨慎用户，我在上传前能看到隐私和文件限制；
- 作为搜索用户，我能确认 `no restrictions` 的实际含义，不会被“无限制”误导。

## 3.10 验收标准

- 首屏 LCP 不被巨大演示视频拖累；
- 图片和 Prompt 缺一不可提交；
- 只接受 JPEG/PNG/WebP 和配置允许大小；
- 示例 Prompt 点击后只填充，不自动提交；
- draft 请求为 `image-to-image` 且包含 upload；
- 成功后通过现有 POST handoff 跳转，不在 query string 暴露 claim token；
- 草稿创建不调用 Provider、不预扣 credits；
- 桌面、平板、手机可用；
- 键盘和屏幕阅读器可完成上传、模式选择和提交；
- 页面没有虚假社交证明和虚假能力；
- metadata、canonical 和 JSON-LD 与实际页面一致。

## 3.11 测试范围

- draft client 类型和错误测试；
- 文件类型/大小/缺 Prompt 测试；
- handoff POST 测试；
- Playwright：访客选择示例、上传、提交、跳转；
- metadata/canonical/schema 测试；
- responsive 截图测试；
- axe/a11y 基础测试；
- 标准 CI。

## 3.12 迁移与回滚

无数据库迁移。旧 Hero/MarketingGenerator 可以保留一个 commit 的可回滚版本；最终不同时渲染两套表单。

## 3.13 不包含

- 匿名真实生成；
- 登录后结果页；
- 多语言发布；
- 大规模 SEO 内页。

---

# PR 4：登录后 Prompt 图片编辑工作区与一次完整编辑

**建议标题：** `feat(editor): deliver the authenticated prompt image editing workflow`
**建议分支：** `codex/ezpic-pr4-editor-workspace`

## 4.1 业务目标

让登录用户从恢复草稿或直接上传开始，完成“上传 → Prompt → 报价 → 确认 → 异步编辑 → Before/After → 下载”的完整主流程。

## 4.2 依赖

PR 1、PR 2、PR 3。

## 4.3 复用现有能力

- `create/page.tsx` 的草稿、reuseJob 和 asset 恢复；
- `CreatorWorkspace`、`GenerationForm`、`CurrentGeneration`；
- `use-generation`、`use-job`；
- MediaUploader、AssetLibrary 和签名预览；
- Quote/Create/Cancel/GetJob ORPC；
- 现有异步任务、credits、审核、Provider 和转存链路。

## 4.4 主要文件

**修改：**

- `apps/saas/app/(authenticated)/(main)/(account)/create/page.tsx`
- `apps/saas/modules/media/components/CreatorWorkspace.tsx`
- `apps/saas/modules/media/components/GenerationForm.tsx`
- `apps/saas/modules/media/components/GenerationFields.tsx`
- `apps/saas/modules/media/components/CurrentGeneration.tsx`
- `apps/saas/modules/media/components/MediaUploader.tsx`
- `apps/saas/modules/media/hooks/use-generation.ts`
- `apps/saas/modules/media/hooks/use-job.ts`
- `apps/saas/modules/media/lib/form-schema.ts`
- `packages/i18n/translations/en/saas.json`

**新增：**

- `apps/saas/modules/media/components/editor/ImageEditorWorkspace.tsx`
- `apps/saas/modules/media/components/editor/ImageSourcePanel.tsx`
- `apps/saas/modules/media/components/editor/PromptPanel.tsx`
- `apps/saas/modules/media/components/editor/EditModeSelector.tsx`
- `apps/saas/modules/media/components/editor/BeforeAfterSlider.tsx`
- `apps/saas/modules/media/components/editor/EditorResultPanel.tsx`
- `apps/saas/modules/media/components/editor/SuggestedPrompts.tsx`
- 相关组件测试

## 4.5 编辑器合同

- source image 必填且必须属于当前用户、状态 READY、未删除；
- Prompt 必填，前后端均限制长度；
- product 仅可为 `image-fast` 或 `image-quality`；
- Form 始终构造 `image-to-image`；
- UI 显示 Standard/Quality，不显示内部 ID；
- 点击 Review 先创建服务端 Quote；
- Quote 显示 credits、模式和过期提示；
- 点击 Confirm 才创建真实 Job 和 Reservation；
- 切换图片、Prompt 或模式后旧 Quote 失效；
- 创建后锁定本次输入快照，不受表单后续修改影响。

## 4.6 结果区

空状态展示可用示例而不是旋转图标；任务开始后展示：

- 阶段文案；
- 进度（Provider 提供时）；
- credits reserved/charged/released 的用户友好摘要；
- 取消按钮只在现有状态机允许时显示；
- 成功后 Before/After；
- Download；
- Edit Again；
- New Edit；
- View Details。

Before/After：

- 左侧必须是本次 Job 实际输入资产；
- 右侧必须是审核通过的输出资产；
- 两端都通过短期签名 URL 获取；
- 不把 URL写入分析或日志；
- 键盘可操作，并提供“显示原图/显示结果”替代控件。

## 4.7 草稿恢复

- claimed draft 自动填充图片、Prompt 和模式；
- 若草稿请求 Quality 但当前 plan 无权使用，保留 Prompt 和图片，模式安全降级为 Standard，并显示升级选项；
- 草稿过期或图片无效时显示明确恢复错误，不创建空任务。

## 4.8 用户故事

- 作为注册用户，我能在一个页面完成完整编辑；
- 作为 Free 用户，我能看到 Quality 但不能绕过 entitlement；
- 作为任务失败用户，我知道 credits 是否退回及下一步；
- 作为手机用户，我能上传、输入、确认、比较和下载。

## 4.9 验收标准

- 没有输入图片时不能报价；
- 客户端篡改 product/model/provider/credits 不会绕过服务端；
- 同一个确认动作使用稳定 Idempotency Key；
- 成功、失败、取消和审核拒绝都有可理解 UI；
- 任务刷新页面后可恢复；
- Before/After 使用准确的输入和输出；
- 下载使用私有签名 URL；
- 其他用户无法查看 Job 或 Asset；
- text-to-image/video 分支不出现在 EzPic editor；
- 移动端完整通过。

## 4.10 测试范围

- form schema/unit；
- Quote invalidation；
- entitlement；
- 草稿恢复；
- Job 状态展示；
- signed preview/download；
- 多用户越权；
- Playwright 成功、失败、取消、刷新恢复、credits 不足；
- a11y；
- 标准 CI 与相关 integration。

## 4.11 数据库迁移

无。版本链在 PR 5 增加；本 PR 使用现有 Job/Asset 关系完成一次编辑。

## 4.12 不包含

- 多轮会话；
- 项目/版本历史；
- 真实匿名生成；
- 蒙版、批量、API。

---

# PR 5：编辑会话、版本链、Prompt 历史与 Edit Again

**建议标题：** `feat(editor): add private edit sessions and version history`
**建议分支：** `codex/ezpic-pr5-edit-sessions`

## 5.1 业务目标

把单次模型调用升级为可持续使用的编辑工作流：用户可以对结果继续编辑、查看每一版 Prompt、回到旧版本并保持完整审计关系。

## 5.2 依赖

PR 4。

## 5.3 设计选择

新增轻量 `ImageEditSession` 聚合模型，不改变 GenerationJob、credits 或 Provider 状态机的职责。

建议 Prisma 模型：

```prisma
model ImageEditSession {
  id          String   @id @default(cuid())
  ownerType   OwnerType
  ownerId     String
  rootAssetId String
  title       String?
  createdAt   DateTime @default(now()) @db.Timestamptz(3)
  updatedAt   DateTime @updatedAt @db.Timestamptz(3)
  jobs        GenerationJob[]

  @@index([ownerType, ownerId, updatedAt, id])
  @@index([rootAssetId])
  @@map("image_edit_session")
}
```

在 `GenerationJob` 增加：

```prisma
editSessionId String?
editSession   ImageEditSession? @relation(fields: [editSessionId], references: [id], onDelete: SetNull)
parentJobId   String?
parentJob     GenerationJob? @relation("ImageEditParent", fields: [parentJobId], references: [id], onDelete: SetNull)
childJobs     GenerationJob[] @relation("ImageEditParent")
```

实际迁移应遵循仓库 Prisma 生成和 migration 约定。`rootAssetId` 在应用层验证归属；若添加外键会导致多态 owner 复杂化，可保持普通 String 并使用事务检查，但必须有索引和删除合同。

## 5.4 主要文件

**修改：**

- `packages/database/prisma/schema.prisma`
- Prisma migration 与生成文件
- `packages/api/modules/media/types.ts`
- `packages/api/modules/media/router.ts`
- `packages/api/modules/media/procedures/create-generation.ts`
- Quote/Create 相关 procedure
- `apps/saas/app/(authenticated)/(main)/(account)/create/page.tsx`
- `apps/saas/modules/media/components/editor/EditorResultPanel.tsx`
- `apps/saas/modules/media/components/JobHistory.tsx`
- `apps/saas/modules/media/components/JobDetail.tsx`
- `apps/saas/modules/media/components/AssetCard.tsx`
- `packages/i18n/translations/en/saas.json`

**新增：**

- `packages/api/modules/media/procedures/list-edit-sessions.ts`
- `packages/api/modules/media/procedures/get-edit-session.ts`
- `packages/api/modules/media/procedures/rename-edit-session.ts`
- `packages/api/modules/media/lib/edit-session.ts`
- `apps/saas/app/(authenticated)/(main)/(account)/edits/page.tsx`
- `apps/saas/app/(authenticated)/(main)/(account)/edits/[sessionId]/page.tsx`
- `apps/saas/modules/media/components/editor/EditSessionList.tsx`
- `apps/saas/modules/media/components/editor/EditVersionTimeline.tsx`
- `apps/saas/modules/media/components/editor/PromptHistory.tsx`
- tests。

## 5.5 业务规则

### 新会话

首个已确认编辑在创建 Job 的同一事务中：

- 验证 root asset 属于用户且 READY；
- 创建 `ImageEditSession`；
- 将 Job 绑定到 session；
- `parentJobId = null`。

### Edit Again

- 只能从自己 session 中已成功且输出审核通过的 Job 开始；
- 新 Job 的 `sourceAssetId` 必须是所选父 Job 的输出；
- `editSessionId` 继承；
- `parentJobId` 指向所选版本；
- 仍重新创建 Quote、审核、Reservation 和异步任务；
- 不复用旧 Quote、旧审核决定或旧 Idempotency Key。

### 版本读取

- session 页面按创建时间展示版本；
- 每版显示缩略图、Prompt、模式、credits、状态和时间；
- 失败版本保留审计但不作为下一次输入；
- 任一成功版本都可成为新分支；
- 当前 MVP 可以线性展示，数据模型允许分支。

### 删除

- 删除输出资产继续使用现有软删除；
- 不删除 Job、Quote、credits ledger 或 session 审计记录；
- 被删除图片显示“asset deleted”，而不是破坏整个时间线；
- 删除 session 在 MVP 只允许隐藏/归档，不级联删除财务记录。

## 5.6 用户故事

- 作为重复编辑用户，我能一键继续修改上一版；
- 作为创作者，我能查看每一版 Prompt 和结果；
- 作为试错用户，我能从较早版本创建新分支；
- 作为隐私敏感用户，我只能访问自己的 session。

## 5.7 验收标准

- 至少连续编辑三轮无需重新上传；
- 每个版本能追溯 root asset、parent job、Prompt、模式和结果；
- 跨用户 session/job/asset 均返回 not found 或 forbidden；
- 父任务失败、未审核或无输出时不能 Edit Again；
- 重复请求不会创建重复 session 或 child job；
- 新版本完整走报价、审核、预扣、异步、结算；
- 历史和资产删除不改变 ledger；
- session 列表支持分页。

## 5.8 测试范围

- Prisma migration；
- session transaction/integration；
- parent/child 权限；
- branching；
- idempotency；
- deleted asset；
- history pagination；
- Playwright：创建、二次编辑、从旧版分支；
- 标准 CI、数据库 integration 和 invariant tests。

## 5.9 迁移与回滚

- 新字段均先 nullable；
- 旧 Job 不回填 session，历史页面继续可见；
- 若回滚代码，新增表和 nullable 字段可以保留，不影响旧流程；
- 不在本 PR 对旧任务执行推测性回填。

## 5.10 不包含

- 文件夹、协作、评论；
- 图层和画布；
- 批量；
- 公共分享链接。

---

# PR 6：图片编辑套餐、Stripe 转化与权益执行

**建议标题：** `feat(billing): package EzPic image editing subscriptions`
**建议分支：** `codex/ezpic-pr6-subscriptions`

## 6.1 业务目标

在不重写支付和积分系统的前提下，建立 Free → Creator → Studio 的订阅闭环，并让套餐权益真正限制模式、并发和输入大小。

## 6.2 依赖

PR 2 的成本基准；PR 4 的编辑主流程。PR 5 可并行，但建议先合并。

## 6.3 复用现有能力

- Stripe Checkout、Portal、Webhook 和 Purchase/Subscription；
- 月付/年付与内部月度 credits；
- Credit Lot、Reservation、Ledger、Refund、Debt；
- `PLAN_ENTITLEMENTS`；
- choose-plan、checkout-return 和 billing settings；
- 现有 pricing 组件。

## 6.4 套餐冻结

在 PR 2 的实测成本未触发调整时，沿用当前 credits：

| Plan    | Monthly credits | Concurrent jobs | Products           | Max image input |        建议价格 |
| ------- | --------------: | --------------: | ------------------ | --------------: | --------------: |
| Free    |              25 |               1 | Standard           |           10 MB |              $0 |
| Creator |           1,000 |               3 | Standard + Quality |           20 MB | $19/月，$190/年 |
| Studio  |           5,000 |              10 | Standard + Quality |           20 MB | $79/月，$790/年 |

公开销售前必须计算“假设用户用满 credits”的模型成本，并确认毛利安全。若不安全，在本 PR 同时调整 credits 或单次任务 credits，并升级 pricing version；不得只改营销文案。

不承诺当前系统未执行的权益，例如优先队列、无限历史、批量或 API。

## 6.5 主要文件

**修改：**

- `packages/config/plans.ts`
- `packages/config/config.test.ts`
- Stripe/Payments 配置与环境 schema
- `apps/marketing/modules/home/components/PricingSection.tsx`
- Marketing pricing 独立页面
- `apps/saas/app/(authenticated)/choose-plan/*`
- `apps/saas/app/(authenticated)/checkout-return/*`
- `apps/saas/modules/payments/*`
- `apps/saas/modules/media/components/GenerationForm.tsx`
- `apps/saas/modules/media/components/editor/EditModeSelector.tsx`
- `packages/i18n/translations/en/marketing.json`
- `packages/i18n/translations/en/saas.json`
- `.env.local.example`

**新增：**

- `docs/product/ezpic-pricing-and-margin.md`
- `apps/saas/modules/payments/components/EditorUpgradeDialog.tsx`
- `apps/saas/modules/payments/components/CreditBalanceSummary.tsx`
- 相关测试 fixtures。

## 6.6 转化规则

- Free 选择 Quality：保留表单，弹出升级；不静默提交 Standard；
- credits 不足：显示本次需要、当前余额和升级 CTA；
- 并发已满：显示正在运行任务并可前往 History；
- Checkout 返回页只显示状态并等待服务端 Webhook，不自行发 credits；
- 订阅成功后回到原编辑草稿/会话；
- Customer Portal 可取消和管理支付方式；
- 年付仍按现有内部月度周期发 credits；
- 退款、Debt 和失败任务 credits 继续使用现有账本语义。

## 6.7 Pricing 文案

只销售已实现权益：

- monthly credits；
- Standard/Quality access；
- concurrent jobs；
- private assets；
- edit sessions/history；
- input size。

隐私对所有套餐成立，不能作为付费墙。`No Restrictions` 不能等同无限使用。

## 6.8 验收标准

- Free 无法通过 API 使用 Quality；
- Creator/Studio entitlement 正确；
- Checkout、Portal、月付、年付和取消正常；
- Webhook 重放不重复发 credits；
- 页面返回不发权益；
- 订阅后原草稿/session 能恢复；
- 退款和 Debt 测试保持通过；
- 套餐数字有单一配置来源；
- Pricing 页面和运行时 entitlement 一致；
- 毛利文档基于 PR 2 数据，不使用虚构成本。

## 6.9 测试范围

- plan schema/config；
- entitlement API；
- insufficient credits；
- Stripe fixtures：checkout、renewal、cancel、partial/full refund；
- annual monthly grant；
- webhook idempotency；
- checkout-return E2E；
- resume edit after upgrade；
- 标准 CI 和 payments integration。

## 6.10 迁移与回滚

不改变现有账本 schema。Stripe Price IDs 由环境配置。若价格尚未创建，付费 CTA fail closed 并显示暂不可用，不能使用假 Price ID。

## 6.11 人类输入

- Stripe test/live Product 和 Price IDs；
- 最终法定卖方名称；
- 退款政策；
- PR 2 成本报告确认。

## 6.12 不包含

- credit packs；
- Organization 计费；
- 团队套餐；
- API/批量；
- 未实现的“优先队列”营销承诺。

---

# PR 7：SEO 内容、产品分析与运营诊断

**建议标题：** `feat(growth): add SEO content, product analytics, and editor operations`
**建议分支：** `codex/ezpic-pr7-growth-operations`

## 7.1 业务目标

让 EzPic 能获取自然搜索流量、衡量从首页到订阅的完整漏斗，并让运营者按产品/Provider 发现质量、成本和任务问题。

## 7.2 依赖

PR 3–PR 6。

## 7.3 SEO 范围

首发只强化首页和必要信任页面，不批量造长尾页。

可索引：

- `/`；
- `/pricing`；
- `/privacy`；
- `/terms`；
- `/content-policy`（若仓库已有法律路由，沿用实际 slug）。

SaaS、登录、历史、资产、编辑会话、checkout 和 admin 全部 noindex。

首页完成：

- 精确 Title/H1/description；
- canonical；
- OG/Twitter；
- `WebSite`、`Organization`、真实 `SoftwareApplication`；
- Showcase；
- Supported edits；
- How It Works；
- No Restrictions 解释；
- 隐私与安全；
- Pricing；
- FAQ。

FAQ 以帮助用户为目的，不规定关键词出现次数，不依赖 FAQ rich result。

## 7.4 分析事件

统一在共享事件模块定义事件名和无敏感 payload schema：

- `landing_viewed`
- `example_prompt_selected`
- `source_upload_started`
- `source_upload_completed`
- `marketing_draft_created`
- `auth_handoff_started`
- `draft_claimed`
- `editor_quote_created`
- `editor_generation_confirmed`
- `editor_generation_succeeded`
- `editor_generation_failed`
- `result_compared`
- `result_downloaded`
- `edit_again_started`
- `edit_session_opened`
- `upgrade_prompt_viewed`
- `checkout_started`
- `subscription_activated`

允许属性：plan、product key、状态、credits bucket、latency bucket、匿名 session hash。禁止 Prompt、文件名、asset URL、job 原始 ID、邮箱、Provider raw response。

## 7.5 主要文件

**修改：**

- `apps/marketing/modules/analytics/*`
- Marketing/SaaS `ClientProviders`
- 首页各模块
- metadata、sitemap、robots
- `apps/saas/modules/media/*` 中核心事件触发点
- `apps/saas/modules/admin/*`
- `packages/api/modules/media/procedures/admin-diagnostics.ts`
- `packages/api/modules/media/procedures/admin-operations.ts`
- `packages/i18n/translations/en/marketing.json`
- `packages/i18n/translations/en/saas.json`
- Privacy、Terms、Content Policy
- `.env.local.example`

**新增：**

- `packages/analytics/editor-events.ts`，若仓库没有共享 analytics package，则放入现有 analytics 模块而不新建 package
- `apps/saas/modules/admin/components/EditorOperationsDashboard.tsx`
- `docs/operations/ezpic-metrics-and-alerts.md`
- `docs/seo/ezpic-launch-seo-contract.md`

## 7.6 运营面板

在现有后台之上增加过滤和汇总，不创建第二套任务系统：

- 按 Standard/Quality、Provider、模型、状态、日期过滤；
- 成功率；
- p50/p95 延迟；
- 平均 Provider 成本；
- 审核拒绝率；
- failure code；
- credits reserved/charged/released；
- session 二次编辑率；
- 当前 kill switch/product enabled 状态。

只展示运营需要的汇总和安全标识，不展示 Prompt 原文或私有图片。

## 7.7 核心指标

- Homepage → upload；
- Upload → draft；
- Draft → sign-up；
- Claimed draft → quote；
- Quote → confirm；
- Confirm → success；
- Success → download；
- Success → Edit Again；
- Free activated → paid；
- D1/D7 return；
- 成功编辑单位成本；
- Creator/Studio 估算毛利；
- GSC impressions/clicks/CTR/rank。

## 7.8 验收标准

- GSC 验证文件/标签可配置；
- sitemap 仅包含批准页面和语言；
- canonical 指向生产 marketing origin；
- SaaS 不索引；
- JSON-LD 的 price/offer 与实际套餐一致；
- Analytics 中无法检索 Prompt、签名 URL 或私有素材；
- 漏斗事件可在选定分析工具中串联；
- admin 只对管理员开放；
- 首页文案与真实能力一致；
- Showcase 有来源记录；
- 不创建相互抢词的 `free/no restrictions/with prompt` 重复页。

## 7.9 测试范围

- event schema 和敏感字段拒绝；
- consent gate；
- metadata/canonical/sitemap/robots；
- JSON-LD validation；
- admin authorization；
- aggregate query；
- Playwright 漏斗事件；
- SEO snapshot；
- 标准 CI。

## 7.10 迁移与回滚

优先使用现有 Job/Attempt/Subscription 数据聚合；非必要不新增 analytics 数据表。外部 analytics 通过 feature flag 和环境变量关闭后不影响生成主流程。

## 7.11 不包含

- 外链建设；
- 关键词内容矩阵；
- 多语言 SEO；
- 用户私有作品画廊；
- 排名承诺。

---

# PR 8：Staging 认证、第三方生产配置与公开上线

**建议标题：** `chore(release): certify EzPic staging and production launch`
**建议分支：** `codex/ezpic-pr8-production-launch`

## 8.1 业务目标

把已经实现的产品接到真实外部服务，在独立 Staging 完成费用、恢复、安全、性能和支付验证，然后以可回滚方式公开上线。

## 8.2 依赖

PR 1–PR 7 全部合并。

## 8.3 主要范围

### A. 环境

- 独立 dev/test/staging/production；
- 不共享数据库、bucket、Stripe webhook secret 或 Trigger environment；
- production 禁用 Mock Provider 和测试审核器；
- 所有生产 secrets 仅在托管平台配置。

### B. 第三方服务

- PostgreSQL；
- Trigger.dev Cloud；
- S3/R2 私有 bucket；
- Standard/Quality Provider；
- Sightengine 或最终审核服务；
- Stripe；
- Sentry；
- PostHog/GSC；
- 邮件 Provider。

### C. 验证场景

至少完成：

1. 注册、验证、登录、草稿恢复；
2. Standard 成功；
3. Quality 成功；
4. Provider 明确失败并退回 credits；
5. Provider 超时/不确定提交恢复；
6. 审核拒绝；
7. 用户取消可取消任务；
8. Before/After 和签名下载；
9. Edit Again 三轮；
10. Checkout；
11. 月度 credits；
12. 年付内部月度 credits；
13. 取消订阅；
14. 部分/全额退款和 Debt；
15. Webhook 重放；
16. 丢失事件由对账恢复；
17. 资产软删除和物理清理；
18. 全局/产品关闭；
19. Sentry 告警；
20. 恢复和回滚演练。

### D. 性能与成本

- Marketing Core Web Vitals；
- 上传并发；
- Quote/Create API；
- Job polling；
- signed URL；
- admin aggregate；
- k6 负载和预算；
- 实际 p50/p95 延迟；
- 单次成功编辑成本；
- 套餐满额成本和毛利。

## 8.4 主要文件

- `.env.local.example`
- 部署配置文件；
- Trigger.dev 配置；
- Provider smoke/benchmark 脚本；
- k6 场景；
- Playwright production-like 配置；
- `docs/operations/ezpic-production-runbook.md`
- `docs/operations/ezpic-launch-checklist.md`
- `docs/operations/ezpic-rollback.md`
- `docs/product/ezpic-final-cost-model.md`
- 必要的 feature flags 和 kill switch 配置。

## 8.5 上线门槛

- 全量 CI 通过；
- Staging Playwright 主流程通过；
- Provider 基准和 smoke 通过；
- Stripe test mode 完整账期通过；
- 私有上传/转存/下载/清理通过；
- Prompt 和输出审核通过；
- 无 Mock/Test adapter；
- Sentry 告警可到达；
- k6 无关键错误或预算泄漏；
- pricing/credits 通过毛利检查；
- domain、DNS、SSL、canonical、sitemap、robots、GSC 正确；
- Runbook 能由未参与开发的人按步骤执行；
- rollback 演练成功。

## 8.6 生产发布策略

- 先以受控流量发布；
- Guest 真实生成保持关闭；
- Standard 先开，Quality 可单独 feature flag；
- 设置每日 Provider 成本预算；
- 设置错误率/延迟/审核异常告警；
- 上线后 24–72 小时监控任务、支付和成本，再逐步放量。

## 8.7 验收输出

- `docs/operations/ezpic-launch-checklist.md` 全部有证据；
- 记录部署 revision；
- 记录第三方 endpoint/environment 名称但不写 secrets；
- 记录已知限制；
- 记录回滚步骤；
- 记录上线后的首周监控指标。

## 8.8 不包含

- 多语言扩张；
- 视频；
- API；
- 团队订阅；
- 真实匿名首编；
- 排名和收入保证。

---

# 9. P1：真实匿名首编（不在上述 MVP PR 中）

Raphael 式“先得到结果再注册”有价值，但当前模板的正式所有者是 USER/ORGANIZATION，现有营销路径是匿名草稿接力。为了避免为 SEO 文案引入新的 credits 所有权和滥用风险，真实匿名生成不进入 PR 1–PR 8。

只有 MVP 上线后以下条件同时满足，才单独立项：

- Standard 单次成本稳定；
- 有全局每日预算和 kill switch；
- 有 IP/device/session/CAPTCHA 联合防滥用；
- 有匿名媒体短期保留和自动删除；
- 能在不建立旁路余额的情况下复用现有 Reservation/Ledger；
- 登录后可安全认领结果；
- 产品数据显示登录墙显著损害激活。

该功能必须单独写 spec，不得静默混入营销 PR。

---

# 10. PR 依赖与合并顺序

```text
PR 1  产品垂直化
  ↓
PR 2  模型基准与路由
  ↓
PR 3  营销首页与草稿
  ↓
PR 4  登录后编辑器
  ↓
PR 5  会话与版本历史
  ↓
PR 6  套餐与订阅
  ↓
PR 7  SEO、分析和运营
  ↓
PR 8  Staging 与上线
```

PR 3 的纯 UI 工作可在 PR 2 基准期间并行，但合并时必须基于最终 Standard/Quality 产品合同。PR 5 和 PR 6 可以并行开发，最终需要在 PR 7 前共同合并。

---

# 11. 每个 PR 的统一交付格式

PR 描述必须包含：

1. Business goal；
2. User-visible changes；
3. Existing foundation reused；
4. Files and interfaces changed；
5. Database migration；
6. Security/privacy/cost impact；
7. Test commands and exact results；
8. Screenshots or recording for UI PR；
9. Rollback；
10. Explicitly not included。

Codex 每完成一个 PR 后必须停止，并汇报：

- branch/worktree；
- commits；
- changed files；
- migrations；
- test results；
- screenshots；
- unresolved items；
- external credentials or human actions required。

不得在同一轮自动开始下一个 PR。

---

# 12. MVP Definition of Done

以下全部成立才算产品 MVP 完成：

- 公开站只表达 AI 图片编辑；
- 首页主词和产品体验一致；
- 用户能上传图片、输入 Prompt、创建草稿、登录恢复；
- 用户能得到报价并确认异步任务；
- Standard 和 Quality 至少有已认证路由；
- 输入和输出私有并审核；
- 用户能查看 Before/After、下载和 Edit Again；
- 至少三轮编辑版本可追溯；
- Free/Creator/Studio 权益和 Stripe 生效；
- GSC、产品漏斗和运营指标可用；
- 成本和毛利经过真实数据验证；
- Staging、恢复、关闭、压力和回滚完成；
- 不存在虚假的 unlimited、uncensored、free forever、no-sign-up generation、4K 或 watermark-free 声明；
- 视频、批量、API、团队订阅、公共画廊和多语言扩张未进入首版。
