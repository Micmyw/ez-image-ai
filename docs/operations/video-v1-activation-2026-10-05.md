# Video V1 configuration and acceptance — 2026-10-05

This batch follows explicit authorization to configure production, research Kie prices and test using the existing administrator's 1,000 credits and provider balance. Original checkout changes remain untouched. Release checkout: `codex/video-v1-release`, starting at `600194011888e228e8a11e17016a2541f9426adc`.

## Price decision

The [supplier evidence](video-v1-price-basis-2026-10-05.md) and [complete parameter price reference](video-v1-prices-2026-10-05.json) distinguish public prices from account receipts. 1,116 supported parameter combinations have reference prices; 18 generic Veo combinations lack a price mapping. Blocked contracts remain unavailable. H3's first input image is free. Seedance Mini/Fast promotion pricing expires at 2026-10-07 06:00 UTC; other configured reference prices expire at 2026-10-12 00:00 UTC.

USD micro-unit budget: SeeAPI base 5,100 plus 200 per requested second; runtime 100,000; storage 10,000; nonbillable outcomes 1,000 bps. Waffo beta prompt screening is publicly free. Payment allocation uses Waffo's public 3.9% + $0.50 rate at the current smallest full-price $19 transaction, rounded up to 654 bps. The fixed fee is not counted twice.

Runtime/storage and a 10% loss allowance are **budget assumptions**, not measured invoices or absolute upper bounds. They assume ordinary bounded execution, finite output retention and shared infrastructure allocation. Waffo payment allocation does not certify PayPal, discounts, taxes, FX or merchant-specific fees. Production remains an invited internal beta; broader paid customer opening requires those actual billing terms and loss observations to fit the configured budget.

Retail credits round upward using the lowest current paid SKU gross value of $0.021944 per credit, including annual/pack bonuses. The target is **profit / complete budgeted cost >= 110%** (not a 110% revenue margin). The formula includes revenue-proportional payment fees and nonbillable failures. It does not promise realized profit when actual costs exceed budget. Administrator acceptance uses original credit lots and records operator-funded test spending; its retail reference is not actual earned revenue.

| Initial acceptance selection                   | Kie public cost | Retail-reference credits |
| ---------------------------------------------- | --------------: | -----------------------: |
| Seedance 1.5 Pro, text, 4s, 480p, sound off    |          $0.035 |                       19 |
| Kling 2.6, text or single image, 5s, sound off |          $0.275 |                       49 |
| Kling 2.6, text, 5s, native sound              |          $0.550 |                       83 |

Initial allowlist is limited to these selections. Kie balance preflight returned 985 provider credits (public conversion approximately $4.925), so acceptance uses a small set of representative requests below that balance and the previously stated $10 ceiling. No uncertain paid request is resubmitted.

| Model               | Priced parameter combinations | Reference credit range |
| ------------------- | ----------------------------: | ---------------------: |
| Kling 2.6           |                             8 |                 49–151 |
| Kling 3             |                           156 |                 41–634 |
| Kling 3 Turbo       |                            52 |                 48–223 |
| MiniMax H3          |                            48 |                 35–135 |
| Seedance 2.5        |                           324 |               84–2,937 |
| Seedance 2          |                           192 |               62–1,938 |
| Seedance 2 Mini     |                            96 |                  24–91 |
| Seedance 2 Fast     |                            96 |                 44–244 |
| Seedance 1.5 Pro    |                           108 |                 19–126 |
| Seedance 1 Pro Fast |                             4 |                  25–59 |
| Gemini Omni Flash   |                            32 |                 54–144 |

These ranges cover the catalog's duration/resolution/sound combinations, not an assertion that every combination was purchased or enabled in production. See the JSON reference for each exact tuple.

## Configuration and recovery

`VIDEO_RUNTIME_CONFIG` carries server policy as one private string binding to avoid the Cloudflare text-binding limit. API credentials, callback secrets, Workflow/R2 bindings and the admission switch remain separate. Both build triggers and both Workers must use the same policy. Packed/flat conflicts stop deployment; malformed runtime policy closes video while retaining the image runtime. See [deployment procedure](cloudflare-automatic-deployment.md).

`VIDEO_MODEL_ALLOWED_OPTIONS` controls new admission and catalog availability; accepted request replay and recovery retain saved settings. Expiring administrator funding is scoped to the named authenticated administrator, does not create a paid receipt and does not change normal customer funding checks.

Private R2 browser CORS was verified for the production origin. Waffo real preflight returned ALLOW/scored in 3,654 ms at 2026-10-04 16:07 UTC. This is a standalone service check, not an end-to-end video acceptance.

## Release evidence

This section preserves the first pre-activation checkpoint. Subsequent authorized production migrations, deployments and paid acceptance are recorded in the [real acceptance report](video-v1-real-acceptance-2026-10-05.md).

Code, local checks, Git/CI, deployment, real provider/moderation callbacks, storage, ledger and segment timings are recorded separately below when completed. Until there is a real delivered job, output generation and callback acceptance remain **NOT_RUN**.

- Concentrated video unit/Mock run: **684 PASS**, external network blocked. Subsequent admission funding and pre-submit expiry regressions also pass in their focused groups; overlapping totals are not added together.
- Final isolated PostgreSQL/flow run: **192 PASS**, **3 optional performance tests NOT_RUN**. All 59 repository migrations applied to a dedicated loopback fixture; no production data used. Includes old/new engine isolation, storage/credit lifecycle and the new funding/expiry cases.
- Configuration/deployment suite: **212 PASS**; affected configuration, database, jobs and API types, changed-file lint/format and diff checks pass. Backend Wrangler/workerd artifact verification passes. Website artifact build is running at this checkpoint.
- Real Waffo preflight: **PASS**. Kie balance read: **PASS**. Paid generation, actual cost receipt, Kie/SeeAPI callbacks and generation segment performance: **NOT_RUN** at this checkpoint.
- Both Cloudflare build targets now contain the private policy and explicit build switch set to false. Runtime admission remains closed until compatible code is deployed and the controlled acceptance begins. Exact Git/CI/deployment and real-job results belong to the subsequent acceptance receipt.

No schema change is required for policy packing, parameter gates or the administrator funding decision. The four existing video migrations remain applied; no payment environment or unrelated production business data is changed.

## Rollback

Set the dedicated video admission switch false on both Workers and the explicit build override false to keep subsequent builds closed. Let accepted video work recover through its original Workflow. Restore compatible code and configuration together; do not pair pre-packing code with only a packed policy. Keep additive video schema and immutable ledger/evidence. Do not redirect video work to the legacy execution engine or delete unsettled records.
