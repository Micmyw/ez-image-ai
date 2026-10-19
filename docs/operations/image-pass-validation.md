# Image-pass candidate validation

Candidate branch: `codex/paypal-one-dollar-image-pass`, initially based on `9fd1a96afc931706922041f889098d4868a2faa2`. This document records local implementation evidence, not production execution or independent approval.

The implementation grants three independent units for a verified USD 1 PayPal capture. Exactly one successful usable image consumes one unit. The frozen offer covers all 29 current image SKUs, including 4K. Repeated purchases are supported. It does not grant ordinary credits, video access or subscription status. Funding is explicit and cannot fall back to the other balance.

## Executed checks

| Check                                   | Result and boundary                                                                                                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core PostgreSQL and contract suites     | 34 tests in four suites passed: 13 pure contract checks, 16 real PostgreSQL ledger/admission/privacy checks, four payment reducer SQL checks, one recovery selector SQL check.                                                 |
| Media API focused regression            | 118 tests in six suites passed: quote, authorization, quote creation, direct creation, combined submission and retry.                                                                                                          |
| Payment collaborator focused regression | 75 new checks passed across offer configuration, checkout intent, owner-bound create/capture/state, PayPal Orders, reducer/routing and PostgreSQL payment replay. The four SQL cases overlap the core row above.               |
| Jobs collaborator focused regression    | 40 tests in five suites passed, including 25 independent-pass consumer checks and existing lifecycle regression cases. The consumer tests mock the ledger boundary; real SQL success/refund consumption is covered separately. |
| UI collaborator focused regression      | 167 tests in 19 SaaS suites passed, plus 82 reserved-route checks and 12 purchase-helper checks.                                                                                                                               |
| Final migration and provisioning        | A fresh disposable local database executed all 67 checked-in SQL migration files, including the new atomic delta; the exact offer provision ran twice successfully. No Prisma migration history was fabricated.                |
| CI workflow contract                    | `pnpm verify:ci-workflow` passed. The PostgreSQL CI job now provisions a dedicated image-pass test database and runs the SQL suites.                                                                                           |
| Formatting and whitespace               | Changed supported source/document files were formatted; `git diff --check` passed.                                                                                                                                             |

The SQL tests run the production entitlement/admission SQL against PostgreSQL 17 with a narrow query/delegate transport. They mock global client construction and unrelated ordinary-credit boundaries; ordinary credit reservation throws if invoked during pass admission. They do not replace entitlement rules, quota calculations or ledger SQL. They do not certify generated Prisma mappings or an actual PayPal/provider call.

Financial and authorization evidence includes:

- Duplicate concurrent capture/webhook fulfillment creates exactly three units once; a separate verified purchase for the same owner creates three more.
- Four concurrent reservations can obtain only three units. A free owner with no ordinary credit account can admit the highest 4K image SKU through the actual generation transaction; ordinary credit tables stay untouched.
- A real owned, approved READY output consumes one unit once. Foreign-owner, multiple-output and expired-approval outputs cannot consume it. Any unresolved READY output also prevents release.
- A verified refund freezes the grant, revokes available units and retains an in-flight reservation. Late success consumes that held unit; known failure revokes it rather than returning spendable value.
- Unknown provider acceptance retains the hold. Confirmed failures can release once. Canceled active pass holds remain recoverable by the durable settlement selector.
- Deleted accounts can remove their ordinary purchase row while preserving immutable financial facts. The grant purchase link becomes null; ledger entries remain.
- All five financial tables enforce RLS. A disposable unrelated role with explicit DML grants still reads zero rows and cannot insert. Existing application owner access remains functional.
- Lost-response replays succeed despite a now-expired quote or depleted balance. Changed funding, quote or parent identity is rejected. Combined submission preserves existing ordinary-credit fingerprints and retry keeps the selected funding source.

Several regressions were observed failing before their fixes: old admission rejected a free owner's paid 4K pass as `ENTITLEMENT_REQUIRED`; direct replay returned `NOT_FOUND`; the original purchase FK blocked account deletion; the finalizer could release a foreign READY binding when told it was unusable. Their focused tests passed after the corresponding fixes.

## Incomplete checks and release gates

The release review follow-up adds a public no-store offer-availability read that exposes only a boolean. The exact active server-owned offer, billing enablement, environment isolation and PayPal configuration must pass; absence, mismatch and errors hide the banner and disable purchase, including its handler. Twelve new API checks plus 22 existing checkout checks passed (34 total); banner/purchase/landing checks passed in three suites (14 total), including loading/error/unavailable states. This availability signal does not authenticate a merchant or certify a real payment.

Whole-package tests and type checks remain incomplete because the official locked Prisma client is unavailable in this environment. The official engine endpoint was previously denied with proxy HTTP 403 `Domain forbidden`; it was not downloaded from an alternate source or replaced with fabricated output. Last complete package commands executed 151 database, 669 API, 449 jobs and 291 payments assertions successfully, but each command still exited unsuccessfully because additional suites could not import the missing official runtime. These counts predate the final focused replay and READY-hold refinements and are not a complete green suite claim.

Final API/database type checks still exit with missing generated-client declarations and related cascading errors. Combined scoped lint reports existing/generated-type warnings (including unresolved Prisma types); strict warning-free lint is not established locally. Official-client CI, schema drift verification, complete build/type checks and lifecycle integration remain required.

No real payment, paid model call, production migration, production provisioning, merge or deployment was performed. Existing PayPal/billing binding name/type metadata establishes presence only: secret values were not read. Live runtime mode, credential validity, merchant Orders/capture eligibility and event subscription remain unverified. The new IMAGE_PASS billing row is not provisioned in production.

The prepared migration/provision and rollback procedure are in [image-pass-paypal.md](./image-pass-paypal.md). Root must coordinate independent review and the approved production target. When automatic website/jobs builds run concurrently, keep the new offer row completely absent (no inactive placeholder) until both compatible deployments are verified, then enable only the exact reviewed offer. Preserve compatible consumers and financial history when stopping intake.
