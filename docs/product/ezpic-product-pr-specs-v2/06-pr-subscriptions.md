# EzPic Product Contract Reference

> Read `00-global-contract.md` before this PR.

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
