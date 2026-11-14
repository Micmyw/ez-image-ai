# 输出预览、审核与原图归档并行：历史设计审查

> 本文以下内容保留为早期审查记录，产品前提已被用户后续决定替代：**已审核的完整模型原图就是可用结果；展示、下载、继续编辑和成功结算不再等待 R2 归档。** 当前实现、适用范围和发布顺序以 [模型原图交付与独立归档](provider-original-delivery-2026-11-14.md) 为准。以下“预览不能结算”“必须先保存原图”等结论，不适用于新的完整原图协议。

审查日期：2026-11-14，北京时间。基于 `ab622e20` 及本轮已有本地修改；这次只审查设计并补充文档，没有修改生产协议、发布代码或调用付费供应商。

## 结论

方向可行，但上一版“审核小预览与原图存储并行，审核通过后先展示”省略了三个必要条件：**独立的预览状态、原图与审核图的不可变对应关系、原图保存失败的资金与恢复处理**。不能只把原有操作改成 `Promise.all`，也不能把小预览登记为普通 `READY OUTPUT`。

建议首期采用：同一次源读取，同时写入现有私有原图对象和生成审核预览；源读取完整、摘要和预览校验通过后允许提交审核；只有最终选中的不可变原图身份与预览来源一致时，才允许发布已通过审核的预览。展示可早于后续归档记账和结算，但这**不承诺完全绕过原图持久化**。真正“原图尚未持久化也先展示”的扩展版本，需要另外实现允许原图最终无法交付的明确状态及失败处理，不能承诺仅凭缩略图和摘要恢复原图。

| 候选方案                                                       | 审查结论                                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 模型回调 URL 直接交审核，随后直接显示该 URL                    | 当前合同不通过：回调不是完整结果体认证；同一 URL 不能证明多次读取相同；私有访问、失效和撤回没有闭环。 |
| 单次源读取，并行生成预览和写原图；冻结不可变对应关系后独立展示 | 可作为首期实现设计，必须同时完成下述状态、权限、计费和恢复约束。                                      |
| 不等原图持久化，仅凭已审核缩略图保证高清原图以后必定可恢复     | 不成立。源 URL 失效或变更、Worker 退出后，摘要与缩略图不能重建原始字节。                              |

这些是新方案的设计阻断项，不是声称当前串行生产路径已存在同样漏洞。

## 必须解决的问题

### 1. 预览不能触发成功计费，也不能使任务提前失败

现有 `evaluateSettlementOutputs` 根据最终 OUTPUT 绑定中 `READY` 且审核有效的数量判断成功，没有独立的原图归档状态。将缩略图放进去，会提前扣积分或消耗 Image Pass 成功单位。反过来，如果预览审核完成就发送结算事件，而原图 OUTPUT 尚未创建，空输出集也可能被视为“没有等待中的输出、零成功”，提前释放资金并失败。

需要独立候选/派生预览关系，并在持久业务状态中明确“原图仍待归档”。预览 verdict 不发送最终结算事件；原图和有效审核证据共同满足条件后，发送唯一幂等结算事件。技术归档永久失败时，预览不构成新增成功单位，沿用对应资金合同的失败处理；内容审核拒绝和模型政策拒绝仍遵守各自冻结计费合同，不能统一改成免费。

依据：[runtime.ts](../../packages/jobs/src/runtime.ts)，`evaluateSettlementOutputs` 3843 附近、零可用输出计算 4004 附近、CREDITS/IMAGE_PASS 结算 4503–4547。

### 2. 提前看图与下载、继续编辑必须是不同能力

现在 `getJob.assets[].preview` 签的是该资产的原始 `objectKey`，不是另一张小图；归档和审核完成后，任务还在 FINALIZING 就能显示。现有 ready 界面同时开放下载、壁纸、打印和视频入口；inline 与 attachment 共用资产授权。

仅给预览新增 binding role 也不够：普通新 ROOT 输入接受本人拥有且审核有效的 READY 图片，并没有预览用途判断。若预览仍是普通 READY MediaAsset，客户可以绕过隐藏按钮直接拿它作为新输入。

新响应必须分别表达 `previewAvailable`、`originalAvailable`、`downloadAvailable`、`refineAvailable`。派生预览仍采用私有 MediaAsset，但必须有不可混淆的用途/候选关系；所有下载、输入、列表、复制和模板读者都要执行相应用途限制。不能用临时公共对象绕过私有资产协议。保留现有 CHILD refine 的父任务成功条件。预览已可见时不提示整体“成功完成”，原图尚不可用时不开放对应操作。

依据：[get-job.ts](../../packages/api/modules/media/procedures/get-job.ts) 59、125；[get-asset-access-url.ts](../../packages/api/modules/media/procedures/get-asset-access-url.ts) 23–55；[EditorResultPanel.tsx](../../apps/saas/modules/media/components/editor/EditorResultPanel.tsx) 239、282；[generation-authorization.ts](../../packages/api/modules/media/lib/generation-authorization.ts) 176；[jobs.ts](../../packages/database/prisma/queries/media/jobs.ts) 543、924、994。

### 3. 必须防止审核的是 B，最后保存和展示的却是 A

现有条件写在冲突或结果不确定时，可以完整读取并采用已经存在的不可变对象 A。供应商 URL 此时可能已返回 B。若并行分支拿 B 制作预览并通过审核，而原图写入最终选择了 A，URL/候选 key 相同不能授权复用 B 的结论。

持久对应关系至少要包含 owner、job、provider attempt、候选身份、原图完整 SHA-256、预览对象及 SHA-256、变换版本/参数、审核 generation/task/verdict。最终对象摘要不同就必须废弃对应预览/结论，对实际选中的原图重新制备和审核。首期在原图赢家未明确前不发布预览；晚到回调、旧 lease 和旧 generation 不得覆盖新决定。审核 PENDING、技术失败、缺失或拒绝都不展示。

依据：[s3/index.ts](../../packages/storage/provider/s3/index.ts) 1039–1056；[assets.ts](../../packages/database/prisma/queries/media/assets.ts) 106–150；[runtime.ts](../../packages/jobs/src/runtime.ts) 3147–3263。

### 4. 小预览持久化不能代替原图恢复

预览 JPEG、摘要、任务 ID 和 verdict 可以恢复预览/审核；它们不包含高清原图。要保证后续交付原图，需要已经持久化的完整不可变候选，或经过验证的供应商不可变内容与保留期限合同。最省复制的首期方案是继续使用现有条件写原图对象作为完整候选，不再额外存一份原图。

原图已写成功但响应丢失时，沿用读取既有对象恢复的能力；失败只重试同一个结果的归档，绝不自动重新调用付费模型。需要为“预览已批准、原图未完成”建立独立、有限重试的恢复路径和明确终态。当前通用恢复最多八次后只记审计并停止扫描，不能推定它会自动释放该新状态的冻结资金。也不能提前创建历史结算事件，把后续恢复错误导向 SETTLE。

现有 writer 在存储失败时会主动中断源流，不能假设加入两个 Promise 后预览分支就会继续。失败隔离、取消和完整字节恢复必须在同一协议里处理。

依据：[streaming-private-image.ts](../../packages/storage/lib/streaming-private-image.ts) 53–61；[s3/index.ts](../../packages/storage/provider/s3/index.ts) 935、1039；[finalization-recovery-store.ts](../../packages/jobs/src/handlers/finalization-recovery-store.ts) 82–116、168–224；[runtime.ts](../../packages/jobs/src/runtime.ts) 4577、5348。

### 5. 不能扩大内存和格式风险来换取表面并行

当前原图下载与 R2 PUT 已经流式并行，每个 64 KiB 块等待背压，计算完整摘要，并在源 EOF/长度确认前保留最后一字节。新方案可把同一读取分给转换器，但审核不能以不完整图像或尚未完成的摘要为依据。

Cloudflare Images binding 接受字节流，现有适用边界是 20,000,000 字节；原图最大 25 MiB，两者不同。Workers 的 128 MB 是整个 isolate 的内存，不是每个请求。不得把普通 streaming executor 全部改成完整原图 `arrayBuffer()`，也不新增站点全局并发额度。Workers 原生 `tee()` 文档描述按慢分支背压，但本项目还有 Node Readable 包装；实际适配链、错误传播和取消需要验证。慢存储分支也可能拖慢预览输入。

建议首期只接普通账户、新鲜 URL、已知长度且不超过 20,000,000 字节、明确静态的 JPEG/PNG/WebP。游客水印、GIF 全帧、SVG 专用渲染、动画 PNG/WebP、inline、未知长度、multipart 和已有恢复任务继续旧路径，不能只因 MIME 像普通图片便推定静态。该首期范围不承诺改善所有游客输出。

依据：[streaming-private-image.ts](../../packages/storage/lib/streaming-private-image.ts) 70–146；[cloudflare-images.ts](../../packages/storage/image-processing/cloudflare-images.ts) 38；[image-moderation-input.ts](../../packages/storage/lib/image-moderation-input.ts) 22–99；[runtime.ts](../../packages/jobs/src/runtime.ts) 5514、5591。

## 对收益判断的修正

已有 17 个样本包含内部演示任务；归档交接前中位数 5.411 秒包含源下载、写入及事务/调度，不能全部视为可省的 R2 等待。审核准备（原图重读、转换及检查）中位 0.770 秒也不是承诺能完全消除的成本，新预览写入、派生关系提交同样有开销。

当前流式原图写入随下载推进，完整 EOF 往往靠近 PUT 尾部。同源转换可重叠部分工作，但真正提前多少，需要分别测量：源 EOF、原图 PUT ACK、预览制备完成、候选提交、审核提交、审核结论提交、预览实际可见、原图可下载。不能把现有阶段中位数直接相加减得到新性能。

已有样本中，审核提交返回到查询准备之间有 5.175–9.987 秒，含默认五秒轮询和数据库/调度；17 个观察到的 SeeAPI 回调均晚于 verdict 提交。这个等待也应作为优先测量对象。缩短轮询前先核对供应商查询限制，不能假设该段时间全部可删除，不能移除恢复轮询。

依据：[原始观测](evidence/output-latency-2026-11-14.json)、[runtime.ts](../../packages/jobs/src/runtime.ts) 的 `imageProcessingPollMs: 5_000`。未新增生产查询，未测得新协议的实际耗时。

## 实现验收与发布门槛

后续实现至少覆盖以下回归：慢源/慢 R2/慢转换的背压和内存；EOF 不足/多字节；原图条件写选中不同对象；PUT 成功响应丢失；审核先完成或归档先完成；旧回调和重复通知；有预览但无最终输出时不提前结算；直接 API 请求不能绕过下载/输入用途限制；已拒绝结果永不展示；进程在预览或原图提交边界退出；原图永久技术失败后按冻结资金合同结清；刷新与账号切换；删除和复制锁；格式及游客旧路径。

按消费者先行发布：先迁移用途/候选身份，再部署状态查询、权限、结算、清理、Workflow/Outbox 恢复读者，最后开启新生产者；旧任务继续原协议。关闭生产者后保留新消费者，直到新候选全部处理完，不能回滚成不认识 preview-only 状态的恢复逻辑。`waitUntil` 只延长请求生命周期，不能代替已提交的持久重试意图。

本次运行现有 `streaming-finalization-runtime`、`finalize-output-review`、`finalize-media` 三个测试文件，**37 项通过**。这些测试验证当前基线，没有验证尚未实现的新并行协议。两项独立源码审查分别覆盖传输/Cloudflare 与展示/资金/恢复，使用用户指定的 `gpt-6.1-sol`、`max`。没有遗留测试服务或新 worktree。

官方平台资料（本次核对）：[Images binding](https://developers.cloudflare.com/images/optimization/binding/)、[Workers 内存限制](https://developers.cloudflare.com/workers/platform/limits/#memory)、[ReadableStream](https://developers.cloudflare.com/workers/runtime-apis/streams/readablestream/)、[waitUntil](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)。
