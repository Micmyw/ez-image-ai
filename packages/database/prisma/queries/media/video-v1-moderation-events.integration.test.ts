import { PrismaPg } from "@prisma/adapter-pg";
import { VIDEO_OUTPUT_MAX_BYTES } from "@repo/config/video-output";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runWithDatabaseClient } from "../../client";
import { PrismaClient } from "../../generated/client";
import { createCreditGrant, releaseCredits } from "./credits";
import { createVideoJobRecord, createVideoQuoteRecord } from "./video-v1";
import {
	listPendingVideoModerationEvents,
	markVideoModerationWebhookNotified,
	persistVideoModerationWebhook,
} from "./video-v1-moderation-events";

describe("video moderation durable inbox isolated PostgreSQL", () => {
	let client: PrismaClient;
	const ownerId = `video-moderation-test-${crypto.randomUUID()}`;
	const taskId = `med_${crypto.randomUUID().replaceAll("-", "")}`;
	let jobId: string;
	beforeAll(async () => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString) throw new Error("BLOCKED: explicit TEST_DATABASE_URL required");
		const url = new URL(connectionString);
		if (
			!["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
			!/(^|[_-])test([_-]|$)/.test(url.pathname.slice(1))
		)
			throw new Error("UNSAFE_TEST_DATABASE");
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 10 }) });
		const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
		await createCreditGrant(
			{ accountId: account.id, amount: 100n, referenceKey: `test:${ownerId}` },
			client,
		);
		const request = {
			mode: "text-to-video" as const,
			prompt: "A calm blue lake",
			duration: 5 as const,
			sound: false as const,
			aspectRatio: "16:9" as const,
		};
		const price = {
			credits: 7n,
			pricingVersion: "TEST_ONLY",
			providerCostMicros: 2n,
			moderationCostMicros: 1n,
			pricingBasis: "ISOLATED_TEST_NOT_A_FORMAL_PRICE",
		};
		const visualSafetyProfile = createVideoVisualSafetyProfile("sightengine", request.duration);
		const textSafetyProfile = createVideoTextSafetyProfile();
		const audioSafetyPolicy = { schemaVersion: 1 as const, mode: "not_requested" as const };
		const quote = await createVideoQuoteRecord(
			{
				ownerId,
				request,
				price,
				visualSafetyProfile,
				textSafetyProfile,
				audioSafetyPolicy,
				maximumInputBytes: 10_000_000,
			},
			client,
		);
		const job = await createVideoJobRecord(
			{
				ownerId,
				quoteId: quote.quoteId,
				idempotencyKey: crypto.randomUUID(),
				request,
				price,
				visualSafetyProfile,
				textSafetyProfile,
				audioSafetyPolicy,
				limits: {
					ownerConcurrency: 1,
					// This isolated inbox test may run after other suites retain fixtures.
					// Admission concurrency itself is covered by video-v1.integration.test.
					globalConcurrency: 10_000,
					providerConcurrency: 10_000,
					maximumStorageBytes: BigInt(VIDEO_OUTPUT_MAX_BYTES),
					maximumInputBytes: 10_000_000,
				},
			},
			client,
		);
		jobId = job.jobId;
	});
	afterAll(async () => {
		if (!client) return;
		if (jobId) {
			const job = await client.generationJob.findUnique({
				where: { id: jobId },
				include: { reservation: true },
			});
			if (job?.reservation?.status === "ACTIVE")
				await releaseCredits(
					{
						reservationId: job.reservation.id,
						amount: job.reservation.amount,
						referenceKey: `test-cleanup:${jobId}`,
					},
					client,
				);
			await client.videoExecution.update({ where: { jobId }, data: { stage: "FAILED" } });
			await client.generationJob.update({
				where: { id: jobId },
				data: { status: "FAILED", terminalAt: new Date() },
			});
		}
		await client.$disconnect();
	});
	it("deduplicates concurrent early events, binds only original sealed output then persists notification", async () => {
		await runWithDatabaseClient(client, async () => {
			const input = { taskId, eventHash: "a".repeat(64), receivedAt: new Date() };
			const events = await Promise.all(
				Array.from({ length: 10 }, () => persistVideoModerationWebhook(input)),
			);
			expect(new Set(events.map((x) => x.eventId)).size).toBe(1);
			expect(events.filter((event) => !event.replayed)).toHaveLength(1);
			expect(events.every((x) => x.jobId === undefined)).toBe(true);
			expect(await listPendingVideoModerationEvents(20, jobId)).toEqual([]);
			const asset = await client.mediaAsset.create({
				data: {
					ownerType: "USER",
					ownerId,
					kind: "OUTPUT",
					status: "VERIFYING",
					verificationEngine: "video-workflow-v1",
					verificationProvider: "sightengine",
					verificationRuleVersion: "video-safety-2026-10-04.1",
					verificationPolicyVersion: "video-policy-2026-10-04.1",
					verificationProviderTaskId: taskId,
					objectKey: `test/${ownerId}/sealed.mp4`,
					mimeType: "video/mp4",
					byteSize: 100n,
					checksum: "b".repeat(64),
					storageEtag: "etag-fixture",
					finalizedAt: new Date(),
				},
			});
			await client.generationJobAsset.create({
				data: {
					jobId,
					assetId: asset.id,
					role: "OUTPUT",
					position: 0,
					assetChecksum: asset.checksum!,
				},
			});
			const pending = await listPendingVideoModerationEvents(20, jobId);
			expect(pending).toHaveLength(1);
			expect(pending[0]).toMatchObject({ jobId, workflowInstanceId: `video-v1-${jobId}` });
			await markVideoModerationWebhookNotified(pending[0]!.eventId);
			expect(await listPendingVideoModerationEvents(20, jobId)).toEqual([]);
			expect(await persistVideoModerationWebhook(input)).toMatchObject({
				replayed: true,
				notified: true,
				jobId,
			});
			expect(await client.outboxEvent.count({ where: { aggregateId: jobId } })).toBe(0);
			const stored = await client.providerWebhookEvent.findUniqueOrThrow({
				where: { id: pending[0]!.eventId },
			});
			expect(stored.envelope).toMatchObject({
				assetId: asset.id,
				checksum: asset.checksum,
				etag: "etag-fixture",
			});
		});
	});
	it.each(["seeapi", "sightengine"])(
		"a legacy callback cannot bind a SeeAPI-profile job even with asset provider %s",
		async (assetProvider) => {
			const original = await client.generationJob.findUniqueOrThrow({ where: { id: jobId } });
			const profile = createVideoVisualSafetyProfile("seeapi", 5);
			const inputSnapshot = { duration: 5, visualSafetyProfile: profile };
			const quote = await client.generationQuote.create({
				data: {
					ownerType: "USER",
					ownerId,
					submittedByUserId: ownerId,
					productKey: original.productKey,
					catalogVersion: "TEST",
					pricingVersion: "TEST",
					credits: 1n,
					costMicros: 1n,
					inputSnapshot,
					pricingSnapshot: {},
					expiresAt: new Date(Date.now() + 60_000),
				},
			});
			const isolatedJob = await client.generationJob.create({
				data: {
					ownerType: "USER",
					ownerId,
					submittedByUserId: ownerId,
					quoteId: quote.id,
					idempotencyKey: crypto.randomUUID(),
					productKey: original.productKey,
					catalogVersion: "TEST",
					pricingVersion: "TEST",
					creditsReserved: 1n,
					inputSnapshot,
					pricingSnapshot: {},
					executionEngine: "video-workflow-v1",
					status: "FINALIZING",
				},
			});
			await client.videoExecution.create({
				data: {
					jobId: isolatedJob.id,
					workflowInstanceId: `video-v1-${isolatedJob.id}`,
					stage: "OUTPUT_REVIEW",
					modelContractVersion: "TEST",
				},
			});
			const crossTaskId = `med_${crypto.randomUUID().replaceAll("-", "")}`;
			const asset = await client.mediaAsset.create({
				data: {
					ownerType: "USER",
					ownerId,
					kind: "OUTPUT",
					status: "VERIFYING",
					verificationEngine: "video-workflow-v1",
					verificationProvider: assetProvider,
					verificationRuleVersion:
						assetProvider === "seeapi" ? profile.ruleVersion : "video-safety-2026-10-04.1",
					verificationPolicyVersion:
						assetProvider === "seeapi" ? profile.policyVersion : "video-policy-2026-10-04.1",
					verificationProviderTaskId: crossTaskId,
					objectKey: `test/${ownerId}/${crossTaskId}.mp4`,
					mimeType: "video/mp4",
					byteSize: 100n,
					checksum: "c".repeat(64),
					storageEtag: "etag-cross",
					finalizedAt: new Date(),
				},
			});
			await client.generationJobAsset.create({
				data: {
					jobId: isolatedJob.id,
					assetId: asset.id,
					role: "OUTPUT",
					position: 0,
					assetChecksum: asset.checksum!,
				},
			});
			await runWithDatabaseClient(client, async () => {
				const event = await persistVideoModerationWebhook({
					taskId: crossTaskId,
					eventHash: "c".repeat(64),
					receivedAt: new Date(),
				});
				expect(event.jobId).toBeUndefined();
				expect(await listPendingVideoModerationEvents(20, isolatedJob.id)).toEqual([]);
			});
			await client.videoExecution.update({
				where: { jobId: isolatedJob.id },
				data: { stage: "FAILED" },
			});
			await client.generationJob.update({
				where: { id: isolatedJob.id },
				data: { status: "FAILED", terminalAt: new Date() },
			});
		},
	);
});
