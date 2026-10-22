# PostgreSQL socket patch regression

`patches/pg-cloudflare@1.4.0.patch` adds bounded, per-socket synchronous
`cork()` / `uncork()` support for the existing `pg` protocol groups. It does not
change dependency versions, add timers, batch separate requests, or introduce
`drain` semantics. The added scratch buffer is limited to 64 KiB or 64 frames;
this does not bound the native transport's existing pending-write queue.

The default database unit suite includes the installed dependency's contracts:

```powershell
pnpm --filter @repo/database test:pg-socket
```

They cover mutable serializer buffers, nested cork, overflow, immediate native
submission, deferred completion, ordered nonempty-write callbacks, failures,
empty `end()` flushing, repeated close, callback-triggered `end()`, destroy,
conditional exports and a mocked TLS writer handoff. Empty writes retain the
upstream synchronous callback behavior. A mocked handoff does not verify a real
TLS handshake.

For the real workerd regression, start an existing dedicated PostgreSQL fixture
on loopback port 55432 with a database name containing `test`. The probe never
uses `DATABASE_URL`, never provisions/stops shared services and opens every
connection read-only. Coordinate an exclusive workerd/DB/CPU window before
setting the flag:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://<local-role>:<local-password>@127.0.0.1:55432/<database_test>'
$env:PG_SOCKET_PROBE_EXCLUSIVE_WINDOW = 'true'
pnpm --filter @repo/database test:pg-socket:workerd --execute
```

The probe bundles the installed workerd conditional export and records its
resolved path and SHA-256 alongside the patch and bundle hashes. It runs three
warmups and twelve measurements per phase, with native Node controls before and
after. Its ABBA baseline is the same installed class with `cork` / `uncork`
disabled, not a copy of the upstream package. Hard assertions check result
correctness and native writer calls: parameterized SELECT 5 → 1, named prepared
SELECT 4 → 1, and BEGIN/two SELECTs/COMMIT 12 → 4. Latency is recorded without
fragile timing pass thresholds. The number of bytes stays unchanged.

Raw results, bundle and metafile are written under
`.cache/pg-cloudflare-regression/`. An optional `PG_SOCKET_PROBE_LABEL` chooses a
unique evidence filename; an existing result is never overwritten. The report
records the root PID and Windows descendant snapshots. After the command
exits, verify those exact PIDs and the launcher exited; clean only task-owned
survivors, descendants first. The runner disposes Miniflare and stops esbuild.

This fixture uses plaintext loopback PostgreSQL. It proves local transport
grouping and query correctness, not deployed latency, TLS acceptance or a
packet-level explanation. Workerd timings can round below 1 ms to zero.
