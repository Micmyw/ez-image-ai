# Explicit Veo tiers: dated pricing and compatibility

Observed 2026-10-08 from [Kie's Veo page](https://kie.ai/veo-3-1), [Pricing](https://kie.ai/pricing) and the [current generation contract](https://docs.kie.ai/veo3-api/generate-veo-3-video.md). The browser evidence records USD **REGION PRICE**, with one Kie credit equal to $0.005. It is not an account invoice, universal regional tariff or paid output test. Recharge bonuses are excluded from the cost floor. Region eligibility, price expiry and charges for repeated standalone Get operations remain unverified.

## New request mapping

`video-veo-3-1` uses `/api/v1/jobs/createTask`, top-level `model=veo-3-1`, and an explicit `input.model`: `veo3_lite`, `veo3_fast` or `veo3`. Both text and single-first-frame requests support 4, 6 or 8 seconds and 720p, 1080p or 4K; the new UI defaults to Lite and 8 seconds. Reference-video, last-frame, extend and standalone resolution upgrades are outside this implementation.

| Tier    | input.model | 720p, USD/video | 1080p, USD/video | 4K, USD/video |
| ------- | ----------- | --------------: | ---------------: | ------------: |
| Lite    | veo3_lite   |           0.075 |           0.1125 |         0.375 |
| Fast    | veo3_fast   |            0.15 |           0.1875 |          0.45 |
| Quality | veo3        |           1.125 |           1.1625 |         1.425 |

These are per-video generation costs, unchanged by choosing 4/6/8 seconds. Creation at 1080p/4K already includes one upgrade; the quote must not add its charge again. The existing moderation budget still varies by seconds. The independent tests enumerate all 54 tier × resolution × duration × input-mode combinations rather than deriving expected prices from application options.

## Existing profit rule and illustrative retail credits

Ordinary video retains a default 11,000-basis-point profit/complete-variable-cost target. The separate 200% template policy is unchanged. Let `C` be provider, moderation, runtime and storage costs after the existing failure allowance, `f` the allocated fixed payment cost, `p` the payment fee fraction and `m=1.10` the ordinary profit target:

```text
required revenue >= (1 + m) × (C + f) / (1 - (1 + m) × p)
credits = ceil(required revenue / lowest gross revenue per issued paid credit)
```

The recorded conditional example uses $0.0051 base moderation plus $0.0002/second, $0.10 runtime, $0.01 storage, 10% unrecoverable failure allowance, 6.54% payment cost, no allocated fixed fee, and the existing $0.021944 gross paid-credit floor. It produces these **8-second examples**, not a frontend tariff or an assertion about actual account costs:

| Tier    | 720p credits | 1080p credits | 4K credits |
| ------- | -----------: | ------------: | ---------: |
| Lite    |           24 |            29 |         61 |
| Fast    |           33 |            38 |         70 |
| Quality |          154 |           158 |        191 |

Quality 720p at 4 seconds is 153 credits; Quality 4K at 4/6 seconds is 190. Catalog and signed quotes use current approved server budgets. The 6.54% historical payment assumption is not a new confirmation that all real payment scenarios cost 6.54%; no budget is reduced by this change.

## Frozen requests, results and prior orders

New quotes bind `veoTier`, the model contract `video-models-2026-10-08.1`, price basis `kie-public-2026-10-08.1`, and a resolution policy inside the immutable signed snapshot. New generic requests without a tier, and other models carrying a Veo tier, reject. Changing a client request after quotation cannot use the original price or admitted idempotency key.

Historical generic receipts with no tier keep that exact shape and their original implicit Fast semantics. The separate `video-veo-3-1-fast` product keeps the old `/api/v1/veo/generate` path and its historical prices; it is not converted to the new generic Fast tariff. A restored editable historical generic draft may explicitly represent its old Fast choice, but accepted or acceptance-unknown requests always replay their untouched receipt. New-version rejection is recoverable only after exact `INVALID_VIDEO_QUOTE`; accepted replay remains ahead of new admission gates.

The [task-detail contract](https://docs.kie.ai/market/common/get-task-detail.md) determines success state and task identity. New 1080p/4K results use the single HTTPS `resultJson.data.result_urls` result, never `origin_urls` or a lower-resolution top-level result as fallback. Returned model/parameter metadata, when supplied, must match the frozen endpoint, tier and resolution. New 720p and historical results retain their documented separate shapes.

New explicit Veo snapshots freeze an **APP_MINIMUM** policy: delivered short edge at least 720, 1080 or 2160 pixels, including Auto/source framing. This is an application delivery floor, **not supplier-confirmed exact output dimensions**. It supplements existing container, maximum dimensions/bytes, duration, aspect, audio and single-result checks. Historical missing-tier jobs do not receive this new policy retroactively. A rejected output does not prove that Kie refunded a generation charge.

## Ordered release and configuration

The old submission consumer manually reconstructs requests without `veoTier`; deploying the new website first could submit paid Lite/Quality orders as the provider's implicit Fast. Release a consumer-only compatibility commit first, keeping old model/price versions, capabilities, website behavior and absence of generic Veo pricing. Verify the background deployment has fully adopted that commit before enabling new quotes/UI. Do not publish both stages as one unobserved deployment or roll the background consumer back while new-tier jobs remain.

The activation stage upgrades only explicitly known approved model/price versions through existing build-secret handling. It preserves audience, admission switches, budgets, paid-credit requirements, finite/`none` expiry and template policies. Unknown/unapproved configuration remains closed. No database migration, new Workflow version or manual deployment is required. Deployment evidence belongs to the controller's release record; this source document does not claim either stage is live.

## Remaining independent contract risks

MiniMax's documented input dimensions/ratio need a separate admission change. Kling 3 Pro square output has contradictory official 1440×1440 versus 1080×1080 statements; existing strict validation is unchanged. Precise output pixels and audio behavior for other models, actual account/regional costs and paid generation quality remain unverified. These are not resolved by tier mapping or local mocked-provider tests.
