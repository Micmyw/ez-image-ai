# Operator-funded video acceptance

`VIDEO_INTERNAL_FUNDING` authorizes one explicitly configured administrator to use existing
ordinary application credits for internal video acceptance. It does not create credits, paid
receipts or supplier balance. It does not grant video access or replace model, moderation,
pricing, storage, concurrency or provider readiness checks.

The setting is a server-only JSON string transported inside the private `VIDEO_RUNTIME_CONFIG`
bundle to the website and background Worker. Never use a `NEXT_PUBLIC_` variable for it.

```json
{
	"userIds": ["the-one-explicitly-authorized-user-id"],
	"validUntil": "2026-10-05T12:00:00.000Z",
	"reason": "Owner-approved use of existing credits for internal acceptance"
}
```

This example is illustrative; use the actual authorized account and a short, explicitly chosen
expiry. `userIds` must contain exactly one ID (1–160 ASCII letters, digits, underscores or
hyphens); wildcards, additional users and unknown fields are rejected. The current authenticated
user must match that ID exactly, have role `admin`, and use internal video access. The reason must
contain 1–300 characters. Missing, malformed or expired configuration preserves the normal paid
funding requirement. No production user ID is embedded in the source.

The exception keeps the approved retail credit debit and provider/moderation costs. The quote
freezes `pricingDetails.funding` with `mode: operator-funded-internal-v1`, the authorized owner,
expiry and reason. It also records `paidRevenueQualified: false`; calculated retail revenue,
payment fees and profit are kept under `retailReference`, not asserted as actual revenue from
these credits. The full pricing snapshot is included in the immutable quote fingerprint and
copied unchanged to the accepted job.

For new normal quotes, the exact paid-credit revenue floor is also frozen in the pricing snapshot.
The database rejects omission or downgrading of that policy. Changing or removing an operator
authorization requires a new quote. Expired or mismatched funding is rejected before reservation.
Accepted idempotent replays continue to return the original job and never reprice or reserve again.

Operator-funded reservations use the existing account lock, debt check, unexpired credit lots,
immutable reservation ledger, settlement and release paths. There is no database migration and
no backfill or rewrite of grants, paid receipts, quotes or jobs. The audit trail is the reserve
ledger entry → reservation → job → frozen funding snapshot.

The external acceptance spending budget remains separate. Application credit balance and this
exception do not implement a dollar budget or authorize additional paid calls. Track the approved
supplier and moderation spending across the acceptance run independently.

To retire the exception, remove `VIDEO_INTERNAL_FUNDING` from the authoritative private runtime
configuration and synchronize the release targets. New requests return to paid-lot funding.
Existing jobs retain their original snapshots and recovery path; do not rewrite snapshots or
release a potentially paid supplier attempt because the authorization later expired.

Immediately before the first supplier submission claim, the database rechecks the frozen price
and operator-funding deadlines using its current clock. A missing, invalid or expired deadline
prevents creation of an attempt and the paid request. The existing failure path releases credits
and storage capacity only under a transaction-locked no-attempt guard. If another caller already
created an uncertain or accepted attempt, its original recovery path continues without release or
another paid submission.
