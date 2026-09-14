# Cloudflare Git builds for production

Connect the two existing production Workers to `Micmyw/ez-image-ai` in Cloudflare. Each push to
`main` then runs Cloudflare's own build and deploy steps. The application list shows the
repository association, and its build page contains logs and commit status. GitHub Actions
continues to validate the repository independently; it does not publish the site.

## Connect each existing Worker

Open **Workers & Pages**, select the existing Worker, and go to **Settings → Build → Connect Git**.
Select GitHub account `Micmyw` and repository `ez-image-ai`. If the private repository is missing,
update the installed Cloudflare GitHub app's repository access to include it.

Both builds start at the repository root because the pnpm workspace, lockfile, shared packages,
and deployment preparation live there.

| Setting                      | Website Worker                                                        | Jobs Worker                                                        |
| ---------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Existing Worker              | `ezimageai-site-production`                                           | `ezpic-workflows-workers-production`                               |
| Repository                   | `Micmyw/ez-image-ai`                                                  | `Micmyw/ez-image-ai`                                               |
| Production branch            | `main`                                                                | `main`                                                             |
| Root directory               | `/`                                                                   | `/`                                                                |
| Build command                | `pnpm install --frozen-lockfile && pnpm cloudflare:git:build website` | `pnpm install --frozen-lockfile && pnpm cloudflare:git:build jobs` |
| Deploy command               | `pnpm cloudflare:git:deploy website`                                  | `pnpm cloudflare:git:deploy jobs`                                  |
| Non-production branch builds | Disabled                                                              | Disabled                                                           |

Do not connect the old rollback services `ezimageai-web-production` or
`ezpic-workflows-production`. Subsequent releases update the same two active services; version
history stays inside their **View deployments** pages.

In **Build variables and secrets**, set `NODE_VERSION=22` and `PNPM_VERSION=11.3.0`. Add the
secret `CLOUDFLARE_PRODUCTION_ENV` containing the reviewed production environment in dotenv
format, using ignored `.env.production.local` as the source. Keep secrets out of Git and chat.
Build variables and runtime variables are separate: these commands explicitly prepare and
apply the corresponding runtime secret files.

Select Cloudflare's managed build API token or an existing token for the production account.
The default generated token includes Workers Scripts, Workers Routes, KV, and R2 edit
permissions plus account/user reads. The jobs deployment must also be authorized to update
its existing Workflow and use Hyperdrive. No GitHub Actions deployment token is required.

Saving a connection can start the first build. Connect after these commands are on `main` and
production configuration is ready. Cloudflare then handles each subsequent `main` push.

## Build and deployment behavior

- Accept only the `workers` profile. In Cloudflare, require `WORKERS_CI_BRANCH=main` and a
  checked-out commit matching `WORKERS_CI_COMMIT_SHA`.
- Reuse production profile preparation and preserve existing feature gates and bindings.
- Generate Node/Workers Prisma clients and run read-only `prisma migrate status` with verified
  TLS. Apply pending migrations separately; builds do not mutate the database schema.
- Build on Linux through the OpenNext wrapper. Pass only allowlisted public configuration and
  dummy database/auth values to the website build. Build subprocesses do not inherit the
  production environment blob or Cloudflare API token. Remove OpenNext's embedded dotenv fallback.
- Populate the website build's remote R2 cache before deploying it. Deploy each target with its
  prepared secret file and the checked-out SHA as its version tag.
- Verify the target's live version tag and 100% traffic. For the website, check HTTP 200 from
  `/api/health`, `/`, `/docs`, and `/create`.

The two native builds run independently. They have no shared transaction or guaranteed order.
If one fails after the other succeeds, correct the failure and retry the same commit. Keep
runtime changes compatible during that interval. See [profile operations](cloudflare-workers-profiles.md)
for separately managed hybrid cutover and rollback.

## Current release prerequisite

The expanded catalog is `2026-09-13.1`. Local production configuration inspected on September 14
still lists `2026-09-07.2` in `MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS` while generation is
enabled. The build stops with `PRODUCTION_CATALOG_NOT_CERTIFIED` before changing a Worker,
preventing a release with an empty executable catalog.

Review the provider evidence required by the [media runbook](ai-media-runbook.md) before adding
the active version to the deployment environment. Builds do not certify new models or change
these gates automatically. Local verification does not certify paid generation, payment
fulfillment, provider billing, or guest safety.

Cloudflare documentation: [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).
