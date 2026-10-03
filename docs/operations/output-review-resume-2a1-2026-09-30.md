# 2A-1 输出 PENDING 定向续跑：实现与本地验证

日期：2026-09-30。状态：代码、本地回归及 jobs Worker 制品验证完成；真实 Cloudflare / R2 的新旧耗时对照 **NOT_COMPLETED**。本轮未推送、未部署、未调用付费审核或生成、未操作生产数据。

## 基线与改动隔离

- 直接父版本为已发布的 `a617d207037d0aa2713965eefc8e8b826f26cdf9`。远程 `main` 的 `aed472af9f843d2503a55eec252b086b248b63fe` 不是本次生产基线。
- 分支：`codex/output-review-resume`；隔离工作树：`D:/AIProject/Gefei/SaaSTool/ez-output-2a1`。共享工作区 `ez-image-ai` 的其他会话改动未纳入、未重置。
- 已发布版本的证据来自共享工作区 `.cache/generation-batch1-release/live-release/real-chain-report-2026-09-30.md`。该报告记录 jobs 版本 `5ee0afc5-457c-48b5-8982-f2b0fa71cd53`、site 版本 `7cb59161-fdca-4ab6-a9c7-2c91c62f132c`。本轮引用该报告，不把它当作本轮重新实测。
- 不含数据库迁移、生产变量调整、输入审核到 Kie 的交接改造、输出审核通过后的交接改造、审核并行、SSE、连接池扩容或 R2 单写。

## 实际行为与文件

| 边界                                                                                | 本次修改                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/jobs/src/runtime.ts`                                                      | 输出审核返回 `IMAGE_PROCESSING` 时，在原有等待事务中读取实际已写入／去重后的 Outbox 行，返回其 ID。复用 SeeAPI taskId、审核 generation、资产身份和原查询时刻。重复 finalizer 遇到正在查询的资产租约也保持等待。 |
| `packages/jobs/src/handlers/finalize-media.ts`                                      | 正常待审返回 `WAITING_MODERATION` 和已持久化事件 ID，不记录技术重试、不提前结算。多输出沿用原绑定函数保存位置；混合真实技术故障仍保留重试语义。                                                                 |
| `apps/workflows/src/orchestrator.ts`                                                | heavy 执行返回并释放执行器槽位后，定向调用私有 `media-deliver-output-review`；纯 PENDING 交接不再主动调用全局 `media-deliver-outbox`。                                                                          |
| `packages/jobs/src/orchestration/executor.ts`、`registry.ts`、`worker-executors.ts` | 新私有任务进入既有 `jobs-control`，只领取指定输出审核事件，再启动现有 `media-verify-upload` / `runPolling`。不在定向分发器内调用审核供应商，不增加执行器并发。                                                  |
| `packages/database/prisma/queries/media/outbox.ts`                                  | 给原 `claimOutboxBatch` 增加可选输出事件筛选；共用 `FOR UPDATE SKIP LOCKED`、租约 token、attempt 和完成回执。限制为指定输出图片事件，保留旧 payload 格式。                                                      |
| `packages/jobs/src/handlers/dispatch-outbox.ts`                                     | 定向唤醒接收未确认／响应丢失时保留同一投递身份，延后检查回执。接受响应不等于业务完成，不提前 ACK。                                                                                                              |
| `apps/workflows/src/execution.ts`、`apps/jobs-runtime/src/server.ts`                | 私有执行响应只传递受限的事件 ID 和等待标志，不透传供应商结果。旧执行响应仍走原投递分支。                                                                                                                        |

新路径为：原等待事务提交 → heavy 返回 → control 领取同一事件 → 原审核 polling。定时扫描继续承担恢复责任；未修改的正常交接仍使用原投递机制。

下一次查询仍以资产上的 `verificationNextAttemptAt` 和有效租约为准。交接不写入新的“五秒起点”；原 polling 按剩余时间等待，到期后才查询。网络故障、429、拒绝、技术失败、既有 BYPASSED 规则未改变，PENDING 不会获得放行资格。

新增事件的 `originalDueAt` 只用于日志，写在原有 Outbox 事务内，不新增计时专用同步写入。事件身份、审核时限、领取权限不依赖此诊断字段。

## 失败测试与恢复验证

实现前保留了实际失败日志；对应日志和最终测试输出在工作树 `.cache/2a1/`，不随代码提交。

| 验证项                                  | 结果与证据边界                                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常 PENDING 的结构化等待与提交事件 ID  | 原实现失败；修改后通过。`red-finalize.log`、`red-runtime.log` 固定原接口不能表达该结果的问题。                                                                                         |
| 输出等待仍进入全局 maintenance          | `red-orchestrator.log` 固定原错误分支；修改后只调用定向任务。此为编排单元测试，不能证明云上节省秒数。                                                                                  |
| 重复 finalizer 与正在运行的审核查询竞争 | 真实 PostgreSQL 复现 `RETRY_SCHEDULED`，修复后为 `WAITING_MODERATION`；同一事件、同一审核 taskId。`red-active-poll.log` 保留复现。                                                     |
| 多输出中已就绪 sibling 的绑定           | `red-sibling-bindings.log` 固定遗漏，修改后保留位置和绑定，等待时不提前结算。                                                                                                          |
| 事务已提交、唤醒前中断                  | 真实 PostgreSQL 中保留提交行，随后从无定向过滤的扫描入口领取、恢复并等待完成回执。                                                                                                     |
| 唤醒已接受、响应丢失                    | 实际签名分发器及 `handleDispatch` 配合真实 PostgreSQL；后续扫描复用一个 Workflow 身份。完成前事件保持 PENDING，收到完成回执后才 PROCESSED。Workflow binding 使用合约桩，未冒充云服务。 |
| 定向领取与扫描同时竞争                  | 真实 PostgreSQL 只有一个领取者；过期租约可重新领取，旧 token 不能完成新租约。                                                                                                          |
| 旧格式与范围隔离                        | 没有新 Trace 的旧事件可领取；旧执行响应保留原行为；输入事件、不匹配资产 ID、非审核事件不进入新定向路径。                                                                               |
| 审核政策和业务恢复                      | 既有审核故障、输入、临时参考图、finalization 与结算回归通过；不新增 SeeAPI 提交或 Kie attempt。                                                                                        |

固定完成时刻的正确性用例使用真实 PostgreSQL，审核模拟在开始后 **7,500 ms** 才变为 APPROVED；仅伪造应用 `Date`，查询发生在 0 / 5,000 / 10,000 ms，得到 PENDING / PENDING / APPROVED。它验证到期门限、身份和账本，不是计时性能实验；R2 和供应商在此用例中是模拟边界，未运行云 Workflow。

| 操作／状态                         |                此固定完成时刻用例的断言 |
| ---------------------------------- | --------------------------------------: |
| 模拟审核提交                       |                                       1 |
| 模拟审核查询                       |                                       3 |
| Kie attempt 行                     |                 1（预置；没有调用 Kie） |
| 输出转存入口                       |         1（模拟存储，非 R2 实际操作数） |
| 正常待审期间 finalization 技术重试 |                                       0 |
| 待审期间账本                       |                        与等待前完全相同 |
| 最终结算                           | 重复执行仍只有 1 条 settlement 账本记录 |

这组数量不与历史线上“两次查询”样本作速度或费用差值：供应商完成条件及运行边界不同。

## 本地检查命令与结果

测试数据库为任务独占的 PostgreSQL 16 容器 `ezpic-2a1-test-postgres`，仅绑定 `127.0.0.1:55432`。`TEST_DATABASE_URL` 指向专用 `ezpic_provider_test`，只应用既有迁移；没有使用共享或生产数据库。

| 命令                                                                                                                                                       | 结果                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm --filter @repo/jobs test`                                                                                                                            | 264 通过，39 个文件                                                                         |
| `pnpm --filter @repo/workflows test`                                                                                                                       | 58 通过，1 跳过，8 个文件                                                                   |
| `pnpm --filter @repo/jobs-runtime test`                                                                                                                    | 8 通过，2 个文件                                                                            |
| `pnpm --filter @repo/api test modules/media/webhooks/kie-callback.test.ts`                                                                                 | 8 通过                                                                                      |
| `pnpm --filter @repo/jobs test:integration`                                                                                                                | 142 通过，8 个文件                                                                          |
| `pnpm --filter @repo/database exec vitest run --config vitest.integration.config.ts --configLoader runner prisma/queries/media/outbox.integration.test.ts` | 6 通过                                                                                      |
| `pnpm workflows:type-check`                                                                                                                                | jobs、Workflow、Node runtime 均通过                                                         |
| `pnpm --filter @repo/api type-check`                                                                                                                       | 通过                                                                                        |
| `pnpm exec oxfmt --check <本批修改文件>`、`pnpm exec oxlint <本批代码文件>`、`git diff --check`                                                            | 通过                                                                                        |
| `pnpm cloudflare:jobs:build`                                                                                                                               | Worker dry build 通过，未部署                                                               |
| `pnpm --filter @repo/workflows test:artifact:workerd --database`                                                                                           | 最终 JS/WASM 在 workerd 启动；真实本地 PostgreSQL 查询、私有任务校验和定向 control 路由通过 |

跳过项是已有的 `orchestrator.simulation.test.ts` 保存基线回放，仅在 `GENERATION_OUTBOX_VERIFY_SAVED_BASELINE=true` 时启用。本轮未重跑这套旧模拟来代替真实链路对照。测试日志仍有既有 pg 并发查询弃用告警和第三方 sourcemap 提示；lint 无警告。

验证的 `apps/workflows/dist-workers/workers.js` SHA-256：

```text
E110F555AB45D3E2FEB1B0CDDF487E941E7C872FF1A348DACA02D92DE0A2C567
```

制品 smoke 明确返回 `liveCloudflareVerified: false`。没有远程 CI 运行，没有新网站完整构建、真实浏览器生图或线上首图验证。

## 计时和真实对照的边界

本轮沿用日志并补充：

- 审核事件 `originalDueAt` → handler 开始；恢复改写 `availableAt` 后仍保留首次 due 时间。旧事件无字段时沿用已有 Trace／availableAt，不反推丢失的原值。
- `retrieval_prepared` 中的 `nextAllowedQueryAt`、`queryStartedAt`、`allowedQueryToStartMs`，用于拆开允许查询与实际发起的间隔。
- Kie 回调的 `callback.auth`、`callback.body`、`callback.database`、`callback.db.read`、`callback.db.persist`、`callback.wake`、`callback.total`。数据库原操作是读取加 guarded update，并非新建事务。
- `callback.database` 包含 read/persist，`callback.total` 包含全部子段，报告时不能重复相加。日志观察失败不改变持久化结果。

不记录提示词、签名 URL、回调令牌、密钥或供应商原始载荷。连接等待、SQL 服务端执行时间仍未测得；新字段不将它们假装拆分出来。

| 指标                           |                             已发布 a617d20 单次真实报告 | 本轮新版真实值             |
| ------------------------------ | ------------------------------------------------------: | -------------------------- |
| 输出后续事件原 dueAt → handler |                                               10.402 秒 | 未测得                     |
| 下一次允许查询 → 实际查询      |                                            原报告未单测 | 未测得，已补日志字段       |
| 首轮审核结束 → READY           | 约 11.711 秒，READY 取 DB updatedAt，非 COMMIT 返回时刻 | 未测得                     |
| 首轮审核结束 → 第二轮 handler  |                                    9.829 秒，与上行重叠 | 未测得                     |
| Kie 完成 → 浏览器可见          |                              约 36.7 秒，跨系统时钟近似 | 未测得                     |
| Kie 回调处理                   |                                      4.955 秒，子段未测 | 未测得，已补日志字段       |
| Kie 内部生成                   |                                               12.949 秒 | 未测得；不计入应用提速收益 |

基线任务是 `cmun2c3v70003psp78ei49y6w`，输出事件 `cmun2dbrw0004psp70knumak0`。原任务一次 Kie attempt、输出一次 SeeAPI 提交／两次查询，正常 VERIFYING 曾产生一次 finalization 技术重试。上述时间重叠，不能相加，也不与历史 102 秒相减。

**maintenance 空闲／受控占用下的真实云新旧对照未完成。** 本轮只读环境清单中未发现 EzImageAI 的隔离数据库、Worker/Workflow 和 R2 测试组合；现存相关资源均为生产用途，另一个 Supabase 项目不属于本任务。用户要求新部署另行确认，因此没有向生产接入模拟器，也没有自行创建云资源。

待单独授权的最小对照范围：隔离网站／jobs Worker、隔离数据库和私有 R2，单一测试身份，4 个任务（a617d20／本候选 × maintenance 空闲／受控占用），固定输出与固定审核完成时刻，只替换 Waffo/SeeAPI/Kie 外部边界。两版共享相同环境配置和负载条件，受控占用必须经过真实 maintenance 执行器。采集实际数据库、Workflow、存储、状态与浏览器全链路，按上表输出并核对事件、attempt、账本。供应商付费调用上限为 0；基础设施资源及费用上限须在部署前另行确认。不得把模拟入口带入生产或向普通客户暴露。

## 兼容与回滚

- 无数据库迁移、无新生产变量。新响应字段可选，新入站任务使用原私有签名校验，旧任务和旧事件仍受原恢复协议保护。
- 分开发布 Node executor 与 Workflow 时，先发布能接收新私有任务的执行端，再发布产生它的 Workflow；Workers 制品包含两端。另需沿用 1A/1B 已有 Trace 入站兼容顺序。
- 优先局部回滚：恢复 finalizer 的全局投递交接，暂时保留新任务 parser、control 路由和回执处理，直到已接收的新工作及父 Workflow 排空。
- 整体回到旧二进制之前，按 [现有切换与回滚流程](cloudflare-workers-profiles.md#cutover-and-rollback) 停止新受理并排空涉及的新任务、Workflow 和租约；不能直接移除旧消费者不认识的新 taskId／Trace。
- 保留原事件、审核 taskId、下次允许查询时刻和账本；不删恢复记录、不重建付费 attempt、不将接受响应当完成。回调计时可独立撤回，无业务状态迁移。
- 本地提交尚未合入／发布，隔离工作树保留供审查；测试进程和任务独占数据库在交付前停止，共享数据库和存储服务保持原状。
