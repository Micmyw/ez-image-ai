# 生图流程第一批 1A＋1B：实现与本地验证

本批按 `.cache/kie-timeout/generation-flow-architecture-v2-2026-09-29.md` 和用户更正后的 `C:/Users/梅一伟/Downloads/codex-generation-next-steps-1A-1B.md` 完成计时、轻量状态与预览、无变化 Outbox 唤醒抑制、统一受理读取。本文是实现和验证记录，不是后续架构方案。

代码基线为 `aed472af9f843d2503a55eec252b086b248b63fe`。开始时已存在其他会话的内容、Effects 和编辑器改动，初始状态保存在 `.cache/generation-batch1/status-at-baseline.txt`。本批在原工作区分项修改，没有切换历史提交、重置工作区或覆盖其他会话改动。1980s 内容附件不属于本批范围。

状态：本地实现及下述验证完成，按任务分别提交；未推送、部署或修改生产配置、权限、积分。没有发起真实付费审核或生成。无数据库迁移、环境变量、连接池或执行器并发变更。

| 本地提交  | 范围                                           |
| --------- | ---------------------------------------------- |
| `525efec` | 安全计时基础、身份/限流/响应就绪及浏览器计时   |
| `9e80f17` | 数据库投影、授权预览、前端加载与回归           |
| `4d27245` | 无变化 Outbox 扫描抑制、执行开始计时、恢复兼容 |
| `5b4e267` | 统一受理读取、最终原子资格检查、可移植模拟     |

本报告、数值证据及本批 Changelog 另作交付记录提交。其他会话的内容、Effects、编辑器与访客改动仍留在工作区；共享 `use-generation.ts` 和 `CHANGELOG.md` 只暂存本批差异。

## 1. 实际修改与边界

| 任务              | 主要文件                                                                                                                                                                                                        | 实际变化                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 0：受理和状态计时 | `packages/api/modules/media/lib/flow-timing.ts`；`submit-generation.ts`、`create-quote.ts`、`create-generation.ts`、`get-job.ts`、`get-asset-access-url.ts`                                                     | 复用日志记录资格/配置、Waffo、事务、分发、状态查询、权限判断和签名；日志携带可用的 request/job/attempt/asset/Outbox ID。 |
| 0：事件开始计时   | `packages/jobs/src/orchestration/{contracts,client,registry,executor,polling}.ts`；`apps/workflows/src/{dispatch,execution,orchestrator}.ts`；`apps/jobs-runtime/src/server.ts`                                 | 将事件 ID 与 dueAt 带到实际执行入口；正常等待后的轮询不重复使用首次事件 dueAt。未知区间记录为未测得。                    |
| 0：浏览器计时     | `apps/saas/modules/media/lib/preview-timing.ts`；`hooks/use-job.ts`；`components/editor/{EditorResultPanel,BeforeAfterSlider}.tsx`                                                                              | 记录收到输出、图片加载、双动画帧后的可见近似值；只在图片仍连接、可见且处于视口内时记录 visible。                         |
| 1：缩小读取       | `packages/database/prisma/queries/media/job-status.ts`；`packages/database/package.json`                                                                                                                        | 使用数据库 select 投影，去除定价图、完整账本/预留、传输/会话状态、历史尝试和供应商原始结果；保留授权所需的最新审核证据。 |
| 1：授权后直带预览 | `packages/api/modules/media/procedures/get-job.ts`；`lib/asset-read-url.ts`；`get-asset-access-url.ts`                                                                                                          | 状态直接携带短期签名预览；复用现有所有权与当前审核证据判定；`private, no-store`。原独立访问入口保留。                    |
| 1：前端交付       | `apps/saas/modules/media/hooks/use-job.ts`；`lib/job-status.ts`；`components/editor/InlineOutputPreview.tsx`                                                                                                    | 输出 READY 即可在 FINALIZING 展示；取消额外输出取址串行请求；原图对照独立加载；保留旧响应兼容分支。                      |
| 2：无变化不扫描   | `packages/jobs/src/runtime.ts`；`handlers/{verify-upload,reconcile-generations}.ts`；`contracts.ts`；`apps/workflows/src/orchestrator.ts`；`packages/database/prisma/queries/media/{assets,jobs,outbox}.ts`     | 将真实事务插入事件的结果作为 `outboxCommitted` 传递；只在明确 false 的验证/轮询完成结果上跳过全局扫描。                  |
| 3：统一受理       | `packages/api/modules/media/procedures/{submit-generation,create-quote,create-generation}.ts`；`lib/generation-authorization.ts`；`packages/database/prisma/queries/media/{generation-admission,jobs,types}.ts` | 新提交复用服务端已批准报价与配置上下文，减少完整资格检查和配置重复读取；最终可变约束仍在原有串行化事务中校验。           |

`flow-timing` 和 `packages/jobs/src/orchestration/task-timing.ts` 只写日志，不增加首图路径的同步数据库写入；不输出提示词、签名 URL、令牌、密钥或异常原始内容。日志失败不能改变业务结果。连接获取等待和 SQL 服务端执行时间为 `null`，不能从客户端墙钟耗时反推。

`packages/api/orpc/procedures.ts` 拆出身份检查，`lib/rate-limit.ts` 复用原 SQL 记录限流；`packages/api/index.ts` 的 HTTP 计时终点是服务端响应就绪，不是客户端收完数据。浏览器受理计时起点明确标为 `submit-generation-call`，不冒充按钮点击前校验时间。图片 Resource Timing 只输出相对起点，读取不到时为未测得；日志输出异常也不会让成功受理或预览变为失败。

预览授权仍检查所有权、READY、删除/期限、当前审核的 checksum、verification generation、provider/task、rule/policy 和有效期。BYPASSED 仅接受原有允许的技术故障策略，不扩大范围。签名期限不超过 300 秒、证据有效期、资产删除期限和适用的访客结果期限。访客的精确授权入口没有扩权。

`displayVersion` 包含资产可见性变化；客户端拒绝旧版本、旧观测时间和已取消请求。已结算且有输出时每 30 秒刷新可见页面授权，隐藏页面策略为 60 秒；活动任务仍是原有 2 秒/15 秒策略。同一内容在加载中和加载后均保持地址稳定，避免新签名反复中断下载；真实撤销移除输出，`visibleUntil` 到期隐藏。图片失败最多自动刷新凭证一次，使用已完成的新响应，再显示原有失败提示和手动重试。撤销依靠状态刷新发现，并非实时推送；已签发 URL 在有效期内仍遵循现有存储访问语义。

受理仍先做资格检查，再 Waffo，再建立报价与任务/积分预留。最终余额、债务、预算、并发、当前套餐与开关、输入类型/大小、存储与审核边界仍原子校验。外部 API 没有进入数据库事务。原来的两次限流计数保留。

## 2. 基线与测量口径

证据根目录：`.cache/generation-batch1/`。先保存了加计时但业务未改的 `admission-before.json`、`outbox-before.json`、`preview-before.json`、`browser/before.json` 和对应源码快照；之后才做行为优化。没有用重置工作区切换版本。

状态接口模拟曾发现基线夹具使用了无效资产 kind；修正为 OUTPUT 后，使用已保存的计时版源码重新跑相同夹具，另存 `preview-before-verified.json`，原始文件保留。重放配置只在测试内替换指定源码，未改工作区或历史提交。

各组使用相同输入、审核序列、延迟与负载，分别报告墙钟、虚拟时间和浏览器时间。**不能把以下独立测试的节省相加，声称一次完整生产生成快了多少。** 可审阅的数值样本、条件、操作次数及原证据 SHA-256 已存入 [数值证据](evidence/generation-batch1-2026-09-30.json)。可移植基线在 `tooling/e2e/fixtures/generation-batch1/`，不依赖已有缓存或回退 Git。

### 2.0 必需指标总览

耗时单位为 ms，均为观测中位数；范围及边界见下节和数值证据。受理模拟中的“点击”起点是 RPC 调用；真实按钮点击前端校验时间未测得。

| 指标                          | 样本/口径                             |        改前 |        改后 | 生产         |
| ----------------------------- | ------------------------------------- | ----------: | ----------: | ------------ |
| 提交起点 → 受理解码           | 每版 3，真实 RPC Fetch 边界、依赖模拟 |     593.671 |     403.975 | 未做生产复测 |
| 同一提交起点 → Kie 接受       | 同组 3，供应商接受标记                |     577.150 |     389.631 | 未做生产复测 |
| Kie 异步模拟时间              | 受理组未测；下游组固定等待配置        |          80 |          80 | 未做生产复测 |
| Kie 完成 → 可见，ALLOW        | 每版 3，真实浏览器＋模拟后端          |      2599.8 |      2438.7 | 未做生产复测 |
| Kie 完成 → 可见，REVIEW→ALLOW | 每版 3，真实浏览器＋模拟后端          |      4794.1 |      4602.3 | 未做生产复测 |
| 状态过程耗时                  | 每版 5，真实过程＋模拟依赖            |      46.516 |      61.910 | 未做生产复测 |
| 状态过程＋模拟请求边界        | 同组 5，非真实 HTTP 传输              |      86.106 |      93.207 | 未做生产复测 |
| READY → 地址可用              | 同组 5，旧路径含额外取址              |     183.475 |      93.269 | 未做生产复测 |
| 签名耗时                      | 同组 5，固定延迟签名器                |      15.437 |      15.195 | 未做生产复测 |
| 首图前额外输出取址            | 每次正常预览                          |        1 次 |        0 次 | 未做生产复测 |
| 状态＋取址 SQL                | 隔离真实 PostgreSQL                   |        9 条 |        6 条 | 未做生产复测 |
| 受理路由配置/完整预检         | 逻辑读取，非全部 SQL                  |     各 2 次 |     各 1 次 | 未做生产复测 |
| 无变化重复唤醒的无效全局扫描  | 6 场景各 3，虚拟时钟                  |        1 次 |        0 次 | 未做生产复测 |
| 首事件 due → 首次实际开始     | 同组，模拟立即开始                    |           0 |           0 | 未做生产复测 |
| Waffo/Kie 逻辑提交，正常      | 每请求及同键重放                      |     各 1 次 |     各 1 次 | 未做生产复测 |
| SeeAPI 提交/查询              | 下游 ALLOW；REVIEW→ALLOW              | 1/1；1/2 次 | 1/1；1/2 次 | 未做生产复测 |

80 ms 是明确配置的异步完成等待，不是实测的供应商性能。状态过程现在包含签名，单独响应耗时略增；收益来自取消下一次取址读取和请求，不能只挑选变快的指标。

### 2.1 受理：点击到模拟 Kie 接受

最终受理组执行真实导出的 `submitGeneration`、鉴权中间件、RPCHandler/RPCLink 编解码、submit/quote/create/authorization 和 `dispatchGeneration`。身份、数据库、分发路由边界固定 8 ms，报价事务 16 ms、任务事务 24 ms、Waffo 30 ms、Kie 提交 25 ms。新增事务内读取也计入延迟。模块已加载、每轮新夹具、前后交替；每场景每版 3 次，仅并发场景同时启动两个同键请求。数据库边界串行受限，不是假定 Promise.all 并行。

接受标记取模拟供应商真正接受，不取 jobId 返回。这是本地 Fetch Request/Response 语义，未运行 socket、Hono、Cloudflare；模拟分发在适配器中内联调用真实 handler，不代表生产 Workflow 的调度时间。外部 fetch 明确禁止。单位为 ms，中位数（观测最小–最大）：

| 场景         |             受理响应：改前 |                       改后 |                Kie 接受：改前 |                       改后 |
| ------------ | -------------------------: | -------------------------: | ----------------------------: | -------------------------: |
| 正常         | 593.671（592.258–617.155） | 403.975（403.564–405.546） |    577.150（576.392–600.315） | 389.631（387.694–389.881） |
| 接受响应丢失 | 592.022（590.779–594.108） | 400.750（387.848–404.821） |    575.435（575.216–578.357） | 385.225（372.633–389.034） |
| 两个同键请求 | 978.686（959.553–984.302） | 686.886（686.877–719.238） | 1024.930（1006.889–1030.225） | 593.086（592.737–640.677） |

旧并发场景的首次响应早于 Kie 接受，直接说明不能把更快返回 jobId 当作首图提速。所有并发响应完成的中位数为 1041.146 → 733.816 ms。独立裸域对照的完整样本另存数值证据，不能从两组实验相减推算鉴权开销。最终使用 `16:47:46Z` / `16:47:58Z` 的 verified 证据；更早单样本结果保留但不再作为本表结论。

正常场景操作次数（包含后续同键重试）：

| 操作                         | 改前 | 改后 |
| ---------------------------- | ---: | ---: |
| 路由配置读取                 |    2 |    1 |
| 独立运行开关读取             |    4 |    0 |
| 账户/可用积分批次/存储预检   | 各 2 | 各 1 |
| 预算预检聚合                 |    4 |    2 |
| 套餐资格预检                 |    3 |    1 |
| 报价重新读取                 |    1 |    0 |
| 最终事务内当前开关＋套餐读取 |    0 |    2 |
| 限流计数                     |    2 |    2 |
| 免费额度检查边界             |    2 |    1 |
| Waffo/Kie 调用               | 各 1 | 各 1 |
| 积分预留/供应商尝试          | 各 1 | 各 1 |

并发同键请求在报价竞争前仍可能调用两次 Waffo，改前和改后均为两次；最终均只有一个预留、尝试和 Kie 提交。没有把这项旧行为描述为本批已消除。

### 2.2 状态和真实浏览器预览

API 测试执行真实状态/取址函数，模拟读取 40 ms、签名 10 ms、每次请求 30 ms；每版加载模块后连续测 5 次，单调用者。补齐分段计时后的同条件样本如下；原 `170.778 → 103.202 ms` 的早期结果仍保留，未与本组混算。

| API 模拟区间       |         改前中位数（范围） |       改后中位数（范围） |
| ------------------ | -------------------------: | -----------------------: |
| 状态过程           |    46.516（41.428–58.138） |  61.910（60.922–78.596） |
| 状态＋模拟请求边界 |    86.106（75.046–97.533） | 93.207（91.155–115.389） |
| 独立或内联签名     |    15.437（12.482–25.250） |  15.195（14.883–15.658） |
| READY → 地址可用   | 183.475（168.722–203.255） | 93.269（91.231–115.730） |

真实 Chromium 加载实际 React 结果面板、`useJob` 与 TanStack Query，使用固定 loopback HTTP 接口：状态 160 ms、输出取址 180 ms、原图取址 1400 ms、图片 120 ms。每次一个页面、独立浏览器 context、模块预打包，没有 Next/Worker 冷启动；每版 3 个样本，中位数（范围）：

| 浏览器区间              |                 改前 |                 改后 |
| ----------------------- | -------------------: | -------------------: |
| 收到输出 → 图片请求开始 | 202.8（202.3–203.9） |       3.3（3.2–3.5） |
| 收到输出 → 图片加载     | 347.0（334.7–347.4） | 146.6（145.9–148.0） |
| 收到输出 → 可见近似值   | 373.9（353.2–375.6） | 172.5（171.0–177.5） |
| 输出额外取址请求        |                 1 次 |                 0 次 |

输出可见时原图仍在加载，任务仍为 FINALIZING。可见使用加载后双动画帧与真实 DOM/视口判断，**不是浏览器合成器精确呈现时间**。

另加固定延迟模拟 Kie 完成 80 ms、私有写入 150 ms、SeeAPI 提交 80 ms/查询 65 ms、PENDING 等待 2200 ms，使用实际 2 秒状态轮询，每场景每版 3 次：

| Kie 完成 → 浏览器可见，中位数 |                    改前 |                    改后 |
| ----------------------------- | ----------------------: | ----------------------: |
| 审核直接 ALLOW                | 2599.8（2583.1–2619.3） | 2438.7（2429.4–2439.4） |
| 审核 REVIEW → ALLOW           | 4794.1（4786.6–4818.5） | 4602.3（4594.1–4605.5） |

两版都是私有写入 1 次、SeeAPI 提交 1 次；审核查询分别 1/2 次，状态查询分别 2/3 次。READY 后仍有约 1.8–1.9 秒等待下一次状态查询。这里状态接口与存储是模拟边界，并未运行完整生产后台链路。

真实隔离 PostgreSQL 投影对照另行验证：旧状态查询＋独立取址读取共 **9 条 SQL → 6 条 SQL**，单资产标量列 **45 → 24**。10 轮交替暖机样本的客户端墙钟中位数 3.622（3.256–4.167）→ 2.125（1.798–5.368）ms；首次新路径冷读为 76.975 ms，不能隐藏冷启动或用本地毫秒值推算跨区性能。夹具含人工扩大的结果/配置数据，负载字节数仅留原始证据，不宣称生产缩减比例。

### 2.3 Outbox：仅无状态变化省去扫描

实际 `runTask/runPolling`，虚拟时钟：执行 40 ms、扫描 80 ms、维护占用 1000 ms、现有等待间隔 5000 ms。模块加载一次，每次单任务、新夹具；每场景每版 3 次，确定性结果的最小/最大均与中位数相同。

| 场景                 | 改前虚拟耗时 |    改后 | 扫描次数 |
| -------------------- | -----------: | ------: | -------- |
| 重复图审，无变化     |       120 ms |   40 ms | 1 → 0    |
| 重复生图查询，无变化 |       120 ms |   40 ms | 1 → 0    |
| 真实提交新事件       |       120 ms |  120 ms | 1 → 1    |
| PENDING → APPROVED   |      5160 ms | 5160 ms | 1 → 1    |
| 重复任务与维护竞争   |      5120 ms |   40 ms | 1 → 0    |
| 旧任务收尾           |       120 ms |  120 ms | 1 → 1    |

首事件 due→首次开始均为 0→0 ms，没有证明这项提速；维护竞争的 busy 为 1→0，无用全局投递的 requested→start 等待原为 5000 ms，新版没有这次投递。这些是单个执行调用尾部耗时，不是首图收益，不将其差值算作每张图都能节省的等待。漏送与接受响应丢失的恢复正确性由真实数据库测试验证，其恢复耗时未测得。

## 3. 回归和测试入口

新增行为先有失败测试，再最小实现；独立复查另外发现并修复了“隐藏/卸载图片误报 visible”和“图片持续失败无限刷新”。持续失败红证据曾出现 3 秒内 11 次状态查询；修复后严格为 2 次图片请求、2 次状态请求。浏览器九项边界全部通过。

额外的慢图回归先红后绿：图片延迟 3300 ms、真实轮询 2000 ms，旧实现 8 秒内发起 4 次图片请求且被新签名不断中断，未显示。修复后 1 次图片请求、2 次状态请求、0 次中断，收到输出后 3342.2 ms 可见。日志 sink 抛异常、Resource Timing 不可用的定向测试均通过。实际 Hono＋RPC/OpenAPI 测试确认响应保留 `private, no-store`；它是响应头/身份计时正确性测试，不冒充真实网络耗时对照。

数据库使用本任务在 `127.0.0.1:55432` 建立的隔离 PostgreSQL，三份独立库均应用 55 个现有迁移。未下载 Docker/MinIO 镜像。初次时间戳测试发现本地原生集群 Asia/Shanghai 与 PrismaPg raw 时间戳解码偏移；只将本任务的集群改为 UTC 后完成回归，没有添加应用时间补偿，也没有修改生产。

以下为已使用的主要入口，必须用测试库，不能加载生产 `.env.local` 执行集成测试：

```powershell
# 受理业务阶段：当时 10 文件 / 127 项；最终扩展模拟见 3.1
pnpm --filter @repo/api test modules/media/procedures/admission-simulation.test.ts modules/media/procedures/admission-context.test.ts modules/media/procedures/admission-timing.test.ts modules/media/procedures/submit-generation.test.ts modules/media/procedures/create-generation.test.ts modules/media/procedures/create-quote.test.ts modules/media/procedures/retry-generation.test.ts modules/media/lib/generation-authorization.test.ts modules/media/lib/text-moderation.test.ts modules/media/lib/executable-route-graph.test.ts

# 状态、权限、计时和 API 模拟：4 文件 / 41 项
pnpm --filter @repo/api test modules/media/procedures/get-job.test.ts modules/media/procedures/get-asset-access-url.test.ts modules/media/lib/flow-timing.test.ts modules/media/procedures/get-job.simulation.test.ts

# 实际 HTTP 编码/响应头、鉴权和请求安全：3 文件 / 24 项
pnpm --filter @repo/api test media-flow-http.test.ts orpc/procedures.test.ts request-security.test.ts
# 限流与日志新增定向入口；和上述及受理回归存在重叠
pnpm --filter @repo/api test modules/media/lib/rate-limit.timing.test.ts modules/media/lib/flow-timing.test.ts

# 数据库受理单元：9 项
pnpm --filter @repo/database exec vitest run prisma/queries/media/generation-admission.test.ts prisma/queries/media/jobs.test.ts --configLoader runner

# 测试库迁移已完成；变量只对当前测试进程生效
$env:TEST_DATABASE_URL = 'postgresql://foundation_test@127.0.0.1:55432/ezpic_batch1_admission_test'
$env:DATABASE_URL = $env:TEST_DATABASE_URL
# 受理集成：新 7 项＋原 53 项
pnpm --filter @repo/database exec vitest run --config vitest.integration.config.ts --configLoader runner prisma/queries/media/generation-admission.integration.test.ts prisma/queries/media/media.integration.test.ts

$env:TEST_DATABASE_URL = 'postgresql://foundation_test@127.0.0.1:55432/ezpic_batch1_test'
$env:DATABASE_URL = $env:TEST_DATABASE_URL
# 实际数据库投影：1 项
pnpm --filter @repo/database exec vitest run --config vitest.integration.config.ts --configLoader runner prisma/queries/media/job-status.integration.test.ts

# Outbox / 查询 / 分发单元：10 文件 / 105 项
pnpm --filter @repo/jobs test src/orchestration/polling.test.ts src/orchestration/executor.test.ts src/orchestration/client.test.ts src/orchestration/registry.test.ts src/orchestration/task-timing.test.ts src/handlers/reconcile-generations.test.ts src/handlers/dispatch-outbox.pending.test.ts src/handlers/deliver-outbox-event.test.ts src/handlers/poll-generation.test.ts src/handlers/generation-polling-dispatch.test.ts
# Workflows：5 文件 / 40 项；Node：6 项；workerd：12 项
pnpm --filter @repo/workflows test src/orchestrator.test.ts src/dispatch.test.ts src/execution.test.ts src/workers-routing.test.ts src/orchestrator.simulation.test.ts --project unit
pnpm --filter @repo/jobs-runtime test src/server.test.ts
pnpm --filter @repo/workflows test --project worker-executor --project workerd

$env:TEST_DATABASE_URL = 'postgresql://foundation_test@127.0.0.1:55432/ezpic_batch1_outbox_test'
$env:DATABASE_URL = $env:TEST_DATABASE_URL
# Outbox/审核/恢复数据库：6 文件 / 138 项
pnpm --filter @repo/jobs exec vitest run --config vitest.config.ts src/handlers/verify-upload.database.integration.test.ts src/handlers/runtime-stores.database.integration.test.ts src/handlers/moderation-outage.database.integration.test.ts src/handlers/temporary-reference.database.integration.test.ts src/handlers/finalization-transfer.database.integration.test.ts src/handlers/recover-finalizing-generations.database.integration.test.ts

# SaaS 结果/状态/详情/历史回归：当时 6 文件 / 45 项，后续计时增补见下
pnpm --filter saas test modules/media/components/editor/EditorResultPanel.test.tsx modules/media/components/editor/BeforeAfterSlider.test.tsx modules/media/lib/job-status.test.ts modules/media/lib/preview-timing.test.ts modules/media/components/JobDetail.test.tsx modules/media/components/JobHistory.test.tsx
# 后续日志异常与 Resource Timing 补充后：3 文件 / 21 项
pnpm --filter saas test modules/media/lib/preview-timing.test.ts modules/media/hooks/use-generation-submit.test.ts modules/media/hooks/use-generation.test.ts

# 浏览器读取保存的基线模块或当前模块；无需 Next/生产连接
node tooling/e2e/src/generation-preview-benchmark.mjs --mode after
node tooling/e2e/src/generation-preview-benchmark.mjs --mode after --downstream

# 按工作区执行类型检查；SaaS 与上述 SaaS 测试串行
pnpm --filter @repo/api type-check
pnpm --filter @repo/database type-check
pnpm --filter saas type-check
pnpm --filter @repo/jobs --filter @repo/workflows --filter @repo/jobs-runtime type-check
```

SaaS 结果面板、对照图、状态、计时和详情回归，以及 API、Database、SaaS、Jobs、Workflows、Node runtime 类型检查通过。SaaS 测试与类型生成顺序执行，避免共享 `.source` 竞争。各分项格式/lint、`git diff --check` 通过。测试范围有重叠，不把多个分项计数相加宣称独立测试总数。

真实数据库验证的恢复场景包括：

- 状态与 Outbox 已提交但唤醒前中断：后续恢复领取并投递原事件。
- 供应商接受后投递响应丢失：重领同一事件，供应商调用/尝试仍各一次，积分预留保持一致。
- claim 返回 null 但过期/证据复用/错误结算实际提交了事件：仍推进；不能把所有 not_claimed 都当无变化。
- 原 APPROVED、PENDING、拒绝、技术失败、BYPASSED 和临时参考图边界保持；旧无信号执行结果保留原投递机制。
- 报价后禁用功能、更改有效套餐或并发上限、余额/债务变化、输入大小变化在最终事务中拒绝；已提交同键重放仍返回原任务。

本地 workerd 测试通过，但它是源码/运行时测试，不等于最终部署制品或线上 Cloudflare 认证。未进行完整 CI、全量发布构建、生产容量/P95 测试。

### 3.1 新旧模拟重放

以下命令各自在隔离 PowerShell 测试进程执行，使用仓库已安装依赖，不加载 `.env.local`。基线模块只在测试进程内替换；外部供应商/数据库均为模拟。浏览器启动和关闭自己的 loopback 服务与 Chromium，记录并核查所属 PID。

```powershell
# 受理最终重放：2 项测试、36 组运行、25.10 s，通过。
# 原始 before/after 快照不改；verified 文件是重放输出，可重生成。
$env:GENERATION_ADMISSION_SNAPSHOT = 'verified'
pnpm --filter @repo/api test modules/media/procedures/admission-simulation.test.ts

# 状态：两版各 5 样本，使用新的名称保留原证据。
$batchRun = Get-Date -Format 'yyyyMMdd-HHmmss'
$env:FLOW_STATUS_BASELINE = '1'
$env:FLOW_SIMULATION_PHASE = "before-$batchRun"
pnpm --filter @repo/api exec vitest run --config vitest.flow-simulation.config.ts --configLoader runner modules/media/procedures/get-job.simulation.test.ts
$env:FLOW_STATUS_BASELINE = '0'
$env:FLOW_SIMULATION_PHASE = "after-$batchRun"
pnpm --filter @repo/api exec vitest run --config vitest.flow-simulation.config.ts --configLoader runner modules/media/procedures/get-job.simulation.test.ts

# Outbox 可移植重放：2 项测试通过；六场景每版各 3 次。
$env:GENERATION_OUTBOX_VERIFY_SAVED_BASELINE = 'true'
$env:GENERATION_OUTBOX_VERIFY_OUTPUT_DIR = "../../.cache/generation-batch1-replay-$batchRun"
pnpm --filter @repo/workflows test src/orchestrator.simulation.test.ts --project unit

# 浏览器可移植重放已通过；使用新目录，禁止覆盖旧 before。
$env:GENERATION_PREVIEW_OUTPUT_DIR = ".cache/generation-batch1-replay-$batchRun/browser"
node tooling/e2e/src/generation-preview-benchmark.mjs --mode before
node tooling/e2e/src/generation-preview-benchmark.mjs --mode after
node tooling/e2e/src/generation-preview-benchmark.mjs --mode before --downstream
node tooling/e2e/src/generation-preview-benchmark.mjs --mode after --downstream
node tooling/e2e/src/generation-preview-benchmark.mjs --mode after --slow-first-image-only
node tooling/e2e/src/generation-preview-benchmark.mjs --mode after --timing-only-check
```

状态/Outbox/浏览器的新增输出目录用于复现，报告表格仍使用第 5 节锁定的原记录；不在多次运行中择取最快样本。可移植 fixture 单独验证不冒充又一组生产对照。格式和 lint 限定为本批实际文件：`pnpm exec oxfmt --check <本批文件>`、`pnpm exec oxlint <本批 TS/TSX/MJS 文件>`；原字节 `.txt` 基线不参与自动格式化。

## 4. 兼容与回滚

1. **受理优化**：从 `submit-generation.ts` 默认依赖移除 `createPreparedJob` 即走保留的独立创建领域流程；保留新增最终原子检查和计时。已提交任务继续使用原 ID、积分预留和恢复事件。
2. **Outbox 优化**：只撤回 `shouldDeliverNextStage` 对明确 false 的抑制，可恢复原全局扫描行为；继续保留可选结果字段及 Trace 解析兼容。旧结果缺少字段时本来就走旧逻辑。
3. **预览优化**：协调回退 getJob/前端的本批实现，旧输出结构由保留的独立取址分支处理；数据库没有需要反向迁移的新增状态。不要简单去掉 URL 字段而继续保留新响应的 null preview 结构。
4. **整版旧后台二进制回滚**：旧严格入站解析可能拒绝新任务的可选 Trace，不能盲目重放。遵循 `docs/operations/cloudflare-workers-profiles.md` 的停止新受理、排空在途工作和租约、再回滚流程。不得让两个执行者对同一不确定供应商尝试重新提交。

回滚应按文件与本批差异选择性修改；禁止 reset 整个共享工作区。无新单任务工作流或双调度所有者，既有在途任务仍使用同一领域操作和恢复路径。

## 5. 证据、未测得项与环境收尾

原始记录：

- 最终受理 `.cache/generation-batch1/admission-{before,after}-verified.json`、`admission-http-{before,after}-verified.json` 与 `admission-validation-verified.md`；原单样本文件及旧报告保留。
- 最终分段状态 `preview-{before,after}-stages.json`、真实数据库 `status-database-comparison.json`；早期 `preview-before-verified.json` 和 `preview-after.json` 保留。
- `.cache/generation-batch1/outbox-{before,after}-verified.json` 与 `outbox-report.md`，原单样本文件保留。
- `.cache/generation-batch1/browser/{before,after,before-downstream,after-downstream}.json`，截图、源码散列、失败复现和进程清理记录。

仍未测得：连接池获取等待、SQL 服务端执行、受理事务/免费额度内部完整 SQL 数、真实供应商完成时间、生产 Cloudflare 调度/跨区通信、R2/CDN 传输、合成器精确呈现、按钮点击到前端校验结束、完整真实点击到首图、漏送/接受响应丢失的恢复耗时、并发容量与 P95。HTTP 正确性已测；完整生产 HTTP 网络时间没有对照测量。不能从模拟目标延迟或 jobId 返回更快推导这些结果。

本批保持 Waffo/SeeAPI、模型参数、私有 R2、积分和退款政策；未启用 Sightengine，没有审核并行、选图即付费审核、SSE/WebSocket、完整工作流、Smart Placement、连接池扩容或 R2 单写改造。

临时浏览器、loopback 服务和原生 PostgreSQL 已关闭。PostgreSQL 的根 PID `26288` 及五个已记录子进程均退出，`55432` 不再监听；证据 `postgres-cleanup.json`。没有停止其他会话/用户的 Docker 或服务。隔离数据库、源码基线和截图保留供复查，没有新建工作树或保留后台进程。

上线建议：本批已具备本地代码与模拟验收证据；生产发布及真实付费验证需另行授权，不能据此承诺一分钟首图。下一批仅建议先验证 2A 精准继续和正常待审建模，再独立验证 2B 普通输出单写。本轮未实施这两项。
