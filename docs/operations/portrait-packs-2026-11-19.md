# Portrait Packs

The editor offers the pack after a confirmed image prompt, input or result rejection. The offer opens a separate experience after the user accepts. The public `/portrait-packs` page is also available from AI Tools. Both enter the same server-authorized opening flow. The request carries only a UUID.

## Access

- The signed browser and the registered account each have two openings. Each opening has a durable receipt with five different artwork IDs. Replaying an existing request returns its original cards. A browser that loses its cookie loses its guest identity.
- A paid subscription period or fulfilled credit pack linked to a verified live payment unlocks unlimited openings. Subscription expiration, cancellation, balance exhaustion and credit expiration do not affect eligibility. Fully reversed payments, sandbox payments and Image Pass purchases contribute no entitlement. An organization checkout belongs to the verified purchaser for this feature.
- Static illustrations are served as image assets. Opening makes no generation request and is free of credits. The user can view or save the cards. Payment eligibility reads the existing purchase and payment evidence without writing financial state.

Apply `20261119133000_portrait_pack_trial` before deploying the application reader and writer. The receipt table uses the same private append-only application permissions as the guest trial receipts. Keep the v1 card IDs and files available for existing receipts.

## Click-rate measurement

In Admin Analytics → Conversion, Portrait Packs shows invitation and draw click rates separately for the homepage popup, editor popup, and standalone page. An exposure means the relevant enabled CTA was visible in an active tab; a draw click means the user started opening by clicking, tapping, or swiping, regardless of whether the request succeeded. The rate is the number of distinct consented browsers that both saw and activated the same CTA at the same placement, divided by the number that saw it, within the selected time, source and device filters. Internal browsers are excluded.

Events use the existing `growth_event` table and its retention; there is no analytics migration, historical backfill or new third-party tracking. Events record only the placement, CTA and stage using the existing first-party consent and session mechanism, never the blocked content, moderation reason, card, job or trial-request IDs. Trial receipts are separate and do not measure clicks.

## Artwork

The built-in OpenAI ImageGen tool produced the 36-card library. The prompts covered opaque evening gowns, cocktail dresses with black tights and heels, and opaque swimwear at a beach or pool. The three replacement portraits use blue, lilac and cherry short dresses with distinct winking, turning and seated expressions. The next sheet adds nine poses in a bar, theater, gallery, atrium and hotel. The prompts specified fictional adult models and ordinary fashion photography. The photos were exported as WebP under `apps/saas/public/images/portrait-packs/v1`. A new pack includes a playful, an evening and a resort look, plus two other cards.

The artwork was reviewed visually. Generation-provider moderation and real payments are separate from the local checks for this feature.
