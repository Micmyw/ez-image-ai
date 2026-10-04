# Hotel Lobby duo implementation

## Baseline and scope

The user authorized Task 0–6 implementation and local verification from the 2026-10-05
Hotel Lobby PRD. A later direct instruction authorizes committing and pushing the
completed feature branch. Paid calls, production migration, deployment, merge to
main and public activation remain outside this batch. The attachment is a requirements reference; its historical
release claims are not current acceptance evidence.

- Original checkout: `D:/AIProject/Gefei/SaaSTool/ez-image-ai`, local `main`,
  HEAD `569bf39eea9dcf072d3c5e5f79d58cd38d6bb466`.
- Original checkout had 218 modified tracked files and extensive untracked work.
  Its initial binary diff hash was `1185a232c6d08dc5021aa13aeb80d9e94dff835b`.
  No implementation was performed there.
- Fetched `origin/main`: `96f47c92d5d32bd20640e7029ab08f88a916c4f1`.
- App-managed worktree:
  `C:/Users/梅一伟/.codex/worktrees/hotel-lobby-duo/ez-image-ai`.
- Implementation branch: `codex/hotel-lobby-duo`; eventual intended incorporation
  target is `origin/main`, subject to separate merge/release authorization.
- The worktree is retained for review while unmerged; it must not be removed while
  it contains unmerged implementation work.

The latest multi-model pending-quote repair
`20261005000000_video_multimodel_quote_pending_evidence` is retained.
All 60 baseline migrations were applied to a new task-owned PostgreSQL 16 container
on loopback port 55439 before generating the additive sidecar migration.
Production migration status was not inferred from local execution.

The local CodeGraph command reported that this worktree has no usable index.
Targeted source reads were used; no index was created.

The original checkout was checked again after implementation: HEAD, all 218 tracked
modifications and binary diff hash match the initial record. No reset or overwrite
was performed. The complete changed-path inventory is in
`hotel-lobby-changed-files.txt`; the regression matrix is in `hotel-lobby-test-map.md`.

## Ownership and data boundaries

| Concern | Implementation boundary |
| --- | --- |
| Public template request and server-only mapping | `packages/config/video-effects.ts`, `video-effects.server.ts` |
| Complete cost and expiring admission policy | Existing video pricing algorithm plus composite template costs |
| Quote, order, reservation and scene sidecar | `packages/database/prisma/queries/media/video-template-*.ts` |
| Additive persistence | `VideoTemplateExecution`, migration `20261005100000_video_template_scene` |
| Authenticated API and admission | `packages/api/modules/video-effects/`, `packages/jobs/src/video-v1/template-admission.ts` |
| Scene provider, storage, moderation and recovery | Template-specific boundaries in AI, storage and video jobs packages |
| Durable continuation | Optional template branch in the existing native video Workflow |
| Tool and owner-scoped draft | `apps/saas/modules/video-effects/`, public `/video-effects/hotel-lobby-ai` |
| Tutorial and sample provenance | Existing Blog plus separate typed video-effect content |
| Acceptance and operational evidence | `docs/operations/hotel-lobby-verification.md` |

One parent video job retains the implemented internal video product key, one original
wallet reservation and one final settlement. Ordered role identities live in the
immutable parent request. Scene paid attempts live only in the sidecar. The derived
scene identity is sealed once; the parent input snapshot is never rewritten. The
scene is not a final OUTPUT and is never inserted as the first video GenerationAttempt.

The existing media/video persistence domain uses Prisma only; the alternate Drizzle
starter schemas do not contain that domain. This scoped implementation follows that
existing boundary rather than introducing an unrelated cross-database media platform.

## Compatibility and operational limits

The Workflow envelope stays version 1 and the existing ordinary-video durable step names
remain unchanged. New template preparation steps have separate stable identities.
Unknown or retired template versions fail closed; recovery uses frozen execution
settings, not a new template's defaults.

Historical release and activation reports were read from the fetched main revision.
They establish implementation history and reference pricing, not this template's real
model access, two-person quality, successful delivery, present production settings or
paid authorization. Missing external evidence is recorded as BLOCKED or NOT_RUN in
the final verification receipt.
