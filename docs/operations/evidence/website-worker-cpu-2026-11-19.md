# Website Worker CPU review · 2026-11-19

## Production baseline

The target is under 20 CPU ms per website HTTP invocation, weighted by actual request count.
Cloudflare Workers Observability recorded 7,474 fetch events with a CPU field for
`ezimageai-site-production` from 12:40 on November 18 to 12:40 on November 19, China Standard Time.
They used 4,189,695 CPU ms, averaging 560.6 ms. The 1,837 events above one second used
3,237,287 CPU ms. The preceding seven-day window ending at the same time averaged 458.3 ms
across 66,280 events. These figures describe the service before the local changes.

At the one-day sample volume, reaching the target requires less than 149,480 CPU ms per day,
a reduction of over 96%. Exact GETs to the bare homepage accounted for 810,288 ms across
460 requests. Exact GETs to the bare Create URL accounted for 34,964 ms across 22 requests.
These URL groups can include sessions or request headers that bypass anonymous caching.
Account billing includes other scripts and Workflows.

## Final artifact on local workerd

The Linux OpenNext build and Wrangler dry-run produced the website Worker with SHA-256
`2f9ae3ba43a431846031a266792d8fe072182f6901786630a3f2dd4c33d893d7`.
The artifact smoke tests exercised the packed Worker, static assets, origin checks,
privacy policy, login boundary, callbacks and concurrent queries through a local PostgreSQL 16 database.
The smoke tests observed zero external HTTP requests.

Each row below used a fresh local workerd process, six warm-up requests and sequential measured requests.
The measurement divides the process's user and system CPU ticks by the request count. Linux reported
100 ticks per second. The endpoint and cache response were checked on every request. PostgreSQL ran
in its own process. This setup measures warm local costs and does not reproduce production cold starts,
geographic distribution or the Cloudflare billing meter.

| Website request                                                    | Measured requests | Mean local CPU ms |
| ------------------------------------------------------------------ | ----------------: | ----------------: |
| Exact analytics policy GET                                         |                28 |              1.07 |
| Analytics policy GET with query, through the existing REST handler |                28 |              5.36 |
| Main sitemap and image sitemap                                     |           28 each |         1.07 each |
| Robots file and site icon                                          |           28 each |         1.43 each |
| Edge health and application health                                 |           28 each |     1.43 and 5.71 |
| Anonymous homepage, cache HIT                                      |                28 |              6.07 |
| Anonymous homepage, forced MISS                                    |                12 |             48.33 |
| Anonymous Create document                                          |                12 |             44.17 |
| Empty session                                                      |                28 |              7.50 |
| Public catalog with local PostgreSQL and generation disabled       |                16 |              8.13 |

## Customer paths and rollout

Eleven Chromium tests exercised the private guest handshake, upload reuse, retry, product choice,
draft continuity and privacy fallback against the production Next build with controlled API fixtures.
In the navigation comparison, all 64 candidate clicks reached the destination heading.
The two Image Pass links each went from two exact-route RSC prefetches to zero before interaction.
The tested desktop and mobile pricing entries went from two to one. A dismissed banner went from
one offer lookup to zero. Across eight navigation and latency scenarios, six local P95s fell and
two rose by 4 and 12 ms. Each scenario had eight samples. The earlier build ran on Windows
and the candidate on WSL, so timing differences include host and build differences.

For a release, update the Jobs maintenance receiver before the website writer to keep analytics
retention active. No schema migration is required. Compare the new website version's total CPU
divided by its HTTP invocation count over comparable 24-hour and seven-day windows. Also track total
CPU, homepage renders, Create, request mix and errors. This review performed no production release.
