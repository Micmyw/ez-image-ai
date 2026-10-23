# Website Worker memory, 2026-10-23

## Failure and measurement

The website deployment at `4e40fd1541481d7a553aabe7ab7a7216bb4d8815`
returned intermittent HTTP 503s after release. Cloudflare recorded three
`exceededMemory` invocations around 11:12:30 UTC. Subsequent HTTP 200 responses
did not close the issue. This is separate from the repaired image Workflow event
type and from a later local connection timeout.

An isolated Linux build artifact from `c9d2aac9` reproduced high memory usage
without a database, provider calls, authenticated users or outbound HTTP. The
website implementation at that commit matches the failing release; the later
commits change the shared phase-event formatter and its tests.

The local workerd inspector measured the website isolate, not process RSS.
Its heap snapshot retained an 89,548,068-byte JavaScript source string. The
44,774,028-character unminified bundle contained Unicode regular-expression
literals, causing V8 to store the entire source string with two-byte characters.
Ordinary esbuild minification leaves Unicode regex literals intact, so that
alone still retained a 60,838,544-byte source string.

| Local artifact experiment                                        | Loaded JS heap | Retained JS heap after public requests |
| ---------------------------------------------------------------- | -------------: | -------------------------------------: |
| Original bundle, six concurrent requests                         |      94.81 MiB |                             140.40 MiB |
| Ordinary minification, six concurrent requests                   |      66.94 MiB |                             110.50 MiB |
| Minification plus parsed ASCII printing, six concurrent requests |      38.12 MiB |                              82.09 MiB |

The ASCII experiment retained a 30,475,900-byte source string. It served health,
home, Create, Docs, login and the protected video redirect. These are controlled
local comparisons, not cloud latency or unlimited concurrency guarantees.
Backing stores and runtime allocations must also fit the platform limit.

## Build and release contract

`cloudflare:web:build` now completes the entire website artifact:

1. Build Next/OpenNext and clear embedded dotenv fallback values.
2. Bundle the outer Worker with Wrangler's minification in a task-owned staging
   directory, preserving the actual conditional exports and WASM/data modules.
3. Use the pinned Next dependency's Terser parser/printer with compression and
   identifier mangling disabled to emit ASCII JavaScript. This includes regex
   literals; no blind Unicode text replacement is used.
4. Reject remaining non-ASCII source or source above the 34 MiB build budget,
   preserve composed source maps, then replace only `apps/saas/dist/worker`.

Production and staging profiles, including hybrid hosting, upload that exact
artifact with `no_bundle: true`. Explicit WASM/data rules retain all binary
modules. Do not run a second source-based Wrangler bundle over `dist/worker`:
it bypasses the checked final representation. The isolated Windows/Linux
builder and CI use the same packaging step.

The final-artifact smoke verifies Unicode-sensitive runtime behavior through
normal pages, locale handling, serialized theme initialization, authentication
redirects and callback signature rejection. It also checks local isolate memory:
64 MiB for initial heap plus backing storage, and 112 MiB for retained public-route
heap plus backing storage after a snapshot. These regression budgets preserve
headroom; they do not replace live Cloudflare measurements or certify all
authenticated workloads.

Source-map composition needs more than the default 2 GiB Node build heap for
this bundle. The build command has a 4 GiB heap limit, after the Next subprocess
has exited. This is a local/CI build allocation only; no production Worker limit,
request admission policy or runtime setting is raised. Automatic Cloudflare Git
builds also run the final-artifact smoke before deployment.

The source transformation does not change request-owned clients, financial
state, moderation, callback ownership or private media. No new paid generation
is needed for this packaging fix. Roll back by redeploying a known-good complete
artifact; do not mix a source entrypoint with the artifact-only deployment profile.

## Verification record

- 97 focused checks passed: 78 deployment-profile tests and 19 Cloudflare build
  tests, including Unicode semantics, source-map composition and the artifact
  guard. Web-host types, affected lint/format and CI-wiring checks passed.
- Next/OpenNext compilation and final packaging passed in isolated Linux. The
  final source is 30,200,177 ASCII bytes. Its real workerd smoke passed with zero
  external HTTP requests: 42,233,968 bytes of initial JS heap and 87,411,460 bytes
  of retained JS heap after the public/unsigned-callback probes (backing storage
  measured separately at 1,577,474 and 1,599,007 bytes).
- A no-bundle Wrangler upload dry run preserved the exact SHA-256 of the final
  JavaScript, three WASM modules and font data. Minification removed comment-based
  module markers, so the runtime smoke now verifies actual included esbuild
  inputs to retain the Node Prisma/Sharp/transport exclusion checks.
- Local experiments and release/live reports are kept under the ignored
  `.cache/worker-memory-20261023/` directory. CI, deployed SHA and live Cloudflare
  results are separate evidence; a passing local smoke does not certify them.
