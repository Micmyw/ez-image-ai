# Configurable text and image moderation

The API and jobs runtime must receive the same server-only configuration. This selects the initial
Waffo text + SeeAPI image combination without Sightengine calls:

```dotenv
MEDIA_SAFETY_ADAPTER=configured
MEDIA_ALLOW_TEST_SAFETY_ADAPTER=false
MODERATION_TEXT_WAFFO_ENABLED=true
MODERATION_TEXT_SIGHTENGINE_ENABLED=false
MODERATION_IMAGE_SEEAPI_ENABLED=true
MODERATION_IMAGE_SIGHTENGINE_ENABLED=false
WAFFO_MERCHANT_ID=<merchant ID>
WAFFO_PRIVATE_KEY=<merchant RSA private key>
SEEAPI_API_KEY=<SeeAPI key>
```

Keep credentials in ignored environment files or runtime secrets. Never prefix them with
`NEXT_PUBLIC_`. The moderation switches are server configuration, not browser controls. After a
configuration change, restart/redeploy both API and job workers through the normal release process.
Preparing a local production environment file does not activate it on the deployed service.

## Switch behavior

| Enabled checks              | Behavior                                                                    |
| --------------------------- | --------------------------------------------------------------------------- |
| Waffo text only             | Merchant-signed prompt scan; no Sightengine request or credentials required |
| Sightengine text only       | Existing English text profile; no Waffo request or credentials required     |
| Both text checks            | Sightengine then Waffo, stopping at the first non-allow result              |
| SeeAPI images only          | One asynchronous task per verified image, then poll the persisted task ID   |
| Sightengine images only     | Existing synchronous image profile                                          |
| Both image checks           | SeeAPI then Sightengine; only allow when both approve                       |
| No check for a content type | Configuration error; that content cannot pass                               |

Enable either Sightengine switch and supply `SIGHTENGINE_API_USER` and `SIGHTENGINE_API_SECRET`
to restore its corresponding checks. The old `MEDIA_SAFETY_ADAPTER=sightengine` setting remains
compatible, including its legacy production-Waffo text layer. Explicit switches apply in
`configured` mode. The test adapter remains forbidden in production.

Waffo's scan is a merchant-signed verification action at the fixed API origin, independent of
checkout sessions. It needs the merchant ID and RSA private key, not checkout product IDs or a
payment webhook public key; changing moderation does not change `WAFFO_ENVIRONMENT`. The request
uses `locale=en`, `semantic=enforce`. Only a complete `allow` with semantic status `scored` and no
matched categories or warnings authorizes generation. Neither service availability nor a free
quota is guaranteed by this integration.

SeeAPI uses `POST https://api.seeapi.com/v1/inferences`, with model `nsfw-filter`, endpoint
`image-moderation`, provider `seeapi`, `threshold_offset=0`, and `strict_special_care=true`.
Its bearer credential and the image's short-lived private access URL stay server-side. HTTP 202
and task status `succeeded` do not mean approval: the worker polls `GET /v1/inferences/{id}` and
requires a complete successful result with `flagged=false` and empty category lists. A definite
flag rejects; unexpected labels without a flag require review. Invalid, incomplete, timed-out,
or unavailable checks never approve an image. The existing 20 MiB image limit is preserved.

Task binding, verification leases, checksum, rule/policy versions, retries, and uncertainty gates
use the existing private-media path. Recovery polls the same bound task; an uncertain submission
without a task ID is withheld for recovery/review, not resubmitted blindly. Detector combinations
form the evidence identity, so changing enabled checks cannot reuse an approval from a different
combination. Text quotes also bind their approved detector combination before credit reservation.

## Coverage and operating cost

Waffo's documented categories focus on sexual content and exploitation; SeeAPI's interface returns
NSFW/special-care labels without a complete documented hate/violence taxonomy. This initial
combination is not evidence of complete violence, hate, identity/consent, copyright, or child-age
verification. Review those requirements with the payment provider and use the Sightengine profiles
where their additional coverage is needed. No detector setup guarantees card-network compliance.
See [the Sightengine profile](./sightengine-moderation.md) for categories, thresholds, and limits.

Cost is controlled by switching unused providers off, screening prompts before generation,
reusing approvals only for the exact unchanged private asset and current detector policy, and
persisting SeeAPI tasks before polling. Generation-provider safety checks remain an extra layer.
The app does not assume the image generator refunds its own charges after a blocked result.

## Credit settlement and rollout

Apply `20260916000000_output_moderation_grace` through the normal database deployment process
before starting this application/worker version. The migration adds one nullable field on the
billing account; existing records start with an unused waiver. Generated clients must match the
schema. Do not reset or migrate an unrelated/production database while running local tests.

New quotes freeze `outputModerationBillingPolicy=first-block-free-v1`. When no approved output is
available and matching current evidence confirms a content rejection, settlement atomically
claims the account's lifetime waiver and settles zero credits; later such jobs settle the frozen
quoted maximum. It uses the existing reservation, immutable ledger, serializable transaction, and
stable `settle:<jobId>` reference. Concurrent jobs cannot both claim the waiver; retries/replays
cannot charge twice. USER and ORGANIZATION credit accounts retain separate lifetime state, and
deleting a job or its media does not reset it. Current generation creation remains USER-scoped;
this change does not introduce organization generation routes.

Old quotes retain their old billing policy. Input rejection, uncertain/review results, inspection
errors, and technical failures do not claim the waiver. Sponsored guest jobs never claim an
account's waiver. Provider acceptance uncertainty still holds the reservation until resolved.
Partial usable output keeps the existing per-output settlement policy.

Results use `OUTPUT_CONTENT_BLOCKED_WAIVED` or `OUTPUT_CONTENT_BLOCKED_CHARGED` to explain the
confirmed billing outcome even after output-media cleanup. Images remain quarantined with no
public access. The quote screen discloses the rule, and the result/history views show the actual
charged/released amounts and appeal guidance. This credit waiver is distinct from a payment refund.

## References

- [Waffo scan prompt](https://docs.waffo.ai/zh/api-reference/endpoints/content-safety/scan-prompt)
- [SeeAPI image moderation](https://www.seeapi.com/docs/nsfw-filter/image-moderation/)

Local fixtures and database tests certify application behavior; they do not certify external
classifier accuracy. A live API smoke check establishes only the request/response exercised.
