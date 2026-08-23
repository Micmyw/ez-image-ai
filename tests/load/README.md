# Controlled media load tests

The load endpoint exercises the real PostgreSQL quote, credit reservation, generation job, attempt,
and Outbox writes with an in-process deterministic provider. It never calls a live AI provider and
does not write media objects. The endpoint is intentionally unavailable unless every safety gate is
present.

## Local smoke

Use only the disposable PostgreSQL database used by the integration suite:

```powershell
$env:TEST_DATABASE_URL = "postgresql://ai_media_test:ai_media_test_only@127.0.0.1:55432/ai_media_foundation_test"
pnpm load:smoke
```

The smoke proves that a disabled endpoint returns 404, an incorrect token returns 401, one authorized
request uses the real database path, a duplicate resolves to the same job, and the credit invariant is
preserved. It creates namespaced rows under `load-test:<run-id>` in that disposable database.

## k6 target

Run the SaaS app against a dedicated test/load PostgreSQL database, never a development or production
database. The server and k6 process must use the same run ID and high-entropy token:

```powershell
$env:NODE_ENV = "test"
$env:DATABASE_URL = $env:TEST_DATABASE_URL
$env:LOAD_TEST_DATABASE_URL = $env:TEST_DATABASE_URL
$env:LOAD_TESTING_ENABLED = "true"
$env:LOAD_TEST_RUN_ID = "local-smoke-001"
$env:LOAD_AUTH_TOKEN = "<at-least-43-visible-ASCII-bytes-from-a-secure-generator>"
$env:LOAD_BASE_URL = "http://127.0.0.1:3000"
$env:LOAD_PROFILE = "smoke"
pnpm load:media
```

The route remains unavailable when `NODE_ENV=production`, the token is weak or wrong, the run ID is
invalid, or `DATABASE_URL` is not exactly `LOAD_TEST_DATABASE_URL`. Loopback databases must have
`test`, `testing`, `load`, or `staging` as a name segment. A remote isolated load database additionally
requires `LOAD_TEST_REMOTE_DATABASE_ENABLED=true` and
`LOAD_TEST_DATABASE_NAME_CONFIRMATION=<exact-database-name>`.

The endpoint has bounded bodies, per-process rate limiting, and per-process concurrency limiting.
Defaults are 600 requests/minute and 64 concurrent requests. Overrides are deliberately bounded by
`LOAD_TEST_RATE_LIMIT_PER_MINUTE` (maximum 10,000) and `LOAD_TEST_CONCURRENCY_LIMIT` (maximum 1,000).
For a remote HTTP target, k6 also requires `ALLOW_REMOTE_LOAD_TARGET=true` and
`LOAD_TARGET_CONFIRMATION=<exact-origin>`.

`steady`, `peak`, and `active-1000` are staging-equivalent capacity tests, not CI or laptop claims.
Run them only against an isolated, resettable database and controlled deployment. Reset that dedicated
database after the run; load rows are intentionally namespaced but the immutable credit ledger prevents
ad-hoc row deletion. Run `pnpm verify:invariants` with the same test database after each load test.
