# GPT Image 2.6 first version

Contract review: 2026-11-11. See [Kie evidence](evidence/gpt-image-2-6-kie-2026-11-11.md)
and [product/SEO scope](../product/gpt-image-2-6-tools.md).

## Admission and prices

The two products use the existing Kie asynchronous image task adapter, durable
job/input/reservation/Outbox transaction, callback wake and authenticated task
retrieval. No additional provider credentials or payment merchant SKUs are needed.
The global generation switch, selected funding source's access rules and existing
storage checks still apply. Credit-funded requests retain their subscription
requirements; the eligible USD 2.99 pass benefit below grants independent image
access only when explicitly selected. The default first-image model is unchanged.

Both new model switches are opt-in, including in development:

- `MEDIA_GPT_IMAGE_2_6_FLARE_ENABLED=true`
- `MEDIA_GPT_IMAGE_2_6_SUNBURST_ENABLED=true`

They also work through the existing server-only `MEDIA_IMAGE_MODEL_FLAGS` pack.
Missing, false or conflicting flags do not admit new requests. Do not enable
producers before compatible jobs, output review and authorized readers are ready.

Cloudflare Git builds use the dedicated non-secret
`MEDIA_GPT_IMAGE_2_6_BUILD_ENABLED=true|false` override. It changes only these two
model flags in the authoritative configuration, including an existing packed
image flag object. Unrelated model flags, credentials and payment controls stay
unchanged; malformed or conflicting original flags reject the build. Ambient
runtime model variables do not enable the override, and the build control is
removed from compilation subprocesses.

Deploy the compatible code with the override absent or false first. After the
jobs consumers and website readers are verified, set it to true on both existing
production Git triggers and rebuild the same commit. For rollback, set it to
false on both triggers and retain compatible consumers for accepted jobs.

Initial fixed retail credits (catalog/pricing version `2026-11-11.1`):

| Product                 | PNG/JPEG 1K |  2K |  4K | SVG | GIF 2–8 / 9 / 10–12 / 13–16 frames |
| ----------------------- | ----------: | --: | --: | --: | ---------------------------------- |
| Flare (medium quality)  |          20 |  40 |  80 |  40 | 40 / 45 / 60 / 80                  |
| Sunburst (high quality) |          25 |  50 | 100 |  45 | 50 / 57 / 75 / 100                 |

GIF uses a 512 × 512 frame canvas; its price follows the provider's sprite sheet
area, with fractional credits rounded up. SVG uses the 1K selection with the
server-owned Luna author. Frame duration does not change the quote. Each quote
freezes the selected format, frames, retail charge and route. Changes require a
new quote; provider token consumption cannot silently increase a user's charge.

Kie charges actual tokens rather than the old 2.5 flat image price. The frozen
`providerCostBasis` explicitly identifies a planning estimate, not a maximum
supplier charge. Raster planning allowances are USD 0.09/0.18/0.36 for Flare
and 0.115/0.24/0.49 for Sunburst, plus USD 0.10 for SVG or the GIF sheet-area
multiplier. Actual `creditsConsumed` is retained by the existing adapter. Real
usage and margins must be measured before relying on these allowances for a
production cost forecast; the provider exposes no hard per-request token cap.

### USD 2.99 image-pack benefit extension

The approved extension covers new purchases and remaining available units from
existing USD 2.99 grants with offer version `2026-11-04.2`. Both Flare and
Sunburst PNG/JPEG at 1K, 2K and 4K, static SVG and 2–16-frame GIF are eligible.
One successful result consumes one pass, including a complete GIF regardless of
its frame count. Explicit pass funding needs no additional subscription; it
does not grant general subscription, storage or video permissions.

`IMAGE_PASS_GPT_IMAGE_26_BENEFIT_POLICY` is the separate
`image-pass-gpt-image-2-6-v1` policy. New quotes freeze it as
`imagePassBenefitPolicy`; reservation rechecks the eligible grant under the
existing owner lock. Historical accepted tasks and reservations retain their
original contracts. The offer's original 29-SKU list, order/payment/grant
snapshots, price and merchant SKU are unchanged. No database migration or
merchant provisioning is required for this benefit.

Both USD 1 offer versions retain their original coverage and subscription rules
and do not receive this extension. Never rewrite an old offer list or count the
frames of a GIF as separate pass units. Deploy compatible admission, reservation
and settlement consumers before new benefit-bearing quotes; accepted quotes and
reserved jobs must remain readable and settleable during rollback. See the
[pack rollout](image-pass-299-rollout.md) for the historical contracts and
extension boundary.

## Outputs and safe recovery

New formats retain their original bytes in private assets and use the existing
authorized read/download path. SVG is a bounded static, self-contained vector
subset; active content, external references and unsupported constructs fail
validation. Visible SVG text must be outlined paths: font-dependent text/tspan
elements are rejected so downloaded artwork cannot substitute an unreviewed
font. The SVG provider prompt requests this subset. GIF review includes every composited frame. Both use an
identity-bound raster representation for the existing image moderation adapter;
they cannot bypass review merely because a provider returned a URL.

Ordinary JPEG/PNG/WebP retain their streaming/first-image paths. Generated
SVG/GIF processing uses the guarded heavy executor. Uploaded references still
accept JPEG/PNG/WebP only; new output formats do not become eligible references,
wallpaper/coloring inputs or video-template sources automatically.

Validation, moderation, provider rejection and technical failure use the existing
public job status and recovery controls. Unknown provider acceptance retains
the same attempt and reservation. It never permits a second paid submission,
automatic failover or an invented refund. Definitive failures can be retried
through the existing explicit user flow.

## Local verification and release boundary

This source change does not deploy, alter remote flags, migrate business data or
provision payments. There is no new database schema migration. Deployment needs
compatible output consumers and Worker artifacts (including SVG renderer WASM)
before enabling the website producers. Keep those consumers while accepted
tasks drain if switches are later disabled.

Focused contract, pricing, pass, moderation/transfer, draft/recovery, route and
browser checks use local fixtures. They do not prove live Kie generation,
callback timing, provider cost, production success rate or search indexing. A
subsequent release check should exercise an authorized real PNG, reference edit,
SVG and GIF through their full private-output/settlement chain and inspect the
actual provider consumption without repeating any uncertain attempt.

Flare/Sunburst support 2–16 frames in Kie's current schema. Economy's distinct
64-frame text-only contract is not enabled in this version; its image-to-image
endpoint supports PNG only and its GIF billing has not been separately verified.

### Initial local verification on 2026-11-11

- Focused config/catalog/provider/quote/pass, drafts/recovery, private output,
  moderation and source-eligibility regressions passed. Database checks used
  mocked unit fixtures, not a live PostgreSQL integration run.
- Config, AI, API, storage, jobs and SaaS type checks passed. Scoped formatting,
  lint and `git diff --check` passed.
- Public routes, sitemap and indexing: 104 tests passed. Browser checks covered
  all three pages at 1440px and 390px, above-the-fold composer controls and GIF
  settings/credits. Existing generation-preview stability checks also passed.
- Generated SVG/GIF Workerd rendering, the jobs Worker bundle and its final
  artifact smoke passed. Website build-tool regressions passed all 21 tests,
  including the real Next Webpack compilation of the SVG WASM import.
- The initial local `pnpm --filter saas cloudflare:build` did **not** complete. The isolated
  builder stopped at `docker version` before snapshot compilation. Starting the
  installed Docker Desktop failed in its Inference manager with an inaccessible
  `dockerInference` local socket. That local attempt certified no website Worker
  artifact. This is historical local evidence, superseded for release readiness
  by the successful Cloudflare Linux build recorded below.
- Temporary local test/build processes exited. That local verification stage
  performed no paid provider task, remote flag change, payment change, Git
  publication or deployment.

### Subsequent production release on 2026-11-11

The GPT Image 2.6 release at `dbbc801e` completed the Cloudflare Linux website
build and final Worker artifact smoke. Compatible production consumers and the
website were released, and Flare and Sunburst were enabled in production through
the dedicated build override. The earlier local Docker startup failure did not
block this cloud release.

No paid real PNG, reference edit, SVG or GIF was submitted during that release
verification. Build/smoke success and enabled catalog entries do not establish
provider completion, customer success rate, settlement or actual generation cost.

The USD 2.99 benefit extension described above is a subsequent change. Its local
tests, CI, deployment and live funding verification must be recorded separately;
the `dbbc801e` release evidence does not certify the extension as deployed.
