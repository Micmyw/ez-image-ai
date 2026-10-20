# Annual pricing and unified-credit rollout review

Status on 2026-10-20: the user explicitly requires one generation-credit system. Purchase discounts do not reduce a credit's usage value. The former proposal excluding new annual lots from independent templates is rejected. No new profit-policy decision is required to implement shared funding. Waffo price activation remains paused until compatible reuse of the original product IDs and real versions is tested and deployed.

## Historical finding

The original candidate preserved approved video quotes with a historical 21,944 USD-micros retail reference, while annual receipts were 13,571/13,611/13,166 micros per promised credit. Main originally derives that floor dynamically; the historical constant was a candidate addition, not an old fixed policy. Under the old independent-template allocator, new lots failed with `INSUFFICIENT_PAID_CREDITS` (public `INSUFFICIENT_ELIGIBLE_CREDITS`). This economic source filter is being removed from new template generation rather than converted into a product restriction.

## Required implementation

New images, ordinary video and independent templates use the same valid shared account credits. New video templates freeze explicit `shared-media-credits-v1` and `paidRevenueQualified: false`; economic reference calculations do not certify actual lot income or block shared funding. Historic accepted paid/internal policies remain immutable. Unknown or missing modes never silently opt old jobs into shared funding. Scene and final-video receivers must support the explicit policy before producer activation.

Retain owner/asset authorization, expiry, refund and chargeback revocation, debt, account/lot locks, insufficient-balance checks, idempotent reservations/settlement/returns and uncertain-provider no-resubmit protections. Do not delete ledger/payment provenance or merely set a paid-only threshold to zero. Annual subscription identity remains the eligibility for existing annual video discounts. USD1 image passes remain separate and explicitly selected.

## Evidence and pending checks

Producer/helper/API fail-first tests reproduced seven failures, then configuration 861 tests, template producer 68 tests and effect API 43 tests passed. Ordinary image API six new-annual cases and ordinary-video 111 tests passed in the superseded 1ba4cb4 CI PostgreSQL step; that whole job was subsequently canceled, not reported as a fully green run. New template tests use real isolated twelve-period receipts and actual monthly lots for both channels and all tiers. Test-only commit ffd093bb is intended to demonstrate the old three-stage receiver rejection before its fix. Complete CI, refund/concurrency regressions and receiver-first rollout evidence remain required. No real model generation or payment is authorized.

Public copy removes unapproved annual-only exclusions. The unchanged homepage aggregate gzip budget still requires CI measurement.
