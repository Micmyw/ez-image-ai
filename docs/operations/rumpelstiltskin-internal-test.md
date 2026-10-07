# Rumpelstiltskin customer reference-video workflow

The user authorized authenticated customer release, necessary migration/publishing, merging main and pushing, and expressly excluded real video-generation testing. No paid generation or trial budget is requested. Public pricing and explicit conservative budgets are accepted cost evidence; a supplier receipt is not a prerequisite to that pricing policy. Actual output quality and Seedance generation acceptance remain untested.

## Customer entry and execution

Registered, non-anonymous accounts can discover `/video/effects/rumpelstiltskin` from Studio navigation. The feature defaults to enabled and `authenticated`; ordinary global video/media readiness and qualifying paid credits still apply. Guests have no free video entitlement. Missing motion material displays preparation status and blocks upload/quotation/generation, while the account page and owner-scoped history remain accessible.

The customer uploads one JPEG/PNG/WebP portrait. Internal left/right bindings must identify the same sealed asset. Waffo reviews the actual video prompt once, and SeeAPI reviews that portrait once; its immutable decision is reused for the identical second binding. There is no generated scene image or scene-image reservation.

Schema 2 freezes a five-second/720p/9:16/silent Standard Seedance 2 request, versioned prompt and backend-selected motion identity. Submission sends `reference_image_urls` and `reference_video_urls`, with `generate_audio:false`; it never mixes first-frame fields or accepts a browser reference URL. The native `VIDEO_WORKFLOW`, reservation, database send fence, uncertainty hold, querying, transfer/review, settlement and private download remain authoritative. Hotel Lobby/Raindance schema 1 behavior is retained.

The prompt requests the uploaded identity on the main performer and preservation of the second character and toe-stepping sequence. These are instructions, not supplier guarantees or tested quality claims. No competitor clip, music or purported 1987 movie source is bundled.

## Private configuration and rollback

- `VIDEO_V1_ENABLED=true` remains a global prerequisite. Missing `RUMPELSTILTSKIN_ENABLED` means true; explicit false closes new generation, and malformed values deny admission. Existing accepted tasks and owner history remain available.
- Missing `RUMPELSTILTSKIN_ACCESS` means `authenticated`. Explicit `internal` uses only `RUMPELSTILTSKIN_ALLOWED_USER_IDS`; neither an administrator role nor another feature's old allowlist grants that rollback audience access.
- Missing `RUMPELSTILTSKIN_ACCEPTED_TEMPLATE_VERSION` accepts the current version. A supplied incompatible version is rejected. Implemented supplier model parameters remain validated independently.
- `RUMPELSTILTSKIN_APPROVED_MOTION_REFERENCE` and optional `RUMPELSTILTSKIN_COST_APPROVAL` remain private server bindings, each at most 5,000 UTF-8 bytes. They do not expand the original 5,000-byte runtime policy pack. Website and background hydration mirror the bindings and clear stale values; invalid runtime packs close admission.
- Build preparation permits an accessible but unavailable customer page when material is missing. It does not manufacture approvals. There is no Rumpelstiltskin build-enable override; explicit operator disable is preserved.

## The unresolved motion asset

No authorized, sealed and approved same-meme reference exists in this change. Source discovery does not grant a license. The original creator's reel is [Instagram DcjC4hHCb0C](https://www.instagram.com/reel/DcjC4hHCb0C/); the creator's [public channel](https://t.me/neuroferma) is a possible authorization contact, but no commercial/AI-reference permission was found. No contact, download or extraction was performed. A generic licensed shuffle clip cannot satisfy the same-meme requirement.

Two preparation paths preserve the feature's intended motion: obtain the creator's explicit authorization and original clip, or have the user provide an original/authorized two-character reference that captures the same complete toe-stepping sequence. A useful target is a silent 4–5 second MP4, 720×1280, 24–60 fps, with both full bodies and feet visible. Actual schema limits are 2–15 seconds, at most 50 MB and the approved dimensions/ratio. Ownership and necessary commercial/AI-processing rights must be recorded; removing a song alone is not authorization.

This release does not add a public reference-video upload or rights-approval subsystem. A user may supply their owned file and rights record for trusted operator ingestion into the fixed template. Arbitrary browser URLs or unchecked user reference files cannot bypass the fixed asset contract. A future per-customer reference workflow would need its own upload, review, dynamic pricing and ownership design.

Trusted ingestion must seal a private admin-owned `MediaAsset` in `READY` state with immutable checksum/key/ETag/storage version, measured bytes, MP4 type, duration, dimensions, fps and zero audio tracks. Actual persisted SeeAPI `OUTPUT` approval must satisfy `hasVideoApproval`, including all sampled-frame evidence. Its raw envelope includes `rumpelstiltskinReferenceApproval` with version, measured fps, `audioTrackCount:0` and the manual rights receipt. The manifest's decision hash is produced by `fingerprintVideoTemplateReferenceApproval`. A fabricated environment `ALLOW` cannot pass database validation. The fixed clip is excluded from consumer job asset bindings.

The current visible page can be published without that asset, but successful generation cannot be claimed or offered until ingestion/approval and both runtime bindings are complete. Material absence is a real readiness failure, not an internal-audience restriction.

## Public complete-cost policy

The dated Standard reference tariff is $0.125 per total reference-video plus output second. Fractional reference seconds are conservatively rounded up. Independent budgets cover portrait/reference/output/prompt review, runtime, storage/transfer, payment fees and failure losses. Their sources, explicit assumptions and finite expiry are frozen in `costApprovalEvidence`; no measured account charge is invented. The default policy expires on **2026-10-14 16:47:22 UTC**. A malformed explicit override is rejected rather than silently replaced.

The contribution-profit target is `(net revenue - risk-adjusted operating cost) / cost >= 2`, or **net revenue >= 3 × cost**. Revenue uses the lowest catalog receipt divided by all issued credits, including annual grants and subscriber bonuses. Payment fees are deducted separately. Lower actual discounted receipts cannot qualify against a higher frozen floor; a lower approved floor increases the quote. This is per-order contribution profit, not company after-tax net profit. See [the complete cost policy and examples](./rumpelstiltskin-cost-and-trial-2026-10-07.md).

## Migration, testing and recovery

`20261007190000_rumpelstiltskin_reference_template` extends the template CHECK and immutable triggers for schema 2; it adds no table, grant or browser permission. It preserves schema 1 guards and uses a transaction with a three-second lock timeout and thirty-second statement timeout. Both native Git build targets run read-only migration status; apply the verified compatible migration before pushing a release that needs successful automatic builds. Never apply unrelated pending migrations to bypass this check.

Local PostgreSQL 17.10 ran all 65 migrations, drift and 94 relevant real integration cases successfully (new reference 5, old templates 34, execution 55). Its fresh loopback cluster was stopped afterwards. UTC configuration is required for parity with CI and the active Prisma adapter; no system/Docker/virtualization settings were changed. Unit contracts use synthetic assets and injected providers with external HTTP blocked. They do not establish real generation acceptance, visual fidelity or live recovery.

Safe regression from the isolated checkout: `node ..\verify-rumpelstiltskin.mjs config saas api jobs`. Browser review needs a disposable database and a verified account, followed by `pnpm dev` and `http://localhost:3000/video/effects/rumpelstiltskin`. Ordinary Node/Next development lacks native `VIDEO_WORKFLOW` and is not the full execution environment. No real secret file was copied here.

For rollback, set `RUMPELSTILTSKIN_ENABLED=false` and synchronize website/background configuration. Keep the receiver, results, owner history and accepted-task recovery running. Do not rewrite frozen snapshots, resubmit ambiguous attempts, or refund accepted work solely because current approval has expired.
