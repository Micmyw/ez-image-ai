import { PrismaPg } from "@prisma/adapter-pg";
import { TestMediaSafetyAdapter } from "@repo/ai";
import { claimGenerationDraftTransaction, createGenerationDraftTransaction } from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabaseVerifyUploadDependencies } from "../runtime";
import { verifyUpload } from "./verify-upload";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const PNG_HEADER = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
let client: PrismaClient;

describe("claimed draft asset verification", () => {
	beforeAll(() => {
		assertSafeTestDatabaseUrl(TEST_DATABASE_URL);
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL! }),
		});
	});

	afterAll(async () => client?.$disconnect());

	it.each([
		["ALLOW", "READY", "APPROVED"],
		["REJECT", "QUARANTINED", "REJECTED"],
	] as const)(
		"carries a claimed draft through MEDIA_ASSET_VERIFY to %s moderation",
		async (decision, expectedAssetStatus, expectedModerationStatus) => {
			const suffix = crypto.randomUUID();
			const assetId = `asset_${suffix.replaceAll("-", "")}`;
			const objectKey = `drafts/${suffix}.png`;
			const tokenHash = suffix.replaceAll("-", "").padEnd(64, "0").slice(0, 64);
			const draft = await createGenerationDraftTransaction(
				{
					claimTokenHash: tokenHash,
					productKey: "image-fast",
					input: { kind: "text-to-image", prompt: "safe draft" },
					expiresAt: new Date(Date.now() + 60_000),
					asset: {
						id: assetId,
						objectKey,
						mimeType: "image/png",
						byteSize: 16n,
					},
				},
				client,
			);

			await claimGenerationDraftTransaction(
				{ claimTokenHash: tokenHash, userId: `user-${suffix}` },
				client,
			);
			const event = await client.outboxEvent.findUniqueOrThrow({
				where: { dedupeKey: `media-asset-verify:${assetId}` },
			});
			expect(event).toMatchObject({
				eventType: "MEDIA_ASSET_VERIFY",
				aggregateId: assetId,
				payload: { assetId },
			});

			const dependencies = createDatabaseVerifyUploadDependencies(client, {
				headObject: async () => ({
					contentLength: 16,
					contentType: "image/png",
					etag: '"etag"',
					metadata: {},
				}),
				readMediaHeader: async () => PNG_HEADER,
				createSignedReadUrl: async () => "https://private.example/signed.png",
				safety: new TestMediaSafetyAdapter(decision),
				moderationProvider: "test",
			});
			await verifyUpload({ assetId }, dependencies);
			await verifyUpload({ assetId }, dependencies);

			await expect(
				client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
			).resolves.toMatchObject({
				status: expectedAssetStatus,
				ownerType: "USER",
				ownerId: `user-${suffix}`,
			});
			await expect(
				client.assetModerationResult.findUniqueOrThrow({
					where: { assetId_provider: { assetId, provider: "test" } },
				}),
			).resolves.toMatchObject({ status: expectedModerationStatus });
			await expect(client.assetModerationResult.count({ where: { assetId } })).resolves.toBe(1);
			expect(draft.id).toBeTruthy();
		},
	);

	it("re-verifies only the explicitly authorized legacy quarantine and persists a fresh fingerprint", async () => {
		const suffix = crypto.randomUUID();
		const assetId = `legacy_asset_${suffix.replaceAll("-", "")}`;
		const ownerId = `legacy-owner-${suffix}`;
		let inspections = 0;
		const dependencies = createDatabaseVerifyUploadDependencies(client, {
			headObject: async () => ({
				contentLength: 16,
				contentType: "image/png",
				etag: '"fresh-etag"',
				metadata: {},
			}),
			readMediaHeader: async () => PNG_HEADER,
			inspectPrivateMediaObject: async () => {
				inspections += 1;
				return {
					bytes: 16,
					sha256: "f".repeat(64),
					etag: '"fresh-etag"',
					versionId: "fresh-version",
				};
			},
			createSignedReadUrl: async () => "https://private.example/legacy.png",
			safety: new TestMediaSafetyAdapter("ALLOW"),
			moderationProvider: "legacy-test",
		});
		await client.mediaAsset.create({
			data: {
				id: assetId,
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				status: "QUARANTINED",
				objectKey: `users/${ownerId}/assets/${assetId}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
			},
		});

		await verifyUpload({ assetId }, dependencies);
		expect(inspections).toBe(0);
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
		).resolves.toMatchObject({
			status: "QUARANTINED",
			checksum: null,
		});

		await verifyUpload({ assetId, allowQuarantinedReverification: true }, dependencies);
		expect(inspections).toBe(1);
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
		).resolves.toMatchObject({
			status: "READY",
			checksum: "f".repeat(64),
			storageEtag: '"fresh-etag"',
			storageVersionId: "fresh-version",
			finalizedAt: expect.any(Date),
		});
		await expect(
			client.auditLog.count({
				where: {
					targetType: "MEDIA_ASSET",
					targetId: assetId,
					action: "MEDIA_ASSET_LEGACY_REVERIFICATION_STARTED",
				},
			}),
		).resolves.toBe(1);

		const rejectedAssetId = `rejected_asset_${suffix.replaceAll("-", "")}`;
		await client.mediaAsset.create({
			data: {
				id: rejectedAssetId,
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				status: "QUARANTINED",
				objectKey: `users/${ownerId}/assets/${rejectedAssetId}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
				finalizedAt: new Date(),
			},
		});
		await verifyUpload(
			{ assetId: rejectedAssetId, allowQuarantinedReverification: true },
			dependencies,
		);
		expect(inspections).toBe(1);
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: rejectedAssetId } }),
		).resolves.toMatchObject({ status: "QUARANTINED" });
	});

	it("retries the full legacy inspection after a transient inspection failure", async () => {
		const suffix = crypto.randomUUID();
		const assetId = `legacy_retry_${suffix.replaceAll("-", "")}`;
		const ownerId = `legacy-retry-owner-${suffix}`;
		let inspections = 0;
		const dependencies = createDatabaseVerifyUploadDependencies(client, {
			headObject: async () => ({
				contentLength: 16,
				contentType: "image/png",
				etag: '"fresh-etag"',
				metadata: {},
			}),
			readMediaHeader: async () => PNG_HEADER,
			inspectPrivateMediaObject: async () => {
				inspections += 1;
				if (inspections === 1) throw new Error("transient object-store failure");
				return {
					bytes: 16,
					sha256: "a".repeat(64),
					etag: '"fresh-etag"',
					versionId: "fresh-version",
				};
			},
			createSignedReadUrl: async () => "https://private.example/legacy-retry.png",
			safety: new TestMediaSafetyAdapter("ALLOW"),
			moderationProvider: "legacy-retry-test",
		});
		await client.mediaAsset.create({
			data: {
				id: assetId,
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				status: "QUARANTINED",
				objectKey: `users/${ownerId}/assets/${assetId}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
			},
		});

		await expect(
			verifyUpload({ assetId, allowQuarantinedReverification: true }, dependencies),
		).rejects.toThrow("transient object-store failure");
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
		).resolves.toMatchObject({
			status: "VERIFYING",
			checksum: null,
			finalizedAt: null,
		});
		await verifyUpload({ assetId }, dependencies);
		expect(inspections).toBe(1);

		await verifyUpload({ assetId, allowQuarantinedReverification: true }, dependencies);
		expect(inspections).toBe(2);
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
		).resolves.toMatchObject({
			status: "READY",
			checksum: "a".repeat(64),
			storageEtag: '"fresh-etag"',
			storageVersionId: "fresh-version",
			finalizedAt: expect.any(Date),
		});
	});
});

function assertSafeTestDatabaseUrl(value: string | undefined): void {
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(value);
	if (
		!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) ||
		parsed.port !== "55432" ||
		!/(^|[_-])(test|testing)([_-]|$)/.test(parsed.pathname.slice(1).toLowerCase())
	) {
		throw new Error("TEST_DATABASE_URL must target a local test database on port 55432");
	}
}
