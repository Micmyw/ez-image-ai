# EzPic 基座修复计划：审计门禁后的实施总纲

> 日期：2026-08-23  
> 目标工作树：`D:\AIProject\Gefei\SaaSTool\ez-image-ai\.worktrees\ezpic-pr1`  
> 原审计分支：`codex/ezpic-pr1`  
> 产品规格：`docs/product/2026-08-23-ezpic-ai-image-editor-spec.md`  
> 审计报告：`docs/repository-capability-audit.md`

## 1. 决策

不要把当前阻断项放进一个“大修复 PR”，也不要静默混入 EzPic 产品 PR 1。

当前问题跨越六个独立的高风险边界：

1. 积分账本、Debt、退款与过期；
2. Provider 配置一致性与不确定提交；
3. 私有上传的不可变性与资产版本绑定；
4. 审核耗尽恢复与重试重新审核；
5. Stripe 事件处理的自动重试；
6. Stripe 真实对账与退款最终状态。

这些问题涉及不同数据库不变量、外部服务语义、恢复策略和回滚边界。合成一个 PR 会导致：

- 代码审查无法确定每个不变量是否单独成立；
- 一个子系统回滚时连带回滚其他修复；
- 并发、幂等和迁移错误难以定位；
- 产品页面改动掩盖财务和数据安全变更；
- 测试失败时无法判断责任边界。

因此采用 **8 个 PR**：1 个审计基线 PR、6 个修复 PR、1 个复验门禁 PR。

## 2. 证据边界

本方案依据：

- 产品所有者提供的基座功能说明；
- Codex 在本地 worktree 上完成的审计摘要；
- 原 EzPic 产品规格；
- 当前可访问 GitHub 安装中的仓库元数据。

当前 GitHub 连接能访问的是 `unhappycat/base-ai-supastarter-template` 的 `main`，而不是用户所述 `Micmyw/ai-supastarter-template` 或本地 `ez-image-ai` 审计 revision。可访问仓库的 `main` 也没有暴露本地审计所述完整媒体基座，因此它不能替代本地 worktree 作为代码真相源。

**执行时以本地 worktree 与 `docs/repository-capability-audit.md` 的精确代码引用为准。** 每个修复 PR 开始前，Codex 必须把审计中的文件、函数、数据库模型和测试引用复制进该 PR 的设计说明；不得根据本文件猜文件路径。

## 3. 原始阻断项编号

| 编号 | 阻断项 | 风险等级 | 修复 PR |
|---|---|---:|---|
| FND-001 | 正 Debt 不阻止新任务；退款后活动 Reservation 成功结算可能不产生 Debt | Critical | PR-F1、PR-F6 |
| FND-002 | Provider 配置、registry、catalog 路由不一致；异常 2xx 被视为明确拒绝 | Critical | PR-F2 |
| FND-003 | 单 PUT URL 指向最终资产 key，审核后仍可被旧 URL 覆盖 | Critical | PR-F3 |
| FND-004 | Stripe worker 失败后正常返回 `FAILED`，Trigger.dev 不自动重试 | Critical | PR-F5 |
| FND-005 | 定时订阅对账不查询 Stripe；退款最终状态不完整 | High/Critical | PR-F6 |
| FND-006 | 输入审核重试耗尽后可能永久停留 `VERIFYING` | High | PR-F4 |
| FND-007 | 任务重试可能复用旧审核证据，而不是当前规则重新审核 | Critical | PR-F4 |

## 4. PR 顺序与依赖

```text
PR-F0 审计证据基线
  ├─ PR-F1 积分、Debt、退款、过期不变量
  ├─ PR-F2 Provider 路由与提交语义
  ├─ PR-F3 不可变上传与资产版本
  │    └─ PR-F4 审核恢复与重新审核
  ├─ PR-F5 Stripe 事件执行与自动重试
  │    └─ PR-F6 Stripe 对账与退款最终状态
  │         └─ 依赖 PR-F1
  └─ PR-F7 全量复验与产品开发解锁
```

可并行：

- PR-F1、PR-F2、PR-F3、PR-F5 可以在独立分支并行开发；
- PR-F4 必须建立在 PR-F3 的资产版本/指纹合同上；
- PR-F6 必须建立在 PR-F1 的退款/Debt 合同和 PR-F5 的事件处理合同上；
- PR-F7 必须基于全部修复合并后的集成分支。

## 5. 冻结的业务合同

除非产品所有者在编码前明确推翻，以下合同视为冻结。

### 5.1 Debt

- `debt > 0` 的用户不能创建任何新的、会预扣用户积分的生成任务；
- Debt 不自动取消已经存在的 Reservation；现有任务继续走到成功、失败或取消；
- 新订阅 Grant、续费 Grant、人工 Grant 先偿还 Debt，剩余部分才成为可消费积分；
- 管理员只能通过不可变账本调整清除 Debt，必须有原因、操作者和 Idempotency Key；
- 前端余额不能把 Debt 隐藏成普通“余额不足”，必须返回稳定、可翻译的欠款错误码。

### 5.2 退款与活动 Reservation

- 退款发生时，不得破坏活动 Reservation 的 Allocation；
- 被退款批次中未锁定、未消费的积分立即撤销；
- 活动 Reservation 后续成功结算时，如果其 Allocation 已不再由有效 Grant 支撑，差额必须形成 Debt；
- 活动 Reservation 后续失败或安全取消时，释放的积分返回原批次，但若该批次已经退款/撤销/过期，则保持不可消费，不得重新增加可用余额；
- 同一退款事件、结算事件或释放事件重放不得重复产生 Debt、撤销或返还。

### 5.3 积分过期

- 已过期 Lot 不能参与新的 Reservation；
- Lot 在 Reservation 创建后过期，不影响该 Reservation 继续结算；
- 过期后成功结算仍消费原 Allocation；
- 过期后失败释放回原 Lot，但该余额仍为过期、不可消费；
- 过期清理不得删除仍被活动 Allocation 引用的审计记录。

### 5.4 Provider 提交结果

每次外部提交只能归为三类：

1. **accepted**：存在经过校验的远程任务标识，或同步结果已经完整持久化；
2. **rejected**：Provider 适配器能证明请求没有被接收，允许安全释放或按策略选择备用路由；
3. **uncertain**：无法证明是否接单，包括异常 2xx、响应体缺字段、网络中断、请求发送后超时以及未明确映射的状态。

默认必须是 `uncertain`，不是 `rejected`。只有 `rejected` 才能自动切换第二个 Provider。

### 5.5 私有媒体

- 客户端永远不能获得最终资产 key 的写 URL；
- 客户端只上传到一次性 staging key；
- 服务端验证大小、MIME、文件头并计算内容指纹后，写入全新不可变 final version；
- 旧上传 URL 即使仍有效，也只能覆盖 staging 对象，不能改变已审核资产；
- 审核证据绑定 `assetVersionId + content hash`，而不是只绑定逻辑 asset ID 或 object key。

### 5.6 审核

- 审核重试耗尽后必须离开 `VERIFYING`，进入可诊断、可重新排队、但不可生成的状态；
- 用户发起的任务重试必须按当前审核 Provider、规则版本和策略版本重新审核；
- 只有同一个审核 attempt 的内部幂等重放，才可以复用同一证据；
- 任何输入内容、Prompt、规则版本或策略版本变化都会使旧证据失效；
- 审核异常一律 fail closed，不创建生成任务，也不公开输出。

### 5.7 Stripe

- Webhook route 只负责验签、幂等持久化和排队；持久化成功后可以快速确认接收；
- worker 只有在业务处理成功或确认是幂等重复时才能正常返回；
- 可重试失败必须抛出错误，让 Trigger.dev 执行重试；
- 不可重试失败进入可见的 dead-letter/人工处理状态，不能伪装成成功；
- 定时对账必须查询 Stripe，而不是只查询本地数据库；
- 退款只有在 Stripe 确认最终成功状态后才执行不可逆积分撤销；
- 事件乱序和重复不得把已终态对象回退为旧状态。

## 6. PR 列表

| PR | 标题 | 业务价值 | 依赖 |
|---|---|---|---|
| PR-F0 | Commit foundation audit baseline | 固化审计证据和 revision | 无 |
| PR-F1 | Enforce credit debt, refund, and expiry invariants | 防止欠款用户继续消费及退款漏债 | F0 |
| PR-F2 | Unify provider routing and uncertain submission semantics | 防止重复生成、错误退款和错误切换 Provider | F0 |
| PR-F3 | Make uploaded assets immutable after verification | 防止审核后媒体被旧签名 URL 替换 | F0 |
| PR-F4 | Recover exhausted moderation and re-moderate retries | 防止永久卡单和过期审核证据复用 | F3 |
| PR-F5 | Make Stripe event workers retryable and observable | 防止支付事件静默丢失 | F0 |
| PR-F6 | Reconcile Stripe subscriptions and finalize refunds safely | 防止订阅/退款状态漂移和重复扣回 | F1、F5 |
| PR-F7 | Re-run foundation invariants and unlock EzPic PR 1 | 形成可审计的开发解锁门禁 | F1–F6 |

## 7. 产品 PR 的解锁门禁

### Gate A：允许恢复 EzPic 产品 PR 1（营销首页，不产生模型费用）

必须满足：

- FND-001 至 FND-007 在复验报告中均为 `closed`；
- PR-F1 至 PR-F6 已合并到同一 integration revision；
- PostgreSQL integration、ledger invariant、MinIO storage integration 和相关 contract tests 通过；
- 无新增未迁移数据库差异；
- changed files 定向格式检查、lint、type-check、unit/contracts 通过；
- PR-F7 生成新的 `docs/repository-capability-audit.md` 或附录，包含精确代码证据。

### Gate B：允许开始原产品 PR 2（真实图片编辑）

除 Gate A 外，还需要：

- Trigger.dev staging 真实执行；
- 主/备 Provider 的最小真实认证与预算批准；
- S3/R2 staging 上传、不可变转存、签名读取和删除验证；
- 生产审核 Provider staging 验证；
- Standard/Quality 候选模型、测试集授权和成本阈值冻结。

### Gate C：允许开始原产品 PR 4（公开销售订阅）

除 Gate A 外，还需要：

- Stripe test mode 完整 Checkout、续费、取消、部分退款、全额退款和事件重放；
- 定时对账实际调用 Stripe test API；
- 年付内部月度 Grant 流程验证；
- 退款后活动 Reservation 成功/失败两条路径验证；
- 毛利模型和套餐 credits 冻结。

## 8. 格式化基线

当前全树 `pnpm format:check` 被既有 Windows/CRLF 基线阻断。基座修复 PR 不得顺手格式化 781 个无关文件。

每个修复 PR：

- 只格式化和检查 changed files；
- PR 描述中记录全树基线仍存在；
- 不修改原产品规格副本的字节内容；
- 若未来要统一换行符，单独创建机械化格式 PR，不和任何业务修复混合。

## 9. 执行方式

将本目录复制到：

```text
docs/foundation-repair/2026-08-23/
```

先让 Codex 执行 `codex-kickoff.md`，并且一次只实施一个 PR。每个 PR 合并前必须输出：

- 精确代码位置；
- 迁移和回滚；
- 新增/修改的不变量；
- 测试命令和结果；
- 未验证的外部服务边界；
- 下一 PR 是否被解锁。
