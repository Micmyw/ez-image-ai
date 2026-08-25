# EzPic growth, SEO, and operations contract

This document records the PR 7 growth boundary on top of the existing EzPic marketing, editor,
payments, generation, credit, storage, moderation, Provider-routing, and admin systems. It does not
introduce a second analytics backend, job system, credit ledger, storage layer, or operational state
store.

## Search indexing boundary

`NEXT_PUBLIC_MARKETING_URL` is the only canonical origin. Production must configure a real HTTPS
marketing origin; reserved `.invalid` hosts, credentials in the URL, and insecure non-loopback
origins fail closed. Local loopback HTTP remains supported for tests.

Only the default-English versions of these paths are indexable:

| Path       | Index policy    | Purpose                         |
| ---------- | --------------- | ------------------------------- |
| `/`        | `index, follow` | Image editor homepage           |
| `/pricing` | `index, follow` | Canonical plan comparison       |
| `/privacy` | `index, follow` | Product privacy and data limits |
| `/terms`   | `index, follow` | Product usage terms             |

The sitemap contains exactly those four URLs. Other marketing routes and every non-English locale
are `noindex, follow`. The SaaS application—including login, create, history, assets, edits,
checkout, settings, and admin—is `noindex, nofollow`, and its robots route disallows crawling.
Legacy `/legal/*` routes remain available for compatibility but inherit `noindex`.

Homepage structured data contains `WebSite`, `Organization`, and `SoftwareApplication`. Paid
`Offer` nodes are emitted only when the matching configured Stripe Price ID is valid; their amount
and currency come from `PLAN_ENTITLEMENTS`. A missing or invalid Price ID produces no purchasable
offer claim. The homepage Showcase uses only the original assets recorded in
`apps/marketing/public/examples/PROVENANCE.md`.

Google Search Console verification is optional through
`NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION`. A missing, malformed, placeholder, or replacement token is
not rendered. A real GSC token, domain verification, sitemap submission, crawl, and live search
inspection remain external release evidence.

## Consented editing funnel

The shared Zod contract permits exactly these events:

1. `landing_viewed`
2. `example_prompt_selected`
3. `source_upload_started`
4. `source_upload_completed`
5. `marketing_draft_created`
6. `auth_handoff_started`
7. `draft_claimed`
8. `editor_quote_created`
9. `editor_generation_confirmed`
10. `editor_generation_succeeded`
11. `editor_generation_failed`
12. `result_compared`
13. `result_downloaded`
14. `edit_again_started`
15. `edit_session_opened`
16. `upgrade_prompt_viewed`
17. `checkout_started`
18. `subscription_activated`

Event properties are strict and may contain only an enumerated plan, the public `image-fast` or
`image-quality` product key, an enumerated status, a credits bucket, a latency bucket, or a
SHA-256-labelled anonymous session hash. Internal identifiers may be used only in the in-memory
dedupe key and are never included in the event detail.

Both schema validation and the dispatcher reject prompts, filenames, asset/object/signed URLs, raw
job IDs, email addresses, cookies, tokens, Provider names, model IDs, Provider cost, and raw
Provider/request/response data. Events are blocked until the existing `consent=true` choice is
present. A blocked or failed send is not marked delivered; a successfully dispatched dedupe key is
delivered once for that browser runtime.

The browser transport currently dispatches only the local `ezpic:growth-event` `CustomEvent` used
by deterministic tests. No external analytics ingestion is configured or certified by this PR.
Adding a real listener later must retain the same schema, consent gate, sensitive-data rejection,
and dedupe semantics.

## Read-only admin operations

The existing admin media surface includes a read-only growth operations panel backed by an
`adminProcedure` and aggregate queries over the existing PostgreSQL media tables. It accepts only
Standard/Quality product, Provider, model, status, and half-open date-range filters. It accepts no
owner, tenant, prompt, asset, URL, or raw job input.

The response reports aggregate job/success/failure counts, success rate, successful-attempt p50 and
p95 latency, average Provider cost in micros, moderation rejection rate, failure-code counts,
reserved/charged/released credits, repeat-edit-session rate, route counts, and effective global and
product controls. It returns no prompt, private image, asset ID, signed URL, raw job ID, Provider
payload, or credential. Existing admin authentication and role middleware remain authoritative;
there is no public or tenant-scoped variant.

Operational interpretation:

- Date filters are `[from, to)` in UTC and apply to job creation time.
- An omitted `to` defaults to the request time, and the effective range is still limited to 366 days.
- Success rate uses terminal `SUCCEEDED` and `FAILED` jobs; cancellation is not counted as either.
- Latency uses the latest attempt's submitted/completed timestamps for successful jobs.
- Provider cost is an internal admin aggregate and must never be copied to public analytics or UI.
- Moderation rejection uses the latest input-asset moderation decision.
- Failure values outside the normalized uppercase code contract aggregate as `UNCLASSIFIED_FAILURE`.
- Repeat-edit rate is the share of filtered edit sessions containing more than one job.
- Controls combine the configured global generation switch with active runtime overrides.

## Verification, rollback, and external status

The change is application-only and adds no database schema or migration. Rollback is the previous
application commit; existing media, payment, job, credit, Outbox, subscription, and runtime-control
rows need no rewrite. During a growth-only incident, remove or disable the analytics listener while
leaving generation and billing state untouched. During an operations incident, retain the existing
generation/product kill switches and diagnose from PostgreSQL aggregates rather than editing
business rows.

Local verification uses Vitest, an isolated PostgreSQL test database, local browser `CustomEvent`
fixtures, test Provider/moderation adapters, and production-build Playwright. It does not certify
real GSC verification, external analytics ingestion, Provider or Trigger.dev execution, Stripe,
cloud storage, production moderation, deployment, or live SEO/event delivery. Those items remain
`NOT_COMPLETED` until separately evidenced without exposing credentials.
