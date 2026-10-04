# Video review branch verification

Historical verification for `4a7294c0f8d085953eb6a1fffbec41bcaec6e2bf`.
The latest repairs and their fresh checks are recorded in
[the review-fix report](video-v1-review-fixes-2026-10-04.md).

Branch: `codex/video-v1-release`. Base: `e4f6b81fd8fc8e769b975e6c59177a1afefa06a9`.
This is the user's requested GitHub review handoff, before production release.

The original dirty workspace remains preserved. Task changes were reconstructed relative to
the original pre-task working patch and merged into current `origin/main`; newer composer,
resources, image workflow and public-content changes were retained.

Evidence date: 2026-10-04. These checks ran in the isolated review checkout, using
its own frozen-lockfile dependencies (Vitest 4.1.11), not the older source checkout.

| Gate                                                | Result                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen-lockfile install and Prisma generation       | PASS; 1323 packages, independent dependency tree                                                                                      |
| Workspace types                                     | PASS; 21 tasks on the first run, SaaS passed after correcting a merged test variable; final Jobs and load-tool types also passed      |
| Config / AI / Storage / Payments contracts          | PASS: 332 / 493 / 139 / 300 tests                                                                                                     |
| Database unit contracts                             | PASS: 106 + 15 + 7 tests in separate suites                                                                                           |
| Jobs unit contracts                                 | PASS: 485 on the integrated code, then 23 focused checks after the lazy moderation-configuration fix (counts overlap)                 |
| Workflows unit and native workerd                   | PASS: 96 plus 9 after repairing the worker-executor fixture; 1 pre-existing skipped test is NOT_RUN                                   |
| Web-host / Node jobs-runtime contracts              | PASS: 103 / 9 tests                                                                                                                   |
| Media E2E harness / UI originality contracts        | PASS: 7 / 4 tests; these are harness contracts, not browser E2E                                                                       |
| API unit contracts                                  | PASS: 649 initially passed; all 3 failed fixtures repaired and their 27-test suites passed, covering the original 652-test set        |
| SaaS unit and build-wrapper contracts               | PASS: 831 Vitest tests in 127 files plus 9 Node build-wrapper tests                                                                   |
| Video isolated PostgreSQL integration               | PASS: 113 database + 24 flow/isolation tests; 3 optional performance cases NOT_RUN                                                    |
| Affected-file lint, format and whitespace           | PASS: 320 format-eligible paths, 269 lint-eligible paths and staged whitespace checks                                                 |
| CI configuration contract                           | PASS; no executable Sightengine selector; legacy-engine-isolation included in integration entry points                                |
| Final Jobs bundle + native workerd artifact         | PASS, including six concurrent loopback PostgreSQL probes and targeted continuation/output-review checks                              |
| Final Linux website build + native workerd artifact | PASS: compilation, types, 60 static pages, OpenNext, Wrangler dry-run and actual local workerd health/login/theme/static-cache checks |
| Browser E2E on this exact review checkout           | NOT_RUN; earlier browser fixtures remain historical evidence                                                                          |
| Hosted CI                                           | NOT_RUN; branch-only push is not a main/PR workflow trigger                                                                           |
| Paid external generation / moderation               | NOT_RUN; paid calls: 0                                                                                                                |
| Production migration, deployment, video opening     | NOT_RUN; this is a review handoff                                                                                                     |

The contract runner stopped on stale fixtures. After fixing them, the failed suites
and the remaining suites were run separately. The table is the combined verified
coverage, not a claim that the original interrupted command exited successfully.
Focused regression totals overlap prior suite totals and must not be summed as
independent tests.

## Repairs found during review-branch verification

- Removed remaining Sightengine selectors in CI and updated its contract guard.
- Added legacy-engine isolation to the integration entry points. The SeeAPI handoff
  invariant now accepts valid early callbacks with no provider task ID while checking
  durable identity, timestamps, immutable output and raw-body hash.
- Corrected the local aggregate runner's isolated-database variable propagation;
  the explicit loopback, database-name and URL-safety checks remain enforced.
- Replaced stale Sightengine test fixtures with the current Waffo/SeeAPI contract.
- Deferred moderation configuration lookup until actual verification. Disabled
  generation can load modules without a configured detector; actual verification
  still rejects missing configuration or credentials before database/provider calls.
- Kept video translations in the authenticated video layout and updated its locale
  regression checks. Corrected stale legal-page date assertions. Node build-wrapper
  tests now run under `node --test`; Docs metadata tests prepare their real module
  through a static import without increasing test timeouts.

## Reproduction and local records

The isolated test database was on `127.0.0.1:55439`, database
`ezpic_video_v1_final_test`. Use a disposable database satisfying the runner's safety
checks. The wrapper shadows environment-file credentials and denies paid external
network access; it never reads a production connection as its test target.

```powershell
$env:VIDEO_VERIFICATION_DATABASE_URL='postgresql://video_test:video_test@127.0.0.1:55439/ezpic_video_v1_final_test'
node tests/video-v1/local-command.mjs test:unit:contracts
node tests/video-v1/local-command.mjs test:video:integration
```

Local raw records are in `.cache/video-v1/` and intentionally excluded from Git:
`release-install.log`, `release-typecheck.log`, `release-saas-typecheck.log`,
`release-unit-contracts.log`, `release-contracts-remaining.log`,
`release-worker-executor.log`, `release-api-fixture-repair.log`, and build manifests.
No credentials, local environment files, dependency trees or temporary build outputs
are included in the review commit.

Final Jobs worker SHA-256:
`6668088c20eeabf2c91e5b1e35363bba514aa6722315272c02954e80c2980ef4`.
This identifies the local artifact; it is not a deployed Cloudflare version.

Final website worker SHA-256:
`03f41d19a47eccb4df9b8456d61bad54dde693bc450f2395f773bee003b1085d`.
The isolated Linux build ran from `2026-10-04T04:30:33.594Z` to
`2026-10-04T04:38:27.548Z`. Website database probing was NOT_RUN; the Jobs artifact
ran the loopback PostgreSQL probes. Both builds used the same source snapshot.
Later differences were documentation and test-only edits, with no runtime drift.
Build containers and their recorded process trees were removed after verification.

The source-workspace evidence remains in [the implementation report](video-v1-seeapi-verification.md).
It is identified separately from the exact branch checks above. Credentials and price gaps remain
BLOCKED as described in [the review guide](../implementation/video-v1-github-review.md).
