# Image quote and generation request accounting

## Verified failure and boundary

The image `media:generation` bucket in `packages/api/modules/media/lib/rate-limit.ts` is a per-user HTTP flood guard: 30 checks per fixed minute. It is not a credit ledger, free-trial counter or plan entitlement. Previously a new combined `/media/generations/submit` request consumed this same bucket during quote authorization and again in `createGenerationFromApprovedQuote`. A concurrent quote-insert loser could also re-enter the normal job authorization path.

No evidence supports a historical quote-plus-submit double credit or guest-trial charge. Image budget queries count only quotes linked to a job (`generation-authorization.ts`); `jobs.ts` finds existing admissions before `reserveCreditsInTransaction`, using the stable `job:<id>:reserve` reference. Guest admission checks its replay before trial allowance, buckets and grant/reservation. Ordinary and template video quotes already have separate interface flood actions; their job admission reserves only after the existing-job check. Those business transactions and limits are unchanged here.

## New behavior

- Standalone image quotes use the independent `media:quote` HTTP bucket, with the same existing 30-per-minute algorithm.
- Every incoming combined image submission, including an accepted-response replay, passes `media:generation` exactly once. Two concurrent HTTP requests check twice; accepting the same job still creates only one reservation. Two different accepted jobs retain two reservations.
- After the real flood check succeeds, the server issues a frozen opaque receipt. A private WeakMap binds the exact object identity to its owner. JSON copies, symbol copies and another owner's receipt cannot bypass a check. A generation receipt cannot bypass the independent quote bucket.
- The receipt travels only through server arguments and request-local submission context. Client schemas neither define nor forward skip/receipt options, and no receipt enters quote input/pricing snapshots, responses or the database.
- A valid receipt skips only the repeated flood check. Environment/model flags, versions, owner scope, account balance/debt, plan entitlement, source readiness/size, storage, budget and transaction-time moderation/eligibility checks remain in place. Ordinary job creation and retry without a receipt retain their own generation guard.

The bucket action change requires no schema migration or counter rewrite. Existing generation bucket records retain their current minute window; the new quote bucket begins independently. No flood threshold is increased and no credit pricing, image/video shared funding, moderation policy or guest allowance is changed.

## Local regression evidence

The existing domain and RPC Fetch simulation runs the real image quote, authorization, combined submission, fallback job and dispatch functions with injected DB/provider ports. It does not contact a paid provider. Initial assertions reproduced seven failures, including merged submissions consuming two checks and standalone quotes consuming the generation bucket. An additional concurrent-recovery regression reproduced three checks for two incoming requests; this prompted the request-local receipt rather than accepting that extra check.

Coverage includes quote-only (no job/reservation), quote plus submit, merged submit, accepted-response replay, simultaneous same-key requests, two different jobs, denial before moderation/admission, client option stripping, snapshot isolation, receipt forgery/owner mismatch and mutable eligibility after a valid receipt. SQL limiter tests exercise both actions with allowed and denied results. DB idempotency remains covered by the existing transaction integration tests, including `media.integration.test.ts` cases for budget-once replay and duplicate owner keys; these require a generated Prisma client and a test database.

No production queries, migrations, credential reads or paid model calls were performed for this change. A mock-port pass must not be represented as a live database or production-provider pass.
