# 真实生成后的结果交付修复

日期：2026-10-23。基线：`a64770483666c301f2629c2f4ebd2eced7d1c58e`。本轮修复不包含新的付费生成、提交、推送或部署。保持[一秒预算的计时合同](./generation-one-second-budget-2026-10-22.md#计时合同)，不以本地外部服务夹具证明生产延迟。

## 已实现的行为

| 路径             | 修复与保护                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 审核提交后的通知 | READY、审核证据、接续事件及 `MEDIA_JOB_UPDATED` 意图仍在同一事务提交。提交后立即启动通知，但已登记请求生命周期时不再等待通知的 250 ms fast path；通知 ACK 和后代任务结束后才关闭本请求的数据库客户端。没有受管理生命周期时，返回前排空。失败仍由原 Outbox 恢复。                                                              |
| WebSocket 关闭   | 无状态关闭 `1005` 规范化为 `1000`；其他不能发送的状态码规范化为 `1011`。合法关闭码和既有重连、心跳、权限到期行为保留。                                                                                                                                                                                                        |
| phase wake       | 用允许的阶段、原因、错误名称和任务关联记录配置、绑定、实例查找及发送失败。已知绑定错误仅映射为 `INSTANCE_NOT_FOUND` / `ENGINE_NOT_STARTED`，其他保留 `UNKNOWN`；日志写入失败不改变原 503 响应或重放执行。禁止输出原始异常、签名、私有 URL 或请求体。事件仍是 `image-phase:${phaseKey}:${epoch}`；旧 Workflow 不需要更换步骤。 |
| 审核首提交       | 正常首次 INPUT/OUTPUT 审核也使用 verification lock 后的完整投影。复用只限该事务与 generation；完整 owner 领取/续租、provider 提交前围栏、历史标记、copy intent 及 ERROR 历史保护保留。                                                                                                                                        |
| 审核结果持久化   | OUTPUT job 行锁后，在 verdict 投影内以数据库时间校验精确 phase owner 和资产租约。资产无效不能遮蔽 owner 失效；失效时在写入证据之前返回。没有 owner 的历史调用保留原分支。                                                                                                                                                     |
| 图片显示         | 输出图从首次出现到原图签名、下载及比较控件补齐始终使用同一个 DOM 节点。新旧响应的私有预览缓存均按账户隔离；明确授权拒绝不再展示旧缓存，原图下载失败时移除比较控件并保留结果图。内容版本变化、明确重试、显示授权撤销和到期仍使用原规则，签名到期不等同于显示授权到期。保留两帧可见性诊断和两秒任务恢复轮询。                   |
| 身份依赖与日志   | `sendEmail` 仅在实际模板发送分支动态加载模板/React Email 依赖。`media.flow.timing` 经现有脱敏后输出一行 JSON，保留 info 等级控制与日志关联。                                                                                                                                                                                  |

`media.getJob` 另在请求局部 scope 中观测首次成功的 `createRuntimeDatabaseClient` 同步构造，记录 `request.database.client.construct`。原有 `request.identity`、`status.query`、授权/签名和 `request.http` 区间保留。构造区间可能嵌套在身份或状态读取内，必须按区间归属/并集处理，不能重复相加。它不证明编译资源加载/复用、连接等待、首条 SQL 或服务器 SQL 执行；未构造、未观察到或构造失败均不发成功样本，缺失不能当作 0。观测器不输出连接串、凭据、会话、查询参数或结果，不共享客户端或更改数据库开关。

请求生命周期通过已有 `@repo/utils/request-lifecycle` 传递。ControlExecutor、TransferExecutor 与 Workers WorkerJobs 在开始业务操作前登记平台 `waitUntil`，同一请求保留独立数据库客户端；不能将数据库客户端共享到其他请求，也不能用未登记的 Promise 代替生命周期管理。Hybrid/Node 等没有该生命周期的调用保持同步排空。

## 本次追加复核与修复

复核仍以 `a6477048` 为 Git 基线，并保留前一轮未提交修改。发现并处理了以下遗漏：

- 原图授权曾成功、后台刷新随后返回 403 时，TanStack Query 保留旧 `data`，原实现继续显示比较图。新旧响应统一通过 `usePrivateAssetPreview` 按账户建缓存键、透传取消信号，并在明确 `UNAUTHORIZED` / `FORBIDDEN` / `NOT_FOUND` 后屏蔽旧数据。临时网络错误与签名期限不会被误判为撤销。账户隔离测试覆盖同一 QueryClient 内身份变化；没有据此声称线上跨账户读取已复现。
- 原图签名接口成功但图片实际下载失败时，比较控件仍存在。现在失败的原图 URL 降级为结果图；新 URL 可恢复比较，输出节点和下载保持稳定。
- 既有 `EditorResultPanel.test.tsx` 的 mock 缺少 `skipToken` 和会话边界，并仍断言没有任何 query hook 调用。已修正为验证无原图时禁用查询且不发请求，并补新旧响应的授权拒绝与账户隔离回归。
- 通知数据库测试只加入包脚本，遗漏 `tests/load/run-integration.ts`，本次 `verify:ci-workflow` 实际因此失败。已补齐入口，并把日志测试、真实 workerd 生命周期测试和预览 Chromium 回归纳入 CI；本地 CI 合同检查通过，尚未运行新的远程 CI。
- phase-wake 的分类仍会将 SDK 的 `WorkflowError` 记为 Unknown，也无法区分已知实例错误。已增加固定错误标记映射，并用真实本地 Workflow binding 验证缺失实例的 503 及不创建替代执行链。诊断异常不会改变响应；这不确定此前生产 503 的原因。

本次验证结果：

| 检查                                | 结果与范围                                                                                                                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 编辑器单元 / Chromium               | 9 文件、81 项单测；24 项真实浏览器回归通过。覆盖新旧响应、原图拒绝/加载失败、同一 QueryClient 账户切换、ID/version 切换、显式重试、撤销/显示到期及两秒轮询期间慢下载。HTTP 使用本地固定夹具。                                                                                        |
| 审核与通知 PostgreSQL               | 5 文件、59 通过、2 跳过。新增未知首次提交不重发和数据库时间抗调用方时钟偏移回归；跳过项为需要 MinIO 的 DB_FAILURE / LEASE_EXPIRED 不可变输出恢复。76 个迁移仅应用到新建的隔离本地测试库。                                                                                            |
| Workflow / WebSocket / 通知生命周期 | phase-wake 单元 20 项、真实 Workflow/WebSocket 43 项、生命周期与路由单元 26 项、通知发布单元 11 项通过。新增 workerd 合同验证真实 Control/Transfer 服务响应返回或取消后，通知 ACK 和后代任务结束前仍保留各自请求 scope，并覆盖失败与旧调用同步排空；数据库与发布传输是本地可控夹具。 |
| 其他回归                            | API 计时/身份 18 项、日志 11 项、邮件 7 项、集成测试计划 28 项通过；数据库包 1139 通过、3 个需显式 guest PostgreSQL 配置的用例跳过。                                                                                                                                                 |
| 静态检查                            | 受影响的 8 个后端/运行时包类型检查、最终 SaaS typegen/Fumadocs/TypeScript、测试启动器 TypeScript、CI 合同、改动文件格式/lint 和 `git diff --check` 通过。                                                                                                                            |

运行入口已同步到 `.agents/skills/verify-changes/SKILL.md`。本轮证据位于 `.cache/review-followup-20261023/` 与 `.cache/generation-preview-review/legacy-green/`。隔离 PostgreSQL、workerd、Chromium 和检查进程已退出，55432 已释放；未启动付费生成、推送或部署。

## 前一轮回归与制品证据

以下制品、模块和 50 并发测量来自前一轮实现，不是本次预览/诊断补丁后的重新构建或性能测量。本次没有用这些历史制品认证当前源码的生产表现。

- 真实本地 Workflow binding 已验证签名 ingress、早到/重复/旧 epoch 信号和丢信号后的持久化恢复。冒号事件名在绑定中可用，这不证明生产 503 已解决；新增诊断用于下一次线上取证。
- 真实 Workerd WebSocket 回归覆盖无状态关闭、无效关闭码、重连、单通知、心跳及 owner 隔离。
- 真实 PostgreSQL 回归覆盖首提交一次、不可变批准证据、外部查询期间 owner 被替换/过期，以及等待 OUTPUT job 锁期间 owner 过期。通知阻塞不阻断接续，通知失败可恢复，意图写入失败会回滚审核结果。
- 真实 Chromium 组件回归复现旧版节点替换和两次 load，新版保持一个节点、一次 load。旧版该样本只有一次网络请求，不能称之为必然重复下载。
- 邮件依赖探针验证普通导入/原始邮件分支的模板初始化模块从 56 降为 0，实际模板邮件仍正确初始化并保持输出。该探针没有测量生产堆内存。
- 聚焦改动后的 API 全单元回归为 119 文件 / 1247 项通过，jobs 全非数据库单元回归为 84 文件 / 1148 项通过；数据库客户端/查询计时回归 60 项、日志 11 项通过。日志检查保留现有方法拦截以及暂停/恢复语义。
- 最终 `dist-workers/workers.js` 已完成 Wrangler dry build，并在真实 workerd 中通过本地 PostgreSQL 查询、路由及目标事件领取检查。该检查不上传或部署 Worker。
- 网站在独立 Linux 快照中完成 Next/OpenNext、Wrangler dry build 和原版最终 workerd smoke；首页、Create、登录、locale/indexing、私有 video 重定向、主题初始化和静态缓存均通过，外部 HTTP 请求为 0。真实 Worker SHA256 为 `652fdca87ceab1fdb952d478b81c714368ce8b18e4485a35d97ca10b560e9b4c`。
- 在该网站制品中核对了 Next/Webpack 与外层 Worker 两套邮件模块图：模板仅在实际 `templateId` 分支通过动态 chunk 或 Promise 初始化器加载。代码仍在制品中，解析和代码内存成本不等于 0；没有在最终制品发送邮件，也没有取得可信的冷启动 CPU/heap 指标。邮件内容等价性来自独立的真实依赖夹具。

聚焦回归入口：

```powershell
pnpm --filter @repo/jobs exec vitest run --config vitest.config.ts src/handlers/verification-projection.test.ts src/realtime/publish.test.ts
# 只允许单独指定的本地、可丢弃 TEST_DATABASE_URL；不能使用生产连接。
pnpm --filter @repo/jobs exec vitest run --config vitest.config.ts src/handlers/verification-projection.database.integration.test.ts src/handlers/verification-notification.database.integration.test.ts
pnpm --filter @repo/workflows exec vitest run src/runtime-execution.test.ts src/phase-wake.test.ts
node tooling/e2e/src/generation-preview-benchmark.mjs --mode after --comparison-stability-only
```

本地验收报告位于 `.cache/live-image-acceptance-20261023/`；构建、数据库、浏览器与负载证据分别记录，不以源码测试替代最终制品检查。新的固定外部夹具并发测试记录全部分母与失败，不能当成实际供应商或生产 Cloudflare 容量证明。

## 前一轮 50 并发本地样本

最终 `dist-workers` 制品在真实 workerd、本地 PostgreSQL/私有 MinIO、一个 Chromium 的 50 个独立 context 中运行；账号、积分账户和任务各 50 个。固定外部 HTTP 夹具为每次审核 3500 ms、生成模型 1500 ms、512 KiB PNG；开启签名回调与通知，保留 2000 ms 恢复轮询。数据库为 direct 模式、100 个最大连接，SQL 诊断关闭。storage/login/settlement fresh-read 开关在该样本均为 true，不等同于当前生产配置。

正式样本 `v9h-final50-pending-02`：50/50 成功，失败/超时/缺失均为 0；峰值活跃任务 50，每任务恰好一次模型提交。原始 attempt、输入/输出审核及 RESERVE/SETTLE 检查通过。源文件、JS 与 WASM 在运行前后没有漂移。

| 墙钟指标                         | 样本数 |      P50 |      P95 |       P99 / 最大 |
| -------------------------------- | -----: | -------: | -------: | ---------------: |
| 点击到可见                       |     50 | 14922 ms | 15667 ms | 15719 / 15719 ms |
| 上传开始到可见                   |     50 | 16741 ms | 17091 ms | 17108 / 17108 ms |
| READY 提交到浏览器收到结果       |     50 |    26 ms |    47 ms |       54 / 54 ms |
| READY 提交到浏览器收到通知       |     50 |     7 ms |    17 ms |       17 / 17 ms |
| 两次审核结果均已持久化到图片可见 |     50 |    67 ms |    84 ms |       98 / 98 ms |
| 审核夹具就绪到 verdict 提交      |    100 |   951 ms |  1273 ms |   1289 / 1291 ms |
| 重型槽占用 / 审核与重型槽交叠    |     50 | 0 / 0 ms | 0 / 0 ms |         0 / 0 ms |

这不是完整 SaaS 网站或 50 台独立设备的性能测量，也不是相同条件下新旧版本的对照。必要数据库/网络 I/O 与可控开销字段均保持未知，不能用整个数据库 span 作为豁免；系统附加一秒预算未认证。第一次启动 `01` 因本地启动器传入空连接池配置而在入口保护退出，尚无业务任务，已单列保存并修正启动器，没有放宽守卫或混入正式 50 任务分母。负载的 64 个已登记进程均退出；网站编译在整个正式测量窗口暂停。

资源以约一秒间隔采样 Windows 任务树，31 个样本。Node 组（3 进程）聚合 WorkingSet 峰值 975970304 bytes、workerd 组（1 进程）560549888 bytes、Chromium 组（53 进程）4406157312 bytes，全树同一采样点聚合峰值 6319104000 bytes。组间峰值发生时刻可能不同，不能相加；这不是 isolate heap，不包括 WSL PostgreSQL/MinIO，也不能与 Cloudflare 128 MiB 内存配额直接比较。补充 `final-evidence-audit.json` 统一出生时间尾零后确认 64 个身份、未知身份 0；原始证据保持不变。

验收、网站构建及独立 PostgreSQL/MinIO 的登记进程均已退出。55432/9540/9541 在 Windows/WSL 两端均已释放，数据、日志和最终产物保留以供复核；没有保留任务后台服务。

## 发布和未关闭的问题

本轮无需数据库迁移、协议切换或新生产开关。保持现有 DB-first 与 receiver-first 发布约束和旧任务排空；通知开关仍要求兼容的 `MEDIA_JOB_UPDATED` 消费者与 DO 绑定。关闭通知不影响 durable intent 的原有恢复合同。

线上样本的身份包络 1326 ms 包含首次数据库使用，不是纯认证 CPU；状态 SQL 已使用一次 owner-scoped 投影。本轮不引入跨请求会话缓存或共享活跃 PrismaClient。无法从公开接口可靠拆分的连接/SQL 等待保留为未知。

首页首次请求的内存超限、phase-wake 503 和 loaded-to-visible 1186 ms 的完整根因仍需发布后的分段证据。包体积、后续 HTTP 200、本地两次 rAF 或邮件模块数量均不能关闭这些问题。系统总附加耗时 ≤ 1000 ms 尚未认证，不承诺固定提速比例。
