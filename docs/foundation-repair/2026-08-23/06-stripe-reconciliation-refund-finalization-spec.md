# PR-F6：Stripe 真实对账与退款最终状态

## PR 标题

`fix(payments): reconcile Stripe state and finalize refunds idempotently`

## 依赖

- PR-F1：积分退款、Debt、Reservation 合同；
- PR-F5：Stripe event durable processing 与自动重试。

## 业务目标

让定时对账以 Stripe 为外部支付真相源校正本地订阅、账期和退款状态，并且只在退款真正进入最终成功状态后执行一次积分撤销/Debt 处理。

## 来源发现

- FND-005：定时订阅对账不查询 Stripe；
- FND-005：退款最终状态处理不完整；
- FND-001：退款与活动 Reservation 的 Debt 结果不完整。

## 冻结合同

### 1. 真相源边界

- PostgreSQL 是内部业务状态与积分账本真相源；
- Stripe 是支付对象、订阅、invoice/payment/refund 外部状态真相源；
- 定时对账必须调用 Stripe test/live API 获取当前外部状态；
- 不允许只扫描本地表后把本地值再次写回本地，称为“对账”。

### 2. 对账对象

根据仓库当前 Stripe 集成，至少覆盖：

- Customer 映射；
- Subscription 状态和周期；
- Checkout/Payment/Invoice 结果；
- 月付/年付内部账期；
- 取消和到期；
- 部分与全额退款；
- 退款失败/等待/最终成功；
- 丢失或延迟的 Webhook；
- 本地存在但 Stripe 不存在的异常记录。

具体事件名与 status enum 必须以仓库安装的 Stripe SDK 和实施时官方文档为准，不在本 spec 猜版本。

### 3. 单调状态

- 使用 Stripe object ID 和稳定内部 reference；
- 记录外部更新时间/event created 或现有等价版本；
- 旧事件不能把最终成功/取消等终态回退；
- 对账不得覆盖更新的本地已验证状态；
- 状态冲突进入明确诊断，不静默选择随机值。

### 4. 退款执行

退款记录分为：

- received/pending；
- final succeeded；
- final failed/canceled 或等价终态；
- needs review。

只有 Stripe 确认 final succeeded 时：

1. 以 refund ID 作为幂等引用；
2. 计算对应 Grant/credits 的撤销范围；
3. 调用 PR-F1 的唯一退款账本服务；
4. 处理未锁定、活动 Reservation 和已消费积分；
5. 写入 Refund/Debt Ledger；
6. 标记内部退款业务处理完成。

pending 不执行不可逆积分撤销。failed/canceled 不应保留已错误撤销的结果；如果旧代码已提前撤销，需要前向补偿方案，不能删除流水。

### 5. 部分退款

- 按实际退款金额和原购买/订阅权益合同计算撤销 credits；
- 使用确定性舍入规则；
- 多次部分退款累计不超过原始可撤销权益；
- 相同 refund 重放不重复撤销；
- 不同 refund 依次执行仍满足总额上限；
- 活动 Reservation 的结果遵循 PR-F1。

### 6. 对账恢复

对账发现：

- Webhook 丢失：补建/补处理外部事件等价业务动作；
- 本地状态陈旧：以幂等事务修正；
- 无法自动判断：进入 needs-review，不进行破坏性猜测；
- Stripe API 暂时失败：记录 retry，不把本地订阅错误地取消；
- account mapping 缺失：告警和人工处理。

## 用户故事

### US-F6.1 丢失续费事件

作为订阅用户，即使某个 Webhook 丢失，定时对账也能从 Stripe 恢复正确账期和权益，且只发一次 credits。

### US-F6.2 Pending refund

作为平台，退款尚未最终成功时不会提前撤销 credits；最终成功后才执行一次。

### US-F6.3 退款后任务完成

作为平台，退款期间已锁定任务成功后会形成正确 Debt，而不是免费完成。

## 测试

### Stripe fixtures/test double

- webhook 正常 + reconcile；
- webhook 丢失 + reconcile；
- webhook 延迟；
- event 乱序；
- subscription active/canceling/canceled/renewed；
- invoice/payment failure 后恢复；
- refund pending -> succeeded；
- refund pending -> failed/canceled；
- 全额退款；
- 多次部分退款；
- 相同 refund 重放；
- refund 与 active reservation settle/release 两条路径；
- Stripe API transient failure；
- stale object/event 不回退终态。

### 真实 Stripe test mode 门禁

在 PR-F7 或本 PR 合并前的 staging 证据中完成：

- Checkout；
- 月付首次权益；
- test clock 或等价续费；
- 取消；
- 部分退款；
- 全额退款；
- Webhook 重发；
- 临时禁用 webhook 后由 reconcile 恢复；
- 对账重复运行幂等。

## 管理后台

- subscription/payment/refund 对账差异；
- external vs internal state；
- last reconciled at；
- automatic repair result；
- needs-review queue；
- replay/reconcile 操作审计。

## 验收标准

- 定时 job 确实调用 Stripe API；
- 丢失 Webhook 可以被对账恢复；
- 退款只有 final success 才撤销 credits；
- 部分/全额退款和重放幂等；
- active Reservation 的成功/失败路径满足 PR-F1；
- 乱序不会回退终态；
- Stripe API 故障不会错误取消用户权益；
- FND-005 与退款相关 FND-001 关闭。

## 不包含

- 新价格和套餐；
- Organization billing；
- 一次性 credit pack 新产品；
- EzPic Checkout UI；
- 生产 live-mode 销售。

## 回滚

- 可以关闭自动 repair，仅保留 read-only reconciliation 报告；
- 不删除外部事件或账本历史；
- 已执行的错误财务动作使用补偿 Ledger，不直接反向 UPDATE；
- 退款幂等引用必须保留。
