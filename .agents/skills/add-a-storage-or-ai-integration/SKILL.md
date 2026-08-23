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
   - AI models/prompts/SDK exports: `packages/ai`
   - authenticated operations: `packages/api/modules/<feature>`
2. For storage, extend `StorageBucketNamesConfig` in `packages/storage/types.ts`, add the bucket value in `packages/storage/config.ts`, implement provider operations under `packages/storage/provider`, and export one active provider through `provider/index.ts`.
3. Add server-only `S3_*` credentials and only genuinely browser-safe bucket names as `NEXT_PUBLIC_*` in `.env.local.example`. For local S3, extend `docker-compose.yml` `minio-setup` to create and set policy on the bucket.
4. Generate upload/read URLs in protected oRPC procedures. Follow `packages/api/modules/users/procedures/create-avatar-upload-url.ts`: derive the object key from `context.user.id` and choose the configured bucket server-side. Add content-type/size/expiry enforcement when the provider contract supports it; never accept arbitrary bucket names or keys from clients.
5. For AI, configure server models in `packages/ai/index.ts`; keep `packages/ai/client.ts` limited to client-safe exports. Add provider keys to `.env.local.example` without `NEXT_PUBLIC_`.
6. Validate AI input with Zod plus `safeValidateUIMessages`, bound message/tool counts and payload sizes, and return streams through oRPC's event iterator. `AiChat.tsx` already forwards `options.abortSignal` to the oRPC client; preserve that client cancellation path and propagate it into provider calls when changing the server contract.
7. Add focused provider-boundary mocks and API tests. For storage, exercise MinIO; for AI, avoid paid live calls in unit/CI tests.
8. Run relevant tests, `pnpm format`, `pnpm lint`, and `pnpm type-check`.

## Canonical reference

`packages/api/modules/users/procedures/create-avatar-upload-url.ts` creates an authenticated S3 upload URL. `packages/api/modules/ai/procedures/stream-message.ts` validates UI messages and adapts `streamText` to an oRPC event iterator.

## Done

Credentials stay server-only, exactly one provider boundary owns each integration, API input and tenant/object scope are constrained, streaming/cancellation behavior is verified, local provider-boundary tests pass, and repository gates pass.

## Common mistakes

- Importing `packages/ai/index.ts` into a client component.
- Letting clients choose unrestricted S3 keys or buckets.
- Running paid AI calls in deterministic unit tests.
- Adding a MinIO bucket to config without creating it in `minio-setup`.
- Dropping the oRPC abort signal while refactoring AI transport.
