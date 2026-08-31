# EzPic Product Contract Reference

> Read `00-global-contract.md` before this PR.

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
