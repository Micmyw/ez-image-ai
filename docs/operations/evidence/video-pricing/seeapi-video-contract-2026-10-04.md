# SeeAPI video visual moderation contract

Evidence date: 2026-10-04. Source: [SeeAPI Video NSFW Filter — Video Moderation](https://www.seeapi.com/docs/video-nsfw-filter/video-moderation/). This is public documentation research and local mocked validation. No paid request or live account acceptance was performed.

The cached source HTML SHA-256 is `74aba8412f76b1247607b85270ae0ef48d3ccbbd931e35603eaa9de89f656682`. The source-derived request, acceptance response, illustrative query response and field constraints are saved in `packages/ai/media/catalog/fixtures/seeapi-video-moderation-contract-2026-10-04.json`. Cached source files are `.cache/video-v1/seeapi-contract/video-moderation.html` and `.txt`; these caches are not a substitute for the checked-in fixture.

## Wire contract

- Create: `POST https://api.seeapi.com/v1/inferences`, `model=video-nsfw-filter`, `endpoint=video-moderation`, `provider=seeapi`.
- Query: `GET /v1/inferences/{id}`. The official documentation explicitly excludes `/v1/generations/{id}` for this model.
- Bearer authorization and `Idempotency-Key` are required. Reuse is permitted only for an identical body. A refreshed signed source URL changes the body. The adapter performs no submission retry, including after HTTP errors, timeouts or an unknown transport result; the existing durable send fence owns uncertainty recovery.
- The source must remain reachable while processing. Official limits are 30 seconds and “100 M”, MP4/MOV via HTTPS. The application retains its private, immutable MP4 source and does not expose arbitrary user-selected URLs through this adapter.
- HTTP 202 / queued / processing is acceptance only. Every returned task is confirmed through GET before a moderation verdict is used, including an immediately succeeded create response.
- `succeeded + flagged=true + output=null + reason=content_policy_blocked` is an explicit policy rejection without a frame report and remains billable. The adapter never invents frames or a clean result for it.

## Callback-only completion

The user explicitly selected callback-only completion without a cyclic polling fallback. The frozen SeeAPI profile records `completionMode=callback-confirm-once`: one callback-triggered, bounded confirmation sequence, with at most three GET requests total including the first. Submission therefore requires a server-constructed, task-bound HTTPS `callback_url` of at most 2048 characters, without userinfo, a fragment, leading/trailing whitespace or control characters. The endpoint's official documentation supports this parameter; it is optional at the provider boundary and required by this application policy.

SeeAPI does have a public webhook signing contract. [Authentication](https://www.seeapi.com/docs/authentication/) distinguishes the Webhook Signing Secret from the API key. The [public official Developer Center application code](https://www.seeapi.com/_next/static/immutable/chunks/40t71rwpea69l.js), SHA-256 `e9183bb3ea667edf30e83aaba041f3593b9612d0aa4783c479b5a0ee65d3a23d`, provides the detailed signature example. This application-code evidence is recorded separately from the video endpoint documentation; it is not evidence of a successful real inference callback.

The example reads `X-SEEAPI-Timestamp`, `X-SEEAPI-Signature`, and `X-SEEAPI-Signing-Key`; the signature is `v1=<64 hex characters>`, with the example accepting case-insensitive hexadecimal/version prefix. It computes HMAC-SHA256 with the full configured secret over the original timestamp string, a dot, and the unchanged request-body bytes. It recommends a ±300-second time window and retaining old `whkey_` secret mappings for deliveries queued before key rotation. The verifier uses Web Crypto verification, rejects unknown/inherited key IDs, and preserves byte offsets, non-ASCII bytes and BOMs. It never parses or normalizes JSON before verification.

The public example lists `generation.succeeded/failed`; an inference-specific event/payload schema has not been confirmed. The receiver therefore does not infer such a schema or trust an event name to update state. A server-generated task-bound URL proof and the database's immutable identity select the previously recorded inference. A verified callback is only a wake hint for the authenticated `/v1/inferences/{id}` confirmation. SeeAPI's `X-SEEAPI-Event` and `X-SEEAPI-Delivery` headers are not included in the documented HMAC input and remain diagnostic metadata; task/state idempotency and durable raw-body identity are still required.

Only network failures, timeouts, HTTP 429 and HTTP 5xx permit another confirmation read. Processing responses, malformed responses, terminal failure/cancellation and completed moderation decisions consume the sequence without further reads. PostgreSQL persists the read count before each GET, a 60-second lease, and 1-second/3-second retry delays; interrupted reads consume their attempt budget. Duplicate callbacks and workflow restarts cannot reset that count. No callback means zero confirmation GETs. Each adapter method performs only one HTTP request and never retries internally.

The adapter and verifier do not introduce a polling fallback. Callback inbox persistence, proof validation, bounded confirmation orchestration, deadlines and operational recovery are handled by their separate owners. Missing, invalid or inconclusive callbacks must not turn into fabricated ALLOW decisions or new paid submissions. Real inference delivery, signing compatibility and completion timing remain **NOT_RUN** pending authorized external acceptance.

## Application visual policy

The video request uses the same strict detector settings as the existing SeeAPI image adapter: `threshold_offset=0`, `strict_special_care=true`. It requests `return_frames=none`, so no extracted frame image storage or source URL disclosure is required.

Admission freezes a canonical visual policy profile, including `num_frames = min(32, max(8, requestedDurationSeconds + 2))`. The adapter validates that frozen profile, its SeeAPI provider and the matching rule version; it does not change sample count when the inspected output has a small duration drift or current environment settings change. The adapter rejects actual duration above 30,000 ms before sending. Durations above this provider limit, including a generated 30-second clip with positive duration drift, require a local hold rather than an invalid paid request.

ALLOW requires matching task/model/endpoint/provider, succeeded status, no task error, and a consistent normal report. The report must identify `scope=sampled_frames`, `sampling_complete=true`, schema `5`, `named-files-v1`, `timestamp_source=frame_index_div_fps_estimate`, and exactly the requested number of checked frames. Per-frame source numbers and timestamps must be unique and strictly increasing. Source frame numbers are not array indexes and need not be contiguous or one-based.

The frozen application policy rejects timestamps outside the inspected duration plus 0.5 seconds, a first sample later than 0.25 seconds, a final sample more than 1 second before the end, and interior sample gaps above 1 second. The actual maximum adjacent gap is retained in evidence for independent database validation. These are conservative application acceptance bounds, not claims that SeeAPI promises uniform frame distribution or exact timestamps. Real output acceptance of these bounds remains NOT_RUN.

Overall `flagged`, report `nsfw_detected`, `flagged_frame_count`, and per-frame `nsfw_detected` must agree. A nonempty NSFW or special-care label with a clean overall verdict produces REVIEW, preserving the existing image policy. Optional `special` may be absent; `specialCareReportedFrames` records how many frames actually included it, and a completely omitted field does not become a fabricated empty category list. Optional `image_url` is ignored and never treated as proof of sampling or safety.

The response does not echo the input video URL or hash. Source identity therefore remains the database's persisted task ID, verification attempt, checksum, ETag and immutable asset binding. Response labels and request IDs are allowlisted diagnostics; raw responses, signed URLs, frame image URLs, messages and credentials are not emitted as evidence.

This policy assesses sampled visual NSFW/special-care content. `video.complete=true` means the required sampling assessment completed; the accompanying `seeapiVideo.scope=sampled_frames` records that limitation. It does not mean every video frame was inspected, nor does it claim the wider historical Sightengine category set. This adapter never supplies audio approval.

The current admission policy explicitly freezes `audioSafetyPolicy: { schemaVersion: 1, mode: "not_requested" }`. Native model sound remains supported; speech transcription and audio-content moderation are temporarily not requested, and no external ASR/audio moderation call is made. Historical snapshots with missing or `required` audio policy keep that original requirement: if an actual audio track exists, fulfillment holds them for review instead of silently downgrading or fabricating audio approval. Historical Sightengine visual profiles remain readable audit facts, but executable Sightengine clients are retired; those jobs also remain on hold instead of draining through the retired provider.

## Verification and external limits

The local adapter suite exercises request parameters, authoritative retrieval, 2–30-second sample counts, policy blocks, optional categories, category REVIEW, count/verdict/timestamp consistency, redirects, bounded responses, malformed responses, and single-attempt uncertain submissions. The synthetic sampled reports are test data, not real outputs. The official illustrative one-frame response is preserved without inflation and intentionally fails the application's minimum complete-sample requirement.

Adapter validation on 2026-10-04:

- Final combined check after removing retired Sightengine executable files and the unused audio ASR module: `pnpm --filter @repo/ai test media/moderation/moderation.contract.test.ts media/moderation/video-configured.test.ts media/moderation/seeapi-video.test.ts media/moderation/seeapi-video-webhook.test.ts`: **157/157 PASS** (11 public factory, 12 video composition, 85 SeeAPI video, 49 raw-byte signature).
- `pnpm --filter @repo/ai test media/moderation/video-configured.test.ts media/moderation/seeapi-video.test.ts`: **97/97 PASS** (12 SeeAPI-only composition, 85 adapter). Includes retired-provider isolation, frozen-profile tampering, actual-duration drift without resampling, callback URL validation, and terminal failure/cancellation without retry.
- `pnpm --filter @repo/ai test media/moderation/seeapi-video-webhook.test.ts`: **49/49 PASS**. Includes signature mutation, time-window boundaries, key rotation, BOM and byte-offset handling.
- `pnpm --filter @repo/config test video-safety.test.ts`: **15/15 PASS**. New admissions accept SeeAPI only while retaining frozen historical profiles.
- `pnpm --filter @repo/ai type-check`: **PASS**.
- Scoped Oxfmt and Oxlint `--deny-warnings` for the adapter and test: **PASS**.
- Independent read-only contract and final adapter review: no remaining concrete findings. This review did not run paid calls or repeat external acceptance.

Live SeeAPI task acceptance, actual sampling distribution, account permission, pricing/billing confirmation and production execution: **NOT_RUN / BLOCKED until authorized external acceptance**. No migration, deployment or production flag change is performed by this adapter work.
