# PayPal image pass implementation plan

> For agentic workers: follow the approved parent task, native implementation with parallel payment/UI/jobs owners, and independent review before integration.

Goal: sell repeatable USD 1 / three successful single images through existing PayPal with an independent entitlement ledger.

Architecture: immutable server-priced checkout snapshot, three individually tracked units, per-job reservation and explicit funding. Current generation/moderation/storage/owner safety boundaries remain authoritative. No ordinary credit grant or automatic funding fallback.

Spec: `docs/superpowers/specs/2026-10-19-image-pass-design.md`.

Global constraints: no real payment or generation; no production migration/push/PR/deployment before review and coordination; retain exact USD 1 and three units, every current image SKU including 4K, no video/subscription; no invented expiry.

Review focus: concurrent fourth admission, changed funding on replay, provider uncertainty followed by late success, refund concurrent with admission/finalization, successful provider response with unusable/multiple outputs.

- [ ] Core schema and ledger: `prisma/schema.prisma`, `20261019010000_image_pass/migration.sql`, `queries/media/image-passes.ts`. Test actual tagged-SQL helpers against an independent PostgreSQL database, no quota/ledger mocks. Exports: fulfillment/revoke helpers given to payment owner; balance, selection, reserve/finalize and generic job funding lookup helpers given to API/jobs owners.
- [ ] Media authorization: quote/submit/retry DTOs freeze `fundingSource`; API preflight and transaction-current admission separately validate pass ownership/SKU availability and preserve free plan limits. Job reserves exactly one unit, no CreditReservation. Test current credit compatibility and explicit insufficient funding without fallback.
- [ ] Jobs consumer: generic reservation guards preserve unknown holds; finalization accepts one pass output; terminal settle consumes once for a usable output and releases once for a safe failed/canceled outcome; late success/recovery and zero-cost rejection preserve binding. Extend recovery selection to canceled jobs with active pass reservations. Test replay/refund/unknown outcomes.
- [ ] Payment owner implements server offer, generic checkout persistence, PayPal create/capture/state and verified reducer integration. Duplicate capture/webhook/return and refund/dispute tests; no paid acceptance call.
- [ ] UI owner implements responsive banner, purchase/return and explicit composer funding with all current image options while runtime availability remains enforced. Single-image promise visible, no subscription wording/behavior.
- [ ] Run focused suites, local PostgreSQL regressions, existing package suites and feasible type/format checks; record blocked generated-client suites and actual result counts; independently review complete combined diff and migration, then report exact rollout prerequisites.
