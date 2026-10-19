# Production guest upload investigation — 2026-10-19 UTC

Read-only investigation. No production writes, deployments, migrations, paid generation calls, model calls, secret reads, IP values, cookies, tokens, prompts, or image contents.

## Verified deployment

Observed production log records use website Worker `ezimageai-site-production`, script version `8476f8d4-6d41-469b-aa8f-a8c612f45c36`, application `deploymentVersion` `174e29ee1576fb1eb907249ed0480e0e9f0f1734`.

This evidence concerns the website upload-intent boundary. It does not certify the jobs Worker or provider execution.

## Fixed 24-hour window

Window: `2026-10-18T15:11:55.247Z` through `2026-10-19T15:11:55.247Z`.

Cloudflare Workers telemetry query, `dry:true`, dataset `cloudflare-workers`, website service, `/api/media/guest-drafts/upload-intents`:

| HTTP status | Request count | Distinct network count |
| ----------- | ------------: | ---------------------: |
| 200         |             5 |                      5 |
| 500         |            40 |                     22 |

The distinct network calculation ran on the data source and returned only a count. No IP value was returned or inspected. A network count is not a person count.

Separate matching OpenAPI-error aggregation returned `count=40`, distinct request count `40`, and only one stable message: `GUEST_UPLOAD_RATE_LIMITED`.

These fixed-window aggregate responses reported `abr_level=1` and `sampleInterval=1`. Other event queries, particularly seven-day queries, sometimes reported `abr_level=10`; their returned records/counts are sampled and must not be mixed with this fixed-window count. Earlier approximate seven-day estimates are not exact totals.

## Correlated error samples

All samples use `POST /api/media/guest-drafts/upload-intents` and HTTP 500. Safe log:

```text
ERROR OpenAPI request failed { name: 'Error', code: undefined, message: 'GUEST_UPLOAD_RATE_LIMITED' }
```

| Response time UTC       | Cloudflare request ID              | Application request ID                 |
| ----------------------- | ---------------------------------- | -------------------------------------- |
| 2026-10-19 09:48:53.475 | `170914d81040a78e944f94fe59dc48dd` | `250c95bd-9977-4660-9bd5-2f6ebcf0e45e` |
| 2026-10-19 05:48:43.576 | `c05026bf58eb8896cd770dada61d6fe2` | `b1186f25-072a-4b17-af2d-1db6f147e96a` |
| 2026-10-19 04:52:14.546 | `3546be5ecd83237b73fde00c370d8603` | `2f1fcca4-9834-49f6-85d4-3398ff8cf493` |
| 2026-10-18 04:45:40.270 | `8464f53f79cc7cb8bdabf371d110f5db` | `12c555ce-f275-4833-8e6b-468a4af2c09a` |

The first three full-correlated samples had Worker runtime `outcome=ok`: the application returned an error response rather than a Worker runtime crash.

## Exact database bucket evidence

Production project was matched through both `docs/operations/cloudflare-hosting-runbook.md:23` and Supabase `list_projects`: `ezimageai-production` / `cresrmesgalqdgbxtyvm`, same organization and Singapore region.

Only aggregate/count/window columns were selected from `guest_abuse_bucket`. No subject hash was returned.

Every `guest-upload:global:day` bucket from October 12–19 contains exactly five committed accepted intents:

| UTC day    | Committed count | Last accepted database timestamp UTC |
| ---------- | --------------: | ------------------------------------ |
| 2026-10-12 |               5 | 05:26:10.578                         |
| 2026-10-13 |               5 | 08:16:15.294                         |
| 2026-10-14 |               5 | 07:51:07.172                         |
| 2026-10-15 |               5 | 07:55:30.775                         |
| 2026-10-16 |               5 | 07:26:27.276                         |
| 2026-10-17 |               5 | 08:03:41.383                         |
| 2026-10-18 |               5 | 04:41:56.677                         |
| 2026-10-19 |               5 | 02:51:40.415                         |

Across these eight dates, the maximum committed global minute count is 1, global hour count is 4, IP ten-minute count is 2, IP day count is 3, and subnet day count is 3. These are observed counts, not confirmed configured thresholds.

On October 19, the five committed IP-day buckets and five subnet-day buckets each contain one accepted intent. Global hour counts are 2 and 3; each global minute has one.

All selected rejection counters are zero. Code throws inside the rate-limit transaction on rejection, rolling back the failed increment. Therefore zero stored rejections does not mean no rejected requests.

## Transition chronology

Narrow Cloudflare event queries returned `abr_level=1`:

- October 18: fifth HTTP 200 at `04:41:59.775Z`, CF request `5498595bc9876d834f1886cfd574eb9a`; following intent at `04:45:40.270Z` returned 500 / `GUEST_UPLOAD_RATE_LIMITED`. Later sampled requests remain 500.
- After the next UTC reset, October 19 returned HTTP 200 at `01:24:48.353Z` (CF `fe90af87f16c6d93a1d5f08027d3655e`), `01:41:35.378Z`, `02:16:36.381Z`, `02:48:36.153Z`, and `02:51:45.352Z` (CF `f5fb719f9903a475795b7e6da8d17912`).
- The next observed October 19 request at `04:52:14.546Z` returned 500 / `GUEST_UPLOAD_RATE_LIMITED`; the full unsampled day query through `15:14:21.678Z` contained five HTTP 200 and 21 HTTP 500 records and no subsequent HTTP 200. The database agrees no later intent was committed.
- Short-window rejection also exists: October 18 first success at `00:49:12.266Z`; `00:49:55.144Z` and `00:49:59.602Z` returned 500 / the same rate-limit code; `00:50:16.250Z` returned 200. Do not describe every failure as occurring only after the daily five successes.

## Confirmed failure stage and limits of attribution

`create-guest-upload-intent.ts` verifies and consumes Turnstile evidence before calling `createGuestMediaUploadIntentTransaction`. The database function throws `GUEST_UPLOAD_RATE_LIMITED` during guest-boundary abuse checks, before allocating the upload session/signing an upload URL. These correlated failures are past Turnstile verification and before upload completion, moderation, draft/task creation, credits admission, and provider requests.

The database rate limiter combines IP ten-minute/day, subnet day, and global minute/hour/day scopes into the same error. Existing logs do not identify the rejected scope. The eight-day five-intent plateau plus UTC-reset recovery is strong evidence of a restrictive global daily limit, but it does not prove the configured numeric threshold or attribute every request to that scope.

The active version exposes all six exact limit bindings as `secret_text`: `GUEST_IP_MAX_PER_10_MINUTES`, `GUEST_IP_MAX_PER_24_HOURS`, `GUEST_SUBNET_MAX_PER_24_HOURS`, `GUEST_GLOBAL_MAX_PER_MINUTE`, `GUEST_GLOBAL_MAX_PER_HOUR`, `GUEST_GLOBAL_MAX_PER_24_HOURS`. Their values were not read. `MEDIA_TRUSTED_PROXY_PROVIDER=cloudflare` is plain text. The public capability does not expose admission limits.

Repository production validation permits at most IP 2/ten minutes, IP 3/day, subnet 20/day, global 3/minute, 30/hour, 100/day. These are source-code ceilings; they must not be reported as the active configuration.

No evidence establishes provider outage, credit failure, corrupted image content, or Turnstile root cause for these 40 failures. The Clarity sessions cannot be individually matched without their network/request correlation data. Same-user and shared-network misclassification remain unverified. No production threshold was changed.

## Follow-up: completion polling frequency

Same fixed 24-hour window (`2026-10-18T15:11:55.247Z` through `2026-10-19T15:11:55.247Z`), website Worker, `/api/media/guest-drafts/upload-completions`, HTTP 200 only:

| Requests per network | Number of networks |
| -------------------: | -----------------: |
|                    3 |                  1 |
|                    5 |                  1 |
|                   11 |                  1 |
|                   29 |                  1 |
|                   58 |                  1 |

Total 106 HTTP 200 requests across five networks. Maximum 58; zero networks with at least 60. Response reported `abr_level=1`, each aggregate `sampleInterval=1`. Network grouping occurred in Cloudflare; only counts and distribution were returned, with no IP values or persistent hashes.

The log query for `PENDING|READY|GUEST_UPLOAD_COMPLETION_TIMEOUT` on this completion route returned count zero (`abr_level=1`). The procedure returns both PENDING and READY as HTTP 200 and does not log those application states. The client permits 60 attempts and throws on its final PENDING response, but this cannot be observed from HTTP status alone.

Therefore these logs do not establish a 60-PENDING timeout followed by a fresh upload intent. They also do not establish whether the 58 requests belong to one completion session, several sessions, or multiple people behind a shared network. Window boundaries can truncate a sequence. No additional identity data was read to link these requests.
