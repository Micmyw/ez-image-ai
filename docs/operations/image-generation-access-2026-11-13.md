# Image-generation access and balance lookup recovery

## User-visible fixes

Ordinary image, SVG and GIF editors previously left CREDITS selected even when a
Free account owned an available subscription-free image pass for the chosen SKU.
The resulting plan-upgrade action obscured an already purchased way to generate.
The editor now selects that qualifying pass by default and displays its one-pass
cost. An explicit funding choice, including a restored draft choice, is preserved.

An image-pass balance lookup failure previously hid or disabled the selector and
blocked submission. Failed or still-loading reads are not authoritative admission
decisions. A selected pass can now reach normal server submission; an initial read
failure also leaves the selector and a balance retry visible. Confirmed exhausted
or uncovered passes still show their existing guidance. No automatic switch to
credit charging occurs.

Paid photo templates also no longer stop an eligible subscriber solely because a
cached credit balance appears too low. Submission checks the current balance and
returns the existing insufficient-credit purchase guidance when needed. Cached
balances may inform a default funding recommendation but cannot force another
purchase before the server is consulted. The stale-balance regression failed
before this change and passed after it.

USD 2.99 offer `2026-11-04.2` and benefit `image-pass-gpt-image-2-6-v1` retain their
existing contracts: no subscription is needed when an eligible pass funds a
supported GPT Image 2.6 Flare or Sunburst output. A complete successful GIF uses
one unit regardless of frame count. USD 1 grants and historical snapshots remain
unchanged. See [the offer rollout](image-pass-299-rollout.md).

## Account-specific administrator test access

The authorized showcase test account is an administrator on Free with credits,
but no suitable image pass. Being an administrator alone does not grant premium
image access. A narrowly scoped, expiring runtime override allows that account to
test the selected model using normal credit billing:

```json
{
	"version": 1,
	"skuKeys": ["gpt-image-2-6-sunburst-1k"],
	"expiresAt": "<ISO timestamp>"
}
```

The config key is `media.image-admin-test.<ownerId>`. The shared database reader
requires the current registered administrator identity, no active ban, an active
latest override and database-time validity. Preflight and transactional admission
both recheck it. The credits endpoint supplies only the current administrator's
eligible SKU keys so the editor can show Generate. It grants no credits,
subscription, storage entitlement or video access. Accepted requests retain their
ordinary reservation and replay contracts after access expires or is revoked.

Prepare or apply access with the dedicated script, using a verified environment
file and the existing administrator's email. It defaults to a read-only preview:

```powershell
pnpm exec tsx packages/database/scripts/image-admin-test-access.ts --env .env.production.local --email '<administrator email>' --sku gpt-image-2-6-sunburst-1k --hours 24 --receipt output/image-admin-access.json
```

After compatible website code is deployed, add `--apply` to activate the authorized
grant. To revoke it, use the same `--env` and `--email` with `--revoke --apply`.
Writes use the existing runtime-config version lock and an audit record. No
migration, billing-plan change, payment or historical grant rewrite is involved.

## Evidence and release status

### Site-wide daily cost ceiling retirement

The first production GIF submission returned `BUDGET_EXCEEDED` before a quote,
job or credit reservation was created. The release environment carried a USD 0.20
site-wide daily ceiling; accepted quotes that day already totaled USD 0.1535.
The test account retained 327 spendable credits and zero reserved credits.

The owner explicitly chose to remove the site-wide daily cost ceiling. New code
no longer reads `MEDIA_DAILY_PROVIDER_COST_BUDGET_MICROS`, aggregates all owners
for admission, or acquires its global budget lock. Old configuration values and
the deprecated internal admission field are ignored. Launch validation no longer
requires that variable. Existing cost snapshots and accounting remain intact.
Single-job and per-account cost limits, guest campaign funding, credit/pass
reservation, access and moderation contracts remain unchanged. No migration is
needed. Deploy both website and jobs consumers before retesting; older running
code can still enforce its historical ceiling during rollout.

Account cost-limit errors now have dedicated English, German, Spanish and French
messages. The frontend regression reproduced the previous generic-error fallback.

- On 2026-11-13, the production public offer endpoint
  `GET /api/payments/image-pass-offer` returned `available: true`. Local receipt:
  `output/homepage-gif-2026-11-13/live-image-pass-offer.json`.
- Focused frontend tests cover automatic pass selection for GPT Image 2.6 PNG,
  SVG and GIF with zero credits and no subscription, one-pass display, explicit
  choice preservation, balance-read errors and administrator credit funding.
- Focused API/database tests cover both 2.6 GIF models through the real preflight
  with a controlled database port, historical pass rejection, exact-SKU test
  access, revocation and insufficient credits.
- Final focused results: SaaS 5 files / 129 tests, API 4 files / 168 tests and
  database 3 files / 91 tests passed. Database, API and SaaS type checks, affected
  TypeScript lint, formatting and `git diff --check` passed. These are local
  component/unit checks, not a production browser or provider-generation test.
- PostgreSQL admission regressions passed in GitHub CI for `59962928`, including
  normal 57-credit GIF reservation, replay after revocation and rejected
  expired/non-admin/banned/anonymous grants. The same run exposed unrelated
  video-cleanup fixture errors, subsequently corrected.
- Website and jobs deployed `59962928` at 100% traffic. The authorized scoped
  administrator grant was activated at 15:16 UTC. The production editor displayed
  Generate with the 57-credit quote; its first submission hit the site-wide cost
  ceiling before creating a job or reservation.
- Ceiling retirement is published in `4cee4de6`. Local verification passed:
  config 169, API 204, database 1292 (3 skipped), editor-error 32 tests; all 22
  type-check tasks, lint and formatting passed. After a Cloudflare Workers API
  incident delayed publication, both production Workers deployed this SHA at
  100% traffic: website version `ae40381a-f438-4d42-a374-c7fc020d695f` at
  15:37 UTC; jobs version `017e05f4-5ebc-4352-af73-500e89a8eb07` at 15:40 UTC.
- The production editor accepted job `cmwf592m10001psp7ol3otdp4` at 15:40:58 UTC.
  Its sole Kie attempt succeeded; a transient transfer error recovered through
  the same task. All-frame output review approved the private asset. The job
  reached `SUCCEEDED` at 15:48 UTC with one 57-credit reserve and one 57-credit
  settlement, no second generation or charge. The UI showed READY and downloaded
  the original GIF. The scoped administrator test grant was revoked at 15:49 UTC.
- Downloaded bytes match the stored asset SHA-256. Inspection confirms 512×512,
  nine distinct frames, nine 200 ms delays, and an infinite loop. The bird stays
  consistent while its wings move. The homepage uses the unchanged GIF and an
  extracted first-frame WebP. See `evidence/gpt-image-2-6-gif-2026-11-13.json`.
- This test used existing account credits, not an actual $2.99 purchase. Pack
  eligibility and one-unit GIF charging remain covered by the contract and tests.
- CI exposed a real solo-template preview bug: pricing used two different
  placeholder references, violating the single-subject request schema. The access
  read now uses the same placeholder identity. Applying the real schema to the
  router test reproduced the failure; all 40 router tests passed after the fix.
  This changes no actual-upload review or financial authorization.
