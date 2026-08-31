import { call } from "@orpc/server";
import { PrismaPg } from "@prisma/adapter-pg";
import { guestAbuseHmacKeyIdentity } from "@repo/config/server";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const storageMocks = vi.hoisted(() => ({
	createSignedUpload: vi.fn(),
	headObject: vi.fn(),
}));
const uploadMocks = vi.hoisted(() => ({ completeOwnedUploadSession: vi.fn() }));

vi.mock("@repo/storage", () => ({
	createFinalAssetObjectKey: vi.fn(
		(ownerId: string, assetId: string) =>
			`users/${ownerId}/assets/${assetId}/versions/version-1/original.png`,
	),
	createSignedUpload: storageMocks.createSignedUpload,
	createStagingObjectKey: vi.fn(
		(ownerId: string, sessionId: string) => `users/${ownerId}/staging/${sessionId}/upload.png`,
	),
	headObject: storageMocks.headObject,
}));
vi.mock("./procedures/complete-upload-session", () => ({
	completeOwnedUploadSession: uploadMocks.completeOwnedUploadSession,
}));

import { loadGuestCapabilitySnapshot } from "./lib/guest-capability";
import { completeGuestDraftUpload } from "./procedures/complete-guest-upload";
import { createGuestDraftUploadIntent } from "./procedures/create-guest-upload-intent";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL;
const abuseSecret = "database-drift-independent-abuse-secret-32-bytes";
const abuseKeyVersion = "launch-key-v1";

let client: PrismaClient;

describe("guest capability database drift fence", () => {
	beforeAll(async () => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl() }),
		});
		await client.$connect();
	});

	beforeEach(async () => {
		await client.$executeRawUnsafe(
			'TRUNCATE TABLE "runtime_config_override", "guest_abuse_bucket", "media_upload_session", "media_asset", "generation_draft", "guest_session_bootstrap" CASCADE',
		);
		vi.stubEnv("NODE_ENV", "test");
		vi.stubEnv("GUEST_MEDIA_ENABLED", "true");
		vi.stubEnv("GUEST_PROMOTION_PERIOD", "promotion-a");
		vi.stubEnv("MEDIA_GENERATION_ENABLED", "true");
		vi.stubEnv("MEDIA_ENABLED_PROVIDERS", "replicate");
		vi.stubEnv("GUEST_ABUSE_HMAC_SECRET", abuseSecret);
		vi.stubEnv("GUEST_ABUSE_HMAC_VERSION", abuseKeyVersion);
		vi.stubEnv("NEXT_PUBLIC_MARKETING_URL", "https://marketing.test");
		vi.stubEnv("MEDIA_TRUSTED_PROXY_PROVIDER", "cloudflare");
		await client.runtimeConfigOverride.create({
			data: {
				configKey: "media.guestGeneration.enabled",
				version: 17,
				value: {
					enabled: true,
					abuseHmacKeyVersion: abuseKeyVersion,
					abuseHmacKeyIdentity: guestAbuseHmacKeyIdentity(abuseSecret),
				},
				reason: "database capability drift test",
				createdByUserId: "test:capability-drift",
				createdAt: new Date("2026-06-01T00:00:00.000Z"),
			},
		});
		storageMocks.createSignedUpload.mockResolvedValue("https://storage.test/private-upload");
	});

	afterEach(() => vi.unstubAllEnvs());

	afterAll(async () => {
		await client?.$disconnect();
	});

	it("rejects promotion drift before consuming the upload or creating a Draft/Bootstrap", async () => {
		const capabilityA = await loadGuestCapabilitySnapshot(process.env);
		const upload = await call(
			createGuestDraftUploadIntent,
			{
				capabilityVersion: capabilityA.version,
				productKey: "image-fast",
				contentType: "image/png",
				bytes: 8,
				sha256: "a".repeat(64),
				turnstileToken: "deterministic-turnstile-proof",
			},
			{
				context: {
					headers: new Headers({
						origin: "https://marketing.test",
						"cf-connecting-ip": "203.0.113.9",
					}),
					responseHeaders: new Headers(),
				},
			},
		);
		const before = await client.mediaUploadSession.findUniqueOrThrow({
			where: { id: upload.sessionId },
			select: { tokenHash: true, guestCompletionConsumedAt: true },
		});
		storageMocks.headObject.mockClear();
		uploadMocks.completeOwnedUploadSession.mockClear();
		vi.stubEnv("GUEST_PROMOTION_PERIOD", "promotion-b");

		await expect(
			call(
				completeGuestDraftUpload,
				{
					sessionId: upload.sessionId,
					completionToken: upload.completionToken,
					capabilityVersion: capabilityA.version,
					productKey: "image-fast",
					sha256: "a".repeat(64),
					prompt: "Replace the background",
				},
				{
					context: {
						headers: new Headers({ origin: "https://marketing.test" }),
						responseHeaders: new Headers(),
					},
				},
			),
		).rejects.toThrow("GUEST_CAPABILITY_CHANGED");

		await expect(
			client.mediaUploadSession.findUniqueOrThrow({
				where: { id: upload.sessionId },
				select: { tokenHash: true, guestCompletionConsumedAt: true },
			}),
		).resolves.toEqual(before);
		expect(before.guestCompletionConsumedAt).toBeNull();
		await expect(
			Promise.all([client.generationDraft.count(), client.guestSessionBootstrap.count()]),
		).resolves.toEqual([0, 0]);
		expect(storageMocks.headObject).not.toHaveBeenCalled();
		expect(uploadMocks.completeOwnedUploadSession).not.toHaveBeenCalled();
	});
});

function safeTestDatabaseUrl(): string {
	if (!TEST_DATABASE_URL) throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
	if (!DATABASE_URL || TEST_DATABASE_URL === DATABASE_URL) {
		throw new Error("UNSAFE_TEST_DATABASE: DATABASE_URL must be a distinct runtime alias");
	}
	const parsed = new URL(TEST_DATABASE_URL);
	const databaseName = parsed.pathname.slice(1).toLowerCase();
	if (
		!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) ||
		!/(^|[_-])(test|testing)([_-]|$)/.test(databaseName)
	) {
		throw new Error("UNSAFE_TEST_DATABASE: expected a disposable loopback test database");
	}
	return TEST_DATABASE_URL;
}
