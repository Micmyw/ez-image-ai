# Website cache alarm retry cleanup

The pinned `@opennextjs/cloudflare@1.20.6` DO queue cleared terminal failures from
its in-memory map but retained the corresponding `failed_state` SQLite row.
`initState()` could restore that row and schedule another alarm after eviction.
This affected successful revalidation, 404 responses, unrevalidatable 200 responses,
and exhausted retries. It does not establish that production had a runaway alarm
loop or excessive billing.

The pnpm patch removes the persisted row before clearing the map in all four
terminal paths. It cancels the alarm only when the failed-state map is empty;
other routes retain their persisted retry counters and scheduling. Transient
failures keep the upstream retry limit and backoff. No Durable Object namespace,
binding, migration, cache key or business job policy changes.

The patch is registered in `pnpm-workspace.yaml` and `pnpm-lock.yaml`. It must be
present during dependency installation before building the website Worker.
Do not edit `node_modules` as a deployment procedure. When upgrading OpenNext,
review whether upstream has fixed all terminal paths before retiring the patch.

Run `node --test apps/saas/cloudflare/cache-queue.test.mjs apps/saas/cloudflare/cache-queue.workerd.test.mjs`
after installation. Both tests run through `test:unit:contracts` in CI. The first executes the installed
queue implementation with real SQLite and a simulated Durable Object lifecycle,
including cold starts and already-delivered alarms. It makes no network calls and
does not certify Cloudflare's eviction timing, production traffic or billing.
The second bundles the installed queue and starts real local workerd instances
against the same persistent SQLite directory. It verifies terminal cleanup and
alarm removal survive runtime restarts, with external network access blocked.

An existing failure row restored after rollout is removed when its retry reaches
a terminal result. OpenNext also discards rows from previous build IDs during
initialization. Rollback to the unpatched dependency can recreate the original
problem; prefer a forward correction.

Git publication alone is not deployment evidence. After website deployment,
check cache queue alarm requests, storage operations and error rates in Cloudflare.
Account billing alerts and infrastructure spending controls are separate from
application credits and provider budgets.
