# 视频供应商价格修订：2026-10-05

当前价格版本为 `kie-public-2026-10-04.3`，模型参数版本为 `video-models-2026-10-04.2`。价格 `.2` 已修正 MiniMax H3 单图计费与 Seedance 2 Mini / Fast 限时价；`.3` 仅新增官方旧接口的 Veo 3.1 Fast 费率，不改变已接入型号的参数或价格。本页记录公开来源、实现和本地验证；真实账单与生产开放须另行验收。

后续已授权的真实生成、单任务费用回执、账户余额核对及开放边界见 [真实验收报告](video-v1-real-acceptance-2026-10-05.md)。下文保留价格修订阶段的预期费用与验证状态，不将公开预算价改写为本账户实际扣费。

## 已实现行为

### H3 单图输入

Kie 官方产品页明确写明：

> Input images: The first 5 images are free; additional images are charged separately.

本产品只支持单图输入，所以 H3 文生和单图生都按生成时长收费：768p 为 `$0.04/秒`，2K 为 `$0.065/秒`；不再给单图请求额外增加 `$0.02`。例如 5 秒 768p 的生成成本均为 `$0.20`，15 秒 2K 均为 `$0.975`。审核、运行、存储和其他完整成本仍通过原有成本策略另行核算。

### Mini / Fast 独立到期

两款官方产品页都明确写明限时优惠截止于 `October 7, 06:00 (UTC)`。页面观测时间为 2026-10-04，因此当前已知报价的截止采用 `2026-10-07T06:00:00Z`，即北京时间 2026-10-07 14:00。

- `video-seedance-2-mini` 和 `video-seedance-2-fast` 在截止点及其后拒绝新报价，返回 `VIDEO_MODEL_PRICE_EXPIRED`。
- 两款模型的报价快照 `pricingDetails.validUntil` 取运营批准有效期与促销截止的较早值。较晚的 `VIDEO_PRICE_VALID_UNTIL` 不能延长这两款模型的促销价；较早的批准有效期也不会被放宽。
- 其他模型仍使用其正常的 `VIDEO_PRICE_VALID_UNTIL`。不必为了 Mini / Fast 缩短全部模型的全局批准期限。
- 旧 `.1` / `.2` 价格批准不能使用当前 `.3` 报价；发布时同步 `VIDEO_PRICE_ACCEPTED_VERSION=kie-public-2026-10-04.3` 和 `VIDEO_MODEL_CONTRACT_VERSION=video-models-2026-10-04.2`。
- `videoSupplierCostMicros` 保留为不读取时钟的纯费率计算函数；正式报价和新准入必须使用含有效期校验的 `resolveVideoModelPrice`。

本次不改写已有价格快照或已接受请求。供应商提交结果不明确时仍不得重新发送付费请求。

### Veo 3.1 Fast：官方旧接口与每视频计费

2026-10-04 UTC（北京时间 2026-10-05）复核的官方合同明确将 `veo3_fast` 命名为 Veo 3.1 Fast：

- 创建：`POST /api/v1/veo/generate`，顶层 `model=veo3_fast`，不是统一接口 `/api/v1/jobs/createTask` 的 `input` 包装。
- 状态：`GET /api/v1/veo/record-info?taskId=…`，供应商明确其为最终权威状态来源。回调仅经原有 HMAC 验证、持久化后唤醒查询。
- 文生与单图均支持 4、6、8 秒和 720p、1080p、4K；声音为供应商原生能力，没有伪造静音开关。文生比例为 16:9 / 9:16，单图另支持跟随输入；不增加参考视频或编辑模式。

官方公开价格按**每个视频**列示，不按秒数相乘：

| 分辨率 | Kie 积分 / 视频 | 名义供应商美元 / 视频 |
| ------ | --------------: | --------------------: |
| 720p   |              60 |                $0.300 |
| 1080p  |              65 |                $0.325 |
| 4K     |             180 |                $0.900 |

公价未单列各时长的账单示例。4 / 6 / 8 秒均有请求合同依据，但本轮只计划真实验收**文生、4 秒、720p、16:9、原生声音**；预计供应商扣 60 Kie 积分 / $0.30，不得写成已实测扣费。其他时长、分辨率和图生组合仅有本地 / Mock 验证，不自动批量付费测试。真实 Fast 生成、计费和签名回调验收在取得记录前均为 **NOT_RUN**。

按当前已批准的完整成本预算，最低档为 **52 站内积分**。该计算采用审核基础 5,100、每秒 200、运行 100,000、存储 10,000 微美元，固定支付分摊 0，支付费率 654 bps、未收费失败预算 1,000 bps、利润 / 完整成本目标 11,000 bps，以及每付费积分最低收入 21,944 微美元。取整后最低付费收入参考为 `$1.141088`、完整成本预算 `$0.536740`，利润 / 成本约 **112.59%**。这是公开供应商价格和预算假设下的计算；运营资助内测积分不构成实收收入，也不能证明实际利润。成本批准改变时须重新报价。

通用 `veo-3-1` 仍无明确价格档映射；竞品 Pro 不能冒充 Kie Quality。H3 Turbo / Max / Max Turbo 仍缺独立合同，不沿用基础 H3 价格。

## 可复核来源

下述补证仅使用官方公开页面的未登录 HTTP GET 和公开只读价格查询，没有调用生成接口或读取账户凭据。原始响应与提取后的 `groupData[].pricingDesc` 保存在 `.cache/video-v1/activation-2026-10-04/pricing/`。

| 来源                                                | 观测时间 UTC             | 原始 HTML SHA-256                                                  |
| --------------------------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| [MiniMax H3](https://kie.ai/minimax-h3)             | 2026-10-04T15:54:42.806Z | `306e8720fdb2cfaa68657928e718ccd00d4473a1ffc86b99ec9a42bef7ee9528` |
| [Seedance 2 Mini](https://kie.ai/seedance-2-0-mini) | 2026-10-04T15:54:42.807Z | `67531a5207fbc34ec41215c72c90757e978e75a5a2e2963e27ec40fa00a28645` |
| [Seedance 2 Fast / 2](https://kie.ai/seedance-2-0)  | 2026-10-04T15:54:45.719Z | `a996aef17017da8159075448a5248fcabce151db8db773562bd39be32e829934` |

全量价格核对见该目录的 `REPORT.md`、`pricing-comparison.json` 和 `model-page-pricing-excerpts.json`。这些是公开价依据，不能冒充本账户实付账单。Seedance Fast 的 480p 仍采用官方较高的美元显示值 `$0.059/秒`，不把 11.7 credits 折算的 `$0.0585` 当作账户实际成本。

Veo Fast 的持久合同摘录见 `packages/ai/media/catalog/fixtures/kie-veo-fast-contract-2026-10-05.json`，官方来源为[旧创建接口](https://docs.kie.ai/old-model/veo3-api/generate-veo-3-video.md)、[旧状态接口](https://docs.kie.ai/old-model/veo3-api/get-veo-3-video-details.md)、[回调格式](https://docs.kie.ai/veo3-api/generate-veo-3-video-callbacks.md)、[HMAC 规范](https://docs.kie.ai/common-api/webhook-verification.md)和[产品价格页](https://kie.ai/veo-3-1)。公开价格查询 `POST https://api.kie.ai/client/v1/model-pricing/page` 使用 `{"pageNum":1,"pageSize":100,"modelDescription":"Veo","interfaceType":"Video"}`，于 `2026-10-04T17:23:33.212Z` 返回 29 条 / 1 页；该只读响应的 SHA-256 为 `03e5a4e1bad39afdc68ab22316965cd4d2566dfdd4617b8c38ee4f2098cbc390`。英文价格与中文文案存在差异，采用英文公开价作预算，不据地区文案推定账户折扣。

## 本地验证

以下第一组保留 `.2` 价格修订时的历史验证记录，不表示当前新增 Fast 只有这些测试：

- 新回归加入后、实现修改前：22 项中 10 项按预期失败，直接暴露 H3 加价、促销未到期关闭和旧版本仍可批准的问题。
- `pnpm --filter @repo/config test video-pricing.test.ts`：**22/22 PASS**。覆盖 H3 两分辨率、截止前一毫秒、截止当时、截止之后、较早批准期限、其他型号不受影响和旧版本拒绝。
- `pnpm --filter @repo/config type-check`：**PASS**。
- 受影响 TypeScript 的 Oxlint `--deny-warnings`、Oxfmt 和 diff 检查：**PASS**。
- 独立只读审核与独立重跑同一 22 项测试：**PASS，无本范围阻塞发现**。
- 真实账户价格、付费生成、实际账单核对、生产部署和入口开放：本次修复均 **NOT_RUN**。

`.3` / catalog `.2` 新增 Fast 后：config 定向 56 项、AI 最终 provider/router 118 项、jobs 最终 submission/callback 59 项、API catalog 8 项均 **PASS**；config / AI / jobs 类型检查及受影响 lint / 格式 / diff 检查 **PASS**。独立审核验证创建与查询路由、原有 HMAC、矛盾任务身份拒绝、不确定提交不重发及旧已接受任务持续恢复，未发现剩余阻塞缺陷。完整 PostgreSQL、构建与发布结果由集中验收报告负责，不能由这些局部测试推定。

## 集成建议

正式批准时同步价格 `.3` 与模型参数 `.2`，并先应用新增 `video-veo-3-1-fast` 的第 61 个前向迁移 `20261005010000_video_veo_fast_quote_pending_evidence`；不得修改已经应用的第 60 个迁移。新增型号仅在明确的 `VIDEO_MODEL_ALLOWED_OPTIONS` 内可提交，首轮仅开放上述最低档验收组合。

Seedance Mini / Fast 截止后须重新读取官方价与账户账单后再建立新费率；不要延长当前促销截止来假装已重新核价。

首次付费提交沿用数据库对冻结价格与内测资助有效期的检查；新增适配器沿用同一提交围栏、独立 Workflow、审核、转存和结算流程。回调与查询都不能切换已冻结的型号。单元测试证明提交不确定后不会再次调用付费接口，但不能替代真实供应商收费和队列跨期验收。
