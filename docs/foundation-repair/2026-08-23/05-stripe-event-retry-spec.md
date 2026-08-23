# PR-F5：Stripe 事件持久化、worker 自动重试与可观测性

## PR 标题

`fix(payments): retry failed Stripe event processing durably`

## 业务目标

确保 Stripe Webhook 事件在业务处理失败时不会因为 worker 正常返回 `FAILED` 而被 Trigger.dev 当成成功；每个事件都能自动重试、人工重放并保持幂等。

## 来源发现

- FND-004：Stripe worker 失败后正常返回 `FAILED`，Trigger.dev 不会自动重试。

## 冻结处理模型

### 1. Webhook 接收

HTTP route 必须：

1. 验证 Stripe 签名；
2. 使用 Stripe event ID 幂等持久化事件；
3. 保存必要、受控的事件 payload 或可恢复引用；
4. 记录 received 状态；
5. 可靠排队；
6. 在 durable persistence 成功后返回 2xx。

验签失败或无法持久化时不得返回成功。

### 2. Worker 成功定义

worker 只有以下情况正常返回：

- 业务副作用已在事务中完成；
- 事件此前已成功处理，是幂等重复；
- 事件被明确分类为当前系统无需处理，并持久化为 terminal ignored。

以下情况必须抛出可重试错误：

- 数据库暂时不可用；
- 锁冲突或超时；
- 下游内部任务暂时失败；
- Stripe API 暂时不可用且当前事件需要查询；
- 任何没有完成业务副作用的 transient failure。

不能通过 `return { status: "FAILED" }` 或等价正常返回结束。

### 3. Terminal failure

不可重试的业务或 schema 错误：

- 持久化失败分类和安全摘要；
- 进入 dead-letter / needs-review；
- 触发告警；
- 管理后台可查看和重放；
- worker 结束行为必须和 Trigger 最大尝试策略一致，不能无限热循环。

### 4. Claim 与幂等

- 一个事件同时只能被一个 worker 处理；
- 使用数据库 lock/lease 或现有等价机制；
- lease 过期可恢复；
- 业务副作用和 processed 状态尽量处于同一事务；
- processed 不得先于业务 commit；
- event ID 与业务 reference key 双重防重；
- 乱序由对象状态机和后续 reconciliation 处理，不靠“最后到达覆盖一切”。

### 5. Trigger.dev

- 明确配置最大 attempts、backoff 和超时；
- test 中验证 worker 抛错会被 Trigger wrapper 视为失败；
- 记录 attempt number 和最后错误分类；
- 达到最大 attempts 后进入可见 dead-letter；
- 手工 replay 使用稳定 Idempotency Key。

## 用户故事

### US-F5.1 临时数据库故障

作为平台，数据库短暂失败不会永久丢掉 Stripe 续费事件；worker 自动重试并最终只发一次权益。

### US-F5.2 重复 Webhook

作为平台，Stripe 重发相同 event 不会重复 Grant、退款或改变状态。

### US-F5.3 人工恢复

作为运营人员，我能看到处理失败原因并安全重放，不需要直接改数据库。

## 测试

- 签名失败；
- event persistence 失败；
- 相同 event 并发接收；
- worker transient failure 抛错；
- worker 返回成功只发生在 commit 后；
- commit 成功但 ack/worker 结束前崩溃，重放幂等；
- dead-letter；
- admin replay；
- unsupported event terminal ignored；
- 乱序事件不回退对象终态；
- 日志不含 secret、Cookie、私有 URL 或完整敏感 payload。

建议提供一个专门的 Trigger contract test，直接断言旧的“正常返回 FAILED”路径不存在。

## 管理后台与监控

至少展示：

- event ID/type/object reference；
- received/processing/retry/dead-letter/succeeded；
- attempts；
- last error classification；
- next retry；
- replay 操作及审计；
- processing lag 和 dead-letter 告警。

## 验收标准

- 所有 transient failures 通过 throw/Trigger failure 进入自动重试；
- 重放不会重复副作用；
- dead-letter 可观察、可审计、可重放；
- route durable persistence 后才 2xx；
- processing 状态和副作用 commit 顺序正确；
- 定向测试证明 FND-004 已关闭。

## 不包含

- 完整 Stripe API 定时对账（PR-F6）；
- 退款积分合同（PR-F1/PR-F6）；
- Pricing 页面；
- 新套餐；
- 生产 Stripe 账期认证。

## 回滚

- 可暂停 worker 消费但保留已持久化事件；
- 不删除 dead-letter；
- 不允许回滚为“失败正常返回”；
- schema migration 保持事件历史可读。
