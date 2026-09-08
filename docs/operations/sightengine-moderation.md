# Sightengine text and image moderation

Implementation scope: English prompts and static input/output images. Sightengine supplies scores;
the versioned application policy decides whether to allow, reject, quarantine for review, or retry a
technical failure. The generation provider's own safety checks are an additional boundary. They do
not replace this policy or control the application's credit ledger.

## Request and response contract

| Subject            | Request                                                               | Required result                                                                                      |
| ------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| English prompt     | `/text/check.json`, `mode=ml`, `lang=en`, `models=general,self-harm`  | `moderation_classes` with all six requested categories listed in `available` and with numeric scores |
| Input/output image | `/check.json`, `models=nudity-2.1,weapon,gore-2.0,violence,self-harm` | Complete consumed fields in `nudity`, `weapon`, `gore`, `violence`, and `self-harm`                  |

Both profiles require HTTP success, `status=success`, no `error` field, and valid
`request.id` / `request.operations` metadata. Every consumed probability must be a finite number in
`[0, 1]`. Missing sections and malformed scores are errors, never zero-risk defaults. Additional
provider response fields do not enter the decision or its audit evidence.

Text is limited to 10,000 characters and must be nonblank. Non-Latin letters, including mixed
English/Chinese prompts, return `REVIEW / UNSUPPORTED_TEXT_LANGUAGE` before an API call. This is a
script guard, not reliable language identification: English is the supported release contract, and
other Latin-script languages are not certified. Inputs are not automatically translated.

Requests use the existing bounded HTTP client: a 15-second default timeout and a 1 MiB default
response limit. HTTP errors, HTTP-200 business failures, invalid JSON, missing credentials, and
timeouts return a sanitized `ERROR / MODERATION_UNAVAILABLE` decision. Do not expose upstream error
messages or fall back to the test adapter.

## Initial application policy

| Signal                                                                               | Score at least 0.85 | Score at least 0.4 and below 0.85 |
| ------------------------------------------------------------------------------------ | ------------------- | --------------------------------- |
| Text sexual, discriminatory, violent, self-harm                                      | REJECT              | REVIEW                            |
| Text insulting/toxic                                                                 | REVIEW              | REVIEW                            |
| Image sexual activity, sexual display, erotica                                       | REJECT              | REVIEW                            |
| Severe gore: very bloody, exposed organs, serious injury, corpse                     | REJECT              | REVIEW                            |
| Physical violence, firearm threat, firearm aimed at another person                   | REJECT              | REVIEW                            |
| Image self-harm                                                                      | REJECT              | REVIEW                            |
| Very suggestive image, firearm/knife presence, firearm aimed at camera, broader gore | REVIEW              | REVIEW                            |

Any definite rejection wins over an ambiguous category. Otherwise any review signal wins over
ALLOW. Combat sports alone and mild suggestiveness alone do not block an image. The broader
violence score requests review when there is no combat-sport signal of at least 0.4; independently
detected physical violence or firearm threats still apply. `suggestive`, `mildly_suggestive`, toy
weapons, and firearm gestures are retained as diagnostics without independent rejection rules.

These are starting product thresholds, not measured accuracy or false-positive guarantees. Review
with a representative, lawful evaluation set before changing thresholds, and bump the relevant
rule/policy version with every change that affects authorization.

This profile does not establish age, adult identity, photo ownership, consent, or reliable detection
of all nonconsensual edits. Those cannot be inferred from an NSFW score. It also does not certify
video moderation: the legacy video transport remains separate, and its historical incomplete
nudity-only completion payload cannot authorize an asset. Do not enable video on this evidence.

## Lifecycle and private evidence

1. Authenticated, retry, and guest prompts are moderated before an approved quote can create a
   generation job/reservation. A text rejection creates no approved quote or new credit reservation.
2. Input images use the existing private upload verification path. Bytes, MIME type, checksum,
   storage finalization, lease, and rule/policy version are checked before `READY` can authorize use.
3. Provider output is transferred to private storage, verified through the same image policy, and
   only approved output can become usable. `REJECT` and `REVIEW` quarantine the asset.
4. Image `ERROR` uses the existing bounded verification retry/deadline policy. Exhausted errors
   remain unavailable. Review does not count as approval or promise an automatic human review.
5. Existing settlement resolves reservations for approved, rejected, review, or failed output. This
   change does not alter ledger accounting or assume a provider will refund its API charge.

Decisions retain only an allowlist: request ID, requested models, provider-reported operation count,
and consumed score values. Approved quote audits (including guest and retry quotes) retain this
evidence. Authenticated/retry text denials use their existing private audit path; guest denials
retain their existing bounded abuse-counter evidence without storing raw prompts. Image evidence
retains scores in `categories` and the sanitized decision/evidence in `rawEnvelope`, tied to asset
checksum, verification generation, provider, versions, and expiry. Despite its legacy field name,
`rawEnvelope` is not the raw Sightengine response. Evidence adds no public DTO fields and needs no
database schema migration.

## Configuration, rollout, and cost

Set these server-only variables in both the app and the workers:

```dotenv
MEDIA_SAFETY_ADAPTER=sightengine
MEDIA_ALLOW_TEST_SAFETY_ADAPTER=false
SIGHTENGINE_API_USER=<local secret>
SIGHTENGINE_API_SECRET=<local secret>
```

Do not put credentials into browser variables, source files, or logs. Generation remains subject to
its existing provider, storage, budget, and certification gates; changing these four variables alone
does not certify or enable the complete generation service.

Current versions are `text-safety-2026-09-08.1`, `media-safety-2026-09-08.1`, and
`media-policy-2026-09-08.2`. Deploy app and workers consistently. Old approved text quotes cannot
authorize new jobs under the new rule. The image lifetime change in policy `.2` preserves the same
classifier rules as `.1`; it does not approve different content.

**Approved static images have no daily recheck.** Their private immutable bytes, checksum, provider,
rule, policy, latest approved evidence, and ownership must still match. New uploads and newly
generated results require their first moderation pass. Reuploading an identical image as a new asset
also requires review; this is not a global content-hash cache across assets or owners. Deletion,
quarantine, and rule/provider changes can still revoke approval.

The implementation uses the finite terminal timestamp `9999-12-31T23:59:59.999Z` to represent no
calendar expiry, preserving the existing database non-null evidence contract and URL expiry bounds.
It does not extend signed URLs or guest result retention. Errors and unfinished checks still follow
their bounded retry/lease/deadline policies; legacy video evidence retains its previous lifetime.

Compatible stored images from `media-safety-2026-09-08.1` and image policies `.1` / `.2` can reuse the
latest exact approved record when recovery runs. Under the existing database lock, the worker
checks all fingerprint, version, attempt, finalization, and state bindings, appends a new approval
referencing `reusedEvidenceId`, and updates the asset in one transaction. It makes no storage or
Sightengine request for this transition, and never modifies the original evidence. The audit action
is `MEDIA_ASSET_APPROVAL_REUSED`. The source record retains the original scores/request metadata;
the reuse record has no new provider operation count. Concurrent replay produces only one new
record. Once transitioned, the asset is no longer a calendar-expiry recovery candidate.

This compatibility is pinned explicitly to the above versions. The older incomplete moderation
rules, missing evidence, rejected/review decisions, changed checksums, other providers, and future
rule/policy changes require fresh verification. Do not bulk relabel old records as trusted. During
rollout, reads remain closed until recovery either reuses a compatible record or completes required
verification. Keep the scheduled worker for unfinished checks and real rule changes: eliminating
daily image API rechecks does not eliminate scheduler/database/storage costs.

One HTTP request can contain several billable model operations. Use the stored
`request.operations`, account plan, and Sightengine usage dashboard for reconciliation. Do not
equate one generation with one moderation request: count prompt, input, output, retries, and any
required rule-change checks. This implementation adds no second moderation vendor or self-hosted model.

## Verification and remaining external prerequisites

The regression fixtures are synthetic responses shaped from official documentation. They contain
no real user prompts, NSFW images, or credentials. Coverage includes text/image profile selection,
threshold boundaries, rejection precedence, missing/malformed results, business errors, redaction,
unsupported scripts, timeouts, and database persistence for input/output ALLOW/REJECT/REVIEW.
Existing integration tests cover recovery, leases, idempotency, finalization, and settlement.

Verification of the original text/image adapter repair on 2026-09-08 (all final commands exited 0):

| Check                                     | Command / scope                                                                                                                                                 | Result                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Focused adapter regression                | `pnpm --filter @repo/ai test media/moderation/sightengine.test.ts media/moderation/moderation.contract.test.ts`                                                 | 58 passed                                                                                        |
| Quote persistence and asset read boundary | `pnpm --filter @repo/database exec vitest run prisma/queries/media/quotes.test.ts prisma/queries/media/assets-read-authorization.test.ts --configLoader runner` | 6 passed                                                                                         |
| API moderation regression                 | `pnpm --filter @repo/api exec vitest run` for text-moderation, guest-admission, asset-authorization, list-assets, create-quote, and retry-generation unit files | 70 passed                                                                                        |
| Worker database integration               | `pnpm --filter @repo/jobs test:integration`                                                                                                                     | 93 passed                                                                                        |
| Guest/retry database integration          | `pnpm --filter @repo/api exec vitest run` for guest-media, guest-admission-boundary, and retry-generation database integration files                            | 10 passed                                                                                        |
| Full workspace tests                      | `pnpm test --concurrency=1`                                                                                                                                     | 1,733 passed, 11 task groups, no cache hits                                                      |
| Full workspace types                      | `pnpm type-check`                                                                                                                                               | 19 task groups passed; latest AI test adjustment also passed `pnpm --filter @repo/ai type-check` |
| Formatting and lint                       | `pnpm format:check`, `pnpm lint`; focused lint after fixing two test-only warnings                                                                              | Passed                                                                                           |

Before the production repair, the new 39-case adapter regression had 27 failures. Quote evidence
persistence failed one test and image evidence persistence failed all three decision cases before
their corresponding fixes. These failures, followed by passing runs, establish the regression
tests exercised the defects. The final adapter suite includes additional boundary/error coverage.

Database verification used a task-owned disposable PostgreSQL 16 container on loopback port 55432;
the application's database on port 5432 was not modified. All 43 existing migrations were applied
to the disposable database; no new migration was introduced. Test-only database URLs and
`MEDIA_DAILY_PROVIDER_COST_BUDGET_MICROS=1000000000` were process-scoped. Guest/retry integration
used the canonical runtime `application_name` URL alias to the same disposable database. The
existing checkout/dependencies were used; this was not a clean-checkout installation. Types
regenerated the existing Prisma client through the normal root task. Build and browser E2E were
not run for this server-only change, which adds no browser DTO or rendering contract. Existing
PostgreSQL client deprecation and Turbo test-output caching notices were non-failing.

### Image approval lifetime follow-up (2026-09-08)

The lifetime change was verified separately from the adapter repair above. Before the production
change, three focused database cases failed: an approved image became unreadable after one year,
and each of the two compatible source-policy cases called moderation again on expiry. They passed
after the change. Coverage also asserts concurrent reuse creates one new evidence generation,
preserves the original approval, and keeps real provider-change reverification authoritative when
it races with settlement.

| Check                                                                                   | Result                |
| --------------------------------------------------------------------------------------- | --------------------- |
| Approval compatibility and recovery unit tests                                          | 38 passed             |
| Worker database integration across verification, finalization, recovery, and settlement | 94 passed             |
| API asset authorization, listing, and authenticated/guest access URLs                   | 9 passed              |
| Database quote and asset-read authorization unit tests                                  | 6 passed              |
| Workspace type check at the time of the change                                          | 19 task groups passed |
| Final jobs type check after the race-fixture adjustment                                 | Passed                |
| Formatting and lint for the lifetime files                                              | Passed                |

The database suite used a separate disposable PostgreSQL 16 container with all 43 existing
migrations; it did not change the application's data or call a paid service. The focused follow-up
checks ran the already-installed Vitest, TypeScript, Oxfmt, and Oxlint tools directly.

Full-workspace certification for this follow-up is **NOT_COMPLETED**. During concurrent Cloudflare
Workflows development, the root test run stopped at the unrelated `request-security.test.ts` case
`reports Workflows readiness without any Trigger configuration`, and root formatting reported
Workflows files. Subsequent pnpm invocations requested a shared dependency-directory replacement
and aborted with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`; no removal or reinstall was forced.
These results do not replace the focused passing checks, or imply that the current combined
workspace is ready to release. No build, browser E2E, push, or deployment was performed for the
lifetime change.

Live Sightengine verification is **NOT_COMPLETED** until credentials are configured and a bounded
staging test confirms the actual response shapes, operation counts, and access to a short-lived
private-image URL. Provider accuracy and latency require a separately recorded evaluation set and
measured results. Local PostgreSQL and mocked HTTP tests do not establish any of these.

For live certification, use an authorized harmless English prompt and an authorized harmless static
image; confirm the selected models, scores, request ID, operations, private audit row, and READY
boundary. Exercise failures and policy rejections through fixtures without collecting harmful
content. Confirm that missing credentials/availability never enables mock moderation or generation.

Official contract references checked for this repair:

- [Text ML models](https://sightengine.com/docs/text-moderation-ml-models)
- [Nudity 2.1](https://sightengine.com/docs/advanced-nudity-detection-model-2.1)
- [Weapon detection](https://sightengine.com/docs/weapon-firearm-knife-detection)
- [Gore 2.0](https://sightengine.com/docs/gore-disgusting-horrific-content-detection)
- [Violence detection](https://sightengine.com/docs/violence-detection-model)
- [Self-harm detection](https://sightengine.com/docs/self-harm-detection-model)
