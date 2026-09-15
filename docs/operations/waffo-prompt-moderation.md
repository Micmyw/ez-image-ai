# Waffo pre-generation prompt scanning

The production Waffo integration requires a successful prompt scan before image generation,
including guests and customers using another payment method. It uses the same merchant credentials
and SDK 0.19.1 as payments. `WAFFO_ENVIRONMENT=prod` automatically enables the additional check;
there is no separate production bypass flag. Local test adapters retain their existing restrictions.

## Request and decision contract

Official reference: [Scan prompt](https://docs.waffo.ai/zh/api-reference/endpoints/content-safety/scan-prompt).

- The shared SDK signs `POST https://api.waffo.ai/v1/actions/verification/scan-prompt`.
- This stateless request omits the SDK's optional prompt-derived idempotency header so identical
  text receives a fresh safety verdict. Payment order idempotency still uses the existing SDK path.
- Request fields are `prompt`, `locale=en`, and `semantic=enforce`. Blank text and text above
  10,000 characters are rejected locally. This preserves the current English prompt contract.
- Only a complete `allow / allowed / scored` verdict with no matched categories authorizes
  generation. `block` rejects; `review` pauses; degraded, malformed, contradictory, or unavailable
  results fail closed. A missing verdict is never an allowance.
- The scan transport rejects non-2xx HTTP statuses and redirects, limits response bodies to 64 KiB,
  and shares the existing 15-second request deadline. It makes one request per scan attempt;
  retries happen through a new user attempt, without an inline loop or unapproved generation.

Sightengine runs first. Text it denies does not need a Waffo request because generation has already
stopped. The common API factory supplies this chain to quote creation, guest admission, and retries.
It does not alter input/output image verification, credit settlement, or provider execution.

The new text rule is `text-safety-2026-09-16.1`. Existing transaction validation rejects quotes
approved under the old rule. Approved private quote audits identify `sightengine+waffo` and retain
the Waffo request reference, decision, semantic status, and allowlisted category names alongside
Sightengine evidence. Raw prompt copies, private keys, upstream error messages, and raw responses
are excluded from these audit records. Guest denials retain their existing bounded abuse evidence.
No database migration is needed because the existing private audit JSON stores this evidence.

## Verification

Focused commands:

```sh
pnpm --filter @repo/payments test provider/waffo/content-safety.test.ts
pnpm --filter @repo/api test modules/media/lib/text-moderation.test.ts modules/media/lib/guest-admission.test.ts modules/media/procedures/create-quote.test.ts modules/media/procedures/create-generation.test.ts modules/media/procedures/retry-generation.test.ts
```

The regression first demonstrated that Waffo rejection/review/errors were ignored by the old
quote factory, then passed with the composed safety chain. Provider-boundary tests cover signed
requests, semantic enforcement, redacted evidence, invalid inputs/verdicts, HTTP failures,
oversized bodies, invalid JSON, missing credentials, and timeouts without live unit-test calls.

Two synthetic prompts were sent directly to the production API on 2026-09-15 UTC: the harmless
landscape returned `allow / allowed / scored`; restricted adult content returned
`review / review_required / scored` with `adult_nsfw`. The latter must not generate. Private local
evidence preserves both request IDs without user content. These requests made no image-generation
call, payment charge, or refund, and do not certify Waffo merchant approval or payment collection.

The composed application adapter also authenticated against both production services and returned
`ALLOW` with both redacted request references. An identical prompt initially reused the SDK's old
scan request ID; omitting the optional idempotency header produced a new Waffo request ID. The
signed-request regression failed before this correction and passed afterward.
