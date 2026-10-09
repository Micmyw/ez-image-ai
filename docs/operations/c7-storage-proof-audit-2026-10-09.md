# C7 第一阶段只读可行性审计（2026-10-09）

结论：可安全实施版本化落盘 proof、恢复回退和锁内绑定校验；当前证据不足以启用 finalize 小 Range 快路径。保持完整落盘 GET/hash/MP4 校验，不能声称已减少全量读取或线上耗时。代码实施继续等待根集成会话提供 C4 集成 SHA。

## 范围、身份与环境

- 文档：ezimage-generation-codex-handoff(1).md；Library ID `libfile_8bc567030ca08191b078668aef012de3`；file_id `file_00000000234c8230a7386790edab467a`；46407 bytes；528 行；version_id=null；created_at/modified_at 均为 `2026-10-09T14:47:15.001744Z`。通过 Library read 完整读取，重点核对第 10、12 节及共同约束；未把云端引用当作本机路径。
- 固定源码基准：`af4c7a333f3820a5914aca9f8ad867a537700f10`。
- 根会话恢复后提供的同机原文真实路径：`D:/梅一伟/Documents/codex/2026-10-08/task/generation-speed-20261009/source/ezimage-generation-codex-handoff(1).md`。本次 Get-FileHash 确认 SHA-256 为 `0a587d14ea09dcb4cbc895640d03cea5195eea381ad8932e42ff13a9a50c93a9`，与提供值一致；不修改该源文件。
- 唯一审计 worktree：`D:/梅一伟/Documents/codex/2026-10-09/task-8/ezimage-c7-audit`。
- 分支：`codex/c7-storage-audit-20261009-task8`。
- 主 checkout 读取时为 `d3cabe21972c7b62282888fd59e686b3b2912713`，工作区无已报告改动；未回退、重置、切换或修改 main。源码审计使用固定基准独立 worktree。
- 已读根 agents.md；固定基准的 packages/jobs、packages/database、packages/storage 及 docs 无另外 AGENTS 文件；apps/saas/AGENTS.md 属于应用子树，未修改应用代码。已读相关存储集成、文档及验证技能。
- 未修改共享源代码、未安装依赖、未运行构建/单测/数据库测试、未访问或写入真实 R2、未付费生成/审核、未部署/push/修改生产配置或价格。
- 本地 shell 曾短暂中断，随后恢复；已补扫隐藏 package.json/json/jsonc/yaml/yml/ps1/sh/cmd/bat 中 aws s3、rclone copy/sync/move、wrangler r2 object 及直接 SDK/native 写入关键字，无匹配。结合源码全树写入扫描形成下列仓库内清单；不把静态搜索当作外部运维、权限或运行部署的穷尽证明。

## 基线校验链路

1. `packages/jobs/src/video-v1/output-storage.ts:48` 的 inspectVideoObject 先 HEAD，再 IfMatch 完整私有 GET；消费到 EOF、统计实际字节数、重算 SHA-256、运行 VideoMp4Inspector，随后执行现有格式/完整性检查和历史音频安全大小检查。expected checksum 也会真正比对。
2. `output-storage.ts:106` 的 transferVideoOutput 校验 provider 源流、流式 hash、分片写入，完成时传 `ifNoneMatch:"*"`，之后 HEAD。此返回值是源流校验与转存结果，不能当作完整落盘读回 proof。
3. `packages/jobs/src/video-v1/fulfillment.ts:205` 的 SUBMIT 审核分支会完整 inspectVideoObject，成功及签名 URL 生成后才跨 beginVideoReviewSubmission 付费审核 fence；必须保留这一顺序。
4. `fulfillment.ts:371` 的 finalizeVideoJob 又完整 inspectVideoObject，然后生成 checkedAt，进入 finalizeVideoDelivery。
5. 普通 transfer 后应用全量 R2 读取的源码口径为送审一次、finalize 一次，目标快路为两次到一次。adoption/STORED recovery 可能另有完整读取；审核供应商读取和用户播放不计入该口径。
6. `packages/database/prisma/queries/media/video-v1-fulfillment.ts:317` 的 outputSpec 保存源流媒体参数、assetId/checksum/etag/report 等；没有完整读回 origin、proof/validator version、owner/job/engine/key/size/frozen fingerprint/validatedAt，不能直接升级成可信 proof。

## 可绑定的 proof 字段与来源

| 字段                                                       | 权威来源与要求                                                                                                                                                                                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| proofVersion、validatorVersion                             | 新的内部服务端常量；明确版本并严格解析，parser/格式规则/安全与约束解释变化时升级。不能把旧 outputSpec/report 的 schemaVersion 当此版本。                                                                                                            |
| validationOrigin、validatedAt                              | 仅首次完整落盘 GET 消费至 EOF、hash 与 MP4 校验成功后生成；origin 固定为完整落盘读取。时间不是 transfer 源流时间，也不是旧 finalizedAt。                                                                                                            |
| jobId、ownerType、ownerId、executionEngine                 | 当前持锁读取的 GenerationJob。assertVideo 已要求 USER 与 video-workflow-v1；proof 再绑定两种 owner 字段与 engine。                                                                                                                                  |
| assetId、verificationEngine、objectKey、mimeType、byteSize | 当前 OUTPUT binding 与 MediaAsset；输出 key 由 claimVideoOutputStorage:186 生成 users/{owner}/video-v1/{job}/{asset}.mp4，private media 逻辑桶固定。byteSize 用规范十进制字符串，严格安全整数转换/范围检查。                                        |
| SHA-256、storageEtag                                       | 首次完整落盘读取计算出的 hash、条件读取绑定的 ETag，必须与当前 asset 和 binding checksum 相符。ETag 原样保存且与 SHA-256 分开。                                                                                                                     |
| frozenFingerprint                                          | 服务端规范化序列化并 hash 不可变 inputSnapshot（或完整相关冻结投影）及 normalized videoOutputConstraints；覆盖模型/模板/输出与音频安全策略版本等。普通 requestFingerprint 单独不足：普通任务该值由 request 生成，安全 profile 等另保存在 snapshot。 |
| validatedMetadata                                          | 建议同时封存实际 duration/width/height/videoTracks/audioTracks/audioTrackIds，并在最终锁内与 asset/outputSpec 对照，避免跳过解析后接受被改动的媒体参数。                                                                                            |
| moderation linkage                                         | 保留现有 verification generation、attempt、provider task、rule/policy/profile、assetChecksum、raw.objectEtag、confirmation event 及完整覆盖/有效期要求；不能靠 proof 替代审核。                                                                     |

`MediaAsset.storageVersionId` 字段存在，但该视频转存路径不获取、不持久化、不按 VersionId 读取对象。proof 的版本化表示证明格式/验证器版本，不能据此声称 R2 对象版本可固定。

数据库迁移 `20261004030000_video_input_snapshot_immutable/migration.sql` 声明视频 inputSnapshot 不可变，`20261004000000_video_generation_v1/migration.sql` 声明 engine 不可变。这里只确认源码迁移，未核实生产数据库是否已应用。通用 READY 身份不可变触发器只保护 OLD.status=READY；输出审核期间的 VERIFYING 身份仍要在服务端持锁重验。

## 写入及覆盖约束

视频自身分片完成传 IfNoneMatch("_")；这能证明请求意图，不能单靠代码或本地 mock 证明 R2 服务端执行条件。共享存储完成接口的条件可选，其余通用写接口可接收 users/_ 路径，未有视频输出 namespace 强制门禁。

以下 S 表示 `packages/storage/provider/s3/index.ts`；行号固定到基准，不保证 C4 集成后相同。

| 仓库写入口                                         | 源码/覆盖条件                                                           | 当前业务 destination                                 |
| -------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------- |
| presigned 私有 PUT                                 | S:84，无 IfNoneMatch                                                    | media/guest/video/effects 的服务端 staging key       |
| CreateMultipartUpload、presigned/server UploadPart | S:96、110、130；part 绑定 key/uploadId/partNumber                       | staging 或服务端 transfer；尚不直接发布完整对象      |
| CompleteMultipartUpload                            | S:151；ifNoneMatch 可选                                                 | staging 无条件；视频输出调用明确传 "*"               |
| 视频输出 transfer                                  | output-storage.ts:128、153、157                                         | 已找到的唯一视频输出写 callsite；条件 multipart+HEAD |
| 通用 buffer PUT                                    | S:668；无条件，users/*                                                  | draft assets、legacy staging、E2E assets             |
| 通用 remote multipart                              | S:1105；完成无条件                                                      | legacy staging                                       |
| staging promotion                                  | S:460、465、489、519；final PUT/complete "*"                            | input/legacy final asset                             |
| 视频参考图规范化                                   | S:363、368；PUT "*"                                                     | assets 中派生 PNG                                    |
| 普通图片直接落盘                                   | S:695；PUT "*"、仅图片                                                  | legacy final asset                                   |
| 视频模板 scene                                     | S:798；复用图片条件写                                                   | scene asset                                          |
| 临时参考图                                         | S:911；PUT/complete "*"                                                 | temporaryReferenceObjectKey                          |
| guest watermark                                    | S:1037、1055；complete "*"                                              | guest image final asset                              |
| avatar/logo 签名 PUT                               | S:1154；无条件                                                          | avatars 桶、server user/org key                      |
| CopyObject/UploadPartCopy                          | 未发现运行时导入或 callsite                                             | 无当前业务入口；不据此推断外部运维无 copy            |
| native R2 binding                                  | video-runtime.ts、cloudflare-worker.ts 做可用性检查，profiles.ts 配绑定 | 未发现对 VIDEO_MEDIA_BUCKET put/multipart 的源码     |
| CLI/config 脚本写入                                | 已恢复并补扫 json/jsonc/yaml/yml/ps1/sh/cmd/bat，无关键词匹配           | 未发现仓库内额外 aws/rclone/wrangler object 写入口   |

删除也属于 proof 生命周期：`packages/jobs/src/video-v1/cleanup.ts` 先 claim 再物理 delete；`packages/database/prisma/queries/media/video-v1-cleanup.ts:114` 在 owner/binding 锁下重验期限、active job/uncertain attempt/lease，并先 tombstone（:237），不能取消这些门禁。外部删除未被这组锁覆盖。

已核对的公开业务上传生成 staging keys；part 签名使用 session.stagingObjectKey，头像/组织 logo 使用 avatars 桶。legacy runtime 的输出路径以 legacy engine 查询且生成 users/_/assets/_，未发现当前公开业务 callsite 可写视频输出 key。这里没有据此认定用户可利用覆盖漏洞；结论是全入口不可覆盖约束尚未被强制证明。

后续如拟补共享写层的 video-v1 namespace 门禁、签名写 URL 条件、multipart 类型约束，属于超出文档三个 C7 文件的共享契约改动，必须先报告根集成会话并协调其他组。不能为启用快路径自行更改 bucket lock、IAM、生产存储设置、清理策略或扩大基础设施。

## SDK 与真实 R2 语义

锁文件 `pnpm-lock.yaml:1053` 的 `@repo/storage` 实际 AWS SDK S3/presigner 版本为 3.1108.0（另一个包带入的 3.984.0 不是此路径）。子审计读取其[官方同版本 schema](https://raw.githubusercontent.com/aws/aws-sdk-js-v3/v3.1108.0/clients/client-s3/src/schemas/schemas_0.ts)，确认 HeadObject/GetObject 的 IfMatch/Range 及 CompleteMultipartUpload 的 IfNoneMatch HTTP 字段映射，GetObjectOutput 包含 ContentRange。未安装或执行 SDK 请求。

[Cloudflare R2 S3 兼容表](https://developers.cloudflare.com/r2/api/s3/api/)列出 HEAD/GET If-Match 和 GET Range；HEAD Range 没有效果。CompleteMultipartUpload 行未明确列出条件操作，不能把这个缺失断言为不支持，也不能把 AWS 支持推作 R2 已验收。版本 API 未实现，不能依赖当前代码没有取得的固定对象版本。

[Cloudflare R2 一致性说明](https://developers.cloudflare.com/r2/reference/consistency/)承诺直接桶读取的强一致性，但并发同 key 写入是最后完成者生效。强一致性不会建立不可覆盖保证，也不会提供对象存储与 PostgreSQL 的原子事务。身份检查到最终事务之间的外部写入/删除窗口仍存在；现有 DB 删除锁能解决参与该锁的应用删除竞争，不能锁住 R2 控制台或独立凭证。

现有 `packages/storage/provider/s3/index.ts:245` 的 readPrivateMediaStream 已传 IfMatch 与 Range，但返回仅 body/contentLength/contentType/etag；丢弃 ContentRange 和 $metadata.httpStatusCode。严格小 Range 证明需要扩展内部返回契约或专用存储 helper，并先报告共享文件改动。

候选身份检查（目前只建议测试设计，不开启）：

- 新 HEAD 对比 proof 的原 ETag、总字节数和 video/mp4，不走公开 CDN/缓存域名。
- GetObject 使用精确保存的预期 ETag、唯一 IfMatch 与单区间 Range，例如 bytes=0-63（以实际总大小裁剪）。
- 要求 206、严格的 ContentRange=start-end/total、ContentLength=range 长度、返回 ETag 和类型一致；实际读取恰好 range 长度并达到该响应 EOF，超长/短读/无 body/200 忽略 Range 均不能快路通过。每条失败路径释放/取消流。
- 404 为对象缺失；412 为身份冲突；416、条件/Range 未被支持、响应字段缺失只能拒绝或依明确守旧规则回到完整检查，不能把 HEAD 成功当 GET 可读性。
- 小 Range 只能证明当次选定范围可读。它不是全对象的新 SHA 校验、MP4 解析或播放/解码证明。只有不可变对象身份已被可信保证，才可把旧完整验证复用于其余字节；比对大小或 ETag 本身不足。

## 持久化、恢复与最终 30 秒事务

最小安全实现范围（需 C4 集成 SHA 后另起实现 worktree）：新增严格内部 proof 类型/版本、在送审前完整落盘 inspect 成功后由受约束状态转换保存 proof、扩展 attestation 与最终锁内再验、完整读取 fallback 和针对性测试。快路径保持 disabled；即便有新 proof，仍执行当前完整 finalize inspect。因此此阶段不能交付读取优化成效。

`beginVideoReviewSubmission:442` 当前只是 assetId/token 的 guarded updateMany。将 proof 合并到此业务 fence 时，需要 jobId/当前 claim 上下文、锁后重读与完整绑定，proof 和付费 may-have-sent fence 同事务提交；本地检查失败、proof 不匹配/DB 失败不得跨 fence。不能只另写一个无校验的 stageData setter，也不要为 timing 新加串行 SQL。proof 写入须原子合并自己的 JSON 路径，保留 timing、callback、audio/visual review 等并发兄弟字段。

`finalizeVideoDelivery:821` 当前只接 assetId/checksum/etag/checkedAt。现有 lock:67 获取 job advisory/row lock、OUTPUT binding 删除锁和 asset row lock，再读取状态；同事务以稳定 settle key 结算、READY、SUCCEEDED。新 attestation 应区分 FULL（本次完整检查）与 PROOF_RANGE（旧完整 proof 加本次条件范围检查），均绑定完整当前身份。无/旧 proof 的 FULL 恢复允许沿原交付边界处理，不能因新 proof 必填而滞留历史任务；PROOF_RANGE 必须完整匹配当前 proof。已知 proof 身份/冻结冲突不得以切 FULL 模式绕过。新契约需在该事务内：

1. 严格解析本次 attestation 并根据模式处理 proof；PROOF_RANGE 从当前 DB 重读 proof，检查 proof/validator version、完整读取 origin，不能只信事务外 snapshot。FULL 路径严格处理无/旧 proof 的 fallback 与已知身份冲突。
2. 重验 jobId、ownerType/Id、两种 engine、OUTPUT assetId/binding、objectKey、mimeType、byteSize、SHA-256、ETag、冻结 fingerprint、封存媒体参数及审核关联。
3. 保留 hasVideoApproval、审核完整性和有效期、历史 audioSafetyPolicy、状态 FINALIZING、资产 VERIFYING/未删除未过期、ACTIVE reservation、现有 settle referenceKey。
4. checkedAt 必须来自本次身份与可读性检查完成之后，有限合法时间、不晚于 now、年龄不超过原 30000ms；不可用旧 validatedAt 更新时间。不在数据库锁内做 HEAD/GET。
5. 两个 finalizer、failure/删除竞争必须维持一次财务终态；terminal replay 仍沿用原处理，不复活内容。

恢复规则：

| 状况                                                               | 行为                                                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 无 proof、历史任务、未知/旧 proof 或 validator 版本                | 明确完整 GET/hash/MP4 fallback；沿原审核与交付边界。不靠原 outputSpec 合成验证来源。 |
| multipart 已完成而 DB commit 失败的 adoption，STORED/recovery      | 继续完整读取、重算 SHA、MP4；复用原 job/asset/key，不重新生成或新增付费审核。        |
| 完整 proof 的 owner/job/engine/key/hash/size/ETag/冻结约束发生冲突 | 拒绝/进入原恢复或 hold 路径；不能静默改 proof 接受新身份。                           |
| 删除、404、412、审核过期/不完整、30秒 attestation 过期             | 不交付、不结算；保持原恢复/拒绝规则。                                                |

刚上线的质量差异报告必须保留。当前 `packages/config/video-output.ts:215` 只拒绝格式/完整性问题；`:250` 的 duration/audio/resolution/aspect 比较生成 warning。proof fingerprint 必须绑定原冻结要求，但不能让请求与实际质量不同变成新拦截；继续以实际时长和原安全策略审核。

## 最小测试要求与计时口径

当前只读审计未运行下列测试；是下一阶段必须满足的要求：

- output-storage 单测：首轮完整 GET/hash/MP4 保留；头和 ETag 一致但 SHA 不同仍拒绝；精确 IfMatch/Range SDK command；206/ContentRange/total/type/ETag/body 长度；200、404、412、416、短读/超长/中途错误；流取消释放；HEAD 后对象变化。
- fulfillment 单测：proof 只能来自完整落盘读取，先 proof/fence 后审核；旧/缺 proof 与 disabled capability 都完整 fallback；冲突 fail closed；预检/DB 失败不发送审核；adoption 不再次 transfer/生成；历史安全策略与质量 warnings 保留。
- 隔离 DB：逐字段篡改 proof/attestation/asset/冻结约束，锁内发现；invalid/future/stale checkedAt；proof 写入与 paid fence 原子性；JSON 兄弟字段并发保留；20 finalizers 一次 settle；failure/删除竞争与 terminal replay；无新 reserve/付费 attempt。
- 存储边界：通用 put/sign/multipart/copy 等入口针对 video output key 的约束与合法 staging/upload 行为；actual SDK 3.1108.0 序列化 mock，不把 mock 当 R2。
- 若以后另获授权，隔离专用 R2 bucket/key 用合成 fixture（不调用模型）验 HEAD+IfMatch Range 组合的成功及 404/412/416、单写与分片完成同 key 冲突、真实 206/ContentRange/短读行为。当前未授权，不执行；MinIO、本地 fake、workerd 不代替 R2 服务端验收。

候选定向命令（未运行）：

```powershell
pnpm --filter @repo/jobs exec vitest run --config vitest.config.ts src/video-v1/output-storage.test.ts src/video-v1/fulfillment.test.ts
pnpm --filter @repo/database exec vitest run --config vitest.integration.config.ts --configLoader runner prisma/queries/media/video-v1-fulfillment.integration.test.ts
```

数据库命令需显式独立可丢弃 loopback TEST_DATABASE_URL；测试已有 localhost + test 数据库名门禁，门禁并不证明该库没人共享，需分配独立 DB/端口，先应用正确测试 schema。不得加载生产 .env 或使用共享/生产 DB。本次没有启动服务、创建数据库或执行测试。

已有 unit/DB 测试源码包含相同头但错误 checksum 拒绝、preflight 不跨 paid fence、adoption、20 finalizer、删除锁与历史安全策略等用例；这里只读到用例，不宣称通过。

证据分类：

| 类别               | 本次状态                                                                           |
| ------------------ | ---------------------------------------------------------------------------------- |
| 文档/官方契约      | 已读取交接原文、R2 官方兼容和一致性说明、SDK 锁定版本 schema；不是项目端到端保证。 |
| 源码推导           | 已核对上述 callsites、绑定和事务；普通 transfer 后两次完整读取。                   |
| 本地 mock          | 未运行，N=0。                                                                      |
| 隔离 DB            | 未运行，N=0。                                                                      |
| 真实 R2/trace/生成 | 未运行，N=0；不使用历史真实视频当当前版本样本。                                    |

实际删除等待、SQL、文件读取均为 0。无同版本同条件前后耗时/字节实测；P50/P95 不适用；线上提速未测。以后计时沿用 videoStageDurations/现有安全日志，区分 transfer、首次完整落盘读、finalize 检查的实际读字节与CPU/墙时；N不足直接列原值，记录文件大小、并发度、冷/热状态与 SDK/代码/环境版本。不得为每个 timing 新加串行 SQL，不承诺固定节省秒数。

## 后续依赖

1. 根会话给 C4 最终本地 SHA/集成结果后，重新核对两处 fulfillment 文件再开始串行实现；本报告不修改 C4 正在工作的源码。
2. 仓库脚本/配置补扫已完成；后续仍需证明真实服务条件语义与不可覆盖保证，才讨论快路径启用；不足时交付守旧 fallback，准确报告未启用。
3. 共享存储 helper 返回字段、类型或写 namespace 约束的改动需先协调，不能越界实现。
4. 不改第 13 节双限流、guest 降速、容量、审核策略、生产配置/价格/账户体系。

## 独立审查记录

按用户要求由独立 Astra max 会话只读核对原文、固定源码与本报告主体，结论为可作为第一阶段审计交付，未发现需修正的 P0/P1/P2 问题。该会话未修改文件、安装、构建、运行测试或访问 DB/R2。其审阅的报告主体 SHA-256 为 `6aa9dadc85a923fbf6741e349d070a3c35451c6a2f1321de6f66a906560dab8e`；本段是审阅结束后附加的记录。审查确认不会推翻 disabled 快路、首轮完整读取、历史 FULL fallback、已知冲突拒绝、最终事务绑定、审核/结算/删除/安全及质量 warning 边界；仍须等待 C4 集成 SHA 与存储启用前提证据。
