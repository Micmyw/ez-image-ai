# Ordinary video upgrade and annual pricing

User-approved retail policy: `video-retail-2026-10-08.1`. Supplier tariff version remains `kie-public-2026-10-08.1`. No supplier contract, paid-credit floor, customer access or template policy is changed.

## Calculation

Targets are profit divided by complete variable cost, not a markup on a previous quote. Ordinary target is `min(1000%, 110% + 15pp × extra actual seconds + 200pp × legal resolution steps + 300pp × one independent non-base mode)`. Annual target is `110% + (capped ordinary target − 110%)/2`, at most 555%. Each price uses the existing integer full-cost solver, including supplier endpoint/tier/audio cost, moderation, runtime, storage, failed-job reserve, payment percentage and fixed allocation. Integer rounding can make realized margin exceed its target; no result is cosmetically capped.

Fixed family anchors are explicit in `retailBaselines`, independent of defaults, UI cheapest-option choices and draft history. Seedance 2 Mini anchors Fast and Standard; Kling 3 anchors Turbo; generic Veo Lite anchors Fast and Quality. Pro/4K is counted once through resolution. The independent legacy Veo Fast and Seedance 1 Pro Fast contracts remain separate. Every legal Gemini resolution step counts even where the supplier cost is equal. Unsupported models remain disabled.

## Qualification and immutable orders

Only the same user's effective paid Creator, Ultimate or Studio subscription with persisted `interval=year` qualifies. Existing billing-period/refund/grace rules apply. Canceled renewal retains qualification for its paid term. Monthly plans, packs alone, unpaid/pending plans, unknown metadata, fully refunded periods, expired periods and another owner's subscription do not qualify. Eligible funding is checked independently: a plan never makes free or underfunded credits eligible for video.

For Stripe annual invoices, all twelve monthly projections repeat the paid amount, while the refund reducer records cumulative refunded money on the first period. Qualification therefore uses the minimum paid amount and maximum refund across the same subscription/invoice group. It does not treat later monthly projections as separate payments or reject a legitimate partial refund solely because the current month's credit status is `REFUNDED`.

Catalog and quotes expose only current credits, standard/annual credits, saved credits and public policy/audience. Private costs and membership identifiers remain server-side. The immutable quote records family anchor, targets, both integer prices, qualified subscription/plan/end, policy versions and cost evidence. Admission rechecks qualification after acquiring the credit-account lock shared with refunds, using a fresh database clock. Any price, eligibility or policy change requires a new quote. Existing replay-first behavior preserves accepted jobs even after expiry, refund or closure, without another reservation.

The catalog also returns a public qualification deadline for refresh scheduling, without subscription identifiers. The foreground UI refreshes within 30 seconds of external changes, sooner at a known deadline, and after payment-query updates or a changed quote. A quote that agrees with refreshed prices remains available for explicit confirmation. Each owner lifecycle and in-flight operation has its own identity, so a response from a prior A session cannot unlock or rewrite a newer A session after an A → B → A switch.

UI shows annual information above the composer, actual tuple-based model badges and a dual-price area. Strike-throughs appear only for qualified annual selections with positive integer savings; equal-price base options show no discount. The percentage is calculated from the final two credit amounts, rounded down to one decimal. Existing image/video navigation and exclusive variant controls remain. Quotes and drafts are scoped to their owner; historical savings come from the frozen order, not current membership. An unknown result retains the same receipt/idempotency key.

## Cost evidence and deployment guard

The 1,188-row approval matrix is a public price fixture based on the historical budget: moderation 5,100 + 200 micro-USD/second, audio extra 0, runtime 100,000, storage 10,000, fixed payment allocation 0, payment 654 bps, unbillable failures 1,000 bps, base target 11,000 bps and paid-credit floor 21,944 micro-USD. This is not evidence of merchant settlement costs or realized accounting profit. The legacy Veo Fast supplier budget remains an unverified proxy under its existing contract.

The dedicated build-only `VIDEO_V1_BUILD_RETAIL_PRICE_VERSION` accepts only this approved version. It overlays `VIDEO_RETAIL_PRICE_ACCEPTED_VERSION` onto the build runner's current private policy, preserving other values and access. No credentials are exported or replaced. Without an approval flag the previous retail behavior remains compatible; unknown flags fail closed.

Both production builds run `verifyApprovedVideoRetailPrices` before packaging or deployment. It reads the actual effective approved runtime cost policy and compares all 1,188 ordinary/annual pairs against the user-approved table, confirms the existing base margin and emits only numerical non-sensitive cost fields. Any price difference stops deployment and requires reporting to the user. The matrix is build/test-only and is not shipped in the application. Capture exact release SHA, CI, both Worker versions and the preflight result as release evidence; local fixtures alone cannot certify production costs.

The guard compares final integer prices, not equality of every cost component with the historical fixture. Offsetting component changes can pass when every approved integer price stays identical. Record the resolved production policy separately and do not describe a local fixture or a successful price comparison as verification of actual merchant costs.

No schema migration is introduced. Roll back the release with its corresponding versioned Worker bindings; never delete accepted jobs, rewrite quotes or disable private history to revert prices. No real video generation or real payment is needed for acceptance tests.
