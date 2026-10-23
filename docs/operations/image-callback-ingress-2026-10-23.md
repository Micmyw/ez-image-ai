# Image callback ingress and timing

The website Worker handles exactly `POST /api/webhooks/ai/kie` and
`POST /api/webhooks/moderation/seeapi-image` before OpenNext. Canonical-origin
validation, the existing request-owned database client, its cleanup lifetime,
and the jobs service binding still apply. The Node/Hono routes retain the same
handlers for local use and rollback. No new endpoint, secret, migration, provider
request, Workflow event name or polling interval is introduced.

This removes the general API router and its extra request-body buffering from
these two Worker requests. The callback modules import only their database
query entrypoints. It does not eliminate Prisma initialization, provider work,
storage transfers or database transactions, and is not a production speed claim.

## Preserved protocol

- Verify the signed callback URL and, for SeeAPI, the signature of the exact raw
  bytes with its timestamp. The handlers retain the 64 KiB streamed body limit.
- Persist the completion notification under the existing lock and immutable
  task/generation binding before signaling the current phase owner. Early and
  duplicate callbacks retain their original behavior.
- Callback bodies cannot approve content or settle credits. The existing task
  still retrieves its result using provider credentials. Unknown acceptance,
  active leases and old epochs cannot authorize a second submission.
- A failed direct handler does not retry through OpenNext. Normal durable
  polling and callback redelivery remain available; a failed owner signal never
  selects another execution chain.
- The database/client lifetime still covers the complete response and managed
  background work. No client, socket or transaction is shared between requests.

## Timing boundaries

All spans use a request-local monotonic clock. `requestId` connects the Worker
entry and handler spans; verified `attemptId` or `assetId` is added only after
the callback URL proof is valid. Logs never contain the callback URL, query
token, signing key, raw body, provider result, SQL text or parameters.

| Span                                           | What it observes                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `callback.ingress.received`                    | First callback observation in the Worker `fetch` function                                                     |
| `callback.ingress.load`                        | Loading the selected callback handler and its dependencies                                                    |
| `callback.ingress.total`                       | Forwarding and scoped handling until the response is ready                                                    |
| `callback.db.client-construct`                 | Successful synchronous construction of the request's lazy Prisma client                                       |
| `callback.auth` / `image-callback.auth`        | Signed callback URL validation                                                                                |
| `callback.body` / `image-callback.body`        | Bounded body reading; Kie also validates the task ID shape                                                    |
| `image-callback.signature`                     | SeeAPI timestamp and raw-byte signature verification                                                          |
| `callback.database` / `image-callback.persist` | Whole callback transaction and its result                                                                     |
| `*.db.transaction-start`                       | Calling the transaction API until its body starts, including any first-use runtime and connection acquisition |
| `image-callback.db.lock`                       | Advisory-lock statement, including round trip and lock wait                                                   |
| `*.db.read`                                    | State read; Kie's existing `FOR UPDATE` also includes its row-lock wait                                       |
| `*.db.persist`                                 | Existing notification/due-time writes, when required                                                          |
| `*.db.owner`                                   | Reading the current phase owner, only for a ready wake                                                        |
| `*.db.transaction-finish`                      | Transaction body completion until commit/rollback acknowledgement or failure                                  |
| `callback.wake` / `image-callback.wake`        | Sending the wake and checking its acknowledgement                                                             |

The subspans overlap their parent spans. Kie's `db.owner` can also be nested in
`db.persist`; do not sum them twice. An `ok` timing outcome means its operation
returned, not that an HTTP response approved content. A missing span is unknown,
not zero. Instrumentation failures cannot change the business result or replay
a failed/uncertain transaction.

The entry marker does not measure provider send time, network arrival before
JavaScript runs, or Worker module initialization before `fetch`. These spans are
not pure SQL/CPU measurements. Connection wait and server SQL execution remain
unknown unless independently measured. Provider completion/send evidence and
cross-runtime clock alignment are still needed to assign the full delay.

## Verification and rollout

Focused tests cover both exact ingress routes, unchanged non-image routes,
canonical-origin rejection, raw-body preservation, cleanup, failure without
fallback, signatures, deduplication and diagnostics failure. The existing
PostgreSQL callback and phase-owner regressions retain the real lock/transaction
evidence. The final website artifact smoke now rejects unsigned image callbacks
and, with `--database`, validates correctly signed callbacks for nonexistent
identities against an isolated local database. It never creates a provider task
or treats a test callback as a moderation verdict.

This change needs a website deployment to activate the direct ingress. It does
not require changing supplier callback URLs or draining Workflow versions. The
jobs/database changes are optional observations around unchanged queries.
Rolling the website back restores its existing Hono ingress and polling.
Local checks and a workerd artifact smoke do not establish live supplier callback
timing or a fixed number of seconds saved.
