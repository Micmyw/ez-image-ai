# EzPic Product Contract Reference

> Read `00-global-contract.md` before this PR.

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
