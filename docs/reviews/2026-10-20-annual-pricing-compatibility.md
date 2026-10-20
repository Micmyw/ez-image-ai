# Annual pricing compatibility candidate — release blocked

Status on 2026-10-20: candidate implementation only. Production plan bindings, merge, and deployment remain paused. A new product restriction limiting discounted annual credits to images and ordinary video has **not** been approved. Public copy must neither present that restriction as the plan contract nor claim these new lots can fund independent templates.

## Unresolved funding conflict

The candidate catalog charges $114/$294/$474 for twelve monthly grants of 700/1,800/3,000 credits. Before fees or refunds, receipts divided by all promised credits yield at most 13,571/13,611/13,166 whole USD micros per credit. Before the catalog change, main derives the independent-template qualification floor dynamically from the sale catalog, producing 21,944. Changing the catalog alone lowers that derived floor to 13,166 and also changes approved video quotes. This compatibility candidate separates the historical retail reference from the actual sale floor and retains 21,944 for the pre-change approved template basis. A new annual lot cannot meet that candidate qualification. Qualified historical lots remain eligible under the unchanged receipt, refund, promised-credit, and bonus-credit checks; annual audience eligibility does not override lot qualification.

The allocator reports `INSUFFICIENT_PAID_CREDITS` when these lots cannot fund a template; the public template API maps this to `INSUFFICIENT_ELIGIBLE_CREDITS`. Having sufficient total credits alone does not resolve this conflict. Preserving the pre-change qualification value in this compatibility candidate is not approval of a newly restricted annual product. Resolving the intended product availability requires an explicit decision before release; this note does not authorize repricing, new cost approval, relaxed qualification, or an additional-purchase requirement.

## Preserved pricing and qualification

The historical retail reference belongs to approved version `video-retail-2026-10-08.1` and remains 21,944 USD micros per credit. It preserves approved credit quotes; it is not the actual receipt floor or evidence of profit on discounted or gifted credits. `videoPaidCreditFloorMicros()` truthfully reports the current sale catalog floor of 13,166. Rumpelstiltskin retains its original cost-version/reference bindings and financial checks. Accepted snapshots, per-lot receipt/refund calculations, and the allocation mechanism are unchanged; the historical reference is an explicit candidate addition, not a previously fixed policy on main.

Ordinary images and ordinary video use existing shared-credit reservations. Ordinary video explicitly records `paidRevenueQualified: false`; shared-credit access does not establish template funding eligibility. Existing annual audience discounts remain separate from funding qualification. For Seedance 2 Mini 720p silent video, the approved five-second quote is 96 standard / 66 annual credits and the ten-second quote is 199 / 124. Hotel Lobby and Raindance retain 69 / 69 for five seconds and 116 / 101 for ten seconds. No new Rumpelstiltskin price or margin is asserted.

## Verification boundaries

The original five real PostgreSQL funding regressions passed for both payment channels and all three annual tiers, including qualified historical lots, exclusion of lower-receipt new lots, twelve promised periods, refunds, and bonus-credit dilution. Existing CI also passed 105 video integration tests and 14 provider-availability tests before the new direct-generation cases were added.

New integration cases exercise actual default image quote/admission/reservation and actual ordinary-video eligibility, quote/admission/reservation for all six new annual tier/channel combinations, including five- and ten-second annual discounts. Local execution is blocked before test collection by the unavailable generated Prisma runtime client; the official schema-engine download returned HTTP 403. These additional cases require CI execution and are not yet passing evidence. No provider dispatch or real generation was performed.

Public FAQ and documentation remove the proposed new annual-specific template exclusion while retaining pre-existing generic eligible-credit rules. The homepage payload budget remains unchanged; compact annual FAQ text requires the normal CI artifact measurement. Passing that budget or the direct-generation regressions will not resolve the independent-template product decision above.
