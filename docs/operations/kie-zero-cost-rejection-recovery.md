# Confirmed zero-cost Kie policy rejection

This recovery applies only to legacy image jobs. It never changes price, audience, provider
credentials, input moderation, admission capacity limits or the separate video engine.

## Automatic closure

The authenticated Kie `jobs/recordInfo` response must identify the same task, report `state=fail`,
`failCode=400`, the exact supported sensitive-content rejection message, explicit
`creditsConsumed=0`, and no output. HTTP failures, missing consumption, another 400 message,
unknown result shapes and callback JSON are insufficient. Dashboard `consumeCredits` is not
silently substituted for the API field. The evidence is retained with its source and UTC
observation time in the attempt response and audit log.

Any conflicting prior cost, charge, output URL, transfer envelope, output asset or additional
attempt retains the reservation for manual reconciliation. A recognized rejection uses the
existing `GENERATION_SETTLE` Outbox and stable `settle:<job>` / `settle:<job>:release` ledger
references. The job ends `FAILED` with `PROVIDER_POLICY_REJECTED_NO_CHARGE`; the original owner
receives only the amount restorable under the existing lot expiry/refund/debt rules.

## Held historical tasks

1. Re-read the exact job, attempt, task identity, original reservation and ledger. Confirm the
   task is still `NEEDS_RECONCILIATION` with `RECONCILIATION_TERMINAL_UNVERIFIED`, the reservation
   is active/unsettled and no output or conflicting billing evidence exists.
2. In the authenticated Kie dashboard, filter by that exact task and a date window covering
   its creation. Record a fresh successful dashboard response, explicit `consumeCredits=0`,
   terminal rejection and absence of result URLs. Exclude the provider `param` object,
   prompts, private media URLs, callback tokens and credentials from exported evidence.
3. In **Admin → Media operations → Confirmed Kie rejection recovery**, enter the attempt ID,
   an evidence reference, reason and sanitized JSON below. This is an administrator attestation
   to externally reviewed dashboard evidence, not a server claim that it queried the dashboard.
   Observation must be within 15 minutes, not future-dated. No credit amount can be supplied.
4. Submit once. An identical retry reuses the same command key and audited result. The action
   locks the original attempt/job, clears reconciliation leases, saves before/after evidence
   and commits one settlement intent. A later success already recorded before recovery blocks
   the action; late callbacks/polls cannot revive a completed attempt.
5. Wait for the existing worker to consume the settlement intent. Confirm one zero SETTLE and
   one RELEASE, reservation finalized, job/attempt terminal, the correct owner's balance and
   released capacity. A queued response alone does not prove credits were released. Expired or
   revoked credits must not become spendable again. Do not issue a replacement GRANT.

```json
{
	"version": 1,
	"provider": "kie",
	"source": "dashboard-log",
	"taskId": "EXACT_PROVIDER_TASK_ID",
	"model": "nano-banana-2-lite",
	"state": "fail",
	"failCode": "400",
	"failMsg": "The input or output was flagged as sensitive. Please try again with different inputs.",
	"consumptionField": "consumeCredits",
	"consumedCredits": 0,
	"outputCount": 0,
	"observedAt": "REPLACE_WITH_ACTUAL_UTC_OBSERVATION"
}
```

## Rollout and validation

Publish the Jobs receiver before the administrator website producer, then verify each exact
commit/version. No database migration or new runtime setting is required. Keep the compatible
receiver until any committed settlements drain. Public checks and administrator recovery do not
authorize a real paid generation or resubmission of rejected content.

Regression coverage includes provider evidence provenance and absence, unknown outputs, duplicate
repairs/settlements, stale leases/callbacks, a success before recovery, conflicting charges,
expired lots, separate owners, shared capacity and video engine isolation. Local test databases
and mocked provider responses do not establish real provider generation success.
