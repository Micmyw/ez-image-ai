# Local Cloudflare website packaging on Windows

Use `pnpm cloudflare:web:build`. Native Windows now selects the isolated Docker/Linux
builder automatically; Docker Engine must be running. Linux and macOS keep the
existing native OpenNext wrapper. On any host the explicit equivalent is:

```sh
pnpm cloudflare:web:build --linux-container --output-dir .cache/cloudflare-web
```

This is local compilation and validation only. It does not deploy, populate remote
cache, migrate a database or enable video/generation/billing.

The wrapper snapshots the current tracked and ordinary untracked source, including
uncommitted edits and deletions. It excludes `.env*`, `.dev.vars*`, key files, host
`node_modules`, generated Prisma/Fumadocs files, previous build outputs and caches.
A fresh Linux container receives that copy without mounting the shared checkout.
The container installs the frozen lockfile with the package manager version from
`package.json`, generates Prisma clients, runs the canonical Next/OpenNext build,
and runs a Wrangler dry build followed by the final-artifact workerd smoke check.
The uncached dependency install limits network concurrency to 8 and allows 180 seconds
per fetch, retaining pnpm's finite retries. This accommodates large Linux native
tarballs without changing dependency versions or weakening lockfile checks.

The container receives only explicitly allowlisted public build inputs and known
build-only placeholders. Production database/provider/storage/payment credentials
are never inherited. Admission, billing and generation switches are false. During
application compilation, the Node network guard permits loopback and public Google
Fonts GET/HEAD requests; provider/moderation HTTP calls through guarded Node
fetch/http/https are rejected. Redirect following is disabled so an allowed origin
cannot redirect outside that boundary. This is a Node HTTP guard, not a container
firewall: it does not intercept direct sockets, native programs or workerd traffic. Dependency
installation and Prisma generation run first, without service credentials.

Each run creates a new directory under the output directory. It contains:

- `source-manifest.json`: exact copied paths and SHA-256 fingerprints.
- `build-manifest.json`: source HEAD, image ID, tracked process/container identity,
  validation status and cleanup status.
- `artifact/worker`: the final bundled Worker plus WASM/data modules.
- `artifact/assets` and `artifact/cache`: OpenNext public assets and initial cache.
- `artifact/wrangler.json`: closed local binding template referencing the bundled
  output. Actual target names, secrets, resource identities and release authorization
  remain the existing deployment preparation process.

On normal completion or a caught build error, the temporary container and source
snapshot are removed in `finally`; artifacts and
manifests remain for review. The shared Windows `node_modules`, `.next`, `.source`
and `.open-next` are not rewritten. A concurrent source edit after the snapshot is
not part of that build: compare the source manifest before using an artifact in a
release and rebuild when relevant source changed.

A failed Docker inspection is not proof of removal. The builder confirms absence
with a successful daemon listing or records cleanup as failed. If the process is
forcibly terminated, or Docker becomes unavailable during cleanup, automatic
cleanup is not guaranteed. Use the manifest's exact container name and full ID to
verify ownership before removing a retained container; preserve the manifest until
absence is confirmed. Do not use a broad container or process-name match.

The Windows command exports into its printed artifact directory; it does not populate
the shared checkout's `.open-next` or `dist`. Existing preview/deploy commands that
read those shared directories do not automatically consume this artifact. Release
preparation must explicitly select the validated artifact and intended bindings.

Native Windows OpenNext previously failed after successful Next compilation because
copied pnpm junctions were inaccessible and esbuild interpreted `cloudflare:sockets`
as an invalid Windows directory. Relinking or flattening the user's dependencies
does not establish a supported Worker artifact. The isolated Linux build uses native
Linux dependencies and validates the actual packaged output.

Build success and local workerd tests do not certify real Cloudflare scheduling,
provider acceptance, private production R2, Supabase, or paid video generation.
