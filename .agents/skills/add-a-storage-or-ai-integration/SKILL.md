---
name: add-a-storage-or-ai-integration
description: Use when extending the shared S3 storage layer or AI model/provider integration and its server API.
---

# Add a storage or AI integration

## Scope

Use for provider-backed storage buckets, signed URLs, AI models, streaming, and feature wiring. Do not expose provider credentials in browser code or call providers directly from reusable UI.

## Procedure

1. Choose the shared boundary:
   - storage contracts/config/providers: `packages/storage`
   - AI media catalogs/provider contracts: `packages/ai/media`
   - authenticated operations: `packages/api/modules/<feature>`
2. For storage, extend `StorageBucketNamesConfig` in `packages/storage/types.ts`, add the bucket value in `packages/storage/config.ts`, implement provider operations under `packages/storage/provider`, and export one active provider through `provider/index.ts`.
3. Add server-only `S3_*` credentials and only genuinely browser-safe bucket names as `NEXT_PUBLIC_*` in `.env.local.example`. For local S3, extend `docker-compose.yml` `minio-setup` to create and set policy on the bucket.
4. Generate upload/read URLs in protected oRPC procedures. Follow `packages/api/modules/users/procedures/create-avatar-upload-url.ts`: derive the object key from `context.user.id` and choose the configured bucket server-side. Add content-type/size/expiry enforcement when the provider contract supports it; never accept arbitrary bucket names or keys from clients.
5. For AI media, extend the versioned catalog and provider adapter in `packages/ai/media`. Keep provider keys server-only in `.env.local.example`. The template Chatbot and generic text/audio model SDK exports have been removed; do not restore them as an integration shortcut.
6. Validate public product/input keys with the media Zod contracts, then create durable jobs with the existing moderation, credit reservation and provider uncertainty gates. Keep provider routes and raw results server-only. Preserve request cancellation without retrying uncertain paid submissions.
7. Add focused provider-boundary mocks and API tests. For storage, exercise MinIO; for AI, avoid paid live calls in unit/CI tests.
8. Run relevant tests and affected formatting, lint, and type checks.

## Canonical reference

`packages/api/modules/users/procedures/create-avatar-upload-url.ts` creates an authenticated S3 upload URL. `packages/api/modules/media/procedures/create-generation.ts` is the image job admission boundary; `packages/ai/media/providers/provider-adapter.ts` defines the provider contract.

## Done

Credentials stay server-only, exactly one provider boundary owns each integration, API input and tenant/object scope are constrained, streaming/cancellation behavior is verified, local provider-boundary tests pass, and affected checks pass.

## Common mistakes

- Importing `packages/ai/index.ts` into a client component.
- Letting clients choose unrestricted S3 keys or buckets.
- Running paid AI calls in deterministic unit tests.
- Adding a MinIO bucket to config without creating it in `minio-setup`.
- Dropping the oRPC abort signal while refactoring AI transport.
