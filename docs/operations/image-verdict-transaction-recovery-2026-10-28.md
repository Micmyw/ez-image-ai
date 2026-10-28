# Image verdict transaction recovery — 2026-10-28

Implementation and investigation record. Confirm production publication using the matching Git commit, Cloudflare build and active Worker versions; this document alone is not deployment evidence.

## Incident evidence

Four existing output images had successful generation and authenticated SeeAPI `ALLOW` retrievals, followed by Prisma `P2028` while persisting the verdict. No corresponding approval evidence committed. Recovery later appended `VERIFICATION_LEASE_EXPIRED`, immediately reached `VERIFICATION_DEADLINE_EXCEEDED`, and settled the jobs as `NO_USABLE_OUTPUT` with zero charge. Returned credits made subsequent generation attempts possible; this was not a duplicate signup-credit grant.

The observed retrieval-result-to-error intervals were approximately 5.8–6.3 seconds. `completeMediaVerification` used an interactive Prisma transaction without timeout options; the request client also supplied no transaction default. A real PostgreSQL regression reproduced `P2028` with the installed Prisma 7.9.1 client: after a controlled advisory-lock wait, its error reported a 5,000 ms timeout and 5,538 ms elapsed. The test does not establish which production SQL statement, lock, network round trip or compiler operation consumed the time. Existing production logs cannot distinguish those contributors.

## Runtime change

- The verdict transaction retains its isolation, prompt/verification/job lock order, evidence writes and atomic continuation. Its explicit budget is `maxWait: 5_000`, `timeout: 20_000`, matching existing bounded business transactions. This does not add automatic transaction retries or change all Prisma clients.
- A still-verifying image with `VERIFICATION_LEASE_EXPIRED` may recover beyond the review processing deadline only when its current provider task is already bound, submission is not uncertain, and the adapter supports retrieval. Existing identity, phase-owner and live-lease gates run first. The four-failure budget and temporary-reference deadline remain authoritative. Recovery retrieves the same task; its new authenticated decision can approve or reject. It does not reuse an uncommitted verdict, submit a new review or generate another image.
- Terminal failed jobs are not reopened automatically. Credit grants, reservations, settlements, refunds and pricing are unchanged.
- Failed verdict commits log `verdict_transaction_failed`, the last transaction stage, elapsed wall time, configured timeout, asset/generation identity and a sanitized error code. No SQL, signed URL, credential, raw exception or provider payload is logged. The stage and duration are diagnostic boundaries, not pure SQL or lock-wait measurements. The original error is rethrown without replay.

No schema migration, configuration switch, Workflow parameter or transport change is required. Deploy the compatible jobs runtime through the normal release process before claiming live protection. Rollback restores the previous runtime; immutable evidence from completed recovery remains valid. A larger bounded timeout reduces default-deadline failures but does not guarantee all database work completes; remaining failures retain guarded recovery.

## Customer restoration

At the user's explicit request, the four originals were restored separately in production at approximately 14:30 Asia/Shanghai. Each private object was read with its stored ETag and every byte checked against the stored SHA-256; each original SeeAPI task was freshly retrieved and returned `ALLOW / NO_POLICY_MATCH`. One guarded transaction appended matching approval evidence and deterministic audit records, marked the four original assets ready and corrected the original job display states. All four zero-charge / five-credit-release settlements were preserved. No generation was repeated, and no customer message was sent.

Read-back through the actual application evidence predicate and presentation mapping accepted all four owner-scoped outputs as `ready`. The production credit account and ledger retained their earlier update times; there were still six provider generation attempts and exactly four recovery audits. This establishes restoration of application eligibility, not that the customer has opened or downloaded the results. The exact manifests, provider evidence, SQL and receipts remain in the ignored `output/investigations` directory.

## Verification

Regression coverage uses a disposable loopback PostgreSQL 16 database with the repository migrations and UTC session timezone. Controlled external review responses are fixtures; tests make no live generation or review submissions.

- Real lock wait exceeding five seconds, followed by exactly one committed approval.
- Expired verdict lease plus processing deadline, followed by retrieval of the same task for both approval and rejection; repeated delivery cannot resubmit.
- Missing task, uncertain submission, temporary-reference deadline and exhausted failure budget remain closed.
- Persistence error diagnostics preserve the original exception and do not replay retrieval or expose private error text.
- Existing phase ownership, output lock order, polling, continuation, notification and moderation-outage tests cover the surrounding boundaries.

Before publication, 106 PostgreSQL tests across eight relevant suites and 57 unit tests across seven suites passed. The jobs package type check, affected-file lint, formatting and `git diff --check` passed. The original three regression failures were observed before the runtime fix; the diagnostic Node/Prisma setup used the same UTC database timezone as production. Local PostgreSQL and Node results are not Cloudflare deployment or live integration certification. Release verification must additionally check the matching CI run, automatic builds and active production versions.
