# Homepage THD experiment — 2026-11-13

User-requested rollback of Title, H1 and Description only, for review after two days of live
exposure. Restore the values before `c701e6f1e8ec02dc36318db4092a6e4a753302c1`:

- English title: `AI Image Editor No Restrictions — Prompt Editing | EzImageAI`.
- English H1: `AI Image Editor No Restrictions`.
- English description: `AI image editor no restrictions: edit photos with prompts beyond fixed templates. Private images and clear credits; safety and usage limits apply.`
- Restore the corresponding German, Spanish and French H1 translations. Their metadata is unchanged.

The shared metadata helper propagates title/description to OpenGraph and Twitter; the homepage
WebSite JSON-LD uses the same description. Current FAQ, other body copy, llms.txt, policy notice,
canonical, hreflang, robots, routes, sitemap and generation permissions remain unchanged.

## Baseline and interpretation

Official GSC data retrieved on November 13, using GSC's America/Los_Angeles dates:

| Final-data window | Clicks | Impressions |   CTR | Average position |
| ----------------- | -----: | ----------: | ----: | ---------------: |
| November 1–5      |    251 |       3,361 | 7.47% |             6.10 |
| November 6–10     |    144 |       2,175 | 6.62% |             8.59 |

Homepage clicks changed from 233 to 126. The latest final date was November 10; November 11
onward was incomplete. URL Inspection passed with the expected canonical and a last crawl at
2026-11-12T04:39:04Z. These observations do not prove the November 5 copy change caused the decline.

At follow-up, verify the live THD, Google's last crawl and index status, then compare available
post-publication GSC dates with equal-length prior dates. Separate final from incomplete data,
brand from non-brand queries, and homepage from site totals. Check whether Google has crawled
the restored version before interpreting rankings or CTR. Two days is an early observation,
not a controlled causal test; if final post-change data is unavailable, report that limitation.

Record the actual deployment time, revision and verification evidence in the private local
GSC analysis directory after publication. Do not infer production deployment from a local test
or automatically change copy at the review deadline.
