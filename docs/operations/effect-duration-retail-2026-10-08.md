# Hotel Lobby and Raindance duration retail policy

The approved October 8 policy covers Hotel Lobby, Raindance Solo and Raindance Duet. Five seconds remains the default. Ten seconds has a separate frozen schema 3 template and choreography; schema 1 five-second jobs remain readable and unchanged. Rumpelstiltskin retains its schema 2 reference-video contract and pricing.

## Pricing and eligibility

The effect base markup stays at the approved 20,000 basis points. Each additional second above five adds 1,500 basis points to the standard markup, capped at 100,000. Annual pricing halves only the additional markup after that cap. Thus ten seconds uses 27,500 standard or 23,750 annual basis points. These are cost markups, not discounts applied to previously rounded credit totals.

Both audiences use the same complete-cost solver and minimum paid-credit receipt. Costs include the scene image, video duration, two input reviews, scene review, output review, text-review budget, runtime and storage. Non-billable failure and payment fees each apply once. The effect payment percentage remains the greater of its approved budget and the inherited video budget, with a 750 basis-point minimum. No ordinary-video retail markup enters this calculation.

With the currently approved budget, the expected prices are:

| Duration   | Standard credits | Annual credits | Annual saving |
| ---------- | ---------------: | -------------: | ------------: |
| 5 seconds  |               69 |             69 |             0 |
| 10 seconds |              116 |            101 |            15 |

The production build must recompute these six effect/duration combinations from its current opaque production policy. Local fixture calculations alone do not certify production. `verifyApprovedVideoEffectPrices` rejects a changed price or markup. Expected direct costs are 348,900 / 437,400 microdollars for five / ten seconds; risk-adjusted operating costs are 387,667 / 486,000. The existing finite cost and text-review approvals are not extended by this release. These figures are conditional approved budgets, not measured ten-second supplier charges.

Annual qualification uses the existing effective paid annual-subscription rule. Quotation freezes its server proof. Acceptance rechecks that proof under the credit-account lock shared with refunds and allocation. A refund or expiry can reject an old annual quote even when paid-pack funds remain. Accepted idempotent requests replay before mutable qualification, price and availability checks. No browser field can grant annual eligibility or supply a price.

## Build activation and release

Set only the nonsecret build approval `VIDEO_EFFECT_BUILD_RETAIL_PRICE_VERSION=video-effect-retail-2026-10-08.1` on both website and jobs build triggers. The build transform requires the existing approved five-second template and cost versions. It adds only these packed runtime keys:

- `VIDEO_EFFECT_RETAIL_PRICE_ACCEPTED_VERSION=video-effect-retail-2026-10-08.1`
- `HOTEL_LOBBY_DUO_ACCEPTED_LONG_TEMPLATE_VERSION=hotel-lobby-duo-10s-2026-10-08.1`
- `RAINDANCE_ACCEPTED_LONG_TEMPLATE_VERSION=raindance-10s-2026-10-08.1`

The transform preserves audience, enabled flags, funding, cost budgets and expiry. Packed-policy size and flat-variable conflict guards still apply. The build logs safe computed costs and public totals; it must not expose the packed secret. The release sequence is exact-SHA CI and no-deploy Cloudflare builds, independent incremental review, jobs deployment first, then website deployment, then live version verification. No database migration is required.

The existing canonical packer removes retired ordinary-video user/model allowlists before adding the three approvals. These fields were already ignored by admission and removed by final runtime preparation. Performing that same cleanup earlier avoids a transient oversized legacy pack; active policy fields and the 5,000-byte bound remain unchanged. A near-limit pack without retired fields still rejects an oversized overlay.

For rollback, close only new admission using the independent effect gates while retaining owner-scoped history. Drain existing schema 3 jobs on a schema-3-capable jobs worker; do not roll the jobs worker back to code that cannot read accepted ten-second snapshots. Keep frozen output duration, full-video moderation, immutable reservation and idempotent settlement checks active during drain. Removing a build approval alone does not erase already packed runtime keys.

## Validation boundary

Local tests use real isolated PostgreSQL for atomic acceptance, four concurrent identical requests, qualification expiry/refund, credit-lock contention, and provider/output contract handling. External provider and safety responses are synthetic. Browser tests mock authentication and business APIs. Neither set demonstrates generated choreography quality or a real paid provider integration. A ten-second output whose safety evidence covers only five seconds remains held for review and cannot settle or play.
