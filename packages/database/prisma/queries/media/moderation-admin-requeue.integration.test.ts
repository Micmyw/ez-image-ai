import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import { requeueAdminMediaVerification } from "./admin-operations";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe("admin media verification requeue", () => {
	let client: PrismaClient;

	beforeAll(() => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl(TEST_DATABASE_URL) }),
		});
	});

	afterAll(async () => client?.$disconnect());

	it("starts one new evidence generation and never marks the asset READY", async () => {
		const suffix = crypto.randomUUID();
		const exhaustedAt = new Date();
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId: `moderation-admin-${suffix}`,
				kind: "INPUT",
				status: "VERIFICATION_FAILED",
				objectKey: `users/moderation-admin-${suffix}/assets/${suffix}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
				checksum: "f".repeat(64),
				finalizedAt: new Date(),
				verificationGeneration: 2,
				verificationAttemptCount: 4,
				verificationExhaustedAt: exhaustedAt,
				verificationDeadlineAt: new Date(Date.now() + 60_000),
				verificationSubmissionToken: crypto.randomUUID(),
				verificationSubmissionUncertain: true,
				verificationSubmittedAt: new Date(),
				verificationLastErrorCode: "MODERATION_UNAVAILABLE",
			},
		});
		const input = {
			assetId: asset.id,
			actorUserId: `admin-${suffix}`,
			idempotencyKey: `moderation-requeue-${suffix}`,
			reason: "Re-run the failed asset with the current moderation policy",
			currentVerification: {
				provider: "test",
				ruleVersion: "asset-rule-v2",
				policyVersion: "policy-v2",
			},
		};

		await expect(requeueAdminMediaVerification(input, client)).resolves.toEqual({
			assetId: asset.id,
			generation: 3,
			replayed: false,
		});
		await expect(requeueAdminMediaVerification(input, client)).resolves.toEqual({
			assetId: asset.id,
			generation: 3,
			replayed: true,
		});

		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } }),
		).resolves.toMatchObject({
			status: "VERIFYING",
			verificationGeneration: 3,
			verificationAttemptCount: 0,
			verificationExhaustedAt: null,
			verificationDeadlineAt: null,
			verificationSubmissionToken: null,
			verificationSubmissionUncertain: false,
			verificationSubmittedAt: null,
			verificationValidUntil: null,
			verificationLastErrorCode: null,
		});
		await expect(
			client.outboxEvent.count({
				where: { aggregateId: asset.id, eventType: "MEDIA_ASSET_VERIFY" },
			}),
		).resolves.toBe(1);
	});

	it("requeues a READY asset only when its evidence is stale against the server contract", async () => {
		const suffix = crypto.randomUUID();
		const checksum = "a".repeat(64);
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId: `moderation-admin-${suffix}`,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: `users/moderation-admin-${suffix}/assets/${suffix}/stale.png`,
				mimeType: "image/png",
				byteSize: 16n,
				checksum,
				finalizedAt: new Date(),
				verificationGeneration: 1,
				verificationAttemptCount: 1,
				verificationProvider: "test",
				verificationRuleVersion: "asset-rule-v1",
				verificationPolicyVersion: "policy-v1",
				verificationValidUntil: new Date(Date.now() + 60_000),
			},
		});
		const verificationValidUntil = (
			await client.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })
		).verificationValidUntil!;
		await client.assetModerationResult.create({
			data: {
				assetId: asset.id,
				assetChecksum: checksum,
				verificationGeneration: 1,
				attemptNumber: 1,
				evidenceKind: "INPUT",
				provider: "test",
				ruleVersion: "asset-rule-v1",
				policyVersion: "policy-v1",
				status: "APPROVED",
				validUntil: verificationValidUntil,
				reasonCode: "TEST_ALLOW",
				categories: {},
				rawEnvelope: { decision: "ALLOW" },
			},
		});
		await client.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY" } });
		const baseInput = {
			assetId: asset.id,
			actorUserId: `admin-${suffix}`,
			reason: "Re-run with the current moderation policy after a rules update",
		};

		await expect(
			requeueAdminMediaVerification(
				{
					...baseInput,
					idempotencyKey: `moderation-current-${suffix}`,
					currentVerification: {
						provider: "test",
						ruleVersion: "asset-rule-v1",
						policyVersion: "policy-v1",
					},
				},
				client,
			),
		).rejects.toThrow("MEDIA_VERIFICATION_NOT_REQUEUEABLE");

		await expect(
			requeueAdminMediaVerification(
				{
					...baseInput,
					idempotencyKey: `moderation-stale-${suffix}`,
					currentVerification: {
						provider: "test",
						ruleVersion: "asset-rule-v2",
						policyVersion: "policy-v2",
					},
				},
				client,
			),
		).resolves.toEqual({ assetId: asset.id, generation: 2, replayed: false });

		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } }),
		).resolves.toMatchObject({
			status: "VERIFYING",
			verificationGeneration: 2,
			verificationAttemptCount: 0,
			verificationProvider: null,
			verificationRuleVersion: null,
			verificationPolicyVersion: null,
		});
	});

	it("never requeues an OUTPUT through the input verification recovery command", async () => {
		const suffix = crypto.randomUUID();
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId: `moderation-admin-${suffix}`,
				kind: "OUTPUT",
				status: "VERIFICATION_FAILED",
				objectKey: `users/moderation-admin-${suffix}/assets/${suffix}/output.png`,
				mimeType: "image/png",
				byteSize: 16n,
				verificationGeneration: 1,
				verificationAttemptCount: 4,
				verificationExhaustedAt: new Date(),
			},
		});

		await expect(
			requeueAdminMediaVerification(
				{
					assetId: asset.id,
					actorUserId: `admin-${suffix}`,
					idempotencyKey: `moderation-output-${suffix}`,
					reason: "Attempt to re-run an output after its reservation is terminal",
					currentVerification: {
						provider: "test",
						ruleVersion: "asset-rule-v2",
						policyVersion: "policy-v2",
					},
				},
				client,
			),
		).rejects.toThrow("MEDIA_OUTPUT_VERIFICATION_REQUEUE_FORBIDDEN");
	});
});

function safeTestDatabaseUrl(value: string | undefined): string {
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(value);
	if (
		parsed.hostname !== "127.0.0.1" ||
		parsed.port !== "55432" ||
		!["/ezpic_moderation_repair_test", "/ezpic_moderation_hardening_test"].includes(parsed.pathname)
	) {
		throw new Error("TEST_DATABASE_URL must target the disposable moderation test database");
	}
	return value;
}
