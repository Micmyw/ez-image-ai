# Source-template callback repair — 2026-11-06

The initial migration preserved source request bodies but omitted their optional callback
URLs. Source generation and per-role input moderation therefore depended on the ordinary
Workflow's timed reads. The user explicitly rejected that design. This local repair makes
those source-template paths callback driven without adding an Outbox producer or scanner.

## Creator upload and price display — 2026-11-07

The access response includes only the provision revision and public option-to-credit
prices. The account/template-scoped browser query stays fresh for five minutes;
settings changes use this table locally. Create obtains one authoritative quote and
submits with its stable saved confirmation. A changed price requires another explicit
click. Display prices never replace current admission, ownership or credit checks.

Source upload admission skips the full built-in reference evidence query. As of
[the November 13 runtime change](source-template-runtime-pricing-2026-11-13.md),
access, quote and job admission also consume the published reference snapshot;
the full built-in material checks run at publication. Upload completion
uses the common owner/session/engine check instead of a duplicate preliminary query;
the post-completion immutable identity read and image inspection remain.

The creator retains local blob thumbnails after upload and allows independent slots
to upload together. Restored original INPUT images from `video-workflow-v1` can receive
an owner-scoped inline URL before generation review, bounded by 300 seconds and the
asset expiry. The query requires sealed, decoded JPG/PNG bytes and excludes deleted,
expired, rejected and quarantined assets. This preview grants no approval or provider
access. Generated OUTPUTs and legacy assets retain full review authorization. Loaded
still images do not renew URLs on a timer; a load failure can request a fresh URL.

Focused component regression: `node tooling/e2e/src/video-template-workspace-regression.mjs`.
It uses actual React components with loopback fixtures, covering local prices, parallel
slots, thumbnail continuity, restored photos, changed-price confirmation and same-key
recovery after reload. It neither generates media nor measures production latency.

## Preserved source contracts

The original `ez-airapvideo` SeeAPI generation callback uses the documented raw-body
HMAC, then reads the stored task through the authenticated API. Its Kie H3 callback uses
a protected URL capability. Neither source contract authorizes result URLs from an
untrusted callback body. The target reuses the shared SeeAPI signature verifier, its
existing private signing-key configuration, and native VideoGenerationWorkflowV1.

Submission adds only the server-created top-level `callback_url` (SeeAPI) or `callBackUrl`
(Kie H3). Source prompts, models, ordered references, audio and generation parameters
are unchanged. The provider attempt stores the hash of a random 256-bit URL capability;
each input-photo role stores its own independent hash before its review submission.
Capability URLs are redacted from API access logs.

## Addressed durable continuation

The two new API routes are:

- `/api/webhooks/video-source/:provider/:token`
- `/api/webhooks/video-source-input/:jobId/:role/:token`

Both bound the body and verify canonical origin and capability ownership. SeeAPI also
verifies its official raw bytes, timestamp and signing key before persistence. They
persist evidence in the existing ProviderWebhookEvent table under separate source
provider identities, then send only `provider-result` or `moderation-result` to the
corresponding native Workflow. Failed persistence/delivery returns 503. Duplicate
acknowledged notifications do not send another event. Callback-supplied task IDs,
statuses and output URLs never bind an attempt or authorize output.

The execution row retains the exact callback receipt IDs, grouped by hashed capability.
Confirmation reads address only those IDs; they do not search all provider events or
global Outbox. A bounded inbox limits retained references per capability. The same
job lock serializes delivery and confirmation claims. A distinct receipt authorizes
one authenticated provider read; an active or failed read cannot be reclaimed by
another wake. Reads after the persisted deadline are rejected using database time.

Before any notification, a source confirmation step only checks its local durable
state and returns `waitFor: callback`; it makes no supplier request. The Workflow waits
until an event or the existing absolute deadline. A timeout parks for operational
review without a further read, generation, refund or settlement. The source input
review follows the same rule independently for every photo, while synchronous complete
review results remain usable. A callback-confirmed pending result returns to waiting
for a new distinct notification; it does not start timer polling. Interrupted or failed
confirmation reads are held for operational review, not silently retried.

Unknown submissions retain the original attempt and reservation. In particular, an
early callback body cannot invent a missing task ID after a lost submission response.
Ordinary video, existing effect engines and their accepted histories keep their current
protocols. Existing bounded startup/Workflow-health maintenance remains independent;
this source callback flow neither creates nor invokes Outbox scanning.

## Verification and release boundary

Local verification includes provider/signature mocks, no-notification/no-query checks,
per-role isolation, duplicate delivery, missing configuration before the send fence,
unknown submissions, deadline exits and failed confirmation holds. Isolated PostgreSQL
checks prove concurrent callback deduplication and single confirmation claims, retained
credit reservations, no Outbox records, early evidence and database deadline enforcement.
Real local workerd tests exercise native Workflow event delivery and forced timeout
without real database/provider stages or outbound provider access.

Executed checks:

- Jobs source and existing webhook/recovery tests: 86 passed.
- Workflow orchestration unit tests: 53 passed.
- Actual local workerd Workflow tests: nine passed, including source event and timeout paths.
- Isolated PostgreSQL source integration: 16 passed; source review unit checks: 11 passed.
- API callback-log redaction: five passed.
- Jobs bundle boundary regression: one passed; offline archives, quotation builders and media bytes remain excluded.
- Jobs, database, API and Workflows type checks passed; affected formatting/lint and whitespace checks passed.

The final Jobs dry-run build contains 3,550,034 JavaScript bytes (896,046 gzip bytes).
Total upload gzip including WASM is 2,048.99 KiB, approximately 2.00 MiB. This supersedes
the earlier footprint-audit final size, while preserving that audit's import-only comparison.
It remains a local Jobs measurement, not the website artifact or a deployment.

All task-owned test processes exited. The temporary PostgreSQL instance was stopped and
port 55432 released; ownership and cleanup are recorded in
`.cache/ezrapvideo-template-integration/callback-postgres-ownership.json` and
`callback-postgres-cleanup.json`. No worktree was created.

Deploy the website callback receivers and compatible Jobs consumer before enabling
source-template producers. The existing ProviderWebhookEvent and VideoExecution JSON
fields are used; this repair adds no database schema migration or new credential name.
The earlier source quote constraint migration remains required for the full integration.

All evidence here is local. No real generation or moderation request, production write,
commit, push or deployment was performed. Supplier-to-production callback acceptance
has not been certified by these mocks or local runtime tests.
