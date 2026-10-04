# 视频功能 GitHub 审核说明

本分支 `codex/video-v1-release` 用于代码审核。比较基线是 `main` 的
`e4f6b81fd8fc8e769b975e6c59177a1afefa06a9`，不是最初方案中的旧版本。
当前交付阶段是审核分支；没有把本分支合并到生产主分支、执行生产迁移或开放视频功能。
完整分支路径见 [改动清单](video-v1-review-files.md)，职责落点见
[实际文件地图](video-v1-file-map.md)，验证结果见
[分支验证记录](../operations/video-v1-review-branch-verification.md)。

对 `4a7294c0` 的外部审核提出了有声视频大小、付费前存储预留和输出到期清理三项问题。
后续修复与新验证单独记录在 [审核修复报告](../operations/video-v1-review-fixes-2026-10-04.md)，
原始验证记录保留为历史证据。

三项修复已获外部源码复审认可。后续的 CI 接入、部署配置一致性修复与真实验收前置条件见
[发布前验证说明](../operations/video-v1-prerelease-validation.md)。CI 状态以 GitHub Actions 中对应完整 SHA 的结果为准。

复审请同时检查 `packages/database/prisma/queries/media/video-v1-storage.ts` 的冻结预算、
准入预留、付费提交检查和 job-key 到 asset-key 的原子迁移，以及同账户上传并发。
`video-v1-cleanup.ts` 的候选扫描与锁内重查须遵守 `deleteAfter`；未来期限和无期限的已交付内容不能提前清除。
转存的 100 MiB 上限与 SeeAPI 的 100,000,000 字节审核上限是两道独立限制；超过后者仍不得交付。

| 交付维度         | 当前状态                                                                   |
| ---------------- | -------------------------------------------------------------------------- |
| 代码实现         | 首轮三项修复已获源码复审认可；后续补齐 CI 与部署配置检查                   |
| 本地与 Mock 验证 | 最新完整集成命令 1577 项通过，主库与隔离库不变量通过；5 项可选测试 NOT_RUN |
| 真实外部服务验收 | BLOCKED / NOT_RUN；凭据存在不等于模型、价格或回调验收                      |
| 生产功能开放     | NOT_RUN；本轮不合并主分支、不迁移生产、不部署                              |

## 最终范围

- 登录白名单内测：文生视频、单图生视频，独立 `VideoGenerationWorkflowV1`。
- 模型及属性以服务端能力目录为准，支持已实现模型的时长、分辨率、画幅和原生声音。
  没有确认接口或价格的模型保持不可提交，不能伪装为可用模型。
- 提示词使用 Waffo；输入图片和生成视频画面使用 SeeAPI。Sightengine 全量退役。
- 用户已将语音审核移出本批：原生声音选项保留，新任务冻结
  `audioSafetyPolicy={schemaVersion:1,mode:"not_requested"}`，不产生音频审核通过证据。
  历史仍要求音频审核的任务不能静默降级。
- 复用账号、支付、不可变积分账本、Supabase PostgreSQL、Hyperdrive 和私有 R2。
  不增加游客视频试用，不改生产域名和首页图片定位。
- 定价约束为 **利润 / 完整可变成本 >100%**，当前计算默认 110% 加价目标。
  它不是“销售额毛利率超过 100%”。正式成本配置缺失时不能报价。
  模型参数、来源与计算方式见 [模型和定价记录](../product/video-model-pricing.md)。

## 建议审核顺序

| 范围               | 主要入口                                                                                                                                                                        | 必须检查的问题                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 请求、报价、积分   | `packages/api/modules/video-v1/router.ts`、`packages/jobs/src/video-v1/admission.ts`、`packages/database/prisma/queries/media/video-v1.ts`                                      | 身份/白名单、不可变参数、价格和审核配置绑定；并发与重复提交只预留一次                                     |
| 文本审核与付费提交 | `packages/jobs/src/video-v1/submission.ts`、`text-moderation.ts`、`packages/database/prisma/queries/media/video-v1-execution.ts`                                                | 同份提示词、完整 Waffo ALLOW 证据、有效期、缓存、发送前持久化 fence；不确定提交不能重试                   |
| 工作流与恢复       | `apps/workflows/src/video-orchestrator.ts`、`video-runtime.ts`、`packages/jobs/src/video-v1/recovery.ts`                                                                        | 浏览器关闭仍运行；正常执行不包装旧 WorkerJobs/全局 Outbox；恢复不创建新付费尝试                           |
| Kie 接口           | `packages/ai/media/providers/kie-video-models.ts`、`kie-video-v1.ts`、`packages/jobs/src/video-v1/webhooks.ts`                                                                  | 真实模型/参数组合、回调验证、状态重查、丢响应后的原尝试恢复                                               |
| SeeAPI 回调        | `packages/jobs/src/video-v1/seeapi-webhooks.ts`、`seeapi-callback-url.ts`、`packages/database/prisma/queries/media/video-v1-seeapi-events.ts`                                   | 原始 body 验签、任务专属 URL proof、先持久化、幂等、早到/重复/迟到通知、租约和崩溃预算                    |
| 转存与交付         | `packages/jobs/src/video-v1/output-storage.ts`、`fulfillment.ts`、`packages/database/prisma/queries/media/video-v1-fulfillment.ts`、`packages/api/modules/video-v1/playback.ts` | 转存失败只恢复转存；审批、结算、播放绑定同一私有对象的 checksum/etag/generation/attempt/task              |
| 图片兼容与 SG 退役 | `packages/jobs/src/runtime.ts`、`packages/database/prisma/queries/media/assets.ts`、`packages/config/content-safety.ts`、`packages/api/modules/media/lib/text-moderation.ts`    | 无可执行 SG fallback；旧未完成任务挂起；旧有效批准仍受完整证据约束；旧真实拒绝保持原计费；故障不能 BYPASS |
| 价格和退款         | `packages/config/video-pricing.server.ts`、`packages/database/prisma/queries/media/paid-credit-funding.ts`、`packages/payments/provider/refund-funding-lock.ts`                 | 全部可变成本、最低付费积分收入、向上取整、退款并发和资金来源，不能用赠送积分假装收入                      |
| 前端               | `apps/saas/modules/video-v1/`、`packages/config/video-models.ts`                                                                                                                | 仅提交公共产品键；参数联动、失效报价、上传/播放鉴权；没有静音播放器代替真实模型声音控制                   |

SeeAPI 输出审核采用回调驱动。已验证并持久化的通知后，查询的是 **SeeAPI 的真实 inference 结果**，
查询 ID 来自本地持久化任务；回调正文不能直接批准内容。一次确认流程最多 3 次 GET（含首次），
仅网络错误、超时、429、5xx 在 1/3 秒后重试。无回调时 0 次 GET；重复回调、恢复和崩溃不能重置预算。
没有周期状态轮询，也不会因读取失败重新 POST 审核或重新生成视频。

## 数据库与部署变化

四个迁移：

1. `20261004000000_video_generation_v1`：独立执行记录、执行引擎归属及不可变身份、索引、RLS。
2. `20261004010000_video_quote_pending_evidence`：视频报价的待审核状态。
3. `20261004020000_video_resource_recovery`：视频清理和回调恢复索引。
4. `20261004030000_video_input_snapshot_immutable`：数据库拒绝修改已接受视频的完整输入快照。

网站和后台分别绑定同一视频 Workflow、私有媒体桶与 Hyperdrive；保留旧图片引擎。
正式操作顺序、配置和回滚见 [部署说明](../operations/video-v1-rollout.md) 与
[配置模板](../operations/video-v1-configuration.example.env)。回滚不删除新表、不重写历史快照、不重置不确定尝试。

## 验证边界

原实施工作区最终集中结果：视频单元/Mock/原生 workerd 567 项、视频数据库 81 项、完整域流程 15 项通过；
22 个工作区类型检查通过。迁移已在隔离 PostgreSQL 验证。旧图片审核、授权和结算有独立回归，
包括发现并修复历史 SG 拒绝计费问题的 2 项 RED → GREEN 测试。

该工作区结果不能代替本分支适配最新主分支后的验证；分支精确结果记录在
[分支验证记录](../operations/video-v1-review-branch-verification.md)。历史报告的数字不应累加为独立用例数量。
真实供应商请求、真实审核回调及云端性能仍为 **NOT_RUN**。

## 上线缺项与已知限制

- 已核对 Kie、SeeAPI、Waffo 凭据存在，但凭据存在不能证明全部模型权限或真实生成验收。
- **BLOCKED**：Kie 视频回调签名密钥、SeeAPI webhook signing-key map、应用 callback proof secret、
  正式成本/价格认可、供应商容量和模型权限验收。没有用测试值填生产配置。
- **NOT_RUN**：真实 SeeAPI inference 签名投递、抽帧覆盖、账单核对、真实端到端生成、生产迁移/部署/开放。
- SeeAPI 的时间覆盖要求属于应用验收条件，官方没有承诺相同抽帧分布；实际返回必须通过验证才能交付。
- 历史本地性能记录的 20 并发准入 P95 约 1265 ms，1 秒目标 **NOT_MET**；内测并发仍受限。
  本轮 350 次性能矩阵是显式可选测试，**NOT_RUN**，没有重写为 SeeAPI 性能证据。
- 退役 SG 的未完成任务、历史要求音频审核的有声任务保持挂起，等待有审计的人工处理。

## 给 GPT 的审查要求

请将完整分支与上述 `main` 基线比较；复审本轮修复时使用 `4a7294c0f8d085953eb6a1fffbec41bcaec6e2bf...HEAD`。
读取本说明、实际文件地图和最新审核修复报告，独立审核实际代码。
重点寻找能复现的错误：重复扣费/生成、不确定请求被重发、审核与内容错绑、回调伪造或重放、
查询预算被恢复重置、新旧引擎交叉执行、未审结果签名可读、退款并发、旧图片功能回归及真实价格缺口。
本轮特别复核冻结音频策略的大小限制、付费前完整容量保障，以及到期清理和物理删除后的容量释放。
对每个发现给出优先级、文件和行号、触发条件、实际影响以及最小复现/回归建议。
请区分代码缺陷、外部配置阻塞和明确不在本批范围的功能；不要把 Mock 通过写成生产验收，
不要猜测密钥、价格、模型权限或实测结果。审查任务不应执行迁移、部署或付费生成。
