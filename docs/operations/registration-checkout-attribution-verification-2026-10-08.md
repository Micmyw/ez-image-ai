# Registration and checkout attribution verification

Date: 2026-10-08. Base: `2df4d34a760b44010684e2a7d63165d1f44e532d` (fetched `origin/main`). Branch: `codex/registration-checkout-attribution`. Worktree: `D:/梅一伟/Documents/codex/2026-10-08/task-4/ezimage-attribution`.

## Result

The authorized local implementation is complete. The administrator entry is `/admin/media#payment-attribution`, **Order attribution**. Registration source and checkout trigger are separate frozen snapshots; legacy or unavailable values remain unknown. Only optional consent enables new collection. No remote push, main merge, deployment or production migration was performed.

| Check                                               | Final result                                                                                                                                             |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database normal unit suite                          | PASS: 150 tests, including schema parity and protection against generic snapshot edits                                                                   |
| Payment reducers                                    | PASS: 25 tests                                                                                                                                           |
| Auth normal suite                                   | PASS: 133 tests, including actual Better Auth email, mocked OAuth callback, magic link, guest registration/existing login and sign-out                   |
| Focused API unit suite                              | PASS: 80 tests across cleaning, subscription/pack checkout, public purchase redaction and administrator permissions                                      |
| Database registration/checkout integrations         | PASS: 17 tests                                                                                                                                           |
| Subscription and credit-pack lifecycle integrations | PASS: 73 tests, including initial copy, renewal, replay, cancellation and partial/full refund retention                                                  |
| SaaS focused client suite                           | PASS: 67 tests, including storage denial, consent withdrawal, first-touch retention, account changes, fresh cross-tab identity and pricing/login handoff |
| Administrator UI and locale tests                   | PASS: 3 tests                                                                                                                                            |
| Public browser acceptance                           | PASS: 2 tests; real first-touch cookie, content-to-pricing handoff and declined consent across navigation/reload                                         |
| Administrator browser acceptance                    | PASS: 1 test; real local password login, seeded database, actual read API, desktop/mobile display and historical unknown credit pack                     |
| Type checks                                         | PASS: database, utils, payments, auth, API and SaaS (including Next route types and Fumadocs)                                                            |
| Formatting/lint/diff                                | PASS: affected files, no lint findings and no whitespace errors                                                                                          |

The database suites used a task-owned PostgreSQL **17.10** cluster on `127.0.0.1:55438`, with UTC server/log timezone. Separate disposable databases were `ezimage_attribution`, `ezimage_attribution_test` and the existing payment harness's required `ezpic_video_v1_final_test`; no test safety guard was weakened. All **66 migrations**, including the new three-column nullable migration `20261008044431_registration_checkout_attribution`, applied successfully to fresh fixtures. Prisma client and tracked Zod output were generated from the schema; the three Drizzle variants remain aligned.

## Acceptance boundaries

- New registered users receive the sanitized first-touch source once; ordinary sign-in and administrator account creation do not backfill it. Anonymous bootstrap does not record a registered source. The actual Better Auth OAuth route template `/callback/:id` was verified and handled with the enabled provider parameter.
- An explicit upgrade or purchase records the initiating product/content page, preserving it through `/pricing`, `/choose-plan`, `/#pricing` and the intended auth return. A fresh session read before checkout clears a prior account's handoff. Optional identity-read failure omits analytics and leaves the protected payment procedure in charge.
- The authenticated server chooses the owner and submitter, verifies organization billing permissions, cleans the pathname and loads the submitter's immutable registration snapshot. Existing checkout keys and aliases retain their original attribution. Trusted PayPal/Waffo fulfillment copies that intent snapshot into the new purchase; subsequent financial events do not replace it.
- The administrator read remains bounded and admin-only. The normal customer purchase response explicitly omits attribution. Private resource IDs and organization slugs are reduced to collection/category paths; URL queries, fragments, userinfo, external trigger URLs and sensitive campaign forms are rejected or stripped.
- Missing consent, blocked cookies/storage and old records remain unknown. Existing recorded order snapshots follow existing account/billing retention. No source is guessed from a payment return URL or current profile visit.

## Evidence and limits

Local screenshots are saved in `D:/梅一伟/Documents/codex/2026-10-08/task-4/evidence/`: `order-attribution-desktop.png`, `order-attribution-mobile.png` and `content-purchase-trigger.png`. They depict synthetic local records and public navigation, not real paid orders. The mobile administrator panel was checked at 390px with wrapping local references and no horizontal overflow. Browser report/attempt artifacts are preserved alongside them.

Initial Windows sandbox runner failures were resolved by scoped subprocess escalation. Initial browser fixture/import and login-navigation races were corrected in the test setup; the final public and administrator runs passed. Independent source review found no remaining blocking issue.

Live provider checkout/webhooks, external OAuth, outbound mail, paid media generation, production bundles, deployment and production migration are **NOT RUN**. Local payment facts and OAuth calls use isolated fixtures/mocks. The next release step belongs to the parent task: apply the reviewed migration before deploying coordinated site/payment-worker code. This report does not certify that production rollout.
