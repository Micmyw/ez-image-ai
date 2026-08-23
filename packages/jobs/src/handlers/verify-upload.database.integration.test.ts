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
});

function assertSafeTestDatabaseUrl(value: string | undefined): void {
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(value);
	if (
		parsed.hostname !== "127.0.0.1" ||
		parsed.port !== "55432" ||
		parsed.pathname !== "/ai_media_foundation_test"
	) {
		throw new Error("TEST_DATABASE_URL must target 127.0.0.1:55432/ai_media_foundation_test");
	}
}
