# Generation orchestration and additional Providers

## Active result polling

Accepted asynchronous submissions start the internal Workflow operation `media-poll-generation` after
the Provider task ID and attempt state have been persisted. Its payload contains only the internal
attempt ID. It resolves the frozen Provider through the recovery registry and reuses `retrieve`,
`normalizeResult`, and the database reconciliation/finalization path.

- The first query is due after 10 seconds. Pending observations use 10-second intervals in the
  first minute, 20 seconds until minute three, 30 seconds until minute ten, and 60 seconds after
  that. Queue time and Provider latency can extend the observed interval.
- Cloudflare Workflows durable waits release Node execution capacity between queries. Each active run has a
  ten-minute window and an iteration bound. Longer work remains eligible for the existing
  five-minute reconciliation sweep.
- A stable per-attempt Workflow idempotency key suppresses duplicate admission. PostgreSQL
  remains authoritative: active polling and scheduled recovery share the same due time, lease,
  lease token, and conditional transitions. Targeted queries do not increment the repair counter.
- Transport errors retain recovery backoff. Polling never resubmits, switches Provider, cancels
  a task, releases credits, or settles a reservation directly.
- Synchronous results enter finalization without polling. Terminal and manual-recovery jobs stop
  their active worker. Submissions without a Provider task ID remain with uncertain-submission
  recovery; polling cannot discover a missing remote task ID.
- Failure to enqueue polling leaves accepted work accepted. Scheduled reconciliation can start
  the missing polling task after observing pending work. A stopped or failed active worker does
  not remove the database recovery path.

Deploy the matching Workflow and Node image with dispatch and reconciliation. The initial Container
configuration allows one `basic` instance; durable waits do not keep a Node polling process alive.
Monitor cold starts, query latency, execution backlog, Provider rate limits, finalization/Outbox lag
and uncertain-submission backlog before changing capacity. See the
[Cloudflare execution runbook](./cloudflare-workflows-runbook.md) for secrets, idle shutdown,
scheduled maintenance cost, cutover and rollback.

Finalization and settlement still use durable Outbox delivery. Timely queries do not promise
instantaneous image delivery: results must still pass private transfer and output moderation.

## Adding another Provider

Adding a Provider usually requires a server adapter and route configuration. Changing a URL and
key alone is sufficient only when request, response, authentication, task-retrieval, and error
contracts are verified to be compatible.

1. Implement `MediaProviderAdapter` under `packages/ai/media/providers`. Map private source-image
   references, prompt and SKU parameters in `submit`; implement task-scoped `retrieve`; normalize
   statuses, output URLs or bounded inline images, cost, and failure evidence. Report uncertain
   acceptance explicitly. Claim Provider idempotency only when the remote API supports it.
2. Register the server credential and adapter in the Provider registry. Extend the Provider key,
   catalog/SKU matrix, static dispatch manifest and submission task as required. Keep public
   product keys stable; Provider/model identifiers and costs remain server-only.
3. Configure exact output-host allowlists and verify private input access, MIME/byte limits,
   streamed transfer, moderation and signed reads. Preserve the existing jobs, attempts,
   reservations, immutable ledger and Outbox paths.
4. Return a remote task ID and trusted retrieval endpoints for asynchronous work; the common
   poller then uses the adapter. Return the successful snapshot for synchronous work. For
   callbacks, implement documented signature verification before using the durable webhook path.
   Retain polling recovery when task retrieval is supported.
5. Test success, rejection, timeout/uncertainty, duplicate delivery, malformed output and private
   transfer. Certify the exact route with authorized private images and bounded staging spend
   before enabling new submissions.

An API without task retrieval or verifiable callbacks has weaker automatic recovery after a lost
response. Document that limitation; never retry uncertain work against another Provider.

Provider changes apply to new quotes and attempts. Existing work keeps its frozen Provider/model
and needs recovery credentials until it drains. Adding a second Provider does not automatically
enable cross-Provider failover or certify image quality and billing behavior.

## Verification boundary

Unit tests cover multi-Provider admission, exact scope, scheduler failure, backoff, bounded runs,
webhook completion, and no resubmission. Database integration cases in
`packages/jobs/src/handlers/runtime-stores.database.integration.test.ts` cover exact-attempt leases,
concurrent duplicate exclusion, due times, and terminal/uncertain work.

Real Workflow/Container deployment, Provider calls, storage policies and production load remain separate
requirements in [the launch checklist](./ezpic-launch-checklist.md). Local tests do not certify
those services.
