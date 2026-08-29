# Anonymous Standard trial operations

This runbook covers the sponsored anonymous Standard Edit trial. PostgreSQL remains the business
source of truth for the temporary principal, trial, credits, job, attempts, result grant, private
assets, cleanup, and audit trail. Trigger.dev, storage, moderation, Turnstile, analytics, and the
configured image service deliver or observe work; they do not own guest eligibility or financial
state.

The feature remains production-off until `pnpm launch:certify` passes against protected evidence for
the exact deployment revision. Local PostgreSQL, deterministic adapters, screenshots, builds, dry
runs, and mock billing are useful local evidence but are not live external certification.

## Production entry gate

Record only non-secret identifiers and redacted evidence references. Never paste HMAC secrets,
Turnstile secrets, cookies, tokens, prompts, signed URLs, raw network addresses, device identifiers,
private object keys, or raw service responses into the runbook or an incident record.

Before enabling admission, prove all of the following for the exact production revision:

- the environment guest gate and audited `media.guestGeneration.enabled` runtime override are both
  enabled;
- only Standard Edit is admitted and its current four-credit quote matches the sponsor grant;
- the trusted-proxy policy rejects direct origin bypass;
- the independent versioned abuse HMAC configuration and promotion-period identifier are present;
- Turnstile site, secret, hostname, and `guest_generate` action evidence is current;
- every rate limit, queue limit/TTL, 24-hour media retention, and sponsored-risk budget is positive
  and fail-closed;
- measured billed Standard cost is recorded and the internal risk ceiling covers that observation;
- an external account hard budget and spend alert have operator evidence;
- private upload/promotion, moderation, Outbox delivery, admission/cleanup tasks, watermarking,
  signed access, alert delivery, privacy disclosure, and deletion readiness have passed.

If any item is missing, guest admission stays disabled and certification remains `NOT_COMPLETED`.

## Abuse HMAC key binding and rotation

Production accepts only an audited object-valued `media.guestGeneration.enabled` override. A legacy
JSON boolean `true` remains a local development/test compatibility value and is rejected by the
production gate. The active production override value has this exact non-secret shape:

```json
{
	"enabled": true,
	"abuseHmacKeyVersion": "launch-key-v1",
	"abuseHmacKeyIdentity": "<64 lowercase hexadecimal characters>"
}
```

`abuseHmacKeyIdentity` is the SHA-256 digest of the UTF-8 bytes
`guest-abuse-hmac-key\0<secret>`. Compute it inside the approved secret-management/deployment
boundary; never put the source secret in the database, audit log, runbook, ticket, command history,
or capability response. The override version and `createdAt` are database-owned audit fields and
must not be edited or backdated.

There is no live production rotation. Rotation is a fail-closed drain lasting at least the immutable
30-day abuse-evidence TTL:

1. Close guest admission and record the old key version, active override version, time, deployment,
   and aggregate queue/risk state. Do not record either key.
2. Drain or expire undispatched work and reconcile accepted/uncertain attempts under the normal
   kill-switch procedure.
3. Create a new audited, higher-version object override containing the new key version and safe
   identity. Its `createdAt` starts a new 30-day clock. Keep `GUEST_MEDIA_ENABLED=false`.
4. Deploy the new secret and version while admission remains closed. Any secret, version, promotion,
   or security-envelope change immediately changes the capability identity, so old upload,
   bootstrap, generation, and link requests fail before consuming credentials or writing business
   state.
5. Wait at least 30 full days from the new override's database `createdAt`. Verify every old-key
   upload, bootstrap, link intent, active trial, session, abuse bucket, and trial-held HMAC value has
   expired or been scrubbed, while immutable job/Attempt/credit/audit facts remain.
6. Rerun the complete production gate. Only then may the environment gate be enabled. The runtime
   gate still rejects a mismatched identity, a fresh override, a malformed/missing key version, or a
   secret shorter than 32 characters.

Changing either key field requires another higher-version override and restarts the full 30-day
clock. Never overlap two abuse keys, accept both identities, copy old HMAC buckets, or backdate the
override to bypass the drain.

## Aggregate monitoring

Use the admin media operations page. Guest diagnostics intentionally exclude raw IPs, subnet or
device values, HMACs, tokens, prompts, media URLs, internal route payloads, and private identifiers.
Monitor:

- admission accepted and denied counts by bounded reason;
- queue depth, oldest age, p50/p95 wait, and expiry before dispatch;
- sponsored risk held, committed, released, and percentage of the configured budget;
- sponsor credits granted, reserved, settled, and released;
- accepted, rejected, uncertain, cost-covered, cost-missing, and billed-spend-mismatch attempts;
- aggregate moderation, watermark, result/grant, and cleanup outcomes.

The consent-aware conversion funnel is separate from authorization and abuse controls. It covers
landing/upload, guest admission, result ready/viewed, watermarked download, account CTA, registered
session and grant completion, the subsequent registered edit, and paid-plan activation. Analytics
may be absent when consent is declined; that must never change guest admission or account access.

## Automatic thresholds

The safety evaluator applies these exact boundaries:

| Signal                       | Warning or slowing              | Automatic guest closure                                |
| ---------------------------- | ------------------------------- | ------------------------------------------------------ |
| Sponsored risk               | 50% warning; 75% slow           | 90% close; 100% reject                                 |
| Waiting queue                | depth above 20                  | depth 25                                               |
| Oldest waiting job           | above 5 minutes                 | 10 minutes                                             |
| Uncertain service acceptance | any older than 10 minutes warns | reconcile; do not fail over                            |
| Moderation                   | —                               | error rate above 1%                                    |
| Watermark                    | —                               | any failure                                            |
| Billed spend                 | —                               | any amount above frozen risk evidence                  |
| Cleanup                      | —                               | any guest asset retained more than TTL plus 30 minutes |

A missing or invalid sponsored-risk budget is an exhausted configuration and fails closed. An
automatic action may create only an audited `media.guestGeneration.enabled=false` override. It must
not disable registered Standard/Quality work, rewrite jobs or attempts, release uncertain
reservations, or mutate external account limits.

## Kill switches

Apply the narrowest sufficient switch, in this order:

1. `media.guestGeneration.enabled=false` stops new guest admission. Undispatched guest work is
   drained through the normal expiry/release path; submitted or uncertain work remains recoverable.
2. `media.model.image-fast.enabled=false` stops new Standard routing for both guest and registered
   traffic. Use only when Standard itself is unsafe.
3. `media.generation.enabled=false` or `MEDIA_GENERATION_ENABLED=false` stops all new generation.
4. The image-service account hard budget is the final external spend boundary. Keep read/reconcile
   access available after it trips.

Every database override requires an operator reason and audit record. Do not edit the active row or
business records directly.

## Drain, reconcile, and cleanup

After closing guest admission:

1. Record the exact deployment revision, runtime override version, aggregate queue/risk snapshot,
   time, reason, and operator.
2. Let undispatched work reach its queue TTL. Confirm reservations and held risk release through the
   existing idempotent ledger and trial paths.
3. Allow accepted work to finalize, moderate, watermark, settle, and schedule deletion normally.
4. Keep uncertain attempts reserved. Reconcile the same attempt until acceptance or rejection is
   evidenced; never submit a replacement while acceptance is uncertain.
5. Confirm clean staging bytes are deleted before a watermarked result becomes READY. Confirm guest
   inputs/results become inaccessible at their immutable expiry and deletion Outbox work completes.
6. Replay only persisted cleanup events after correcting the cause. Object-not-found is idempotent
   cleanup success; do not fabricate object or event identifiers.
7. Verify expired grants, link intents, bootstraps, Sessions, abuse buckets/HMAC evidence, and finally
   orphaned temporary Users are pruned without affecting registered accounts. Confirm retained
   trial, job, Attempt, credit, ledger, and audit rows remain intact with the expired temporary owner
   relationship detached.

If cleanup exceeds TTL plus 30 minutes, admission remains closed until the backlog and dead letters
are zero or an approved incident decision documents the residual risk.

## Rollback and re-enable

Application rollback redeploys the previous immutable revision while retaining the additive guest
schema and existing trial records. Do not reverse the migration or delete guest rows to make a
rollback appear clean. Continue reconciliation and cleanup with the compatible worker revision, or
forward-fix it under an incident plan.

Re-enable only after the root cause is fixed, all uncertain acceptance is reconciled, cleanup is
within threshold, sponsored risk and billed spend agree, alert delivery is proven, and the complete
production gate is rerun. Roll back the audited guest-disable override rather than editing it. Expand
the guest cohort gradually and record a fresh aggregate snapshot after each change.

## Evidence ledger

Keep these items `NOT_COMPLETED` until they are verified against the live external system and exact
deployed revision:

- billed Standard cost and the matching internal risk ceiling;
- external hard-budget and spend-alert configuration;
- production Turnstile, trusted-proxy, storage, moderation, task, watermark, and cleanup evidence;
- deployed privacy content and runtime configuration;
- production alert receipt, guest enablement, and live end-to-end trial evidence.

`pnpm launch:certify` must continue to fail while any required item is incomplete. A forged `PASS`
record that omits a guest gate is invalid and must be rejected by the certification schema.
