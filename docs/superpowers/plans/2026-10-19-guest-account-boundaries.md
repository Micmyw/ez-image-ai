# Guest account boundaries implementation plan

**Goal:** Remove network identity quotas from guest admission while preserving session, device, global, safety and account boundaries; preserve exclusively claimed, unaccepted guest inputs as account assets without stale deletion races.

**Base:** `35e41b04b6bbbb1ba8c33ab7fad5cfc8977dbfaa`, branch `codex/guest-account-boundaries`.

**Constraints:** No production writes, counter deletion, paid calls, push, PR, deployment, pricing, gift-policy or safety changes. Existing image/video shared credits and accepted guest history stay unchanged. Old configuration packages remain accepted; retired bindings are removed only from newly staged versions.

## Tasks

- [x] Add failing configuration and database-boundary tests proving legacy IP/subnet quota fields and full old buckets cannot reject upload, bootstrap or generation; retained global/session/device limits still reject.
- [x] Remove network thresholds from active config/fingerprint/transport and all rate/active-job checks. Keep trusted IP verification, Turnstile and historical HMAC evidence. Preserve explicit global minute/hour fallbacks independently of retired IP aliases.
- [x] Remove legacy marketing draft IP rate, active-count and byte quotas; retain global admission and per-request media safety, use a unique draft identity instead of shared network identity.
- [x] Test and update build-secret overrides, environment filtering and undeployed-version binding retirement so old serving versions retain configuration.
- [ ] Establish a claim/cleanup protocol before changing guest input retention. Only exclusive unaccepted claims may become ACCOUNT. If an already executing deletion cannot be safely excluded, report the exact blocker instead of changing flags alone.
- [ ] Run focused Vitest, format/lint and available local PostgreSQL checks; report generated-client limitations honestly. Update customer-facing changelog and relevant boundary documentation.

## Review focus

- Same-IP guests with independent sessions/devices must not share a business quota.
- Old malformed/missing network settings must not disable an otherwise valid new guest configuration.
- Session/device, global minute/hour/queue/cost checks and authentication must remain effective.
- A formerly scheduled or already leased deletion must never remove a claimed account input.
- Accepted guest jobs/results, watermarks, credits, access grants and historical receipts must remain untouched.
