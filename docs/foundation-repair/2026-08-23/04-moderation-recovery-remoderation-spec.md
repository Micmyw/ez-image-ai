# PR-F4：审核耗尽恢复与任务重试重新审核

## PR 标题

`fix(moderation): recover exhausted checks and re-evaluate retried tasks`

## 业务目标

让审核 Provider 异常不会使输入永久卡在 `VERIFYING`，并确保用户重试任务时按当前内容和当前政策重新审核，而不是复用已经过期或不匹配的证据。

## 依赖

必须建立在 PR-F3 的 AssetVersion + content hash 合同之上。

## 来源发现

- FND-006：输入审核重试耗尽后可能永久停留 `VERIFYING`；
- FND-007：任务重试可能复用旧审核证据。

## 冻结状态机语义

Codex可以沿用现有 enum 名称，但行为必须满足：

- 待处理；
- 正在验证；
- 已批准；
- 已拒绝；
- 审核服务异常、需要重新排队或人工处理；
- 最终归档。

`VERIFYING` 只能表示当前确实有活跃 attempt 或仍在可自动恢复窗口内。达到最大重试次数后必须原子地：

- 结束当前 attempt；
- 将证据转为非批准、可诊断状态；
- 记录错误分类、attempt 数和 next action；
- 允许管理员重新排队；
- 按产品策略允许用户稍后重新发起审核；
- 保持 fail closed，不创建生成任务。

不得通过把异常默认为通过来解决卡单。

## 审核证据合同

一条可复用证据必须同时匹配：

- owner/resource boundary；
- assetVersionId；
- content hash；
- normalized prompt hash；
- moderation provider；
- provider model/rule set；
- internal policy version；
- evidence kind（input/output）；
- 尚未失效的有效期；
- verdict 为 approved。

任何一项变化，旧证据不能授权新任务。

## 重试分类

### 1. 内部幂等重放

同一个 moderation attempt 因 worker 重试而重放：

- 可以读取同一 attempt 的已持久化结果；
- 不创建第二条逻辑证据；
- 不重复调用 Provider，除非现有恢复策略需要且有稳定 idempotency。

### 2. 用户重试生成任务

用户点击 Retry/Edit Again 或重新创建业务任务：

- 重新报价；
- 重新解析当前 input version 与 Prompt；
- 按当前 policy/rule version 创建新的 moderation attempt；
- 旧证据只作审计，不能直接授权；
- 审核通过后才允许创建 Reservation 和 generation task。

### 3. 管理员重放

管理员重放必须选择：

- 重试同一审核 attempt；或
- 以当前规则创建新 attempt。

操作需原因、操作者和 Idempotency Key。

## 超时与重试

- transient error 使用有上限的指数退避；
- retry policy 在配置中可见；
- 每次 attempt 的错误分类持久化；
- exhaustion 后离开 VERIFYING；
- 定时 recovery job 只领取符合条件的记录，并使用锁/lease 防重复；
- worker 崩溃留下的过期 lease 可以恢复；
- 用户界面显示“审核暂时不可用，可稍后重试”，而不是永久 spinner。

## 与任务/积分的关系

按原规格，输入审核应发生在创建生成任务和预扣之前：

- 审核拒绝或异常不创建任务、不预扣；
- 如果当前代码先预扣，Codex必须在设计说明中说明并修正为同一冻结合同，或请求产品所有者决策；
- 输出审核异常时，结果保持隔离，Reservation 按既有输出恢复合同处理，不公开资产；
- 不因审核 Provider 异常切换生成 Provider 或重复生成。

## 用户故事

### US-F4.1 审核服务故障

作为用户，审核服务故障后我不会无限看到“验证中”；系统会给出可重试状态，且不会扣生成积分。

### US-F4.2 当前规则重新审核

作为平台，当规则更新后，旧任务重试会按新规则评估。

### US-F4.3 内容版本绑定

作为平台，图片内容变化后，即使逻辑 asset ID 相同，旧审核也不能授权新版本。

## 测试

- transient error 后成功；
- 达到最大 attempts 后离开 VERIFYING；
- worker 在状态更新前/后崩溃；
- recovery job 重放；
- 两个 recovery worker 并发；
- 用户 retry 创建新 attempt；
- policy version 变化；
- prompt 变化；
- assetVersion/hash 变化；
- 完全相同的内部幂等 replay 不重复 Provider 调用；
- 旧 evidence 过期；
- rejected evidence 不可复用；
- output moderation error 保持隔离；
- 管理员 requeue 审计。

## 验收标准

- 数据库中不存在超过恢复窗口仍无活跃 attempt 的永久 VERIFYING 记录；
- exhaustion 有明确状态、错误与 requeue 动作；
- 用户任务重试总是按当前规则创建审核 attempt；
- 证据绑定 AssetVersion/hash/prompt/policy；
- 审核失败不创建任务或旁路预扣；
- admin 操作可审计；
- 定时恢复幂等且并发安全。

## 不包含

- 修改内容政策本身；
- 更换 Sightengine；
- 放宽安全限制；
- EzPic 页面文案；
- 生成 Provider 路由修复（PR-F2）。

## 回滚

- 可以关闭自动 requeue，但不能恢复永久 VERIFYING；
- 新 evidence 字段应向后兼容历史记录；
- 无法证明有效的 legacy evidence 默认不可授权新任务。
