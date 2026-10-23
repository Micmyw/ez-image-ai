# Purchase presentation experiments

Implementation date: 2026-10-23. This document describes local changes, not a production rollout or a winning variant.

## Variants and scope

| Experiment           | Control                   | Treatment                       | Eligible surface                                                   |
| -------------------- | ------------------------- | ------------------------------- | ------------------------------------------------------------------ |
| `pricing-default-v1` | Default to annual billing | Default to monthly billing      | Public home/pricing plan cards without an explicit selection       |
| `result-purchase-v1` | Existing result actions   | Add “Compare plans and credits” | Account image results after the actual output loads and is visible |

Both use independent, versioned 50/50 hashes of the existing consented analytics browser cookie.
No additional identifier, price, free allowance, model entitlement, payment operation or safety rule is introduced.
Without optional analytics the existing annual/result experience remains available. Explicit URL billing
intervals and selections made before assignment take precedence and do not enroll that surface.
Selections made after exposure are retained while reporting the originally assigned variant (intent to treat).
Reloads and home/pricing navigation keep the same browser assignment. Clearing/expiring the existing cookie
creates a new browser identity; this is not cross-device user randomization.

Pricing exposure requires visible pricing content in an active document. Both result arms observe the
same anchor after the result actions. An entry click is also direct exposure evidence: ingestion order
cannot cause a click arriving before its viewport event to disappear. Guest results and video results
are outside the result experiment. Downloads, editing and print actions remain available in both arms.

## Measurement

The existing first-party event endpoint validates the experiment/variant pair against the browser
cookie. It resolves identity, internal/admin status and timestamps on the server, enforces consent,
and stores only allowlisted diagnostics in the existing `growth_event` JSON. No schema migration is needed.
Rejected/failed event responses do not mark the browser dispatch delivered; optional analytics never block
purchase or generation. Network loss and browser navigation can still lose observations.

Analytics displays these distinct steps:

- Unique exposed browsers and unique entry-click browsers; entry CTR uses exposed browsers.
- Actual checkout-button clicks, separate from public Choose-plan/guide clicks.
- Browser/account linkage coverage and ambiguous links.
- Persisted checkout intents created after exposure, then verified production payments linked to those
  exact intents and owners. A redirect or browser “subscription activated” event cannot prove payment.
- Payment rate among exposed browsers, plus a separate full-window rate for browsers observed for seven days.

The earliest retained exposure starts a fixed seven-day conversion window. The selected report range
chooses exposure cohorts; source/device filters refer to that first exposure. Ninety days of retained
events are read so repeat visits do not start a new cohort when switching 24h/7d/30d reports. The existing
20,000-event safety bound fails explicitly rather than returning a truncated report. Browser events are
grouped before aggregation. Deletion beyond the retention horizon can no longer establish earlier exposure.

Payment attribution requires an authenticated, server-resolved account observation within the window.
Shared browsers with multiple accounts and accounts exposed on multiple browsers are reported as
ambiguous and excluded from financial attribution. Renewals, test/unverified/zero-value payments,
pre-exposure checkout intents, and payments outside the window are excluded. Cross-device conversions
without a trustworthy link are not guessed. The same payment may be an outcome of both independent tests;
their totals must not be added as incremental revenue.

The new activity table splits current activity into registrations during the selected range and older
customers, while preserving the existing registration-cohort funnel. Result views require a loaded,
visible image; downloads mean authorized download navigation started, not that a file finished saving.
Completion latency uses server job creation to successful terminal state and is not click-to-visible latency.
Unknown sources, missing optional observations, administrator exclusions and sample counts remain visible.

## Reading results

The result control has no new guide button, so its guide-click count is naturally zero. Compare common
downstream checkout-button clicks, server checkouts and verified payments to judge that experiment.
Do not select a winner from raw CTR or a few payments. Use full seven-day cohorts, inspect allocation and
coverage, and compare equivalent time/source/device groups. The simultaneous experiments can interact;
these reports show marginal outcomes, not proof of independent causal uplift. Current customer volume
is small enough that this release establishes measurement rather than a near-term statistical verdict.

For a new treatment or eligibility change, increment the experiment ID and update both the shared contract
and ingest schema. To stop enrollment, remove/disable the surface hook and retain the reader/schema for
its historical observations. Returning to annual defaults does not alter existing subscriptions.

## Local verification

- Config assignment distribution/stability; ingest validation/consent; database cohort/time/checkout/payment
  evidence, deduplication, old exposures, ambiguity, source/device filters; existing funnel contracts.
- `node tooling/e2e/src/conversion-experiments-regression.mjs`: actual components, hook and event transport
  in fresh Chromium with loopback acceptance fixtures, no production payment/provider calls.
- `node tooling/e2e/src/generation-preview-benchmark.mjs --mode after --comparison-stability-only`:
  existing private-preview authorization, node continuity, expiry/retry and download regressions.
- Focused SaaS routing/content/pricing/analytics tests and affected type/format/lint checks.

Browser fixture reports under `.cache/conversion-experiments/` and `.cache/generation-batch1/browser/`
include owned process IDs and cleanup verification. Local fixtures do not establish deployed behavior.
