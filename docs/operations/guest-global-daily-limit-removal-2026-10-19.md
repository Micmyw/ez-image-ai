# Remove the global daily guest request cap

## Authorized behavior

The user's 2026-10-19 decision removes the **global daily request-count cap**. The patch deletes
the corresponding admission checks rather than replacing the limit with a large number.

It applies to three independent buckets:

| Entry                                   | Retired bucket               |
| --------------------------------------- | ---------------------------- |
| Guest private upload intent             | `guest-upload:global:day`    |
| Temporary anonymous session preparation | `guest-bootstrap:global:day` |
| Sponsored guest generation admission    | `guest-generate:global:day`  |

The configuration field `maximumGlobalRequestsPerDay` and the required production environment
setting `GUEST_GLOBAL_MAX_PER_24_HOURS` are removed from the active contract. Old environment
packages remain compatible: the retired key is ignored and excluded from new deployment
snapshots. The existing binding-retirement helper stages its removal on an **undeployed**
version; this patch has not invoked that helper against production.

Existing `*:global:day` database rows are neither consulted nor updated by these paths. They
remain historical records until ordinary retention removes them. No database schema migration,
counter reset, or production data deletion is required.

Other counters retain their existing behavior: global minute/hour request rates, IP/subnet
windows, per-session/device daily trials, concurrent jobs, queue/storage capacity, and cost
budgets. Account images and ordinary videos continue to use the same valid credit balance and
reservation rules. The scope does not add a separate video allowance.

## Deployment boundaries

This is a local code patch. No merge, production configuration write, binding staging, deployment,
migration, or paid model call has been performed.

The current production Worker still enforces its deployed limits until a release is approved
and completes. Do not delete the old setting from the currently serving old Worker first:
the old production configuration requires it and would disable guest capability. New code
accepts either the old key or its absence, and the normal release flow can retire the key with
the new artifact.

Removing the value from the capability fingerprint changes the public capability version.
Newly prepared requests use the new snapshot; an open page or unclaimed draft from before the
release can require a refreshed capability. Already accepted generation identities, ledger
reservations, and evidence are not rewritten. Release verification must read the actual active
website/jobs versions and exercise allowed non-paid request paths; local mocks are not evidence
of live release completion.

## Separate proposals awaiting review

The login counter redesign and guest review-timeout recovery remain separate proposals. The
recovery prototype is preserved on `codex/proposal-guest-review-resume` at
`79aab3af7d4de348ccca99dcb7ea97f43b5b31b3`; it is not included in this branch.
See [customer-flow proposals](customer-flow-proposals-2026-10-19.md).

The incident's daily-five plateau and request IDs remain historical evidence in
[the production investigation](evidence/guest-upload-rate-limit-2026-10-19.md). They are not
proof that a new deployment has removed the cap.

## Verification

Configuration tests first reproduced the old fail-closed requirement and retained numeric
field, then verified that missing or arbitrary old values no longer impose a daily cap while
the remaining limits stay intact. API boundary tests verify that admission no longer forwards
the retired field. Deployment tests verify precise key filtering, preservation of all other
settings, and retirement on an undeployed snapshot only.

Database-boundary regressions exercise the real upload, bootstrap, and generation admission
functions with an already full historical global-day bucket and mocked transaction I/O. They
also cover denials at each remaining rate dimension. PostgreSQL integration fixtures are
updated to require no new global-day rows; real PostgreSQL integration and full artifact builds
remain unverified in this environment because the required generated Prisma client is absent
and its official engine download returned HTTP 403. No download restriction was bypassed.

Focused results: **209 tests passed** across configuration (62), API admission/capability/
verification (50), deployment preparation (51), three database admission boundaries (18), and
existing app feedback/recovery tests (28). Configuration and web-host TypeScript checks passed.
The broader database unit command passed 129 tests in seven files, including the new cases;
five additional suites could not load the absent generated Prisma client. Those broader results
overlap the focused count and are not an additional 129 tests. Formatting and whitespace checks
passed. Database lint has no errors and four pre-existing diagnostics caused by absent Prisma
types; a complete type/build certification is still unavailable.
