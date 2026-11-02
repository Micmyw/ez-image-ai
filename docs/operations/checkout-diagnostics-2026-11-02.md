# Checkout diagnostics

Local implementation for one-time image passes and credit packs. This document does not certify deployment, live browser receipt, payment success or entitlement delivery.

## Evidence contract

| Observation                                    | What it establishes                                                                        | What it cannot establish                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Existing `PaymentCheckoutIntent`               | The site accepted purchase initiation and created a checkout                               | A marketing click was collected, or PayPal opened                                   |
| Browser `link_received` / `redirect_requested` | The browser reported receiving a link / requesting navigation                              | Arrival at PayPal or buyer approval                                                 |
| Browser `redirect_failed`                      | A synchronous navigation exception was reported                                            | The complete cause of a missing navigation; later network failures may be invisible |
| Browser `return_*`                             | A hydrated return component reported its approval/cancel flags (or lack/conflict of flags) | Genuine approval, a declined card, voluntary abandonment or payment success         |
| Server operation `started`                     | The server began that operation                                                            | The provider received or accepted a financial request                               |
| Server `capture/succeeded`                     | The authenticated PayPal capture response passed the existing order correlation checks     | Local event persistence or fulfillment                                              |
| Server `ingest/succeeded`                      | The existing verified payment-event ingestion returned successfully                        | The worker finished granting credits/images                                         |
| Local checkout `COMPLETED`                     | The authoritative local checkout reached its completed state                               | The absence of later refunds, disputes or frozen entitlements                       |

Server operations are `create`, `bind`, `recovery`, `capture` and `ingest`. An unresolved recovery returns `unconfirmed`, not `succeeded`. A provider HTTP error records only a fixed internal code, HTTP status, bounded provider issue and PayPal debug ID when available. An error is an observation for that operation, never a customer-fault classification. Timeouts and lost responses remain uncertain. Existing financial gates, idempotency keys, webhook ingestion and entitlement logic are unchanged.

Browser reports are operational support records, separate from optional marketing analytics and their consent policy. They contain only a local checkout ID and an allowlisted event; the server supplies authenticated actor, provenance and receipt time. No payment token, approval URL, referrer, fingerprint, card information or free text is accepted. Return events run after client hydration, so an RSC prefetch does not count as a return visit. Capture-request errors mean the browser did not receive a success response and can coexist with server success.

## Persistence and access

- Reuse `audit_log` with action `PAYMENT_CHECKOUT_DIAGNOSTIC` and target type `PAYMENT_CHECKOUT_INTENT`; no schema migration or historical backfill.
- Browser observations are first-seen receipts, deduplicated by checkout and event, at most eight per checkout. They are not visit counts, a full clickstream or proof of exact browser event order. Server attempt UUIDs correlate start/result; duration excludes diagnostic writes.
- Writes are awaited within the request-owned database lifetime and occur outside financial transactions. A storage exception emits a sanitized fallback log and leaves the payment operation's result intact; it does not retry payment or claim diagnostic receipt. Extra writes have a latency cost; live overhead is not measured by unit tests. A process termination, blocked/aborted beacon, lost session, unavailable database or retention can still leave gaps.
- `POST /api/payments/checkout-diagnostics` requires a same-origin authenticated non-anonymous session and checkout ownership. Organization checkouts require the active organization and billing-management authority. Client fields cannot create server evidence or mutate checkout state.
- `GET /api/admin/payments/checkout-diagnostics` requires administrator role and disables caching. It performs only local reads, no provider calls. It returns at most 20 checkouts and the latest 100 valid/invalid candidate receipts per checkout; truncation and unreadable entries are explicit.
- The dashboard scope is all image-pass/credit-pack checkouts created in its time range, including administrators. It is independent of the registration cohort and source/device filters above it. Exact ID search ignores the date range. Newest order queries currently use the existing checkout schema; evaluate an index separately if production volume warrants one.
- Audit retention and access follow the existing operational audit store. This change does not introduce a cleanup job or promise indefinite history.

## How to investigate

Open conversion monitoring and expand **订单支付诊断 / Checkout diagnostics**, or search by exact local checkout ID. Read local status, browser coverage and each server operation separately. A capture success followed by ingestion failure calls for site-side payment-event reconciliation through the existing authorized workflow; diagnostics do not authorize a second charge. An explicit provider issue can guide follow-up, but does not by itself prove a permanent buyer failure or absolve site integration.

Absent affirmative evidence, retain **付款未确认，原因未知 / Payment unconfirmed; cause unknown**. A creation-time provider status is not a current status; investigator queries must not be misattributed to customer checkout errors. The two historical October checkouts are not rewritten. Buyer-side PayPal login/card/3-D Secure details and the reason for leaving PayPal can still require customer feedback or PayPal support.

## Verification and rollout boundary

Focused database-contract, API authorization, provider-boundary, payment-idempotency, browser-transport and admin-label tests use synthetic fixtures. They verify diagnostic failure isolation and preserve financial behavior without charges, refunds or real checkout creation. Type/lint checks cover the affected workspaces. Production release and live observation remain a separate authorized step; enabling this code cannot recover missing historical events.
