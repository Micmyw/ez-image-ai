# PR-F2：Provider 路由一致性与不确定提交语义

## PR 标题

`fix(ai): unify provider routing and preserve uncertain submissions`

## 业务目标

保证产品目录、模型路由、Provider registry 和运行时配置只有一套可验证的路由图；当外部提交结果不明确时，冻结原任务并恢复原 Provider，而不是错误退款或向第二个 Provider 重复生成。

## 来源发现

- FND-002：Provider 配置、registry 与 catalog 路由可能不一致；
- FND-002：异常 HTTP 2xx 被误判为明确拒绝。

## 冻结合同

### 1. 单一启用路由图

运行时必须能够从一个受控入口得到：

```text
Product ID
  -> server-side route candidates
  -> provider adapter
  -> provider model identifier
  -> pricing/cost metadata
  -> enabled/disabled state
```

不得出现：

- catalog 声明产品可用，但 registry 没有 adapter；
- registry 注册了 adapter，但配置引用不存在的 route/model；
- 前端产品列表和任务 worker 使用不同的路由来源；
- disabled Provider 仍可被旧 catalog 选中；
- 同一 Product ID 在不同进程解析为不同路由。

启动时和 CI 中运行配置验证；生产发现不一致时 fail closed，并允许全局/产品级 kill switch 生效。

### 2. 三态提交结果

适配层必须表达三类结果。可以沿用现有类型名，但语义必须等价：

- `accepted`：远程任务 ID 已验证并持久化，或同步结果已完整持久化；
- `rejected`：能证明 Provider 未接单；
- `uncertain`：不能证明是否接单。

下列情况默认 `uncertain`：

- 2xx 但缺少任务 ID、输出或必要字段；
- 2xx 响应无法解析或 schema 校验失败；
- 请求体可能已发送后的 timeout、socket reset、连接中断；
- Provider 返回未在其适配器中明确分类的状态；
- 业务响应自相矛盾；
- Webhook 地址注册结果未知。

不得用“HTTP 是 2xx”推断 accepted，也不得用“响应无任务 ID”推断 rejected。

### 3. Provider 专属分类

每个 Provider adapter 必须显式定义：

- 哪些响应能证明 accepted；
- 哪些错误能证明 rejected；
- 哪些状态可在同一 Provider 安全重试；
- 哪些状态只能进入 reconcile；
- 是否支持 Provider 级 idempotency key；
- 如何查询原提交；
- 如何验证 webhook 签名；
- 如何取消。

没有明确定义的情况落入 uncertain。

### 4. 提交尝试持久化

在发起外部请求之前持久化 submission attempt，至少关联：

- generation task；
- route/provider/model；
- stable attempt ID；
- request fingerprint；
- provider idempotency key（若支持）；
- attempt number；
- created timestamp；
- outcome state。

外部调用后，在数据库中记录 accepted/rejected/uncertain 和经过脱敏的分类证据。不得把原始 Provider 响应、密钥或签名 URL 写进日志/Sentry。

### 5. 路由切换

- accepted：继续原任务；
- uncertain：禁止 release、用户取消和备用 Provider 提交，进入现有对账/恢复状态；
- rejected：按现有路由策略决定是否释放或尝试下一个候选；
- 任何备用路由都必须复用同一个业务任务，不产生第二次用户扣费；
- 同一 attempt 重放不能产生第二次外部提交。

## 用户故事

### US-F2.1 配置错误提前失败

作为运维人员，我希望错误的 Provider/catalog 配置在启动或部署阶段被发现，而不是在用户任务中随机失败。

### US-F2.2 异常 2xx 不重复生成

作为用户，当 Provider 接收请求但返回异常 2xx 时，系统不会退款后再切换另一个 Provider，使我得到两份结果并让平台承担双重成本。

### US-F2.3 可恢复任务

作为管理员，我能看到 uncertain attempt 的证据、原 Provider 和恢复动作，并优先查询原任务。

## 测试矩阵

每个启用 Provider 至少测试：

- 正常 accepted；
- 明确拒绝；
- 2xx 缺任务 ID；
- 2xx 无效 JSON；
- 2xx schema 不完整；
- 4xx 明确不接单（仅在该 Provider 合同支持时）；
- 429；
- 5xx；
- 请求发送前连接失败；
- 请求发送后连接中断；
- timeout；
- webhook 后到；
- 轮询发现原任务；
- 同一 attempt 重放；
- kill switch；
- catalog 引用未注册 route；
- disabled Provider 被引用；
- 不同进程配置一致性。

使用本地 fake HTTP server/adapter contract tests 模拟响应，不要求真实付费调用即可验证状态机。

## 验收标准

- catalog、registry、runtime config 有单一验证入口；
- CI 对所有启用产品执行路由图验证；
- 异常 2xx 被归类为 uncertain；
- uncertain 不 release、不切换 Provider、不允许用户取消；
- attempt 在外部调用前持久化；
- 重放不重复提交；
- 管理后台能查看 attempt 状态和恢复；
- 所有启用 Provider 通过同一合同测试套件。

## 不包含

- 新增更多 Provider；
- EzPic Standard/Quality 最终模型选择；
- 模型成本定价；
- Provider 大规模真实容量认证；
- UI 重构。

## 回滚

- 保留原任务与 attempt 数据；
- 允许通过产品/Provider kill switch 停止新提交；
- 不允许通过回滚恢复“异常即 rejected”的旧行为；
- schema 迁移若新增 attempt 字段必须向后兼容旧任务恢复。
