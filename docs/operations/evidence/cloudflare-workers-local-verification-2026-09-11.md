# Local Workers profile verification — 2026-09-11

This record covers the local implementation of the `workers` and `hybrid` profiles. It does
not certify a deployed Cloudflare account, an Images entitlement, Hyperdrive origin TLS/cache
configuration, private R2, or a live provider/payment integration. Those remain `NOT_COMPLETED`.
The task did not push, deploy, upgrade an account plan, or migrate a production database.

## Verified behavior

| Check                         | Evidence                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Full workspace types          | 22 tasks passed after introducing the official Workers Prisma client                                                                                                                                               |
| Formatting and lint           | Full repository checks passed; database type-only configuration prevents generated WASM JavaScript from being treated as an emit target                                                                            |
| Database/jobs/API integration | 941 tests passed against disposable PostgreSQL: 177 database, 82 isolated guest, 94 jobs, 576 API and 12 isolated API tests                                                                                        |
| Final database regression     | 64 unit tests and 9 real PostgreSQL scope/credit tests passed after conditional Prisma imports changed                                                                                                             |
| Image boundary                | 45 image/lifecycle tests passed, including actual Sharp output checks                                                                                                                                              |
| Remote media                  | 55 focused contracts passed; actual workerd checked streaming, redirects, byte limits, missing scope and private destination/DNS-rebinding rejection                                                               |
| Workflows                     | 19 tests passed, including workerd execution-boundary tests                                                                                                                                                        |
| Website regression            | 373 SaaS tests passed; the final website boundary/configuration checks passed 21 focused tests                                                                                                                     |
| Browser regression            | 33/33 passed: 18 authenticated media/subscription/SEO and 15 guest/landing/originality checks                                                                                                                      |
| Final jobs Worker             | Wrangler output loaded directly in workerd; unsigned requests rejected, invalid signed tasks rejected, and a real Prisma WASM query completed through local Hyperdrive                                             |
| Final website Worker          | Linux Next/OpenNext build and Wrangler output loaded in workerd; health, login, pricing, catalog and static JavaScript returned 200; three concurrent catalog queries used local Hyperdrive without `DATABASE_URL` |
| Website cache                 | Private/no-store dynamic responses and immutable static assets verified                                                                                                                                            |

The final hybrid image build and offline runtime check passed. The image imported Node Prisma
and all job handlers, selected Sharp, rendered a 6,099-byte PNG with 1,030 bright lettering pixels,
and ran as UID 1000. The prior image failed the same lettering assertion. The final image
manifest is `sha256:e26e78c1ab36691f039c3de18d48c8f870891fa99393c6f2da76a6990156f55e`.

The full contract runner passed the preceding package stages but initially failed four SaaS
layout tests after a concurrently added analytics component. The isolated layout mock was
updated, and the complete SaaS test suite then passed. No analytics implementation was changed
by this task.

## Final artifacts

The website uses Next.js 16.3.4, OpenNext 1.20.6 and Wrangler 4.129.0. Its final output is
30,226.56 KiB raw / 6,993.90 KiB gzip, with 279 static assets. Its JavaScript SHA256 is
`3da178968aa977e17078bd67a617fec6e540012487cb56f00d951593cad7b230`.
The jobs Worker output is 8,871.91 KiB raw / 2,088.87 KiB gzip. Both are below the Workers Paid
10 MiB compressed script limit; this is an artifact-size check, not a load or billing test.

The website scan covered 317 source modules and found no Node Prisma runtime, native Sharp,
Node media transport implementation or `.node` binaries. None of the 15 checked local sensitive
values appeared in its final artifact. OpenNext's embedded environment fallback was cleared.
The precompiled Prisma query compiler WASM is included and exercised by the real database smoke.

Ignored evidence is retained in `.wrangler/` and `apps/saas/dist/worker-linux/`, including original
build logs, HTTP results, static assets and `verification-summary.json`. Reproduce checks using
the commands in [the profile runbook](../cloudflare-workers-profiles.md).

## Failures caught during verification

- Source-level workerd tests and dry builds initially missed the Node Prisma runtime's
  `fileURLToPath(import.meta.url)` failure in the final bundle. Separate generated clients and
  the `workerd` conditional entry now select Prisma's official edge runtime. The website keeps
  `.wasm?module` imports for OpenNext/Wrangler to package as precompiled modules. CI now starts
  the final website/jobs artifacts, and its PostgreSQL job executes a real final-artifact query.
- Native Windows Next compilation succeeds, but OpenNext's copied pnpm junctions can fail in
  final packaging. The complete supported packaging check used an isolated Linux/WSL directory.
- The first browser run passed 17/18 authenticated tests; its upload was blocked because the
  existing MinIO allowed only `http://localhost:3000`, while this test used port 3175. An isolated
  MinIO permitting the exact test origin and a fresh test database produced the final 33/33 run.
  The shared development MinIO configuration was preserved.
- The built hybrid image initially produced only the watermark plate. A real image fixture and
  a failing pixel assertion confirmed missing font support. The image now installs Fontconfig
  and DejaVu, and CI checks visible lettering inside the image with network access disabled.

## RED → GREEN and cleanup

New behavioral tests first failed for missing runtime adapters, overlapping database/image
contexts, executor validation/admission and panoramic watermark lettering; they passed after
implementation. The final-artifact startup and real SQL checks additionally cover a packaging
failure that mocks cannot reproduce. The container lettering assertion also failed against the
old image before the font correction.

All recorded task-owned verification process trees exited. The isolated Linux/WSL build
directory was removed. The dedicated PostgreSQL and MinIO containers and the task's initial
test database on the shared local PostgreSQL were removed and their absence verified. The
existing `supastarter-postgres` and `supastarter-minio` services remained running with their
configuration preserved. Built artifacts and verification logs remain available locally.
