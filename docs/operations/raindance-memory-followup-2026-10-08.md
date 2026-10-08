# Raindance memory follow-up and real-test preflight

Follow-up to `420eb4df`, on the isolated `codex/hotel-raindance-remediation` branch. No push, deployment, production load test, account change or paid provider call is part of this patch.

## Incident evidence and limits

Cloudflare read-only telemetry reconfirmed the exact reported Ray on Worker version `4aa80d15-c36b-45b4-bffa-c891b56c2b95` (Git build `1e09de497839c2c816313e72489c38660f4df200`):

| UTC          | Request                                                 | Result                                                                                | CPU / wall                        |
| ------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------- |
| 12:30:27.177 | Raindance Ray `a475282bdd5ffac2`                        | Three retained `Worker exceeded memory limit.` exception records, no allocation stack | Not supplied on exception records |
| 12:30:30.451 | `GET /blog/raindance-ai-trend`, same Ray                | HTTP 503, `exceededMemory`                                                            | 3321 / 3886 ms                    |
| 12:30:31.066 | `POST /api/rpc/videoV1/catalog`, Ray `a475283ca89bfac2` | HTTP 503, `exceededMemory`                                                            | 0 / 1189 ms                       |

The catalog invocation used POST at the RPC transport boundary; its documented OpenAPI route uses GET. A nearby account-credit read succeeded. No per-request heap, allocation stack or isolate identifier was returned. The shared website Worker runs both routes, but the records do not prove these requests used the same isolate or identify which allocation exhausted it. The zero-CPU catalog failure is not evidence that its pricing calculation itself caused this incident.

The SSR path uses the shared outer Worker, lazy database scope, root providers, StudioShell and effect workbench. The database wrapper is already lazy in the incident version. After session hydration, StudioShell's video navigation used the complete catalog even on an effect/article page. It also refreshed that table every 30 seconds while visible. This is a separately reproducible source of unnecessary work that can overlap SSR and other API activity. The existing public-session optimization is left intact.

Cloudflare's [memory limit](https://developers.cloudflare.com/workers/platform/limits/#memory) applies to the whole isolate, including JS and WASM, and concurrent requests can share it. Its [profiling guide](https://developers.cloudflare.com/workers/observability/dev-tools/memory-usage/) recommends local snapshots with representative traffic. This patch does not increase limits or certify resolution of the original OOM.

## Bounded fix

The navigation now calls an authenticated `videoV1.availability` read. It shares the catalog's access, model-disable and owner-specific eligibility reads. It returns availability and qualification expiry, and stops pricing once one usable option is found. The exact existing price resolver still enforces approval, expiry, audience and cost policy. The generator retains its full catalog; no price/output contract changes.

The client uses a separate owner-scoped cache, keeps the 30-second visible-page refresh and known-expiry refresh, responds to payment invalidation, disables visitor/anonymous queries and does not retry. No catalog data is shared between owners. A first failure without usable cached data hides the navigation entry. A background refresh failure keeps the previous cached availability; a successful unavailable response hides the entry. This preserves the existing navigation behavior, and there is no fallback to the full table.

## Local measurement

The isolated Node helper benchmark used only explicit fixtures, no database or provider calls. Five serial samples of the full table produced 17 models, 1,188 priced options and 367,524 JSON bytes. The identical fixture's navigation result was `{ "available": true }` (18 bytes, excluding RPC framing and the endpoint's qualification-expiry field).

| Helper                  | Five-sample elapsed range | Heap-used delta after first call |
| ----------------------- | ------------------------- | -------------------------------- |
| Full catalog            | 9.87–16.99 ms             | 6,004,904 bytes                  |
| Navigation availability | 0.13–0.31 ms              | 48,432 bytes                     |

The full-table function was not changed. Heap deltas depend on GC; these are not peak-memory figures, a capacity estimate, or the deployed Workers heap. Node module loading was also inspected, but Node/tsx import memory is not presented as production Worker memory. No Next/OpenNext build ran alongside the other developer's build; historical local Worker artifacts were stale and were not used as this release's evidence.

Task-local scripts and raw measurements are in `D:/梅一伟/Documents/codex/2026-10-08/task-7/`: `memory-probe.mjs`, `catalog-workerd-probe.mjs`, and `evidence/memory-catalog-before.json`, `memory-catalog.json`. The workerd probe contains only the catalog helpers and synthetic configuration; it is explicitly separate from complete Next/RPC/auth/database profiling.

The local **workerd** probe completed at 15:24:07 UTC with five serial requests in each of two fresh runtimes. All ten returned HTTP 200 and the same availability decision. External service requests were hard-blocked; there were no database/provider bindings. `Runtime.getHeapUsage` measured the actual task-local V8 isolate before and after each request:

| workerd helper | Local dispatch + response read | First request JS heap delta | Response bytes |
| -------------- | ------------------------------ | --------------------------- | -------------- |
| Full catalog   | 15.56–23.36 ms                 | +1,057,372                  | 367,524        |
| Navigation     | 1.65–3.68 ms                   | +69,504                     | 18             |

This is a 600,773-byte helper bundle, not the deployed Next artifact. Timings include local dispatch/response reads, not just Worker CPU. No forced GC was used for these samples; later full-table deltas include automatic collection and can be negative. They do not measure peak memory or a leak. Both runtimes and their loopback inspectors were disposed. Evidence: `evidence/catalog-workerd-memory.json`. Earlier inspector harness attempts failed or were interrupted and are not counted as passing measurements.

Verification: 30 API tests (catalog equivalence/access/expiry/disabled models/annual audience and authenticated route behavior), 28 website tests (navigation refresh, owner isolation, guest disabling and existing StudioShell behavior), website and API TypeScript checks, scoped lint with warnings denied, formatting and `git diff --check` passed. Thirteen new server cases failed before the implementation, while the existing 17 catalog cases passed. No production build or live browser recheck of this unreleased endpoint is claimed.

The next memory investigation must profile the complete integrated release with representative SSR and authenticated navigation traffic in an isolated environment, including auth/API module initialization and Prisma/WASM allocations. `packages/api/index.ts` and its handler eagerly import the full router/auth/job graph; this remains a cold-start profiling candidate, not a proven allocation cause. The current patch reduces repeated work but does not resolve those imports or establish production memory headroom.

## Authorized adult materials found

The earlier report's missing-material blocker is superseded by this targeted repository search. Both selected images were visually inspected; neither is a competitor output, a downloaded real-person photograph, or a new generation in this task.

| Input order | File under `apps/saas/public`                                                  | Provenance                                                                                                                                                                                                                                             | SHA-256                                                            |
| ----------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Left, A     | `images/effects/1980s-ai-photo/input-adult-v1.webp` (1000×1250, 131,048 bytes) | `docs/product/evidence/1980s-ai-photo-2026-09-29.json`: user-authorized built-in image generation, fictional early-thirties adult woman, no real-person reference. Original artifact `exec-70958d8b-9c84-4dcf-821d-85a4566923a3.png`.                  | `87591984e7ff7bc665408716dcbd1136368773fa4d39ad1bf88565cf0c51fab4` |
| Right, B    | `images/models/nano-portrait.webp` (1024×1536, 130,166 bytes)                  | `docs/product/model-artwork.json`: original Codex/OpenAI image tool artwork; exact prompt names a fictional adult woman. Original artifact `exec-9f46165d-c807-46ff-958c-2d86d6ab1f68.png`, preserved from `94fa11299c145d5cfde0587a5af80cd05a84be02`. | `56ec9321df79a6cc1811fb8812b6921bbbe51f1913f316cbe68fb913beaa73e6` |

A has a gray shirt and frontal portrait; B has a blue coat/orange scarf and an over-shoulder pose. This supplies different identities and clothes to evaluate left/right mapping. Both are torso portraits, so a generated scene must invent unseen body detail; full-body preservation cannot be claimed. The model-gallery label does not make B a verified output of that named product model. Use as owned synthetic input only, not as a product result. Internal testing is the authorized use; this task does not publish source or output samples.

## Existing test-route audit

- `tests/load/provider-smoke.ts` configures only 20 image SKU cells. It rejects live image smoke before creating an adapter and has no allowed Seedance video route. Its test confirms that behavior.
- `.github/workflows/provider-smoke.yml` forces `PROVIDER_SMOKE_CONFIRM_LIVE=false` and supplies no paid-provider key. It is not a usable real video executor.
- `tests/video-v1/local-command.mjs` strips service credentials and loads `no-paid-network.mjs`. Integration/E2E fixtures use mock providers and disposable funding. Removing those guards would create a different tool; none were removed.
- Historical real video acceptance used the normal product flow with a separately approved, expiring operator-funded grant, not mocked production billing. That recorded grant expired on October 6.
- `requireVideoTemplateAdmission` in `packages/jobs/src/video-v1/template-admission.ts` accepts `HOTEL_LOBBY_DUO_INTERNAL_FUNDING` only for `hotel-lobby-duo`. It explicitly passes no internal funding for Raindance. `applyVideoInternalFunding` also requires an existing admin and `VIDEO_V1_ACCESS=internal`. Ordinary-video internal funding does not authorize either two-stage product by inheritance. Do not switch global access modes or extend this exception under the current task.

No existing authorized, budgeted, durable-attempt tool for “mock business billing plus real supplier calls” was found. No credential was extracted or copied to try a direct call. No account role, paid lot, membership, payment, funding configuration or test guard was changed.

The minimum operational unblock is to sign in through the normal product with an existing authorized test account holding qualifying paid credits. The last observed five-second quote was 69 credits each (138 for two); recheck exact current quotes before accepting. No purchase is authorized by this report. If such an account is unavailable, the user must separately authorize a narrowly scoped test-funding implementation or provide an already configured legitimate environment. Enabling a nonexistent mixed-mode smoke path is not an available operation.

## Planned two submissions, still not executed

Latest user direction remains **silent**, maximum two video attempts total, one Hotel and one Raindance, including failed/unknown outcomes. The durable task ledger still contains no attempts or task IDs: **0/2 video, 0 image, USD 0 known spend**.

The normal effect workflow is: sign in → ordered owned inputs A/B → normal upload/private storage and review → actual five-second quote → single accepted job → `nano-banana-2-lite`, 1K, 9:16 scene → review → `bytedance/seedance-1.5-pro`, image-to-video, 5 seconds, **720p**, 9:16, `generate_audio=false`, fixed lens → output review/storage/settlement. These are two complete two-stage jobs. No direct Kie shortcut, automatic retry, 10-second upgrade or 480p injection into the effect contract is allowed.

Known public supplier estimate: 2 × $0.020 scene + 2 × $0.0875 video = **$0.215**. Existing conservative image/output review budget adds **$0.0428**, giving **$0.2578** before any separately billed text review or account-specific settlement difference. Text review was previously approved at a temporary zero estimate, not verified as permanently free. Actual Kie balance and final provider/review fees must be checked through the legitimate execution route before submission. The total authorized cap remains $10 with no recharge.

A separate 480p5 silent experiment would be $0.1275 supplier / $0.1703 including the same review allowance, but no existing allowed complete-effect route supports it. It is not the execution plan for the 720p product and will not be silently substituted. Published price sources: [Kie Seedance 1.5 Pro](https://kie.ai/fr/seedance-1-5-pro), [Kie Nano Banana 2 Lite](https://kie.ai/nano-banana-2-lite).

No product sample or trend-quality pass is claimed. When unblocked, keep the original ledger, record intent before each call, and query the original task after uncertainty. Evaluate both identities, left/right placement, scene, action, five-second rhythm, silent-track contract and failures. No unused attempt authorizes a third video.
