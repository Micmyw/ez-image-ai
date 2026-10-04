# Video V1 changed-file audit

Historical implementation snapshot. For the final GitHub review branch, use the
[review inventory](video-v1-review-files.md) and [review guide](video-v1-github-review.md).
The empty-index and file-count statements below apply only to the recorded source snapshot.

Snapshot: 2026-10-03T17:57:20.478Z; branch `main`; HEAD `569bf39eea9dcf072d3c5e5f79d58cd38d6bb466`.
HEAD is unchanged from the recorded implementation baseline. This is a working-tree delivery manifest, not a commit, push, deployment or production acceptance record.

## Method and scope

- Compared `.cache/video-v1/initial-status.txt` and `.cache/video-v1/initial-hashes.json` with the current porcelain status and SHA-256 file contents. The initial hash file records initially dirty/untracked paths, not every tracked file. Initially clean tracked changes are identified against the unchanged HEAD.
- Matched changed paths to the implementation map and the admission, data, provider, submission, fulfillment, legacy-jobs, workflow and UI owner reports in `.cache/video-v1/`. A whole HEAD diff is not treated as this batch: most visible image/composer/Effects/Blog changes predate this work.
- Excluded `.cache`, `output`, dependencies, build/generated directories, Prisma-generated Zod, test reports, `.tsbuildinfo`, and `docs/product/evidence` artifacts from source counts. Product source assets remain eligible. Generated schema output is documented separately below.
- Initial-to-current hashes show content equality or change, not authorship of every changed line. The 2 unattributed files and mixed changelog sections below are retained and excluded from exclusive Video ownership. The reviewed path allowlist is saved in `.cache/video-v1/audit-known-video-paths.json`; any additional path observed on a later run defaults to unattributed.
- Full machine-readable hashes and status evidence: `.cache/video-v1/changed-files-audit.json`; repeatable read-only capture plus this document writer: `.cache/video-v1/audit-changed-files.cjs`. This snapshot does not cover edits after 2026-10-03T17:57:20.478Z.

## Baseline preservation and index

- Initial snapshot entries: **10317**; source entries after exclusions: **147**.
- Initial source hashes unchanged: **131**; changed: **16**; missing: **0**; source entries without an initial hash: **0**.
- Known Video paths in this manifest: **191** (**14** initially dirty overlays, **83** initially clean tracked edits, **94** new files, including this audit).
- Initial status contained **0** staged entries; current `git diff --cached --name-status` is **empty**. The index is unchanged at these two checkpoints.
- `initial-index.patch` is absent. Empty initial staged status and empty current cached diff are the actual evidence; no claim is made that a staged patch snapshot exists or that every intermediate index state was monitored.
- No source file was deleted, restored, staged or committed by this audit. Existing untracked source files remain present.

## Initially dirty files further modified for Video V1

Each listed path already had user work before this batch. Only the Video additions/edits belong to this task. Hashes are 16-character SHA-256 prefixes; full values are in the JSON evidence.

| Path                                                                            | Initial hash       | Snapshot hash      | Attribution                                                                              |
| ------------------------------------------------------------------------------- | ------------------ | ------------------ | ---------------------------------------------------------------------------------------- |
| `apps/saas/app/sitemap.test.ts`                                                 | `09697b8d44f72bcb` | `c47b0d42477d61f7` | Account UI and routing                                                                   |
| `apps/saas/content/changelog/releases.ts`                                       | `3edd5a90bc7a2815` | `b13dd251e727d882` | Video beta entry confirmed; concurrent dark-theme wording is not attributed to this task |
| `apps/saas/modules/shared/components/studio/HeaderNavigationMenu.tsx`           | `aed7feebb5501381` | `047a4fe6267c4230` | Account UI and routing                                                                   |
| `apps/saas/modules/shared/components/studio/StudioShell.tsx`                    | `d1681b86bc3df795` | `0f909f6cfc10f10e` | Account UI and routing                                                                   |
| `apps/saas/proxy.test.ts`                                                       | `df2e8f193fb26ef6` | `d44fd61eb37d4576` | Account UI and routing                                                                   |
| `apps/saas/proxy.ts`                                                            | `3eeb0398d3c2a383` | `7d8318d065ac50b9` | Account UI and routing                                                                   |
| `apps/saas/tests/media-generation.spec.ts`                                      | `8594726b9a416169` | `70a58d7845202afb` | Account UI and routing                                                                   |
| `CHANGELOG.md`                                                                  | `e12a01304e910622` | `84f10eef3a44a0b5` | Video beta entry confirmed; concurrent dark-theme wording is not attributed to this task |
| `packages/i18n/translations/de/saas.json`                                       | `274dd4e0fe605d13` | `f7810c39c774bafa` | Account UI and routing                                                                   |
| `packages/i18n/translations/en/saas.json`                                       | `cdfb761f0ab8c459` | `6cee742ad69bdc89` | Account UI and routing                                                                   |
| `packages/i18n/translations/es/saas.json`                                       | `e7e415d91383451b` | `f64e7ca9f597966e` | Account UI and routing                                                                   |
| `packages/i18n/translations/fr/saas.json`                                       | `e76a08034d3a64ad` | `44204c9cc7cd7601` | Account UI and routing                                                                   |
| `packages/jobs/src/handlers/finalization-transfer.database.integration.test.ts` | `9f6897af837ef19c` | `6c6e43962ce6eb7a` | Video domain and legacy fencing                                                          |
| `packages/jobs/src/runtime.ts`                                                  | `8d64e06c8ba73f25` | `c16c7cd3382d516c` | Video domain and legacy fencing                                                          |

## Other Video implementation files

`NEW` means absent from the initial status/hash snapshot and currently untracked. `MODIFIED` means initially clean tracked source changed during the batch. Attribution follows the recorded owner reports and actual Video-related diffs.

### API and private content

| State    | Path                                                                               |
| -------- | ---------------------------------------------------------------------------------- |
| MODIFIED | `packages/api/index.ts`                                                            |
| MODIFIED | `packages/api/modules/media/guest-capability.database.integration.test.ts`         |
| MODIFIED | `packages/api/modules/media/lib/dispatch-created-job.database.integration.test.ts` |
| MODIFIED | `packages/api/modules/media/procedures/cancel-generation.ts`                       |
| MODIFIED | `packages/api/modules/media/procedures/complete-upload-session.ts`                 |
| MODIFIED | `packages/api/modules/media/procedures/get-job.test.ts`                            |
| MODIFIED | `packages/api/modules/media/procedures/list-jobs.ts`                               |
| MODIFIED | `packages/api/modules/media/procedures/retry-generation.ts`                        |
| MODIFIED | `packages/api/modules/payments/billing-prelaunch.integration.test.ts`              |
| MODIFIED | `packages/api/modules/payments/credit-pack-lifecycle.integration.test.ts`          |
| MODIFIED | `packages/api/modules/payments/payments.integration.test.ts`                       |
| MODIFIED | `packages/api/modules/payments/waffo-provider-lifecycle.integration.test.ts`       |
| NEW      | `packages/api/modules/video-v1/log-redaction.ts`                                   |
| NEW      | `packages/api/modules/video-v1/playback-http.test.ts`                              |
| NEW      | `packages/api/modules/video-v1/playback-policy.ts`                                 |
| NEW      | `packages/api/modules/video-v1/playback.test.ts`                                   |
| NEW      | `packages/api/modules/video-v1/playback.ts`                                        |
| NEW      | `packages/api/modules/video-v1/router.ts`                                          |
| NEW      | `packages/api/modules/video-v1/uploads.test.ts`                                    |
| NEW      | `packages/api/modules/video-v1/uploads.ts`                                         |
| MODIFIED | `packages/api/orpc/router.ts`                                                      |

### Account UI and routing

| State    | Path                                                                    |
| -------- | ----------------------------------------------------------------------- |
| NEW      | `apps/saas/app/(authenticated)/(main)/(account)/video/history/page.tsx` |
| NEW      | `apps/saas/app/(authenticated)/(main)/(account)/video/layout.tsx`       |
| NEW      | `apps/saas/app/(authenticated)/(main)/(account)/video/page.tsx`         |
| MODIFIED | `apps/saas/app/layout.tsx`                                              |
| MODIFIED | `apps/saas/modules/shared/components/AppWrapper.tsx`                    |
| NEW      | `apps/saas/modules/video-v1/api.ts`                                     |
| NEW      | `apps/saas/modules/video-v1/messages.test.ts`                           |
| NEW      | `apps/saas/modules/video-v1/model.test.ts`                              |
| NEW      | `apps/saas/modules/video-v1/model.ts`                                   |
| NEW      | `apps/saas/modules/video-v1/playwright.config.ts`                       |
| NEW      | `apps/saas/modules/video-v1/render.test.tsx`                            |
| NEW      | `apps/saas/modules/video-v1/use-video-upload.ts`                        |
| NEW      | `apps/saas/modules/video-v1/use-video.ts`                               |
| NEW      | `apps/saas/modules/video-v1/video-v1.e2e.ts`                            |
| NEW      | `apps/saas/modules/video-v1/VideoHistory.tsx`                           |
| NEW      | `apps/saas/modules/video-v1/VideoJob.tsx`                               |
| NEW      | `apps/saas/modules/video-v1/VideoNavigationLink.tsx`                    |
| NEW      | `apps/saas/modules/video-v1/VideoWorkspace.tsx`                         |
| NEW      | `apps/saas/modules/video-v1/vitest.config.ts`                           |
| MODIFIED | `apps/saas/package.json`                                                |
| MODIFIED | `apps/saas/tests/checkout-review.spec.ts`                               |
| MODIFIED | `apps/saas/tests/subscription-upgrade.spec.ts`                          |
| MODIFIED | `packages/auth/config.ts`                                               |
| MODIFIED | `packages/auth/lib/organization-slug.test.ts`                           |

### Checks and workspace dependencies

| State    | Path                                           |
| -------- | ---------------------------------------------- |
| MODIFIED | `package.json`                                 |
| MODIFIED | `pnpm-lock.yaml`                               |
| MODIFIED | `tests/load/run-integration.ts`                |
| MODIFIED | `tests/load/verify-invariants.ts`              |
| NEW      | `tests/load/video-verification-target.test.ts` |
| NEW      | `tests/load/video-verification-target.ts`      |
| NEW      | `tests/video-v1/local-command.mjs`             |
| NEW      | `tests/video-v1/no-paid-network.mjs`           |
| NEW      | `tests/video-v1/run.ts`                        |
| MODIFIED | `tooling/e2e/src/run.ts`                       |

### Database and engine isolation

| State    | Path                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------- |
| MODIFIED | `packages/database/package.json`                                                                |
| NEW      | `packages/database/prisma/migrations/20261004000000_video_generation_v1/migration.sql`          |
| NEW      | `packages/database/prisma/migrations/20261004010000_video_quote_pending_evidence/migration.sql` |
| NEW      | `packages/database/prisma/migrations/20261004020000_video_resource_recovery/migration.sql`      |
| MODIFIED | `packages/database/prisma/queries/media/admin-growth-operations.integration.test.ts`            |
| MODIFIED | `packages/database/prisma/queries/media/admin-operations.ts`                                    |
| MODIFIED | `packages/database/prisma/queries/media/assets-read-authorization.test.ts`                      |
| MODIFIED | `packages/database/prisma/queries/media/assets-transactions.test.ts`                            |
| MODIFIED | `packages/database/prisma/queries/media/assets.ts`                                              |
| MODIFIED | `packages/database/prisma/queries/media/attempts.ts`                                            |
| MODIFIED | `packages/database/prisma/queries/media/edit-session-queries.integration.test.ts`               |
| MODIFIED | `packages/database/prisma/queries/media/edit-sessions-migration.integration.test.ts`            |
| MODIFIED | `packages/database/prisma/queries/media/edit-sessions.integration.test.ts`                      |
| MODIFIED | `packages/database/prisma/queries/media/effective-subscription.integration.test.ts`             |
| MODIFIED | `packages/database/prisma/queries/media/index.ts`                                               |
| MODIFIED | `packages/database/prisma/queries/media/job-status.integration.test.ts`                         |
| MODIFIED | `packages/database/prisma/queries/media/job-status.ts`                                          |
| MODIFIED | `packages/database/prisma/queries/media/jobs.ts`                                                |
| MODIFIED | `packages/database/prisma/queries/media/kie-callback.ts`                                        |
| MODIFIED | `packages/database/prisma/queries/media/moderation-admin-requeue.integration.test.ts`           |
| MODIFIED | `packages/database/prisma/queries/media/moderation-operations.ts`                               |
| MODIFIED | `packages/database/prisma/queries/media/moderation-outage.integration.test.ts`                  |
| MODIFIED | `packages/database/prisma/queries/media/moderation-recovery.database.integration.test.ts`       |
| MODIFIED | `packages/database/prisma/queries/media/moderation.database.integration.test.ts`                |
| MODIFIED | `packages/database/prisma/queries/media/payment-environment.integration.test.ts`                |
| MODIFIED | `packages/database/prisma/queries/media/subscription-checkout.integration.test.ts`              |
| NEW      | `packages/database/prisma/queries/media/video-v1-cleanup.integration.test.ts`                   |
| NEW      | `packages/database/prisma/queries/media/video-v1-cleanup.ts`                                    |
| NEW      | `packages/database/prisma/queries/media/video-v1-execution.integration.test.ts`                 |
| NEW      | `packages/database/prisma/queries/media/video-v1-execution.ts`                                  |
| NEW      | `packages/database/prisma/queries/media/video-v1-fulfillment.integration.test.ts`               |
| NEW      | `packages/database/prisma/queries/media/video-v1-fulfillment.ts`                                |
| NEW      | `packages/database/prisma/queries/media/video-v1-isolation.integration.test.ts`                 |
| NEW      | `packages/database/prisma/queries/media/video-v1-moderation-events.integration.test.ts`         |
| NEW      | `packages/database/prisma/queries/media/video-v1-moderation-events.ts`                          |
| NEW      | `packages/database/prisma/queries/media/video-v1-recovery.ts`                                   |
| NEW      | `packages/database/prisma/queries/media/video-v1-uploads.ts`                                    |
| NEW      | `packages/database/prisma/queries/media/video-v1.integration.test.ts`                           |
| NEW      | `packages/database/prisma/queries/media/video-v1.ts`                                            |
| MODIFIED | `packages/database/prisma/queries/media/webhooks.ts`                                            |
| MODIFIED | `packages/database/prisma/schema.prisma`                                                        |

### Documentation

| State | Path                                                         |
| ----- | ------------------------------------------------------------ |
| NEW   | `apps/saas/content/docs/video-beta.mdx`                      |
| NEW   | `docs/implementation/video-v1-changed-files.md`              |
| NEW   | `docs/implementation/video-v1-file-map.md`                   |
| NEW   | `docs/operations/evidence/video-v1/performance-summary.json` |
| NEW   | `docs/operations/evidence/video-v1/task-stage-timings.csv`   |
| NEW   | `docs/operations/video-v1-configuration.example.env`         |
| NEW   | `docs/operations/video-v1-rollout.md`                        |
| NEW   | `docs/operations/video-v1-verification.md`                   |

### Private storage and inspection

| State    | Path                                                                 |
| -------- | -------------------------------------------------------------------- |
| MODIFIED | `packages/storage/image-processing/cloudflare-images.ts`             |
| MODIFIED | `packages/storage/image-processing/sharp.ts`                         |
| MODIFIED | `packages/storage/image-processing/types.ts`                         |
| MODIFIED | `packages/storage/index.ts`                                          |
| MODIFIED | `packages/storage/lib/stream-copy.ts`                                |
| NEW      | `packages/storage/lib/video-mp4.test.ts`                             |
| NEW      | `packages/storage/lib/video-mp4.ts`                                  |
| MODIFIED | `packages/storage/provider/s3/index.ts`                              |
| NEW      | `packages/storage/provider/s3/video-input.minio.integration.test.ts` |
| NEW      | `packages/storage/test-support/video-fixture.ts`                     |

### Provider and configuration

| State    | Path                                                            |
| -------- | --------------------------------------------------------------- |
| NEW      | `packages/ai/media/catalog/fixtures/kie-video-v1-contract.json` |
| MODIFIED | `packages/ai/media/moderation/index.ts`                         |
| MODIFIED | `packages/ai/media/moderation/seeapi.ts`                        |
| MODIFIED | `packages/ai/media/moderation/types.ts`                         |
| NEW      | `packages/ai/media/moderation/video-configured.test.ts`         |
| NEW      | `packages/ai/media/moderation/video-configured.ts`              |
| MODIFIED | `packages/ai/media/providers/index.ts`                          |
| NEW      | `packages/ai/media/providers/kie-video-v1.test.ts`              |
| NEW      | `packages/ai/media/providers/kie-video-v1.ts`                   |
| MODIFIED | `packages/config/package.json`                                  |
| NEW      | `packages/config/video-v1.test.ts`                              |
| NEW      | `packages/config/video-v1.ts`                                   |

### Video domain and legacy fencing

| State    | Path                                                                                     |
| -------- | ---------------------------------------------------------------------------------------- |
| MODIFIED | `packages/jobs/package.json`                                                             |
| MODIFIED | `packages/jobs/src/handlers/finalization-recovery-store.ts`                              |
| MODIFIED | `packages/jobs/src/handlers/jobs.database.integration.test.ts`                           |
| NEW      | `packages/jobs/src/handlers/legacy-engine-isolation.database.integration.test.ts`        |
| MODIFIED | `packages/jobs/src/handlers/moderation-outage.database.integration.test.ts`              |
| MODIFIED | `packages/jobs/src/handlers/output-mime-runtime.test.ts`                                 |
| MODIFIED | `packages/jobs/src/handlers/recover-finalizing-generations.database.integration.test.ts` |
| MODIFIED | `packages/jobs/src/handlers/runtime-stores.database.integration.test.ts`                 |
| MODIFIED | `packages/jobs/src/handlers/verify-upload.database.integration.test.ts`                  |
| MODIFIED | `packages/jobs/src/orchestration/executor.test.ts`                                       |
| MODIFIED | `packages/jobs/src/orchestration/executor.ts`                                            |
| NEW      | `packages/jobs/src/orchestration/legacy-task-ownership.ts`                               |
| MODIFIED | `packages/jobs/src/orchestration/verification-recovery.ts`                               |
| NEW      | `packages/jobs/src/video-v1/admission.test.ts`                                           |
| NEW      | `packages/jobs/src/video-v1/admission.ts`                                                |
| NEW      | `packages/jobs/src/video-v1/cleanup.test.ts`                                             |
| NEW      | `packages/jobs/src/video-v1/cleanup.ts`                                                  |
| NEW      | `packages/jobs/src/video-v1/contracts.ts`                                                |
| NEW      | `packages/jobs/src/video-v1/flow.database.integration.test.ts`                           |
| NEW      | `packages/jobs/src/video-v1/fulfillment.test.ts`                                         |
| NEW      | `packages/jobs/src/video-v1/fulfillment.ts`                                              |
| NEW      | `packages/jobs/src/video-v1/moderation-webhooks.test.ts`                                 |
| NEW      | `packages/jobs/src/video-v1/moderation-webhooks.ts`                                      |
| NEW      | `packages/jobs/src/video-v1/output-storage.test.ts`                                      |
| NEW      | `packages/jobs/src/video-v1/output-storage.ts`                                           |
| NEW      | `packages/jobs/src/video-v1/recovery.test.ts`                                            |
| NEW      | `packages/jobs/src/video-v1/recovery.ts`                                                 |
| NEW      | `packages/jobs/src/video-v1/submission.test.ts`                                          |
| NEW      | `packages/jobs/src/video-v1/submission.ts`                                               |
| NEW      | `packages/jobs/src/video-v1/telemetry.test.ts`                                           |
| NEW      | `packages/jobs/src/video-v1/telemetry.ts`                                                |
| NEW      | `packages/jobs/src/video-v1/webhooks.test.ts`                                            |
| NEW      | `packages/jobs/src/video-v1/webhooks.ts`                                                 |
| NEW      | `packages/jobs/src/video-v1/workflow-binding.ts`                                         |

### Workflow and hosting

| State    | Path                                                     |
| -------- | -------------------------------------------------------- |
| MODIFIED | `apps/saas/cloudflare-worker.ts`                         |
| MODIFIED | `apps/saas/wrangler.jsonc`                               |
| MODIFIED | `apps/web-host/src/profiles.test.ts`                     |
| MODIFIED | `apps/web-host/src/profiles.ts`                          |
| MODIFIED | `apps/workflows/package.json`                            |
| MODIFIED | `apps/workflows/src/index.ts`                            |
| NEW      | `apps/workflows/src/video-generation-v1.ts`              |
| NEW      | `apps/workflows/src/video-generation-v1.workerd.test.ts` |
| NEW      | `apps/workflows/src/video-orchestrator.test.ts`          |
| NEW      | `apps/workflows/src/video-orchestrator.ts`               |
| NEW      | `apps/workflows/src/video-runtime.ts`                    |
| MODIFIED | `apps/workflows/src/workers.ts`                          |
| MODIFIED | `apps/workflows/test-support/artifact-workerd-smoke.mjs` |
| MODIFIED | `apps/workflows/vitest.config.ts`                        |
| MODIFIED | `apps/workflows/wrangler.jsonc`                          |
| NEW      | `apps/workflows/wrangler.video.test.jsonc`               |
| MODIFIED | `apps/workflows/wrangler.workers.jsonc`                  |

## Generated companions excluded from source counts

- `packages/database/prisma/zod/index.ts` was regenerated from the Prisma schema (owner-reported, not hand-edited). Ignored Node/workerd Prisma clients were also regenerated. These are generated companions to the three SQL migrations, not additional authored source changes.

## Parallel changes outside Video ownership

| Path                                                        | Initial hash       | Snapshot hash      | Treatment                                                                                                                                |
| ----------------------------------------------------------- | ------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/saas/modules/media/components/editor/PromptIdeas.tsx` | `60b3cf1f832f9ac3` | `e65dca03ff691e4e` | Already dirty/untracked initially; changed during shared work; exact author/task not proven; preserved and excluded from Video ownership |
| `docs/product/editor-layout.md`                             | `d58fded2fd9d396d` | `dd9718d04f953013` | Already dirty/untracked initially; changed during shared work; exact author/task not proven; preserved and excluded from Video ownership |

The prompt-idea dark-theme sentences under the existing composer category entries in `CHANGELOG.md` and `apps/saas/content/changelog/releases.ts` are also absent from the initial working patch. Those mixed-file deltas are not claimed as Video implementation. Their Video beta entries are explicitly identified above.

## Initially dirty source preserved byte-for-byte

These **131** paths still match their initial SHA-256. Their HEAD differences are preexisting work and are not part of this Video batch.

- `apps/saas/app/(guest)/try/page.tsx`
- `apps/saas/app/(public)/blog/[...path]/page.tsx`
- `apps/saas/app/(public)/blog/page.tsx`
- `apps/saas/app/(public)/effects-preview/[slug]/page.tsx`
- `apps/saas/app/(public)/effects/[slug]/page.tsx`
- `apps/saas/app/(public)/effects/page.tsx`
- `apps/saas/app/docs/[[...slug]]/page.tsx`
- `apps/saas/app/docs/docs.css`
- `apps/saas/app/docs/layout.tsx`
- `apps/saas/app/draft/continue/route.test.ts`
- `apps/saas/app/draft/continue/route.ts`
- `apps/saas/app/effects-directory.test.tsx`
- `apps/saas/app/effects-routes.test.tsx`
- `apps/saas/app/public-routes.test.tsx`
- `apps/saas/app/sitemap.ts`
- `apps/saas/content/docs/credits.mdx`
- `apps/saas/content/docs/image-editing.mdx`
- `apps/saas/content/docs/index.mdx`
- `apps/saas/content/docs/privacy.mdx`
- `apps/saas/content/docs/quick-start.mdx`
- `apps/saas/content/effects/1980s-ai-photo.ts`
- `apps/saas/content/effects/index.ts`
- `apps/saas/content/posts/ai-image-editing-prompts.ts`
- `apps/saas/content/posts/private-image-editing-workflow.ts`
- `apps/saas/modules/docs/components/DocsHeader.tsx`
- `apps/saas/modules/docs/components/LLMCopyButton.tsx`
- `apps/saas/modules/effects/components/EffectAnalytics.tsx`
- `apps/saas/modules/effects/components/EffectCard.tsx`
- `apps/saas/modules/effects/components/EffectControls.tsx`
- `apps/saas/modules/effects/components/EffectDetailPage.tsx`
- `apps/saas/modules/effects/components/EffectEditorProvider.tsx`
- `apps/saas/modules/effects/components/EffectExample.tsx`
- `apps/saas/modules/effects/components/EffectPresentation.test.tsx`
- `apps/saas/modules/effects/components/EffectPresetCard.tsx`
- `apps/saas/modules/effects/components/EffectRecommendations.tsx`
- `apps/saas/modules/effects/components/EffectsDirectory.tsx`
- `apps/saas/modules/effects/effects.css`
- `apps/saas/modules/effects/lib/analytics.test.ts`
- `apps/saas/modules/effects/lib/analytics.ts`
- `apps/saas/modules/effects/lib/content.test.ts`
- `apps/saas/modules/effects/lib/content.ts`
- `apps/saas/modules/effects/lib/editor-context.tsx`
- `apps/saas/modules/effects/lib/editor-guest-draft.test.ts`
- `apps/saas/modules/effects/lib/editor-guest-draft.ts`
- `apps/saas/modules/effects/lib/editor-return.server.test.ts`
- `apps/saas/modules/effects/lib/editor-return.server.ts`
- `apps/saas/modules/effects/lib/editor-return.ts`
- `apps/saas/modules/effects/lib/editor-selection.test.ts`
- `apps/saas/modules/effects/lib/editor-selection.ts`
- `apps/saas/modules/effects/lib/types.ts`
- `apps/saas/modules/effects/lib/validation.ts`
- `apps/saas/modules/landing/components/image-to-image.css`
- `apps/saas/modules/landing/components/ImageToImagePage.tsx`
- `apps/saas/modules/landing/components/LandingGenerator.tsx`
- `apps/saas/modules/landing/components/LandingPage.hero.test.tsx`
- `apps/saas/modules/landing/components/LandingPage.tsx`
- `apps/saas/modules/landing/lib/guest-draft-client.ts`
- `apps/saas/modules/media/components/editor/ComposerHeader.tsx`
- `apps/saas/modules/media/components/editor/EditorResultPanel.tsx`
- `apps/saas/modules/media/components/editor/generation-composer.css`
- `apps/saas/modules/media/components/editor/ImageEditorWorkspace.test.tsx`
- `apps/saas/modules/media/components/editor/ImageEditorWorkspace.tsx`
- `apps/saas/modules/media/components/editor/ImageSourcePanel.tsx`
- `apps/saas/modules/media/components/editor/PromptPanel.tsx`
- `apps/saas/modules/media/components/editor/SuggestedPrompts.tsx`
- `apps/saas/modules/media/components/GenerationForm.test.tsx`
- `apps/saas/modules/media/components/GenerationForm.tsx`
- `apps/saas/modules/media/components/guest/GuestTrialWorkspace.tsx`
- `apps/saas/modules/media/components/ImageOutputSettings.test.tsx`
- `apps/saas/modules/media/components/ImageOutputSettings.tsx`
- `apps/saas/modules/media/components/MediaUploader.tsx`
- `apps/saas/modules/media/hooks/use-generation-submit.test.ts`
- `apps/saas/modules/media/hooks/use-generation.ts`
- `apps/saas/modules/media/hooks/use-guest-trial.test.ts`
- `apps/saas/modules/media/hooks/use-guest-trial.ts`
- `apps/saas/modules/media/lib/draft-handoff.test.ts`
- `apps/saas/modules/media/lib/draft-handoff.ts`
- `apps/saas/modules/models/components/ModelPage.tsx`
- `apps/saas/modules/payments/lib/editor-upgrade.test.ts`
- `apps/saas/modules/payments/lib/editor-upgrade.ts`
- `apps/saas/modules/public-content/components/blog.css`
- `apps/saas/modules/public-content/components/BlogAnalytics.tsx`
- `apps/saas/modules/public-content/components/BlogCard.tsx`
- `apps/saas/modules/public-content/components/BlogDirectory.test.tsx`
- `apps/saas/modules/public-content/components/BlogDirectory.tsx`
- `apps/saas/modules/public-content/components/BlogEffectFeature.tsx`
- `apps/saas/modules/public-content/components/BlogPresetPrompt.tsx`
- `apps/saas/modules/public-content/components/BlogPrompt.tsx`
- `apps/saas/modules/public-content/components/BlogVisual.server.ts`
- `apps/saas/modules/public-content/components/BlogVisual.test.ts`
- `apps/saas/modules/public-content/components/ContentToc.tsx`
- `apps/saas/modules/public-content/components/EffectCallout.tsx`
- `apps/saas/modules/public-content/components/PromptBlock.tsx`
- `apps/saas/modules/public-content/components/PublicFooterLinks.tsx`
- `apps/saas/modules/public-content/components/PublicMarkdown.test.tsx`
- `apps/saas/modules/public-content/components/PublicMarkdown.tsx`
- `apps/saas/modules/public-content/components/PublicPageShell.tsx`
- `apps/saas/modules/public-content/lib/blog-content.test.ts`
- `apps/saas/modules/public-content/lib/blog-markdown.ts`
- `apps/saas/modules/public-content/lib/blog-presentation.ts`
- `apps/saas/modules/public-content/lib/blog-types.ts`
- `apps/saas/modules/public-content/lib/blog-validation.ts`
- `apps/saas/modules/public-content/lib/content.ts`
- `apps/saas/modules/public-content/lib/pagination.test.ts`
- `apps/saas/modules/public-content/lib/pagination.ts`
- `apps/saas/modules/shared/components/studio/StudioToolNavigation.tsx`
- `apps/saas/modules/shared/lib/growth-analytics.test.ts`
- `apps/saas/public/images/effects/1980s-ai-photo/family-snapshot-v3.webp`
- `apps/saas/public/images/effects/1980s-ai-photo/input-adult-v1.webp`
- `apps/saas/public/images/effects/1980s-ai-photo/street-portrait-v2.webp`
- `apps/saas/public/images/effects/1980s-ai-photo/studio-portrait-v2.webp`
- `apps/saas/test-support/server-only.ts`
- `apps/saas/tests/1980s-content.public-routes.spec.ts`
- `apps/saas/tests/docs.spec.ts`
- `apps/saas/tests/effects.public-routes.spec.ts`
- `apps/saas/tests/guest-trial.spec.ts`
- `apps/saas/tests/helpers/effects-admin.ts`
- `apps/saas/tests/helpers/effects-content.ts`
- `apps/saas/vitest.config.ts`
- `docs/plans/2026-09-29-effects-and-guides.md`
- `docs/product/1980s-ai-photo-validation.md`
- `docs/product/editor-layout-restoration.md`
- `docs/product/effects-and-guides-verification.md`
- `docs/product/effects-and-guides.md`
- `packages/api/modules/media/procedures/complete-guest-link-intent.test.ts`
- `packages/api/modules/media/procedures/complete-guest-link-intent.ts`
- `packages/i18n/translations/de/marketing.json`
- `packages/i18n/translations/en/marketing.json`
- `packages/i18n/translations/es/marketing.json`
- `packages/i18n/translations/fr/marketing.json`
- `packages/utils/lib/growth-analytics.ts`
