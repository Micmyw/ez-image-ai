# Task 3 report: enforce guest admission ceilings

## Outcome

- Status: `DONE_WITH_CONCERNS`.
- Reviewed base: `2f8133e521d4ac350de9a550906138cf18f53945` (`fix: bound guest denial evidence`).
- Commit subject: `fix: enforce guest admission ceilings`; final SHA is reported after the commit because this report is part of that commit.
- Scope remained Task 3 only. No Schema or migration changed, and the Task 1 link/dispatch and Task 2 evidence-erasure behavior stayed intact.

Production guest configuration now fails closed unless the complete launch envelope is explicit. Subject evidence is promotion-qualified at generation, upload, and bootstrap boundaries; minute/hour/day capacity remains global across promotions but separate per boundary. Upload forwards and validates the promotion period before writing a rate bucket, and bootstrap principal capacity uses one cross-promotion global advisory lock.

## Behavior implemented

- Production requires an explicit positive `GUEST_RISK_BUDGET_MICROS` no greater than `350000`; development, test, and the existing local production-build E2E exception retain deterministic defaults.
- Queue TTL/depth are positive and no greater than `600` seconds / `25`; evidence TTL is exactly `30` days.
- Frozen ceilings are enforced for session active/accepted `1/1`, device active/accepted `1/1`, IP active/10-minute/day `2/1/3`, subnet/day `20`, global minute/hour/day `3/30/100`, outstanding bootstraps `25`, and temporary principals `100`. Stricter positive values remain valid except the exact evidence-TTL policy.
- Generation subject scopes are `guest-generate:<promotion>:ip:ten-minute|ip:day|subnet:day`; upload and bootstrap use the same promotion-qualified shape for their own boundary prefixes.
- Cross-promotion capacity scopes are `guest-generate|guest-upload|guest-bootstrap:global:minute|hour|day`. `guest-turnstile-token` remains global and unchanged.
- Upload requires the config-compatible promotion syntax before any database write, forwards that period from the API, and never calls signed storage after database admission rejects.
- One global `guest-bootstrap-cap:global` advisory lock serializes temporary-principal and outstanding-bootstrap cap checks across promotions. Existing same-session generation serialization was left unchanged because its real concurrency regression was already stable.
- Rejected generation admissions preserve a zero-row Trial, Quote, CreditAccount, Lot, Ledger, Reservation, Job, Outbox, and Attempt graph. Upload rejection preserves zero MediaAsset, upload-session, storage-reservation, and audit rows.
- Queue age and depth are independently covered: an existing depth of `10` produces an accepted exact `600`-second estimate, depth `11` rejects by age, and a controlled-capacity fixture admits exactly `25` waiting jobs before depth N+1 rejects.

## TDD evidence

### RED

- Config before production edits: `18/37` passed and `19` intended behavioral assertions failed. Missing risk configuration and every frozen N+1 value were incorrectly accepted as enabled; no import or fixture failure was counted.
- Generation PostgreSQL before scope edits: `2` intended failures and `1` passing concurrency regression.
  - Promotion B was incorrectly rejected with `GUEST_IP_RATE_LIMIT` because subject scopes were static.
  - The expected `guest-generate:global:minute` row was absent because the old dash-form global scope remained.
  - Concurrent admissions sharing a promotion/session already produced one graph and one stable `GUEST_TRIAL_UNAVAILABLE`, so no additional locking path was added.
- Upload/bootstrap PostgreSQL after prefix-isolated fixture cleanup: `4` intended scope failures. Promotion B was incorrectly rejected by static upload/bootstrap subject scopes, and the expected colon-form boundary-global rows were absent.
- Deterministic temporary-principal RED held both old and desired global-minute bucket rows, waited for two real PostgreSQL lock waiters, and then released them. At `current anonymous principals + 1`, both cross-promotion leases fulfilled instead of exactly one; this was not a timeout, queue/risk failure, or fixture-order artifact.

### GREEN

- Config: `37/37` passed.
- Upload API/capability: `8/8` passed.
- Generation PostgreSQL: `35/35` passed.
- Upload/bootstrap PostgreSQL: `14/14` passed.
- Cross-promotion global concurrency admitted exactly `2/8` generation contenders and rejected six with stable `GUEST_GLOBAL_RATE_LIMIT`; all rejected owners retained an empty business graph.
- Cross-promotion temporary-principal concurrency produced exactly one fulfilled lease and one `GUEST_TEMPORARY_PRINCIPAL_CAP_EXCEEDED`.
- The existing same-session concurrency regression remained one graph plus one stable `GUEST_TRIAL_UNAVAILABLE` and zero Attempts.

### Mutation checks

- Temporarily changed the queue TTL ceiling from `> 600` to `>= 600`. Config went RED exactly `1/37`: the valid explicit `600`-second envelope became `GUEST_CONFIGURATION_INVALID`. Restored implementation: `37/37` passed.
- Temporarily reverted generation IP/10-minute evidence to the old static scope. The promotion-isolation case went RED because promotion B received `GUEST_IP_RATE_LIMIT`. Restored promotion-qualified scope: focused case passed.

## Verification

- Task 1 regressions: jobs runtime store `50/50`; database guest link `7/7`.
- Task 2 Schema/retention regressions: `21/21`.
- `pnpm test:unit:contracts`: exit `0`; all constituent batches passed (`1,109` tests by batch totals).
- `pnpm test:integration`: exit `0`; database `156 + 77`, jobs `70`, API `406 + 11` = `720` tests.
- `pnpm test --force`: exit `0`; `12/12` tasks successful, `0` cached.
- `pnpm format`: exit `0`.
- `pnpm format:check`: exit `0`; all `1,115` files matched.
- `pnpm lint`: exit `0`.
- Final `pnpm type-check --force`: exit `0`; `21/21` tasks successful, `0` cached.
- Focused and full database tests used only `ezpic_residual_limits_20260829_test` through loopback port `55432`, with `DATABASE_URL` kept distinct during integration runs.

## Exact resource cleanup

- Before deletion, the exact database list contained `ezpic`, `ezpic_residual_limits_20260829_test`, and `ezpic_testing`.
- Only `ezpic_residual_limits_20260829_test` was dropped. The repeated list retained protected databases `ezpic` and `ezpic_testing`.
- Forwarder managed session `41677` received Ctrl-C. Launcher PID `42860` and Node PID `10220` are absent; port `55432` is closed.
- Docker Desktop was started once in the dual-isolated environment with root PID `19452`. Its initial and final recorded product tree was `4444,15764,18924,19452,28264,29784,34256,36024,37604`.
- Docker stopped once through the supported isolated `docker desktop stop`; stop launcher PID `32780`, created `2026-08-29T11:32:51.3740102+08:00`, exited `0`. No PID-termination fallback was used.
- Two current-run task records remained after supported shutdown: `34256.json` for `com.docker.build.exe` and `4444.json` for `docker-sandbox.exe`. Both exact recorded PIDs were already absent; only those two verified task-owned records were removed, leaving the isolated task directory empty.
- Every recorded Docker, forwarder, and stop PID is absent; no Docker product process remains. `com.docker.service` is stopped.
- WSL distributions `Ubuntu-24.04` and `docker-desktop` are stopped.
- Guarded ports `2375, 2376, 3000, 3001, 5432, 55432, 9000, 9001` are closed.
- Global Docker settings SHA-256 remains `C3AEA9DBD24BF4FEED03CF2C81F4B683E712BDDBDD6E4D28953E935E4DFEF4F2`.
- Isolated Docker settings SHA-256 remains `E4ED5A1109B5E156604E38424BED432FDD7E5FD04662E399FBB521281000EE22`.
- `docker-desktop` registry base remains `\\?\D:\Docker\DockerDesktopWSL\main`; C-drive Docker VHDX count is `0`.

## NOT_COMPLETED

- No push, PR, merge, deployment, production enablement, or remote CI.
- No real Provider, Turnstile, Stripe, Trigger.dev, mail, or cloud-storage call.
- No browser/public/live verification. Whole-wave E2E remains owned by the final integration stage.

## Concerns

- The first forced type-check invocation stopped before source type checking because Prisma generation had no `DATABASE_URL`. It was rerun with the exact isolated database URL and passed `21/21`; this was an invocation-environment issue, not a source failure.
- Existing PostgreSQL `client.query()` nested-query deprecation warnings and intentional payment-fixture error logs remained unchanged and non-blocking.

## Review fix round 1: make the outstanding-bootstrap ceiling atomic

- Status: `DONE`.
- Reviewed HEAD: `1cafd79210c4af1fe02d09d4adfd48a3c5407c32` (`fix: enforce guest admission ceilings`).
- Delivery is a new regular `fix:` commit; `1cafd79` was not amended.
- No Schema or migration changed.

### Root cause and implementation

- The outstanding-bootstrap check previously ran during principal lease acquisition, after the Bootstrap had already been created. It therefore did not serialize the operation that increased the outstanding count.
- The old claim-time predicate also used `count > maximum`. Once historical rows exceeded the ceiling it rejected the very claim that would have reduced the outstanding count, creating a self-sustaining backlog until expiry.
- `createGuestSessionBootstrapWithClaimFence` now requires the configured ceiling, takes the existing claim lock and the cross-promotion `guest-bootstrap-cap:global` advisory lock in the same transaction, counts active unclaimed/uncompleted Bootstraps, and rejects at `count >= maximum` before inserting the Bootstrap.
- The ready-upload finalization transaction passes the ceiling and verification clock into that creation path. Draft creation, completion-token consumption, Bootstrap counting/insertion, and both locks therefore commit or roll back together.
- Principal lease acquisition retains the same global lock for temporary-principal capacity but no longer rejects based on outstanding Bootstrap count, so claims can drain a historical over-cap backlog.
- `complete-guest-upload` forwards `loaded.config.limits.maximumOutstandingBootstraps` and maps the internal `GUEST_OUTSTANDING_BOOTSTRAP_CAP_EXCEEDED` error to stable public `GUEST_CAPACITY_UNAVAILABLE`.

### TDD evidence

#### RED

- Public error mapping reached the real procedure catch path and failed behaviorally: expected `GUEST_CAPACITY_UNAVAILABLE`, received `GUEST_OUTSTANDING_BOOTSTRAP_CAP_EXCEEDED`.
- Historical over-cap drain reached the real claim transaction and failed behaviorally: expected `CREATED`, received `GUEST_OUTSTANDING_BOOTSTRAP_CAP_EXCEEDED`.
- The cross-promotion creation fixture first had its READY moderation ordering and staged-terminalization token transition aligned with current database guards. After those fixture-only repairs, the unchanged production code produced the intended RED: both concurrent `finalizeGuestDraftFromReadyUploadTransaction` calls fulfilled when exactly one was allowed. This was not a connection, migration, constraint, timeout, or fixture-setup failure.

#### GREEN

- Guest Bootstrap PostgreSQL file: `16/16` passed. The concurrent case preseeds N-1, produces exactly one success and one stable cap error, proves the loser has zero Draft/Bootstrap rows and an unchanged completion token/consumption timestamp, and finishes at exactly N outstanding rows.
- The historical over-cap case permits one claim and reduces outstanding count by one; the temporary-principal cap regression remains enforced.
- Guest upload API/capability file: `9/9` passed, including exact ceiling forwarding and stable public error mapping.
- Task 3 config and generation admission regressions: `37/37 + 35/35` passed.
- Task 1 regressions: guest link `7/7`; jobs runtime store `50/50`.
- Task 2 regressions: guest retention `11/11`; API admission `14/14`.

### Mutation check

- Temporarily changed the creation predicate from `count >= maximum` to `count > maximum`. The cross-promotion concurrency test failed exactly because both finalizations fulfilled instead of one. Restoring `>=` returned the focused test to GREEN.

### Final gates

- `pnpm test:unit:contracts`: exit `0`; `1,110` tests passed.
- `pnpm test:integration`: exit `0`; database `156 + 79`, jobs `70`, API `407 + 11` = `723` tests.
- `pnpm test --force`: exit `0`; `12/12` tasks successful, `0` cached.
- `pnpm format`, `pnpm format:check`, `pnpm lint`, and `git diff --check`: exit `0`; all `1,115` files matched formatting.
- `pnpm type-check --force`: exit `0`; `21/21` tasks successful, `0` cached, using the exact isolated database URL for Prisma generation.
- Existing PostgreSQL nested-query deprecation warnings, Turbo no-output warnings, and intentional payment-fixture error logs remained unchanged and non-blocking.

### Exact cleanup

- The exact disposable database was `ezpic_residual_limits_fix1_20260829_test` through loopback port `55432`; all `36` migrations had been applied before testing.
- Before deletion, the database list was `ezpic`, `ezpic_residual_limits_fix1_20260829_test`, `ezpic_testing`, `postgres`, `supastarter`, and `supastarter_test`. Only `ezpic_residual_limits_fix1_20260829_test` was dropped; the repeated list retained every other database.
- Forwarder managed session `19578` received Ctrl-C. Launcher PID `30284` and Node PID `43724` are absent; port `55432` is closed.
- Docker Desktop root PID `34724` was started at `2026-08-29T11:56:03.5082144+08:00`. Its final current task-owned tree before shutdown was `3184,24504,25312,27272,31448,32728,34724,36140`; initial PID `37044` had already exited.
- Docker stopped through supported isolated `docker desktop stop`; stop launcher PID `42436`, created `2026-08-29T12:15:59.2345363+08:00`, exited `0`. No PID-termination fallback was used.
- Every recorded Docker, forwarder, and stop PID is absent; no Docker product process remains. `com.docker.service`, `Ubuntu-24.04`, and `docker-desktop` are stopped.
- Guarded ports `2375,2376,3000,3001,5432,55432,9000,9001` are closed.
- Global Docker settings SHA-256 remains `C3AEA9DBD24BF4FEED03CF2C81F4B683E712BDDBDD6E4D28953E935E4DFEF4F2`; isolated settings SHA-256 remains `E4ED5A1109B5E156604E38424BED432FDD7E5FD04662E399FBB521281000EE22`.
- Registry mapping remains `\\?\D:\Docker\DockerDesktopWSL\main`; C-drive Docker VHDX count is `0`.
- Supported shutdown left task records `24504.json` and `31448.json`. Their exact recorded processes were absent; only those two verified current-run records were removed, leaving the isolated task directory empty. These transient task records are not recoverable, but contain no product or user data.

### NOT_COMPLETED

- No push, PR, merge, deployment, production enablement, remote CI, browser/public/live verification, or real Provider, Turnstile, Stripe, Trigger.dev, mail, or cloud-storage call was performed.
