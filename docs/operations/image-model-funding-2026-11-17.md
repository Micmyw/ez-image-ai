# Shared image model funding — 2026-11-17

Status: implementation and local verification complete. The owner subsequently authorized Git publication. Deployment, live payment and real-provider generation were not performed for this change.

## Authorized behavior

The owner explicitly authorized subscription credits, purchased credit packs and the USD 2.99 / three-successful-image Image Pass for every image model. Current coverage is 16 public image products and all 41 image SKUs. The same access rules apply across models; model availability, supported inputs, prices, moderation, debt and balance checks still apply.

An effective paid subscription or spendable purchased credits establishes paid image access. Purchased credits are identified by an unexpired positive credit lot tied to an owner-matching, paid subscription billing period or fulfilled credit pack with a positive net payment. Discounted purchases and bonus credits within a purchased lot have no per-credit revenue threshold. Remaining valid purchased subscription credits continue to qualify even without an active subscription. Pure sign-in or gifted balances do not establish paid access.

This is an access check only. Credit-funded jobs retain the existing shared balance, lot allocation, atomic reservation, immutable ledger, refunds and settlement. It does not grant subscription status, additional storage or video permissions. Transactional admission acquires the credit-account row lock before checking purchased-credit eligibility, serializing it with spending and refunds. The API balance and editor expose the same access fact.

## Image Pass compatibility

New quotes freeze `image-pass-all-image-models-2026-11-17-v1`. This additive benefit covers both existing available and new grants from offer `2026-11-04.2`, including MiniMax H3 and Seedream 5.5 at every supported size. One successful image consumes one pass; supported SVG and GIF outputs retain the same one-output rule regardless of GIF frame count.

The purchase snapshot stays at its original 29 SKUs. The new benefit adds the six GPT Image 2.6 SKUs and six H3/Seedream 5.5 SKUs. Configuration regression checks require the effective current benefit to match the complete image catalog. Future catalog additions must update the versioned benefit contract and its coverage checks, without rewriting accepted quotes.

Both historical USD 1 offers and the prior GPT Image 2.6 benefit remain readable under their frozen contracts. No historical order, grant, accepted quote or ledger entry is rewritten. Retries preserve the source pass policy. New quotes remove the Sheru-specific model-access exception; historical quotes retain compatibility. Funding selection stays explicit, and pass reservation still rechecks the qualifying grant under existing locks.

No payment SKU, database schema migration or payment-provider configuration change is required. A future authorized release must deploy readers that accept both benefit versions before enabling new quote producers, and retain those readers while accepted new-policy jobs drain.

## GTA and Sheru

- GTA starts with GPT Image 2.6 Sunburst and allows the customer to change model and supported output settings. Tool composition still controls the wallpaper ratio. It requires paid access even when a basic model is selected.
- New GTA guest generations are rejected; previously accepted guest requests can still replay. Uploads remain available for login/purchase handoff. Paid template uploads never start the sponsored guest trial.
- Sheru allows prompt, model and output editing while retaining the reference photo and edited prompt during model changes and purchase handoff.
- Missing-reference actions now open the photo picker instead of displaying a disabled Generate button. With complete inputs, Generate proceeds to admission or the purchase choice. Pending uploads/submissions retain their normal guards.
- Requests from paid templates carry restrictive `generationAccess: paid` context. Quotes freeze `requiresPaidImageAccess`; preflight, transactional admission and retries enforce it. This context is part of the owner-bound submission fingerprint and cannot reuse an ordinary free preparation. Unmarked historical submission identities remain unchanged.

The existing image pipeline is reused: draft preparation still waits 1.2 seconds, creates no job and reserves no funds. Preparation and Generate share the same identity. Current admission, prompt/input/output moderation, original-provider delivery, archival and recovery remain in place. No new provider path or performance claim is introduced.

## Local evidence

- Shared form, landing, model navigation, draft recovery, pass selection and submission hook regression: 194 tests across nine SaaS files.
- Quote/preparation/submission and authorization regression: 344 tests across eight API files, plus 31 retry and credit-account cases.
- Sheru content, presentation, selection and return/handoff validation: 69 cases across five SaaS files.
- Transactional admission and Image Pass: 144 tests across two database files; 38 config cases also cover all current SKUs and old-policy isolation.
- Purchased-credit SQL: seven cases passed using the existing isolated SQL test port with PGlite's PostgreSQL WASM engine over a loopback `pg` socket. This validates query semantics for owner, expiry, spent credits and refunds; it does not establish production PostgreSQL concurrency or live payment behavior.
- GTA public browser checks: 11 passed. Sheru: three viewport journeys passed (1440, 390 and 320 pixels), covering editable prompt, upload-button action, model change, retained photo/prompt and purchase dialog without a generation request. Screenshots were inspected under `apps/saas/test-results/sheru-paid-review`.
- SaaS, API and database TypeScript passed. Focused Oxfmt, Oxlint and Git whitespace checks passed. All four SaaS/studio locales have matching leaf keys and ICU argument shapes, and the changed messages rendered in English and French. Generated client-message projections match their sources.

Browser checks use the local Next application with controlled service boundaries. No test evidence here certifies live checkout, real paid image output, production deployment or latency improvement. Earlier GTA UI/result evidence remains in `gta-tools-p0-2026-11-17.md`.
