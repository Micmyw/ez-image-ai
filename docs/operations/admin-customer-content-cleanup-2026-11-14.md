# Administrator customer content diagnostics and selected cleanup

This change is a local implementation. No production data was deleted, no live provider was called, and no release or deployment is certified by this document.

## Private diagnostics

The customer-image panel lists uploads and outputs, including sealed uploads without a generation job. `GUEST` means the asset's current `GUEST_TRIAL` retention class; `ACCOUNT` means its current account retention class. An adopted guest image can therefore appear under account content. The filter does not infer a person's registration history. Asset IDs, owner IDs and job IDs are exact-match search inputs. Original asset kind and the selected job's input/output binding role remain separate.

Administrator middleware protects every list, detail, plan and execution endpoint. List/detail/plan-recovery reads append their own administrator audit. Responses use `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`. Only audited detail reads sign the database-selected immutable image key, for 60 seconds. The API never accepts a preview URL or storage key from the browser.

SeeAPI displays persisted classifier categories, technical failure code/status and whether the immutable evidence still matches the current asset generation, checksum, provider task and policy. Waffo displays the persisted decision, reason, semantic status and matched categories from quote or blocked-prompt audits. Historical evidence is labelled; a technical failure is not a content verdict. Immutable-copy provenance remains intact and is never reclassified as a provider call for the copied target.

The independent prompt-content panel also covers text-only jobs, failed tasks without images and blocked prompts without a created job. Prompt detail is private and audited; list rows do not expose prompt text.

Model terminal evidence and message provenance are independent. Authenticated Kie retrieval uses its existing attempt/task-bound terminal evidence. New `providerDiagnostic` messages are bound to attempt/provider/task and explicitly label authenticated retrieval, authenticated submission, callback diagnostics or internal diagnostics. Strict historical zero-cost rejection evidence retains the distinction between authenticated record-info and administrator-attested dashboard evidence. Legacy free-form messages remain historical application diagnostics. A callback message never supplies authenticated terminal, moderation or billing authority. Where old writers did not save a message, the UI cannot recover or invent it.

Only allowlisted diagnostic leaves are returned. Messages and categories are bounded and scrub signed/raw URLs, object paths, credentials, JWTs and long opaque tokens. Provider credentials, arbitrary raw JSON, transfer envelopes, storage keys and billing snapshots never enter these read projections.

## Exact cleanup plan

Cleanup requires an administrator to select at most 20 explicit asset IDs, enter a reason, inspect the preview and type its exact confirmation. The server records a versioned plan in the audit log with a random plan ID, canonical SHA-256 hash, actor ID and ten-minute database-time expiry. It freezes owner, key, checksum, ETag, storage version, byte size, asset update time and review generation. The public preview exposes IDs, counts, byte totals and blocked reasons; private object identity stays on the server. The same actor, plan hash, complete confirmation and all selected identities are rechecked inside the execution transaction. A changed or expired plan fails atomically.

Only finalized ordinary legacy-engine images in a stable terminal asset state are eligible. The preview and execution reject live jobs, active credit/image-pass/storage reservations, nonterminal or uncertain provider attempts, unresolved/active image review, transfer/promotion leases, active uploads, unconsumed valid guest upload-completion receipts, unexpired `ACTIVE` or claimed `SUBMITTED` drafts, protected source-template material, and active or uncertain account-copy writers. `SUBMITTED` drafts are protected even when no generation job exists. All copy journal Outbox events remain intact, including already processed `ACCOUNT_INPUT_COPY_REVIEW_SOURCE` and `ACCOUNT_INPUT_COPY_READBACK` receipts.

Execution follows the existing owner-storage fence, asset-binding lock, verification lock and asset-row protocol. It creates an explicit `MEDIA_ADMIN_ASSET_DELETE_AUTHORIZED` audit with the actual administrator as actor; it never impersonates the customer. The audit binds the exact object and tombstone to the executed plan. This is a narrow administrator authorization exception during the image automatic-deletion pause. `MEDIA_IMAGE_AUTO_DELETE_ENABLED` is not enabled or bypassed globally.

## Physical deletion and retries

The transaction writes the existing `DELETED` soft tombstone and a durable `MEDIA_OBJECT_DELETE` Outbox intent. The tombstone revokes use and prevents later draft/job/copy adoption while storage cleanup is pending. It does **not** delete the `MediaAsset` database row or release occupied storage capacity.

The storage consumer validates the exact administrator authorization against the immutable object and executed plan before honoring it during the deletion pause. R2 deletion then uses the existing idempotent storage pipeline. Only successful physical deletion writes `MEDIA_OBJECT_DELETE_COMPLETED` and releases the matching committed quota reservation. Storage failure retains the same object identity and durable event for retry; it never removes the database evidence first.

The detail panel separates queued, retrying, failed/unresolved and physically completed deletion. A completed API request means the intent was queued, not that R2 was deleted. Recent confirmed plans can be restored from the current administrator's five newest execution receipts after navigation. The administrator re-enters the original confirmation to retry. A `DEAD_LETTER` retry revalidates the exact authorization, resets the same Outbox event to pending, preserves its ID/dedupe/payload and adds a retry audit. Already pending/completed work is not duplicated. No private cleanup plan is persisted in browser storage.

## Database records that can be removed

The optional log selector is off by default. Its sole supported class is `GrowthEvent` browser telemetry with `internal=true` and a creation time older than 30 days according to PostgreSQL. A preview freezes at most 100 selected rows, their content hashes and JSON byte estimates. Execution locks and rechecks every selected row, then performs a bounded delete by those exact IDs. JSON size is an estimate, not reclaimed PostgreSQL disk space. The optional explicit telemetry-ID filter supports narrower selection and isolated regression fixtures.

Real-visitor telemetry, all Outbox events, provider/webhook receipts, generation jobs/attempts, financial ledgers, credit lots, orders/refunds, accepted quotes/pricing snapshots, grants, moderation results/provenance, asset rows, owner fences and all deletion/audit records remain. There is no arbitrary table selector, prefix-based bucket deletion, full-table delete or truncation.

## Release order and rollback

This feature reuses audit logs and Outbox intents and adds no database schema migration. It requires the existing owner-storage and asset-binding protocols. Deploy compatible storage cleanup consumers in Workers and any enabled hybrid runtime **before** publishing the administrator execute endpoint. Drain incompatible consumers before allowing administrators to confirm plans; old consumers do not recognize the new exact administrator authorization and can only defer while the automatic-deletion pause remains active. Deploy compatible draft/upload/copy admission readers together so a revoked asset cannot be adopted from an earlier read.

Keep automatic image deletion paused throughout. No R2 lifecycle rule change is part of this feature. Roll back the UI/producers first while retaining compatible consumers until accepted cleanup events complete or are explicitly held; do not delete their audits or Outbox rows. Storage already deleted after explicit confirmation cannot be restored by rolling back code.

## Local verification

Focused database tests cover retention-pause authorization, private diagnostic projections and plan expiry. Isolated loopback PostgreSQL tests cover typed confirmation, actor/hash/object mismatch, atomic stale-plan rollback, active jobs/reservations/copy/drafts, unconsumed guest completion, immutable evidence/copy-journal preservation, internal-log boundaries, exact-event retries and recent-plan isolation. API tests use the actual administrator middleware and verify authentication/role rejection, private headers, strict bounded inputs and bounded conflicts. UI tests cover original/output roles, source-labelled diagnostics and cleanup counts/blocked reasons/physical state.

Append-only proof fixtures remain under unique task-owned prefixes in the disposable test database; tests do not disable evidence triggers or truncate shared tables. These are local mocked-storage and database results, not evidence of live R2 deletion or a deployed external integration.
