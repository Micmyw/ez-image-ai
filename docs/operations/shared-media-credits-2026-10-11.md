# Shared ordinary image and video credits — 2026-10-11

The owner approved correcting capacity messages and allowing new ordinary videos to use the
same valid account balance as images, with tests and independent review before release.
This replaces the ordinary-video paid-lot restriction documented on October 7. Hotel Lobby,
Raindance and Rumpelstiltskin retain their independent audience and funding policies.

## Policy and compatibility

New ordinary quotes freeze `funding.mode=shared-media-credits-v1`. Admission removes the
paid-lot filter only for this explicit ordinary-video snapshot and reserves through the existing
credit-account transaction. Gifted credits are usable; expired lots, account debt, insufficient
balance, tenant ownership, concurrent reservations and stable idempotency remain enforced.
No schema or ledger migration is needed. Do not alter existing payments or credit-lot provenance.

Provider and moderation cost calculations and customer credit totals do not change. The
qualified-paid retail calculation is retained under `retailReference`, with
`paidRevenueQualified:false`: an account balance does not prove a payment receipt or realized
profit. Annual price eligibility still requires its existing server evidence.

Older unaccepted ordinary-video quotes must be refreshed when their funding fingerprint differs.
Accepted paid/internal jobs retain their original immutable snapshot, reservation and execution
rules. The execution guard recognizes the new shared mode only for ordinary video and rejects
unknown modes or conflicting paid policies. Template funding remains independent.

## Capacity and recovery

The image API and client match stable error-code tokens rather than matching an unbounded
substring. `PROVIDER_CONCURRENT_JOB_LIMIT_REACHED` must not collapse into the personal
`CONCURRENT_JOB_LIMIT_REACHED` message. Video distinguishes owner, global, provider and rate
limits. Shared capacity can be full even when the current account has no active tasks.

Known definitive admission rejections can release an unsubmitted confirmation. Unknown outcomes
retain the same quote/receipt and idempotency key. A timeout never authorizes a replacement paid
request. An unresolved historical provider result can continue to occupy shared capacity; changing
the text or funding policy does not settle that task.

Two historical image attempts were inspected read-only during this investigation. Their stored
audit records show a normalized provider failure that could not be classified as a confirmed
technical failure. The resulting manual-reconciliation state intentionally retains reservations and
does not enter the automatic polling claim. No historical task was cleared, released or resubmitted.
The stored normalized failure is not a fresh supplier or billing confirmation.

## Ordered release and rollback

The regular `main` push triggers website and Jobs builds independently. Use two source commits:

1. Publish only the config helper/export and execution consumer compatibility (with its regression
   tests). Keep ordinary quote production on the old paid/internal policy. Confirm that Jobs runs
   this receiver commit at 100% before continuing.
2. Publish the ordinary quote/admission policy, corrected messages, translations and docs. Verify
   the exact final SHA on both the website and Jobs and check the public pages.

Run the relevant credit/admission/execution and template regressions, type/lint/format checks,
Workers builds and an independent review of both stages before release. Use only disposable
loopback databases for tests. Production migration status may be read; no migration is required.

Rolling back the producer does not authorize rolling back the compatible receiver while any
accepted shared-funding job remains active. Keep the receiver until those tasks drain. Closing
admission must preserve history, private assets, uncertainty holds and the original reservations.

This release does not include a new paid generation test. Public-page checks and local fixtures
do not establish supplier acceptance, result quality or production generation latency. Historical
manual holds require separate supplier evidence and authorization for any resolution.
