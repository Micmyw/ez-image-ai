# EzPic Product Contract Reference

> Read `00-global-contract.md` before this PR.

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
