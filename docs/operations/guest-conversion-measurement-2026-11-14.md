# Guest conversion measurement and voluntary feedback — 2026-11-14

## Scope and state

This is an authorized local implementation record for selected items 35, 91, 92, 93, 98 and 100. No publication, production configuration change, paid generation or customer outreach is authorized by this record. Local fixtures cannot establish conversion improvement, live authentication success, provider latency or receipt of customer feedback.

## Facts and measurement contract

The earlier browser ingestion projected generation/experiment diagnostics but discarded `task_hash` and `latencyBucket`. Those allowlisted fields are now retained. Historical `source_upload_completed`, `guest_result_viewed` and `identity_observed` records are not retrospectively converted into stronger evidence.

`generation_journey_observed_v1` describes a browser observation. Its strict scalar projection allows version, registered stage, optional random UUID action/draft references, one-way job hash, public model key, bounded reason/method/topic and bounded timing. It rejects prompts, filenames, image URLs, raw jobs, account identifiers, provider payloads and tokens. Ingestion derives account identity and time on the server. The browser and server both apply analytics consent/privacy policy. Auth paths contain no query parameters; prefetch/prerender requests are excluded, and mounted auth/result observations also require document visibility.

`generation_journey_confirmed_v1` is absent from the public event allowlist. Only the owning server operation invokes the writer after committed success. A stable session-scoped hash of the persisted entity identifies an idempotent receipt. Upload completion, draft claim, job admission and final registered session are distinct confirmations. A sign-in request, magic-link email send, intermediate two-factor session or client identity event cannot become an auth confirmation. Writers return failure without changing business outcomes. Callers use their existing managed request lifetime where available; no unowned asynchronous work is introduced.

Action/draft references are untrusted correlation hints. They never affect authorization, quotation, idempotency, billing, admission or restoration identity. The admin journey report separates distinct Generate clicks, draft references and confirmed jobs. Repeated observations retain their event count while distinct identities are counted separately. Multiple jobs for one click and shared-browser account ambiguity are explicit; missing linkage is unknown, not abandonment. Admin/internal sessions remain excluded by the existing conversion reader. These counts do not identify natural persons.

Visible-result timing starts at the user's actual Generate click on the same document's monotonic clock and ends at the existing decoded-image/viewport visibility callback. Up to 20 job timings are kept in memory for 30 minutes. Refreshes and missing timing stay unknown. The report only uses explicitly marked `generate_to_visible` observations with a matching confirmed job; URL retrieval, readiness, job settlement and browser visibility remain separate boundaries. P50/P90 are computed from matched whole samples, never added phase percentiles.

## One primary hypothesis

**Hypothesis:** preparing the guest source before Generate and restoring the same draft through authentication will increase the share of identifiable draft attempts reaching a useful visible result and reduce click-to-visible time, without increasing generation failures, repeated paid submissions or customer effort.

This is a product hypothesis, not an observed result. Functional repairs apply to all eligible users; there is no intentionally broken control. This change creates no additional experiment or assignment. Existing deterministic assignment and seven-day maturity logic for `pricing-default-v1` and `result-purchase-v1` remains unchanged. If a later release tests presentation copy, select one primary hypothesis and use the existing assignment/reporting machinery, preserve historical exposures, and change neither price nor entitlements. Do not claim causality from this bundled before/after release or immature payment cohorts.

Primary observations: distinct Generate clicks, one-to-one linked confirmed jobs, actual visible results, matched click-to-visible latency. Guardrails: confirmed failed/held jobs, duplicate/ambiguous associations, input failures, support topics, missing telemetry, provider cost and payment/refund evidence from existing authoritative reports. Consent coverage, source/device mix, repeat users and server-confirmation deployment coverage can change these measurements. Neither absent events nor zero observed feedback establishes absence of problems.

## Voluntary feedback and operations record

The existing feedback dialog offers six optional topics: result quality, waiting, upload, sign-in, price/credits and other. A topic can accompany a user-reviewed email draft or a ticket in the existing support inbox. No new feedback service or automatic outbound message is introduced. Opening a mailto draft is recorded only as `feedback_email_opened`, not receipt or submission. The support workspace emits a browser acknowledgement only after the existing ticket-create API succeeds. The persisted support ticket is the authoritative received record. No prompt, image, payment data, error payload or feedback text is sent to analytics.

Record one row per voluntarily received, reviewed issue in the existing support operations workflow. Keep contact details and message contents in the owner-scoped ticket, not in this document or analytics. A suggested review record is:

| Field              | Meaning                                                                           |
| ------------------ | --------------------------------------------------------------------------------- |
| Evidence reference | Internal support ticket reference, or manually confirmed received email reference |
| Observed fact      | Customer's report and separately reproduced behavior; distinguish them            |
| Topic              | One of the six optional topics, or unknown                                        |
| Hypothesis         | Proposed explanation, with remaining uncertainty                                  |
| Local change       | Exact change and focused verification receipt                                     |
| Publication        | Not published, or later authorized commit/deployment evidence                     |
| Result             | Follow-up evidence and window; unknown until observed                             |

No customer reports, releases or improvements have been invented or populated by this implementation. Future outreach needs its own authorization.

## Release and verification boundary

The event contract uses the existing JSON diagnostics column; it requires no schema migration. Deploy the strict reader/ingestion and server-confirmation consumer code before relying on newly produced v1 counts. Keep historical events and current experiment assignments intact. A partial producer rollout appears as missing coverage, not conversion decline. Local API, aggregation and component regressions verify the contracts; live generation, provider login, customer feedback receipt and conversion outcomes remain separate acceptance evidence.
