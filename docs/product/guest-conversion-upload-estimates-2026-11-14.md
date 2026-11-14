# Upload compatibility, capability cache and observed durations

## Local implementation

`prepareImageUpload` runs before allocating upload identities, hashes and visible previews. It bounds source bytes by the smaller caller/product limit, rejects image dimensions above 24 million pixels or a 16,384-pixel edge, and checks the encoded size again. Business upload byte limits have not increased.

JPEG EXIF orientations 2–8 are neutralized in a decoder-only copy, then applied exactly once to canvas pixels before JPEG encoding. Complete PNG and WebP retain their original bytes and transparency. Repairable truncated PNG retains PNG encoding. HEIC/HEIF conversion requires bounded `ispe` dimensions and successful browser-native decoding; it produces PNG to preserve alpha. Missing/unsupported metadata or browser codec support gives an actionable JPEG/PNG export message. A large HEIC-to-PNG result can still exceed the existing byte limit and is rejected. This does not establish universal HEIC support across mobile browsers or devices; no third-party codec was added.

Successful normalization caches both the original and resulting File objects. Retry reuses the same encoded File. Auth/draft handoffs should retain the normalized File (`MediaUploadItem.preparedFile`) rather than re-encode an original after an unknown upload result. `MediaUploader` restores an initial File once, and manual replacement prevents it from replaying. Temporary previews reference normalized upload bytes, not the original HEIC or EXIF representation.

`guestCapabilityQueryOptions` uses the shared `guest-capability` browser query key, 30-second freshness and 60-second collection. Concurrent calls deduplicate. Explicit retry cancels and invalidates that key before reading again. It is separate from the existing five-minute public media catalog and must never be dehydrated with individual eligibility into cached public HTML.

## Duration observation contract

`GET /api/media/generation-duration` is independent of generation admission. Its input accepts only a validated public image product, matching SKU and service class. It returns either `processing` with no seconds or an aggregate range with P50/P90, sample count, observation time and newest sample time. It exposes no user, job, asset or provider identifiers. Public/client cache freshness is two minutes.

The read considers at most 500 recently updated successful legacy image jobs in the last seven days, narrowed by product/SKU/service class and the current catalog/pricing versions, then selects at most 200 eligible tasks. Durations are job `terminalAt - createdAt`, including input waiting, orchestration, generation, output review and finalization after job creation. They are not supplier-attempt timing, browser-visible latency or the current job's remaining time. Selection/upload time before job creation is outside this metric. At least five valid samples and a newest sample no older than 24 hours are required.

Known exclusions are current administrator owners/submitters, explicitly marked internal GrowthEvent users, archived test billing jobs, funding outside CREDITS/IMAGE_PASS, invalid/missing timestamps and tasks without a successful known-provider attempt and nonempty non-fixture task identity. Failed/canceled jobs are excluded. The public endpoint withholds numerical observations outside production or without configured real providers.

GenerationJob has no immutable historical internal/test/environment classification. Current roles and optional positive internal marks cannot prove every unmarked test or former administrator has been excluded. Therefore public wording explicitly describes **recent completed tasks, excluding marked internal tasks**. It must not claim a pure customer cohort, a guarantee, a countdown, conversion improvement or live measured performance of this release. Incompatible catalog/pricing versions are not mixed. Low-volume model/SKU groups can correctly remain without seconds.

## Verification evidence

Focused database tests: 10 passed. Focused API tests: 4 passed. These cover aggregation boundaries, current-version isolation, invalid selection, minimum samples, stale/invalid results, public shape, nonproduction/mock behavior and read failures. They use controlled fixtures and do not assert production statistics.

Browser/unit checks for native canvas normalization, preview identity, shared capability caching and the displayed range are included in the owning SaaS test files. The coordinator runs SaaS checks sequentially with Next/Fumadocs and Playwright; no browser codec matrix or paid generation acceptance is claimed here.
