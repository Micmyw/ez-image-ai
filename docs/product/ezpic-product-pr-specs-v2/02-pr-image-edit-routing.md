# EzPic Product Contract Reference

> Read `00-global-contract.md` before this PR.

# PR 2：图片编辑模型基准、Standard/Quality 路由与成本合同

**建议标题：** `feat(ai): certify standard and quality image edit routes`
**建议分支：** `codex/ezpic-pr2-image-edit-routing`

## 2.1 业务目标

使用现有 Provider 抽象和 catalog，为 `image-fast` 与 `image-quality` 选择真正适合 Prompt 图片编辑的路由，并留下可复现的质量、延迟和成本证据。

## 2.2 依赖

PR 1。

## 2.3 复用现有能力

- `packages/ai/media/providers/` 的 Replicate、Fal、Gemini、Kie 适配器；
- `packages/ai/media/catalog/` 的路由和成本字段；
- Provider smoke 工具；
- 服务端预算、circuit breaker 和模型级并发；
- Mock Provider 和合同测试。

## 2.4 主要文件

**修改：**

- `packages/ai/media/catalog/catalog.ts`
- `packages/ai/media/catalog/routing.ts`
- `packages/ai/media/catalog/catalog.test.ts`
- 相关 Provider adapter/config，仅在现有接口缺少目标模型必要字段时做最小扩展
- `.env.local.example`
- 根 `package.json` 或相应 workspace package scripts

**新增：**

- `packages/ai/media/benchmark/image-edit-benchmark.ts`
- `packages/ai/media/benchmark/types.ts`
- `packages/ai/media/benchmark/scorecard.ts`
- `packages/ai/media/benchmark/image-edit-benchmark.test.ts`
- `fixtures/image-edit-benchmark/manifest.json`
- `fixtures/image-edit-benchmark/README.md`
- `docs/product/image-edit-model-benchmark.md`

## 2.5 基准测试合同

至少使用 10 张拥有测试授权的输入图片，覆盖：

1. 商品白底图；
2. 人像；
3. 室内场景；
4. 室外场景；
5. 多物体复杂场景。

每张图至少运行以下任务中的三个，总任务数不少于 30：

- 替换背景；
- 移除常见物体；
- 添加物体；
- 修改颜色/材质；
- 调整光线和氛围；
- 风格转换；
- 局部修改同时保持主体身份。

每次记录：

- Provider 和模型；
- 成功/失败；
- 首次结果是否可用；
- 主体保持评分 1–5；
- Prompt 遵循评分 1–5；
- 视觉质量评分 1–5；
- 延迟 p50/p95；
- Provider 成本；
- 输出尺寸和 MIME；
- 审核拒绝/Provider 拒绝；
- 需要重试次数。

测试素材、评分和原始输出全部私有；报告只引用非敏感汇总。

## 2.6 路由冻结原则

- Standard：优先低延迟和低成本，但可用率必须达标；
- Quality：优先主体保持和 Prompt 遵循；
- 至少一个主路由；备用路由只有在其输入/输出语义与主路由兼容时启用；
- 不允许仅凭模型营销页选择；
- catalog 中 `providerCostMicros` 必须来自实测或 Provider 账单公式；
- credits 若需调整，同时升级 pricing version；
- 客户端仍只看到 Standard/Quality。

建议发布阈值：

- 成功完成率 ≥ 95%；
- 首次可用率：Standard ≥ 70%，Quality ≥ 80%；
- p95 延迟在首页/价格页所述范围内；
- 单次模型成本低于对应 credits 收入预算；
- Provider 返回结果可安全转存到现有私有存储。

## 2.7 验收标准

- `pnpm provider:benchmark:image-edit` 可在显式预算参数下运行；
- 默认 dry-run，不调用付费模型；
- 真跑必须要求 `--confirm-spend` 和最大预算；
- 报告列出 Standard/Quality 的最终选择与弃选理由；
- 两个产品只接受 `image-to-image`；
- public catalog 无 Provider 信息；
- Provider 缺密钥时 fail closed；
- 所有输出继续走远程 URL 安全检查、转存和审核；
- catalog 及 Provider 合同测试通过。

## 2.8 测试范围

- benchmark 参数和预算测试；
- scorecard 聚合测试；
- Provider request mapping fixtures；
- MIME/输出数量/远程 URL 测试；
- catalog 路由和价格版本测试；
- `pnpm provider:smoke` dry-run；
- 标准 unit/contracts、lint、type-check。

## 2.9 迁移与回滚

无数据库迁移。路由和 credits 通过 catalog/pricing version 回滚。已经创建的 Quote/Job 保留其快照，不被新版本回写。

## 2.10 人类输入

执行真实基准前需要：

- 至少一个 Provider 测试账号和密钥；
- 明确最大调用预算；
- 测试图片授权确认；
- 人工评分者。

若这些尚未提供，Codex 先完成 harness、fixtures 和 dry-run 测试，然后停止，不得伪造基准结果。

## 2.11 不包含

- 页面 UI；
- Stripe 定价；
- 批量或蒙版；
- 新 Provider 架构。

---
