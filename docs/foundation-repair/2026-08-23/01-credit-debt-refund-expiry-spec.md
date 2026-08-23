# PR-F1：积分 Debt、退款、Reservation 与过期不变量

## PR 标题

`fix(credits): enforce debt, refund, reservation, and expiry invariants`

## 业务目标

确保退款、活动任务、积分过期和欠款并发发生时，不会让用户免费获得生成结果、重复获得积分、继续创建新任务或丢失审计链。

## 来源发现

- FND-001：正 Debt 不阻止新任务；
- FND-001：退款后的活动 Reservation 成功结算可能不产生 Debt；
- 审计要求人类确认 Debt、退款后成功结算和积分过期合同。

执行前，Codex 必须从 `docs/repository-capability-audit.md` 抄录精确模型、服务、函数和测试位置。本 spec 不允许它猜路径或新建旁路账本。

## 冻结不变量

### 1. 新任务门禁

在创建生成任务、Reservation、Allocation 和初始 Outbox 的同一事务内：

- 锁定用户 Credit Account；
- 若账户 `debt > 0`，拒绝创建任务；
- 不创建 Reservation、Allocation、任务或 Outbox；
- 返回稳定错误码，例如现有命名体系中的 `CREDIT_DEBT_OUTSTANDING`；
- 前端文案由翻译层处理，数据库层不保存营销文案。

不得只在 UI 或预报价接口检查 Debt；真正门禁必须在写事务中执行。

### 2. 已存在 Reservation

Debt 出现在 Reservation 创建之后时：

- 不取消已提交任务；
- 不释放仍可能产生成本的 Reservation；
- 成功任务继续结算；
- 失败或安全取消任务继续释放；
- 最终账本必须反映退款与任务结果的组合。

### 3. 退款与锁定积分

退款处理需要区分：

- 可撤销、未锁定积分；
- 活动 Allocation 锁定积分；
- 已结算消费积分；
- 已过期积分。

合同：

- 未锁定余额立即撤销；
- 活动 Allocation 不被删除、不改绑到其他 Lot；
- 若活动任务成功，结算后形成等于“已消费但已退款”的 Debt；
- 若活动任务失败或取消，释放回原 Lot，但原 Lot 已退款时保持不可消费；
- 已消费部分在退款时直接形成 Debt；
- 重放退款或任务终态事件不重复变更。

### 4. Grant 与 Debt

任何会增加用户 credits 的业务 Grant：

1. 先偿还现有 Debt；
2. 写入不可变 Debt repayment ledger entry；
3. 仅将剩余部分创建为可消费 Lot；
4. 同一个 Grant 引用键重放结果一致。

这包括订阅首次 Grant、续费 Grant、人工 Grant 和补偿 Grant；如果现有系统对某类促销 Grant 有明确隔离合同，Codex必须在设计说明中列出并由产品所有者批准例外。

### 5. 过期

- 新 Reservation 只能选择未过期、未撤销、可消费 Lot；
- Reservation 创建后 Lot 过期，不改变 Allocation；
- 成功结算可消费已锁定 Allocation；
- 失败释放回已过期 Lot 时，不增加可消费余额；
- 过期清理不能删除活动 Allocation、Ledger 或审计引用；
- 可用余额查询不能把过期释放算回可用额度。

### 6. 并发与锁顺序

必须定义并统一以下事务的锁顺序：

- reserve；
- settle；
- release；
- refund/revoke；
- grant/debt repayment；
- expire。

目标是避免：

- deadlock；
- 两个事务同时消费同一余额；
- refund 与 settle 互相覆盖；
- debt repayment 与 reserve 同时通过。

沿用现有数据库与 service patterns，不新增独立余额缓存作为真相源。

## 用户故事

### US-F1.1 欠款阻断

作为有退款欠款的用户，我不能继续消费平台 credits，直到欠款被有效 Grant 或管理员账本调整偿还。

**验收：** Debt 为正时，报价可以展示，但任务写事务拒绝且没有副作用。

### US-F1.2 退款期间任务成功

作为平台，我在用户退款后仍能对已经被 Provider 接收的任务正确结算，并记录该结果产生的 Debt。

**验收：** 结果可按既有策略交付或隔离，但不能出现“退款后免费成功且无 Debt”。

### US-F1.3 退款期间任务失败

作为平台，失败任务释放的退款积分不会重新变为可消费余额。

### US-F1.4 过期期间任务完成

作为用户，我在积分有效期内启动的任务可以完成；但失败释放的已过期积分不会延长有效期。

## 必须新增的测试场景

### 单元/服务测试

- Debt 为正时 reserve 被拒绝；
- Debt 为零时既有流程不变；
- Grant 小于 Debt：全部用于还债，无新 Lot；
- Grant 等于 Debt：Debt 清零，无新 Lot；
- Grant 大于 Debt：剩余部分成为 Lot；
- 重放同一 Grant 不重复还债。

### 数据库 integration/invariant

- reserve 与 refund 并发；
- settle 与 refund 并发，两种提交顺序都满足相同财务结果；
- release 与 refund 并发；
- grant 与 reserve 并发；
- expiry 与 settle 并发；
- expiry 与 release 并发；
- 同一终态重复处理；
- Reservation 创建前 Debt 检查与任务写入处于同一事务；
- 所有 Ledger 引用键唯一且重放幂等。

### 回归

- 正常订阅 Grant；
- 正常生成成功/失败；
- 部分退款与全额退款调用现有入口；
- 管理员人工调整审计。

## 迁移要求

Codex先判断现有 schema 是否足以表达：

- revoked/expired Lot；
- Debt repayment；
- refund 与 reservation 的稳定引用。

如果需要迁移：

- 不重写历史 Ledger；
- backfill 必须可重复运行；
- 对无法判断的历史状态生成诊断报告，不自动猜测；
- migration 和 backfill 分离，生产执行有 Runbook；
- 新约束先检测冲突，再启用。

## 管理后台

- 展示 Debt 来源、偿还记录和关联退款；
- 展示退款发生时的活动 Reservation；
- 管理员清债必须填写原因和 Idempotency Key；
- 不允许直接编辑余额字段。

## 验收标准

- FND-001 两个子问题均有失败测试后修复；
- Debt 门禁位于写事务，不只位于 API/UI；
- 活动 Reservation 在退款后成功会形成正确 Debt；
- 活动 Reservation 在退款后失败不会恢复可消费积分；
- 过期合同全部有 integration tests；
- 未引入第二套余额或旁路账本；
- 原有 Ledger 不可变性保持；
- PR 描述列出锁顺序和并发测试证据。

## 不包含

- Stripe worker 自动重试；
- Stripe API 对账；
- 套餐价格和积分数量；
- EzPic 产品页面；
- Organization 计费重构。

## 回滚

- 代码可 revert；
- 账本迁移不得删除历史；
- 若生产发现问题，使用 feature flag 暂停新生成，不允许关闭 Debt 门禁作为回滚；
- 数据修复必须通过新的审计 Ledger entry，不直接 UPDATE 历史流水。
