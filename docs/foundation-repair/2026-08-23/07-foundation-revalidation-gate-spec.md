# PR-F7：基座全量复验与 EzPic 产品开发解锁

## PR 标题

`test: revalidate media SaaS foundation invariants`

## 业务目标

在 F1–F6 合并后的同一 revision 上运行此前缺失的 integration、invariant、storage、worker 和端到端测试，逐项关闭原 blocker，并明确哪些产品 PR 被解锁。

## 范围

### 1. 更新审计

更新 `docs/repository-capability-audit.md` 或新增日期化复验附录：

| Finding | 原证据 | 修复代码 | 失败测试 | 通过测试 | 结论 |
|---|---|---|---|---|---|
| FND-001 | ... | ... | ... | ... | closed/open |

每项必须有精确文件路径、函数、测试和 revision。

### 2. Linux 集成环境

Windows Docker daemon 不可用不是跳过集成测试的长期理由。选择一种明确环境：

- WSL2 + Docker；
- 独立 Linux staging；
- GitHub Actions service containers；
- 其他隔离 Linux CI。

必须有独立：

- PostgreSQL test database；
- MinIO 或兼容 S3 test bucket；
- 不使用生产数据和生产凭据。

### 3. 测试矩阵

#### 基础

- `pnpm install --frozen-lockfile`；
- Prisma generation 和 schema drift；
- `pnpm lint --deny-warnings`；
- `pnpm type-check`；
- `pnpm test:unit:contracts`；
- changed files format；
- `git diff --check`。

#### PostgreSQL / Ledger

- 所有 PR-F1 integration 与 invariant tests；
- 并发 reserve/refund/settle/release/grant/expire；
- deadlock/serialization retry；
- migrations on empty DB；
- migrations on representative existing snapshot；
- rollback/forward-fix Runbook。

#### Provider

- PR-F2 fake server matrix；
- catalog/registry/config validation；
- uncertain recovery；
- idempotent attempt replay；
- no alternate Provider on uncertain。

#### Storage

- PR-F3 MinIO attack regression；
- multipart；
- staging cleanup；
- signed GET/PUT boundaries；
- asset hash/version binding。

#### Moderation

- PR-F4 exhaustion；
- requeue；
- policy/hash changes；
- stale evidence rejection；
- output quarantine。

#### Stripe

- PR-F5 retry/dead-letter；
- PR-F6 reconciliation/refund fixtures；
- 具备账号时运行 Stripe test-mode certification；
- 没有账号时明确保持 Gate C 关闭，不能写“已生产验证”。

#### E2E/Load

- 相关 Playwright：上传、审核错误、任务创建门禁、支付事件 admin 诊断；
- k6 对 reserve、upload complete、webhook intake/replay 的最小 smoke；
- 敏感信息日志检查。

### 4. 格式基线

- 全树 781 个 CRLF 基线单独记录；
- 本 PR 不做全树机械格式化；
- 所有 changed files 必须通过 formatter；
- 若 CI 仍强制全树 format，创建独立格式基线决策，不将无关改写混入修复历史。

## 解锁规则

### 允许恢复原 EzPic PR 1

只有当：

- FND-001 至 FND-007 全部 closed；
- code-level integration 全部通过；
- 不存在 unresolved Critical；
- audit 明确标记外部服务尚未认证的边界；
- 产品 PR 1 仍不产生模型费用、不公开销售。

### 原 EzPic PR 2 保持关闭，直到

- 真实 Provider 最小认证；
- Trigger.dev staging；
- S3/R2 staging；
- 生产审核 adapter；
- 模型测试集、预算和阈值。

### 原 EzPic PR 4 保持关闭，直到

- Stripe test-mode 全账期和退款认证；
- reconciliation 真调用证据；
- 定价/毛利冻结。

## 验收标准

- 原 blocker 一一对应关闭证据；
- 此前未运行的 Postgres/MinIO/invariant/Playwright 已在隔离环境运行；
- 失败测试在修复前可复现、修复后通过；
- 外部真实服务未验证项不被冒充通过；
- 生成 `docs/foundation-repair-readiness.md`，明确 Gate A/B/C 状态；
- PR 描述给出下一步唯一允许动作。

## 不包含

- EzPic 首页实现；
- 新模型调用；
- 生产部署；
- 多语言；
- SEO 内容。

## 回滚

本 PR 主要是测试和文档。发现 blocker 未关闭时不回滚测试，而是保持产品开发门禁关闭并回到对应修复 PR。
