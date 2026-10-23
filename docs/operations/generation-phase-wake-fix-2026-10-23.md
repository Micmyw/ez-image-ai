# Image callback Workflow wake failure

## Cause

The real image test at `c9d2aac` completed through durable polling, but both Kie
and SeeAPI output callbacks failed at `WorkflowInstance.sendEvent` after their
notifications had already been persisted. The failing phase event type was
`image-phase:<phaseKey>:<epoch>`.

An isolated Cloudflare Workflow reproduced the SDK failure on 2026-10-23:

| Event type                                           | Actual cloud binding result                                    |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `image-phase:7cc53c18-5feb-4fb1-b8a9-0c8dbd2ccbb0:1` | `(workflow.invalid_event_type) Provided event type is invalid` |
| `image-phase-7cc53c18-5feb-4fb1-b8a9-0c8dbd2ccbb0-1` | Sent and received successfully                                 |

The temporary probe had only its own Workflow binding, no database, storage,
provider or production bindings, and a default HTTP handler returning 404.
It did not generate images or modify customer data. This confirms the cloud
binding restriction, beyond the REST schema's alphanumeric/hyphen/underscore
rule. Local workerd accepts the old colon type, which explains why earlier
local tests did not detect the failure.

Cloudflare reference: [Workflow Workers API](https://developers.cloudflare.com/workflows/build/workers-api/).

## Fix and boundaries

- Sending and waiting use the same `imagePhaseEventType` formatter with hyphens.
- Validate the 100-character limit before the signed ingress obtains an instance.
  Reject oversized types; truncation could collide across phase identities.
  Database-issued UUID phase keys fit even at the maximum safe integer epoch.
- Map only the observed fixed error marker to `INVALID_EVENT_TYPE`; never log
  raw errors, private URLs, signatures or provider payloads.
- Retain signature checks, owner/phase/epoch identity, durable notification
  evidence, authenticated provider retrieval and timeout recovery. Sending an
  event does not approve an image or authorize another provider submission.

The user explicitly requested omitting old-task compatibility for this fix.
There is no versioned event-name branch or dual sending. No database migration,
secret change, feature flag, UI change or polling-frequency change is required.
The current production target is the Workers jobs service; its sender and waiter
are released together. The website transports the unchanged private owner tuple.

## Verification

`image-phase-event.test.ts` failed against the original formatter for UUID
phase identities and the maximum event length. The signed-ingress regression
also failed with 503 when its binding enforced the real cloud alphabet. Both
pass with the fix. Workerd coverage exercises model and review phase wakes,
early and duplicate events, stale epochs, phase isolation and lost-event polling.

The isolated cloud probe also bundles the actual `handlePhaseWake`, `runPolling`
and formatter from this checkout. Only the business query result is synthetic;
HMAC ingress, Workflow binding, persisted steps and event delivery run in the
cloud. Review and generation waits consume epoch 7, not the injected stale epoch
6, and complete through the next query without waiting for the 60-second timeout.

This is live cloud signaling evidence, not a new paid generation test or a
measurement of end-to-end production latency. The temporary Worker/Workflow
must be removed after recording results. Ignored local evidence is stored under
`.cache/phase-wake-fix-20261023/`.
