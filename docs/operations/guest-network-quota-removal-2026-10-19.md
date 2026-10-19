# Guest network quota removal

This change removes IP and subnet business quotas from guest upload, temporary identity preparation, generation admission and the legacy public draft endpoint. A shared connection no longer owns a shared request allowance or active-job cap. No production counter rows are cleared.

Trusted proxy address parsing, Turnstile remote-IP verification, origin/capability/claim bindings and bounded historical HMAC evidence remain. IP evidence is not used to consume request buckets or reject new business work. Existing network denial categories remain readable for history.

The retained guest controls are session/device daily allowances and active jobs, global minute/hour request rates, bootstrap and temporary-principal capacity, queue depth/age, input byte/type validation and cost controls. Global hourly admission uses its own explicit setting and a 30/hour legacy-call fallback; it never falls back to a retired IP setting. Authenticated image/video entry points retain their existing account authorization and shared credits. Content review is unchanged.

The old `POST /media/drafts` no longer consumes the separate `marketing-draft` IP minute bucket or aggregates active drafts/bytes by IP-derived owner. Each request uses an independent random identity. Its global draft minute limit and input byte/type/model checks remain.

## Configuration compatibility

New code ignores old `GUEST_IP_MAX_ACTIVE_JOBS`, `GUEST_IP_MAX_PER_10_MINUTES`, `GUEST_IP_MAX_PER_24_HOURS`, `GUEST_SUBNET_MAX_PER_24_HOURS`, `MEDIA_MAX_ACTIVE_ANONYMOUS_DRAFTS` and `MEDIA_MAX_ANONYMOUS_DRAFT_BYTES` settings, including missing or malformed values. Old raw configuration packages are accepted. New runtime packages omit these exact keys; similarly named keys are preserved.

The existing staged-binding retirement only creates an undeployed version. Old serving versions retain their old bindings until new code is deployed. This branch does not publish anything or update production settings. It builds on the separately authorized global-daily-cap removal.

## Verification boundaries

Focused regression covers full old network buckets at upload/bootstrap/generation, independent active guests sharing an address, old configuration compatibility, preserved global minute/hour limits and the legacy public draft endpoint. A PostgreSQL-only fixture uses a uniquely named temporary schema in an explicitly selected loopback test database and executes the real bucket SQL; it does not generate or emulate a Prisma client. Existing full integration tests are updated for the new policy but require a genuine generated client before they can run.

Guest draft promotion into ACCOUNT retention is a separate change with its own cleanup-consumer rollout boundary; this network change does not alter historical guest result ownership, watermark, credits or access grants.
