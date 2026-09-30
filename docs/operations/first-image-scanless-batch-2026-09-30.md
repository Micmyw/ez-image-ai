# 首图主链路去扫描化：本地批次验收

本批完成源码实现、分项本地提交、回归和本地实际运行时对照。结论限定为：**正常首图路径不再调用全局扫描，维护竞争造成的交接等待在本地对照中消失。维护空闲时没有观察到明显的端到端提速；审核查询间隔仍是主要等待。** 未推送、部署、改生产配置、追加积分或调用真实付费供应商。

## 基线与隔离

- 已发布：`a617d207037d0aa2713965eefc8e8b826f26cdf9`。远程 main：`aed472af9f843d2503a55eec252b086b248b63fe`，落后八个提交。
- 2A-1：`517406a`，直接复用。当前隔离分支：`codex/output-review-resume`，路径 `D:/AIProject/Gefei/SaaSTool/ez-output-2a1`。共享仓库的未提交内容未纳入。
- 源码审计：`ab7bc6a`；统一推进机制：`d1d67e1`；单对象输出：`447ae33`。验证驱动、证据和文档另作提交，未自动并入 main。
- 旧源码从 `git archive a617d20` 提取到本任务缓存，未切换／重置共享工作区。包解析显式指向旧快照，避免链接到当前源码。旧 jobs 制品来自现有本地 `ezimageai-batch1-release:a617d20` 镜像；镜像内 runtime、orchestrator、create-generation 与锁文件的 SHA-256 均与该提交一致。
- jobs.js 旧制品 SHA-256：`b672ae90ded4732c6ab2c734031f5d3a6c443c2d5b65fa36917777bfb35c8671`；新制品：`2ff4681a8e7033c7e9050ae300a39ba3e023b6957f2fe06f92e676e5d7df21f6`。每份样本记录了所加载的实际制品摘要。
- [源码／等待／测试对应表](first-image-scanless-audit-2026-09-30.md) 包含修改前审计和最终调用位置。无数据库迁移、并发扩容、SSE、审核并行或 Sightengine 启用。

## 实际修改

1. 受理返回真实已提交事件身份；新建／重放统一定向唤醒。审核完成、provider 结果确认、输出审核和结算都返回当前 job/attempt/asset 的实际事件。新的 `media-deliver-events` 复用 Outbox 领取、租约、到期、交付身份和完成回执，保留旧输出专用入口兼容。
2. 已接受的原 attempt 在当前持久 Workflow 中继续 polling。结构化 PENDING 沿用原审核任务和下次允许查询时间，睡眠时释放执行器和 DB。显式空 continuation 不再落回全局扫描。
3. 普通无变换 JPEG/PNG/WebP，已知长度且 ≤10 MiB，先预留空间再条件写一份私有 final 对象。冲突和重试读取实际 winner；最终 DB 提交仍验证租约。大／未知长度、视频、访客水印、旧 multipart 继续原流式 staging 路径。
4. 审核允许后原事务提交 READY，即可按现有规则取预览；结算、回执复查和清理继续执行，不阻塞首图。Waffo、SeeAPI、拒绝／PENDING／技术失败／BYPASSED、账本和退款规则保持不变。

## 对照边界

驱动：`tooling/e2e/src/scanless-runtime.mts`。实际执行受保护 submitGeneration、Better Auth 会话查询、真实 PostgreSQL、最终 jobs 制品、workerd Workflow、WorkerJobs 三个执行器、私有 MinIO/S3、受保护 getJob、签名预览和 Chromium 图片解码。

仅外部供应商 HTTP 替换为隔离夹具：Waffo 固定等待 100 ms；Kie 接受后固定 1500 ms 完成并调用真实签名回调处理器；输入／输出 SeeAPI 在各自提交后的固定时刻（0 或 3500 ms）完成。查询次数不决定结果。供应商夹具真实读取审核／生成使用的同一私有对象；其他外部请求一律拒绝。

每格一个新用户／新库、相同图片、参数、套餐、模型和单个生成任务，交错运行旧／新制品。维护占用条件是在 Kie 接受后 1200 ms 启动实际 maintenance 任务，用独立 PG 连接锁定一条无关 attempt 约 3500 ms；释放后任务正常返回 200。该锁没有覆盖被测任务的表／行。新样本维护实占 3538／3542 ms。

**不是 Cloudflare 云端性能测试。** Hyperdrive 是本地真实绑定，存储是实际 MinIO，并非云 R2；没有模拟数据库、调度或存储函数。浏览器是最小预览页、250 ms 查询间隔，不是完整 SaaS Editor；没有把这组数值当成线上页面耗时。未启动定时扫描；旧正常流程仍自行调用全局扫描，新流程日志断言其调用数为零。

## 端到端实测（毫秒）

| 维护 | 审核完成规则   | 旧点击→Kie 接受 | 新点击→Kie 接受 | 旧 Kie 完成→可见 | 新 Kie 完成→可见 | 旧点击→可见 | 新点击→可见 |
| ---- | -------------- | --------------: | --------------: | ---------------: | ---------------: | ----------: | ----------: |
| 空闲 | 立即           |            1011 |             853 |              522 |              639 |        3048 |        2995 |
| 空闲 | 提交后 3500 ms |            6024 |            5937 |             5644 |             5754 |       13178 |       13195 |
| 占用 | 立即           |             887 |             874 |             4146 |              614 |        6545 |        2995 |
| 占用 | 提交后 3500 ms |            6011 |            5941 |             9323 |             5587 |       16844 |       13044 |

Kie 固定处理 1500 ms；回调定时误差 3–16 ms 单列，未计作应用优化。维护占用两格分别减少 3550／3800 ms；空闲两格为 53 ms 减少／17 ms 增加，不能据此声称稳定的空闲提速。没有用历史 102 秒样本计算收益，也不报告 P95。

另用相同最终 workerd 制品跑了一次 10 MiB 输出边界：一次私有 PUT、原 attempt、审核、浏览器解码和一次结算成功，点击到可见 3381 ms。图片为测试 PNG 加填充字节；这是有界传输回归，不是云内存上限、真实大分辨率图或并发压测。

### 新版受理与回调

四格受理分段范围：报价查找 4.2–6.2 ms；配置 3.7–3.9 ms；资格 33.8–41.8 ms；Waffo 106.2–118.0 ms；报价事务 12.9–15.2 ms；job／预留事务 78.0–88.1 ms；分发 139.7–143.4 ms。限流单次约 2.0–2.5 ms，edit-context 0.05–0.11 ms。

回调鉴权 0.22–0.25 ms；body 0.43–0.94 ms；DB 读取 3.55–10.48 ms；DB 持久化 6.32–14.75 ms；唤醒 35.67–42.95 ms；整体 49.96–63.25 ms。整体与内部 DB 子阶段有包含关系，不能相加。这些是本地数据，不能解释或替代此前生产约 4.955 秒的回调时间。

### 交接、输出与预览

| 指标                                 | 旧                           | 新                                                       |
| ------------------------------------ | ---------------------------- | -------------------------------------------------------- |
| Kie 完成→输出 handler，空闲          | 131／134 ms                  | 151／164 ms                                              |
| Kie 完成→输出 handler，维护占用      | 3627／3610 ms                | 161／141 ms                                              |
| 输出 handler→审核提交                | 190–231 ms                   | 154–168 ms                                               |
| 首次输出查询→READY，延迟审核         | 5211／5229 ms                | 5194／5190 ms                                            |
| 首轮输出待审 handler 结束→READY      | 旧制品缺绝对查询计时，未测得 | 5167／5169 ms（由现有 queryStartedAt＋阶段累计计时关联） |
| 输入事件原 dueAt→handler             | 见证据逐条记录               | 216–223 ms                                               |
| 原 dispatch 事件 dueAt→handler       | 见证据逐条记录               | 68–79 ms                                                 |
| 原 finalize 事件 dueAt→handler       | 见证据逐条记录               | 58–73 ms                                                 |
| 输出 PENDING 事件 dueAt→轮询 handler | 旧版本无此结构化路径         | 68／71 ms                                                |
| 允许下次查询→实际查询（输入／输出）  | 旧制品未记录，未测得         | 输入 88／94 ms；输出 161／158 ms                         |
| READY 行 updatedAt→浏览器收到输出    | 29–273 ms                    | 50–276 ms                                                |
| 浏览器收到→解码→可见                 | 见证据                       | 解码 4–8 ms，随后两次动画帧 19–28 ms                     |

READY 使用资产行 updatedAt，非数据库提交服务端时间；不能据此精确拆分 commit。输出 handler→审核提交包含领取、下载、写入和 DB，**不是纯存储耗时**。本轮没有为拆分它新增同步计时数据库写入。连接等待、SQL 服务端执行、云调度、云 R2 网络、正式 UI 查询周期未测得。

SQL 总查询次数未测得；上面的操作计数仅覆盖明确记录的调度、供应商、Worker 输出存储和账本，不能作为数据库往返次数。

### 操作次数与账本

- 每个样本：Kie 提交 1、attempt 1、Kie 结果查询 1；输入和输出各提交审核 1 次。立即审核各查询 1 次，延迟审核各查询 2 次。未增加供应商调用。
- 旧正常路径全局扫描 6 次（立即）／8 次（延迟）；新路径均为 0。接收／查询／继续仍有定向调用，不声称“没有调度”。
- Worker 已记录的输出存储 HTTP：旧为 POST×2、PUT×2、GET×2、DELETE×1，新为 GET×1（不存在检查）、PUT×1。供应商和浏览器读取私有图片在此计数边界之外，两边均保留。
- 旧延迟审核 finalization 技术重试计数 1，新为 0；正常 PENDING 改用结构化等待。每份样本账本均一次 RESERVE、一次 SETTLE，实际结算 5 个本地测试积分；没有真实账户资金变更。
- [机器可读证据](evidence/first-image-scanless-2026-09-30.json) 保留逐事件 dueAt、handler、审核查询时刻、回调分段、摘要、job 和账本身份。原始日志与样本保存在本任务 `.cache/first-image/`，未纳入提交。
- 仓库内 `pnpm --filter @repo/e2e-media test:scanless-report` 校验八份日志／结果：缺失关键 handler 记录、混用制品、重复供应商提交／账本或新版进入全局扫描都失败。向缓存副本注入扫描记录时该校验实际失败；原始八份证据通过，避免把日志缺失当成“扫描为零”。

## 回归与构建

| 命令／检查                                                                                                                                                                                                                               | 结果及作用                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm --filter @repo/jobs test --maxWorkers=4`                                                                                                                                                                                           | 39 文件、264 通过；审核、供应商尝试、调度、故障／恢复契约                                |
| `pnpm --filter @repo/jobs test:integration --maxWorkers=1`                                                                                                                                                                               | 9 文件、152 通过；含真实 PostgreSQL 租约竞争和 2 个 PostgreSQL＋MinIO 写后崩溃／过期测试 |
| `pnpm --filter @repo/workflows test --maxWorkers=4`                                                                                                                                                                                      | 9 文件、63 通过；1 个非本批模拟测试按原门控跳过；含本地 workerd                          |
| `pnpm --filter @repo/jobs-runtime test`                                                                                                                                                                                                  | 9 通过；hybrid 入站、结果脱敏、兼容                                                      |
| `pnpm --filter @repo/api test modules/media/procedures/create-generation.test.ts modules/media/procedures/submit-generation.test.ts modules/media/procedures/get-job.test.ts modules/media/webhooks/kie-callback.test.ts --maxWorkers=4` | 59 通过；受理重放、权限、预览、回调                                                      |
| `pnpm --filter @repo/storage test --maxWorkers=4` / `test:minio`                                                                                                                                                                         | 121／12 通过；条件写、冲突 winner、大文件回退、不可覆盖                                  |
| database：outbox、generation-admission、job-status 三个 integration 文件，`--config vitest.integration.config.ts --configLoader runner`                                                                                                  | 14 通过；现有可变资格／状态／扫描兼容                                                    |
| database、storage、jobs、API、workflows、jobs-runtime、e2e-media 的 `type-check`                                                                                                                                                         | 全部通过，包括新增 .mts 驱动                                                             |
| `pnpm --filter @repo/workflows build:workers`；`test:artifact:workerd --database`                                                                                                                                                        | 实际 JS/WASM 制品成功，真实 PG 查询和新／旧定向入口准入通过；制品约 9169 KiB             |
| `pnpm --filter saas build`                                                                                                                                                                                                               | Windows 本地 Next 生产构建通过；不等于 OpenNext 最终云制品认证                           |
| 受影响文件 Oxfmt／Oxlint、`git diff --check`                                                                                                                                                                                             | 通过；未运行／声称远程 CI                                                                |

RED 证据保留在 `red-continuation.log`、`storage-red.log`：原路径依赖扫描、缺少不可变直接写。故障回归分别证明事务提交后未唤醒可恢复、接受丢响应保留原 delivery number、扫描与定向领取竞争只一方成功、旧 token 不能 ACK、租约过期可恢复、持久步骤重放不再提交、重复乱序回调不倒退，以及存储已写后 DB 故障／fence 失效不提前 READY。它们与完整正常矩阵分开记录，未把单元桩宣称为完整故障端到端。

构建容器创建曾被自动审批拒绝，仅返回 `blocked by policy`；没有重试同一动作。随后使用本地 Next 构建成功。Linux/OpenNext 网站最终打包、远程 CI 和云部署验证保留到批次发布准备，不能由本地 Next 构建替代。

## 复现与安全边界

1. 使用任务独占 PostgreSQL（loopback 55432）和 MinIO（loopback 9540），不要改变共享数据库／桶。新建匹配 `ezpic_scanless_*_test` 的测试库，设置该进程 `DATABASE_URL`／`TEST_DATABASE_URL`，运行 `pnpm --filter @repo/database exec prisma migrate deploy`。示例本地凭据在驱动中固定，不能用于部署。
2. MinIO 的测试凭据为 `scanless`／`scanless-local-only`，bucket `scanless-private`。只向这个本地服务运行测试。驱动自行创建桶，不修改共享 CORS。
3. 构建 jobs 后，设置 `SCANLESS_LABEL`、`SCANLESS_REVIEW_DELAY_MS=0|3500`、`SCANLESS_MAINTENANCE_BUSY=false|true`，运行 `pnpm --filter @repo/e2e-media test:scanless-runtime`。两端口 9560/9561 仅 loopback；结束自动关闭浏览器、HTTP 服务、PG 客户端和 Miniflare。
4. 旧对照需要源码快照和该提交的 jobs 制品，路径解析指向快照，使用同一驱动。不能只换 API 源码、却复用新版 jobs 制品。每格独立库，避免旧全局扫描拾取其他格遗留事件。
5. PostgreSQL＋MinIO 崩溃回归额外设置 `RUN_MEDIA_STORAGE_INTEGRATION=true` 及上述本地 S3 环境后运行 jobs integration。默认 CI 未提供该服务时明确跳过两个跨存储案例；本轮已实际运行通过。
6. 八格使用 `{old|new}-{idle|busy}-{immediate|delayed}-rpc` 标签，将每格控制台输出保存为与 JSON 同名的 `.log`。运行 `pnpm --filter @repo/e2e-media test:scanless-report`，或传入证据目录绝对路径；它只读样本并输出本地汇总，不调用服务。数值依据完整日志，不能仅提供空日志或汇总 JSON。

交付时已停止并移除本任务的 `ezpic-scanless-test-postgres`／`ezpic-scanless-test-minio` 容器；55432、9540、9560、9561 端口均已关闭，记录的进程已退出。共享 `supastarter-postgres`／`supastarter-minio` 未动。隔离工作树尚未合并，连同本地 `.cache/first-image/` 证据保留；缓存未提交。

## 兼容、回滚与剩余等待

发布应一次确认整个批次目标／测试身份／次数／费用上限，再执行接收端优先顺序：先 jobs（识别旧 Trace、旧 outputReview 和新 continuation），验证存活与旧请求兼容，再网站生产者。hybrid 若在目标中也须先更新其接收端。没有变量／迁移必改项。

回滚先停止新版网站生产者／回到已发布网站，jobs 暂留兼容接收端；等待新任务、持久 polling、定向移交与相关租约完成／恢复，并确认没有仍会发送新任务种类的 Workflow，再回滚 jobs。不能先把 jobs 降到不认识 `media-deliver-events` 的版本。故障中间态、输出身份和 Outbox 行不能删除；旧 staging／multipart 与单写 final 共存，旧转正条件写可识别已经存在的 final。保持 heavy=1、control=4、maintenance=1。

仍必要的等待是 Waffo、输入／输出审核、模型运行、真实资源限额及故障恢复；本地延迟格中，两次审核各约五秒的查询间隔占主导，审核服务本身各用了固定 3.5 秒，发现完成仍有余量。此批消除了维护竞争和一次输出复制，**没有证明消除了生产原有几十秒等待**。下一步应先在一次获准的云批次验证中使用现有计时确认剩余瓶颈；未测到云端证据前，不继续扩展架构或承诺秒数。
