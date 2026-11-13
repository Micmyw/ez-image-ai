# MiniMax H3 Image: pricing and integration

Reviewed 2026-11-13. The owner selected **5 / 10 / 20 EzPic credits for 1K / 2K / 4K**.
Registered workspaces default to H3 1K. Free accounts retain 10 lifetime sign-in credits,
H3 1K access and their existing Nano Banana 2 Lite 1K access. H3 2K/4K require a paid plan.
Anonymous sponsored trials and frozen Image Pass coverage are separate and unchanged.

## Supplier prices

The [Kie pricing table](https://kie.ai/pricing) and
[H3 image-edit page](https://kie.ai/minimax-h3-image?model=minimax-h3/image-edit)
were read on 2026-11-13. The image-edit page explicitly charges each reference image,
**including the first**, at USD 0.0025. The generic video billing banner above the table
is not the image pricing contract.

| Operation               | 1K / 2K |      4K |
| ----------------------- | ------: | ------: |
| Text-to-image           | $0.0090 | $0.0275 |
| Edit with one reference | $0.0115 | $0.0300 |

Kie credits (USD 0.005 each) and EzPic credits are different units. No recharge bonus
is assumed. The existing EzPic flow supports one reference and one output per task.
The official model IDs are `minimax-h3/text-to-image` and `minimax-h3/image-edit`.
The quote freezes the respective operation's supplier cost, not a shared text/edit estimate.

## Calculation

Current subscription inputs come from `packages/config/plans.ts`: Pro USD 19/month or
114/year for 700 credits/month; Ultimate USD 49 or 294 for 1,800/month; Max USD 79 or
474 for 3,000/month. Annual plans issue twelve monthly allowances. Max annual has the
lowest undiscounted subscription revenue per credit: `474 / (3000 * 12) = 0.0131666667` USD.
Credit Packs, even with their subscriber bonus, have higher revenue per credit.

Planning assumptions use the existing image-margin method, with explicit image review:

- Supplier cost plus 15% contingency.
- Runtime/storage reserve: USD 0.005 for 1K; USD 0.010 for 2K/4K.
- SeeAPI review reserve: USD 0.0001 per checked input/output. Its
  [NSFW Filter 2.0 tariff](https://www.seeapi.com/docs/nsfw-filter-2/image-moderation/)
  is 0.01 supplier credits per check. This reserve rounds up the repository's
  conservative USD 299/30,000-credit basis; the website's rounded USD 0.00 is not free.
- [Waffo prompt checks](https://docs.waffo.ai/zh/api-reference/endpoints/content-safety/scan-prompt)
  currently state free during beta, so zero prompt fee is assumed.
- Payment fee assumption: 4.5% + USD 0.30 per subscription purchase, plus a separate
  1.5% revenue reserve for refunds/disputes. These are budgeting inputs, not verified
  merchant rates. Allocate the fixed fee once per transaction; annual purchases have one.
- All allowance credits are consumed; no profit is attributed to unused balances.

```text
plannedCost = 1.15 * KieCost + runtimeStorage + 0.0001 * (referenceCount + 1)
allocatedRevenue = planPrice / creditsIssued * imageCredits
allocatedPaymentAndRisk = (0.06 * planPrice + 0.30) / creditsIssued * imageCredits
contribution = allocatedRevenue - allocatedPaymentAndRisk - plannedCost
contributionRate = contribution / allocatedRevenue
```

## Lowest-price subscription scenario: Max annual

| Scenario         | EzPic credits | Kie cost | Planned cost | Revenue allocation | Contribution | Contribution rate |
| ---------------- | ------------: | -------: | -----------: | -----------------: | -----------: | ----------------: |
| 现有 Lite 1K     |             5 | $0.02000 |     $0.02820 |           $0.06583 |     $0.03364 |             51.1% |
| H3 1K 纯文本     |             5 | $0.00900 |     $0.01545 |           $0.06583 |     $0.04639 |             70.5% |
| H3 1K 一张参考图 |             5 | $0.01150 |     $0.01842 |           $0.06583 |     $0.04342 |             65.9% |
| H3 2K 一张参考图 |            10 | $0.01150 |     $0.02342 |           $0.13167 |     $0.10026 |             76.1% |
| H3 4K 一张参考图 |            20 | $0.03000 |     $0.04470 |           $0.26333 |     $0.20267 |             77.0% |

These contributions precede tax, fixed operating overhead and acquisition spending.
The reserve does not establish measured failure/retry rates, indefinite retention cost,
actual merchant fees or invoice-reconciled profit. No paid H3 generation was used for this calculation.

## Free-account cost

For one reference per successful edit and two uses of the lifetime 10-credit allowance:

| Model                 | Supplier cost/account | Planned cost/account | Planned cost/10,000 fully used accounts |
| --------------------- | --------------------: | -------------------: | --------------------------------------: |
| Nano Banana 2 Lite 1K |               $0.0400 |             $0.05640 |                                 $564.00 |
| MiniMax H3 1K         |               $0.0230 |             $0.03685 |                                 $368.50 |

This saves 42.5% in supplier fees and about 34.7% including the same infrastructure
reserves. Free usage is an acquisition expense, not paid revenue. Extra uploads,
waived/retried outputs and account abuse are not counted in this two-output example.

## Implementation and release

- Public product: `image-minimax-h3`; SKUs: `minimax-h3-1k/2k/4k`.
- Catalog/pricing: `2026-11-13.1`. Subscription prices and historical accepted quotes remain frozen.
- Kie contracts: prompt up to 5,000 characters; PNG/JPEG; documented aspect ratios;
  provider reference limit 20,000,000 bytes and 64,000,000 pixels. EzPic retains one reference.
- Free-tier checks use the SKU as well as product at preflight and transactional reservation.
- Model flag: `MEDIA_MINIMAX_H3_IMAGE_ENABLED`; existing provider and catalog readiness gates apply.
- Receiver code supporting the new routes precedes website producers in a release.
- No database migration, payment SKU or Image Pass snapshot rewrite is needed.
- Public page: `/minimax-h3-image`; illustrations and prompts originate from Kie with local provenance.
- The showcase follows the editor before the written guides. Three supplied text examples use a large-image gallery; the cafe example has a keyboard-accessible original/result comparison and a reference download.

## Local verification (2026-11-13)

- Provider/catalog contract suites: 224 passing AI tests; configuration contract suites: 207 passing tests.
- Plan eligibility: 57 passing config tests; transactional admission: 43 passing database tests. API authorization, subscription, quote and creation checks passed, including all six H3 operation/tier price snapshots.
- Runtime dispatch and provider rejection/recovery checks: 84 passing jobs tests.
- Final focused editor/public suites: 220 passing tests across 12 files. After the gallery refinement, the 46 public-route and example-material checks passed again.
- Playwright public-page check passed at 1440px and 390px: supplied images loaded, showcase precedes instructions, comparison responds to keyboard input, prompts populate the editor, prices match and no horizontal overflow occurs.
- Screenshots: `output/playwright/minimax-h3-2026-11-13/public-routes-MiniMax-H3-p-d39af-ompts-on-desktop-and-mobile-public/minimax-h3-1440.png` and `minimax-h3-390.png` in the same directory.
- AI, config, API, database and jobs type checks passed. The final SaaS type check reported a Button `render` type error in the concurrently added, untracked `apps/saas/modules/payments/components/SubscriptionCompensation.tsx`; that unrelated work was preserved. No MiniMax type error was reported.
- Scoped formatting/lint and translation client-message checks passed. Browser fixtures mock the public catalog; no paid H3 generation was executed.

## Authorized production rollout

The user authorized publishing all current session changes on 2026-11-13, followed by real H3 generation and showcase publication. Apply the independent SeeAPI migration before code deployment. Deploy jobs with H3 enabled but delegation/compensation issuance off, then the compatible website with all three controls enabled, then activate jobs delegation. Existing readers and financial consumers remain compatible throughout.

Cloudflare builds use dedicated exact-boolean overlays over the current authoritative remote environment:

- `MEDIA_MINIMAX_H3_IMAGE_BUILD_ENABLED` updates flat and packed H3 flags.
- `MEDIA_SEEAPI_INPUT_FAILURE_DELEGATION_BUILD_ENABLED` controls new input delegation.
- `MEDIA_TECHNICAL_FAILURE_SUBSCRIPTION_BONUS_BUILD_ENABLED` controls new offer issuance.

They preserve unrelated variables and are removed from child environments. Ambient runtime flags cannot override the authoritative bundle. Deployment and actual generation evidence will be recorded after completion.
