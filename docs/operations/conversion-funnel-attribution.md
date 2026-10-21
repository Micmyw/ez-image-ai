# Conversion funnel and acquisition attribution

Implementation date: 2026-10-21. Deployment and production migration require a separate authorized release.

## Entry and interpretation

### 管理员中文展示

- `/admin/analytics`：转化漏斗、UTM / Referrer 来源、设备筛选、首次生成失败、支付与收入统计。
- `/admin/media`：订单归因、图片与提示词审查、生成失败码及恢复操作。
- 这两个页面及后台导航默认显示简体中文。中文文案在管理员布局内注入，保留现有服务端 `role=admin` 权限检查；普通客户和访客无法访问这些报表。
- 仅改变后台显示，不新增公开中文语言、不修改 `NEXT_LOCALE`，不改变前台、邮件或 SEO 语言。其他后台模块未翻译的内容继续使用原语言。
- 来源域名、UTM 值、订单 ID、原始错误码及审计内容原样保留。常见错误码附有中文解释；未知错误码直接显示，`NO_USABLE_OUTPUT` 本身不被断言为审查拒绝。
- 中文源文件：`apps/saas/modules/admin/lib/messages/zh-CN.json`。本次仅本地实现，随已获授权的后续发布上线。

`/admin/analytics` includes a customer conversion section exposed through the existing
`analytics_conversion` capability (`admin.analytics.read`, platform scope only). It uses a
24-hour, 7-day or 30-day **registration cohort**. Each stage counts distinct registered,
non-guest customers and excludes administrator accounts. Generation is an optional step:
customers may purchase before generating. Percentages divide each stage by registrations,
not by the preceding stage. Do not present this as an ordered sequential funnel.

Stages: registration → generation attempted → at least one successful generation → observed
purchase click → server checkout intent → confirmed production payment. The first-attempt
summary separately exposes initial failure even when a later retry succeeds. Image and video
generation both use the authoritative `generation_job` table.

Actual payment comes from the existing verified financial reader (subscription payments,
credit-pack fulfillment and Image Pass grants). Renewals, test/unknown environments,
unverified evidence, missing payment dates and zero amounts do not count. Redirects and
browser `subscription_activated` observations never establish payment.

Browser traffic and checkout-action tables use observations received during the same selected
period, including unsigned-in visitors. These are separate populations from the registration
cohort. A browser cookie lasts up to 30 days: browser counts are neither people nor GA sessions.
A browser can appear under more than one observed acquisition source; source-row browser
counts are not additive. The UI never divides all database registrations by observed browsers. A separate linked-visitor
rate uses only browsers with a preceding page observation and a server user-create-hook
`registration_confirmed` proof in this period. Ordinary login, browser-supplied signup events
and visits first observed after registration cannot establish this link. The same linked
browser sample shows later successful generation and verified payment; unobserved or
unconsented journeys are not reconstructed.

## Attribution and coverage

- GA page locations now retain only validated `utm_source`, `utm_medium`, `utm_campaign`,
  `utm_term`, and `utm_content`. Other query values and fragments remain redacted. Public
  Create, image tools, model pages and Image Pass are included. Private account paths remain disabled.
- First-party events prefer UTM source, then the hostname from the external document referrer.
  Thus `utm_source=chatgpt.com` and an untagged `https://chatgpt.com/` referrer are recognized.
  Referrer policy, privacy settings and app browsers may suppress referral information.
- HTTP `Referer` on the later event POST is normally our own page, so it must not be treated
  as the original external referral. The sanitized entry snapshot carries that observation.
- Customer outcome source is the existing consented, write-once registration snapshot.
  A later login or payment return does not rewrite registration history. Existing campaign,
  medium and country breakdowns remain in the detailed registration-cohort report.
- Device is a coarse server-derived browser category, not a fingerprint. Missing historical
  devices and sources stay `unknown`. `direct` means observed entry with no external/UTM source.
- Coverage exposes customers with browser observations, unknown registration sources and
  excluded internal browser identifiers. Absence of observations does not prove no clicks.
- Observations from a browser identified as administrator/impersonated within the reporting
  window are excluded together, including earlier unsigned-in observations from that identifier.
  Unidentified internal visitors and undetected automation cannot be classified with certainty.

## Collection contract

`POST /api/analytics/events` accepts an allowlisted event schema, a UUID, a bounded safe
public path and optional sanitized first-touch snapshot. It requires the configured same
origin, current server-verified analytics permission and a matching hashed browser cookie.
Permission is version-2 explicit consent or a permitted trusted region; refusal and privacy
signals override both. Identity comes only from the
authenticated server session; input cannot choose user ID, internal flag, device or timestamp.
Known bot user agents are dropped. User-agent strings and IP addresses are not stored.

A server-only registration observation uses a stable `registration:<userId>` event ID.
It is only emitted by Better Auth user creation for enabled signup journeys with consent
and an existing browser identifier. The public ingestion schema rejects this event name.
Its write is failure-isolated from registration and does not modify authentication.

Existing growth events now use only the first-party transport; PostHog delivery is retired. New page
and identity observations connect current signed-in actions; subscription, credit-pack and
Image Pass buttons observe `purchase_clicked`, `checkout_requested`, `checkout_redirected`
and `checkout_failed`. Resuming an existing subscription checkout emits the same action stages
without creating another intent. Failure categories are bounded enums; raw provider/error payloads,
prompts, private media and private job IDs never enter this table. Telemetry is optional,
uses `keepalive`, and never blocks the business action. Delivery before navigation is best
effort, so server facts remain authoritative.

`growth_event` holds analytics observations only. It has UUID deduplication, a shared
database limit of 90 observations per browser identifier per minute, and indexes on time,
browser and account. This is abuse mitigation, not proof that observations are human.
Old rows are deleted in batches of at most 100 during accepted ingestion after 90 days.
Idle installations purge on subsequent activity. Account deletion cascades directly linked
observations. Consent withdrawal removes the browser identifier and stops new collection;
it does not retroactively erase already received observations.

Reports fail explicitly beyond 20,000 event or job facts; they do not silently truncate.
At greater volume, replace fact loading with equivalent scoped SQL aggregates before raising
the limit. Current permission/audit and financial-evidence contracts remain in force.

## Release and rollback

1. Apply additive Prisma migrations `20261021100000_growth_event_funnel` and then
   `20261021120000_anonymous_traffic_diagnostics` to the intended target.
   They include the server-only RLS boundary; follow the existing
   `supabase-private-postgres.sql` post-migration hardening procedure as project administrator.
2. Deploy the compatible website/API after the migration. No new provider keys or analytics
   vendor configuration is required for first-party collection.
3. With consent, visit a public page using a known UTM value; read back the observation and
   verify the admin report. Check anonymous counters separately before optional consent;
   declined consent must create no new counters or detailed observations. Do not manufacture
   a paid conversion: use independently authorized checkout/payment verification.
4. Application rollback can leave the additive table in place. Do not delete analytics or
   financial history to roll back application code.

Production migration, deployment, real payments and paid image/video generation were not
performed during this local repair. Local SQL verification used an isolated PGlite PostgreSQL
engine and the generated migration, not the production database.

## Image rejection investigation (read-only, 2026-10-21)

The earlier production audit found 16 non-admin customers who had attempted generation;
12 failed their first attempt and four succeeded. Across their 32 jobs, 14 succeeded and
18 failed. No customer checkout intent existed at that audit snapshot.

The 12 customer jobs ending in `NO_USABLE_OUTPUT` all had rejected input-image moderation
and no generation-provider attempt. Scoped stored SeeAPI evidence has `flagged=true` with
sexual/nudity labels; three task records additionally contain `specialCare` labels concerning
possible minors. These are provider classifications, not verified descriptions of the images.
Private images and prompts were not opened, so false-positive rates cannot be established.
No numeric confidence scores are present in the saved SeeAPI evidence.

The parser uses `flagged=true` for `REJECT`, labels without that flag for `REVIEW`, and
malformed/failed responses for `ERROR`. No evidence was found that these 12 content rejections
were transport failures mislabeled by the parser. `NO_USABLE_OUTPUT` is the internal settlement
code; the customer API already maps the evidence to `CONTENT_NOT_ALLOWED`. The remaining
failures in the audit were five verified no-charge provider policy rejections and one timeout.
No safety thresholds, special-care checks, credit accounting or historical evidence were changed.

## Local verification

- 215 focused tests passed across browser tracking/checkout components, conversion calculations,
  API and admin permissions, registration hooks, SeeAPI parsing and SQL integration.
- The isolated PGlite run applied the generated migration and exercised actual PostgreSQL
  queries, UUID deduplication, throttling, retention, RLS enablement, account deletion and
  latest-moderation selection. Its temporary TCP server was stopped after the run.
- Type checks passed for `@repo/auth`, `@repo/api`, `@repo/database`, `@repo/utils` and `saas`.
  Focused formatting, lint and `git diff --check` passed.
- No real checkout, payment or paid generation was performed. No production migration,
  deployment, Git publication or CI run is claimed. Full live browser collection remains
  a release verification step.

## Regional consent and anonymous counters (2026-10-21)

See [website analytics](./website-analytics.md) for the current version-2 regional permission policy, PostHog retirement and Clarity coverage. Detailed events and acquisition snapshots use the same server-verified policy; plain legacy `consent=true` is no longer sufficient. Anonymous hourly counters have no visitor/account join and are shown separately. Image/video input diagnostics only retain bounded length/options/stage categories. Apply the additional `20261021120000_anonymous_traffic_diagnostics` migration before this website change.
