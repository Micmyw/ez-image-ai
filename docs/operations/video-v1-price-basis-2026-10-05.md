# 视频供应商价格修订：2026-10-05

价格版本由 `kie-public-2026-10-04.1` 提升为 `kie-public-2026-10-04.2`。本次只修正 MiniMax H3 单图输入计费与 Seedance 2 Mini / Fast 限时价有效期，不批准账户费用、不开放生产入口。

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
- 旧 `.1` 版本批准不能使用新 `.2` 报价，需重新签认 `VIDEO_PRICE_ACCEPTED_VERSION=kie-public-2026-10-04.2`。
- `videoSupplierCostMicros` 保留为不读取时钟的纯费率计算函数；正式报价和新准入必须使用含有效期校验的 `resolveVideoModelPrice`。

本次不改写已有价格快照或已接受请求。供应商提交结果不明确时仍不得重新发送付费请求。

## 可复核来源

均为官方公开页面的未登录 HTTP GET；没有调用生成接口或读取账户凭据。原始响应与提取后的 `groupData[].pricingDesc` 保存在 `.cache/video-v1/activation-2026-10-04/pricing/`。

| 来源                                                | 观测时间 UTC             | 原始 HTML SHA-256                                                  |
| --------------------------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| [MiniMax H3](https://kie.ai/minimax-h3)             | 2026-10-04T15:54:42.806Z | `306e8720fdb2cfaa68657928e718ccd00d4473a1ffc86b99ec9a42bef7ee9528` |
| [Seedance 2 Mini](https://kie.ai/seedance-2-0-mini) | 2026-10-04T15:54:42.807Z | `67531a5207fbc34ec41215c72c90757e978e75a5a2e2963e27ec40fa00a28645` |
| [Seedance 2 Fast / 2](https://kie.ai/seedance-2-0)  | 2026-10-04T15:54:45.719Z | `a996aef17017da8159075448a5248fcabce151db8db773562bd39be32e829934` |

全量价格核对见该目录的 `REPORT.md`、`pricing-comparison.json` 和 `model-page-pricing-excerpts.json`。这些是公开价依据，不能冒充本账户实付账单。Seedance Fast 的 480p 仍采用官方较高的美元显示值 `$0.059/秒`，不把 11.7 credits 折算的 `$0.0585` 当作账户实际成本。

## 本地验证

- 新回归加入后、实现修改前：22 项中 10 项按预期失败，直接暴露 H3 加价、促销未到期关闭和旧版本仍可批准的问题。
- `pnpm --filter @repo/config test video-pricing.test.ts`：**22/22 PASS**。覆盖 H3 两分辨率、截止前一毫秒、截止当时、截止之后、较早批准期限、其他型号不受影响和旧版本拒绝。
- `pnpm --filter @repo/config type-check`：**PASS**。
- 受影响 TypeScript 的 Oxlint `--deny-warnings`、Oxfmt 和 diff 检查：**PASS**。
- 独立只读审核与独立重跑同一 22 项测试：**PASS，无本范围阻塞发现**。
- 真实账户价格、付费生成、实际账单核对、生产部署和入口开放：本次修复均 **NOT_RUN**。

## 集成建议

正式批准时使用 `.2`，并在截止后重新读取 Mini / Fast 官方价与账户账单后再建立新的费率版本；不要延长当前促销截止来假装已重新核价。

报价有效期也应在首次付费提交前按冻结快照检查，以覆盖已接受任务排队跨截止的情况。本次修改只负责报价层，未修改 jobs 或数据库执行围栏；不能把报价层测试描述成已验证队列跨期的真实收费行为。
