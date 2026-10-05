# Hotel Lobby price and model permission receipt

The owner approved revenue of at least **three times complete cost** on 2026-10-05.
The template-only policy is `hotel-lobby-duo-cost-2026-10-05.2`. At the budgets below,
the quote is **69 credits for the complete scene-plus-video order**. The intermediate
scene has no separate customer charge. Ordinary video pricing is unchanged.

## Approved budget and calculation

All numbers are USD, rounded conservatively in integer micro-dollars. This is an
approved engineering budget using current public rates, not a merchant invoice or
a guarantee of realized profit. Reapprove before broader paid opening if actual
fees, tax, FX, moderation, retention or nonbillable losses exceed this budget.

| Cost component                            | Budget per complete order | Basis                                                                |
| ----------------------------------------- | ------------------------: | -------------------------------------------------------------------- |
| Scene, Nano Banana 2 Lite 1K              |                  0.020000 | Higher English Kie public rate; Chinese copy differs                 |
| Video, Seedance 1.5 Pro, 5s/720p/silent   |                  0.087500 | 5 × 0.017500                                                         |
| Inherited final-video review budget       |                  0.006100 | 0.005100 base + 5 × 0.000200; retained conservatively                |
| Two input-image reviews plus scene review |                  0.015300 | 3 × 0.005100 conservative budget, not SeeAPI's tariff                |
| Both prompt checks                        |                  0.000000 | Waffo currently states free during beta; versioned and expiring      |
| Runtime                                   |                  0.200000 | Existing 0.10 + template 0.10 allocation; estimate                   |
| Storage and transfer                      |                  0.020000 | Existing 0.01 + template 0.01 allocation; estimate                   |
| Direct budget                             |                  0.348900 | Sum above                                                            |
| Risk-adjusted budget                      |                  0.387667 | Ceil(direct / 0.9), 10% nonbillable outcome allowance                |
| Payment fee                               |                  0.113561 | Ceil(7.5% × minimum qualifying revenue); fixed fee not counted twice |
| Complete budget                           |              **0.501228** | Risk-adjusted budget plus payment fee                                |
| Minimum qualifying revenue                |              **1.514136** | 69 × 0.021944                                                        |
| Revenue / complete budget                 |               **3.02085** | About 202.09% profit/cost and 66.90% gross margin                    |

The paid-credit floor is the existing lowest catalog value, Studio annual
USD790 / 36,000 credits, conservatively floored to 21,944 micro-dollars per credit.
The existing paid-lot qualification and refund checks still apply. Promotional,
unfunded and administrator test credits are not represented as paid revenue.

The price solver includes payment fees in the revenue equation, applies the failure
allowance once to the combined budget, rounds credits upward and rechecks the final
profit. **68 credits fail the three-times target** under this budget. The template
rejects markup below 20,000 bps and payment budget below 750 bps, requires a payment
cost basis, and retains a higher existing payment budget. Shared video markup remains
11,000 bps. The old 654 bps payment allocation assumed full-price USD19 receipts;
qualifying discounted Creator receipts can be as low as USD15.3608, for which the
public 3.9% + USD0.50 terms require 716 bps. The template rounds that up to 750 bps.

Budget validity ends at **2026-10-12T00:00:00Z**, or the existing video cost approval
expiry if earlier. Missing or expired approvals reject new quotes. Existing accepted
jobs retain their original immutable price and execution snapshots.

## Sources checked in this task

Only public HTTP reads and an authenticated account-balance GET were performed.
No image/video generation or paid moderation request was submitted.

| Source                                                                                                    | Observation UTC      | Evidence                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Kie Nano Banana 2 Lite](https://kie.ai/nano-banana-2-lite)                                               | 2026-10-05 00:58:28  | HTTP 200; embedded English pricing: `4 credits ($0.02) for 1K`. Chinese copy says USD0.015; budget uses the higher value.                                                        |
| [Kie Seedance 1.5 Pro](https://kie.ai/seedance-1-5-pro)                                                   | 2026-10-05 00:58:28  | HTTP 200; `720p: 3.5 credits/s ($0.0175) no audio`.                                                                                                                              |
| [SeeAPI image moderation](https://www.seeapi.com/docs/nsfw-filter/image-moderation/)                      | 2026-10-05 00:58:28  | HTTP 200; `0.01 credits/gen`. Rounded display USD0.00 does not mean free.                                                                                                        |
| [SeeAPI pricing](https://www.seeapi.com/pricing)                                                          | 2026-10-05 00:58 UTC | Public Basic USD29 / 3,200 credits implies USD0.000090625 per 0.01-credit check. The approved USD0.0051/check budget is intentionally higher; actual merchant plan not verified. |
| [Waffo prompt moderation](https://docs.waffo.ai/zh/api-reference/endpoints/content-safety/scan-prompt.md) | 2026-10-05 00:58:43  | HTTP 200; free during beta, no separate enablement; not a permanent free-price promise.                                                                                          |
| [Waffo payments](https://waffo.ai/pricing)                                                                | 2026-10-05 00:58:33  | HTTP 200; `per transaction 3.9%+$0.5`. Merchant-specific terms not verified.                                                                                                     |

Raw source bodies, HTTP status and hashes remain in the task-local
`.cache/hotel-lobby/pricing-source-check.json`. Kie's public pricing search returned
HTTP 200 with zero matches for the full display names; no price was inferred from
that empty result. The product pages supply the quoted rates.

## Model permissions and private configuration

The fixed mapping is Nano Banana 2 Lite 1K, two ordered reference photos, followed by
Seedance 1.5 Pro image-to-video, five seconds, 720p, 9:16, silent, fixed lens. The
server owns these values; the client cannot supply a model, prompt, rate or remote URL.

The minimum additional `VIDEO_MODEL_ALLOWED_OPTIONS` entry is:

```json
{
	"productKey": "video-seedance-1-5-pro",
	"modes": ["image-to-video"],
	"durations": [5],
	"resolutions": ["720p"],
	"sounds": [false]
}
```

This allowlist is shared with ordinary video. Applying this entry also permits that
selection for the existing eligible video cohort; it does not widen the login whitelist.
Image configuration requires `MEDIA_NANO_BANANA_2_LITE_ENABLED=true` and `kie` in
`MEDIA_ENABLED_PROVIDERS`. Global generation, database emergency model overrides,
readiness, funding and the independent template gate still apply.

The local preparation tool preserves the supplied current private environment,
appends only the missing allowed tuple and template cost policy, and produces a new
ignored private dotenv file. It never changes a remote Worker, credentials, payment
environment, customer balance or existing grant. It forces template generation and
its build override closed and does not manufacture template quality acceptance.
An existing incompatible/expired cost policy or an oversized runtime bundle is an
error, not permission to replace unrelated policy.

Run `pnpm hotel-lobby:prepare-config --input <current-private-dotenv>` from the
repository. The default new output is `.wrangler/hotel-lobby/prepared/.env.local`;
`--output <new-ignored-path>` selects another private destination. Existing output
files, tracked/public paths and paths outside the repository are refused. Never
copy the public reference over a current production configuration.

The checked-in [closed reference](hotel-lobby-configuration.example.env) was passed
through this real CLI successfully. It produced `PREPARED_CLOSED`, 69 credits,
1,514,136 micro-dollars minimum revenue, 501,228 micro-dollars complete cost, and a
2,199-byte private policy. Template enablement remained false and its acceptance
marker remained empty. This was offline configuration validation, not a live quote
or production configuration change.

On 2026-10-05 01:03:28 UTC, the existing local production credential authenticated
successfully to `GET https://api.kie.ai/api/v1/chat/credit` (HTTP/provider 200) and had
a positive balance. The local image flag and provider list already included the
scene candidate. Both running Cloudflare Workers expose Kie/SeeAPI credential
bindings, but their secret values and private policy are not readable via settings.
**Authentication and balance do not establish entitlement to the exact two-model
template.** That account entitlement, actual debit, callbacks and duo quality remain
NOT_RUN pending bounded paid acceptance. No new paid budget was inferred from an
earlier ordinary-video administrator grant.

Keep `HOTEL_LOBBY_DUO_ENABLED=false`, content `draft`, and examples empty until real
acceptance. Separate the four states: implemented pricing/permission configuration;
local calculated quote; authenticated read-only account check; production activation.
Only the first three have evidence here.
