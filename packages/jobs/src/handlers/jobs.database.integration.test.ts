import { PrismaPg } from "@prisma/adapter-pg";
import {
	createCreditGrant,
	createGenerationJobTransaction,
	createModeratedGenerationQuoteTransaction,
	fingerprintGenerationQuoteSecurityPayload,
	ingestProviderEvent,
	settleCredits,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
	DispatchStore,
	FinalizationStore,
	ProviderEventStore,
	SettlementStore,
} from "../contracts";
import { dispatchGeneration } from "./dispatch-generation";
import { finalizeMedia } from "./finalize-media";
import { processProviderEvent } from "./process-provider-event";
import { settleGeneration } from "./settle-generation";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
let client: PrismaClient;

describe("database-backed media generation", () => {
	beforeAll(() => {
		assertSafeTestDatabaseUrl(TEST_DATABASE_URL);
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL! }),
		});
	});

	afterAll(async () => client?.$disconnect());

	it("replays creation, provider events and settlement without duplicate side effects", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `task4-user-${suffix}`;
		const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
		await createCreditGrant(
			{ accountId: account.id, amount: 20n, referenceKey: `task4-grant:${suffix}` },
			client,
		);
		const inputChecksum = "b".repeat(64);
		const verificationValidUntil = new Date(Date.now() + 60_000);
		const inputAsset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: `users/${ownerId}/assets/${suffix}/input.png`,
				mimeType: "image/png",
				byteSize: 32n,
				checksum: inputChecksum,
				finalizedAt: new Date(),
				verificationGeneration: 1,
				verificationAttemptCount: 1,
				verificationProvider: "test",
				verificationRuleVersion: "test-rule-v1",
				verificationPolicyVersion: "test-policy-v1",
				verificationValidUntil,
			},
		});
		await client.assetModerationResult.create({
			data: {
				assetId: inputAsset.id,
				assetChecksum: inputChecksum,
				verificationGeneration: 1,
				attemptNumber: 1,
				evidenceKind: "INPUT",
				provider: "test",
				ruleVersion: "test-rule-v1",
				policyVersion: "test-policy-v1",
				status: "APPROVED",
				reasonCode: "TEST_ALLOW",
				categories: {},
				rawEnvelope: { decision: "ALLOW" },
				validUntil: verificationValidUntil,
			},
		});
		await client.mediaAsset.update({
			where: { id: inputAsset.id },
			data: { status: "READY" },
		});
		const quoteInput = {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			productKey: "image-fast",
			catalogVersion: "2026-08-13.1",
			pricingVersion: "2026-08-13.1",
			credits: 4n,
			costMicros: 3_000n,
			inputSnapshot: { kind: "text-to-image", prompt: "test" },
			pricingSnapshot: { credits: 4 },
			expiresAt: new Date(Date.now() + 60_000),
		} as const;
		const quote = await createModeratedGenerationQuoteTransaction(
			{
				...quoteInput,
				moderation: {
					decision: "ALLOW",
					provider: "test",
					ruleVersion: "TEST_ALLOW_JOBS_INTEGRATION_V1",
					reasonCode: "TEST_ALLOW_JOBS_INTEGRATION",
					inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quoteInput),
				},
			},
			client,
		);
		const creation = {
			ownerType: "USER" as const,
			ownerId,
			submittedByUserId: ownerId,
			quoteId: quote.id,
			idempotencyKey: `task4-idempotency:${suffix}`,
			inputAssetIds: [inputAsset.id],
			expectedModerationRuleVersion: "TEST_ALLOW_JOBS_INTEGRATION_V1",
			expectedAssetModerationRuleVersion: "test-rule-v1",
			expectedAssetModerationPolicyVersion: "test-policy-v1",
		};
		const first = await createGenerationJobTransaction(creation, client);
		const duplicate = await createGenerationJobTransaction(creation, client);
		expect(first.job.id).toBe(duplicate.job.id);

		const dispatchStore = createDispatchStore(first.job.id);
		const mockProvider = {
			provider: "replicate" as const,
			submit: vi.fn(async () => ({
				providerTaskId: `provider-${suffix}`,
				status: "QUEUED" as const,
				outcome: "accepted" as const,
				idempotency: { key: `attempt-${suffix}`, providerSupported: true, replayed: false },
				reconciliation: { submissionToken: `attempt-${suffix}` },
			})),
			retrieve: vi.fn(),
			normalizeResult: vi.fn(async () => ({
				outputs: [
					{
						kind: "remote-url" as const,
						url: "https://replicate.delivery/mock.png",
						trust: "untrusted-transfer-candidate" as const,
					},
				],
				progress: 100,
				providerCostMicros: 3_000,
				failure: null,
				retryable: false,
				providerCharged: true,
			})),
		};
		await dispatchGeneration(
			{ jobId: first.job.id, version: first.job.version },
			{ store: dispatchStore, getProvider: () => mockProvider },
		);
		await dispatchGeneration(
			{ jobId: first.job.id, version: first.job.version },
			{ store: dispatchStore, getProvider: () => mockProvider },
		);
		expect(mockProvider.submit).toHaveBeenCalledTimes(1);

		const eventInput = {
			provider: "replicate",
			providerEventId: `webhook-${suffix}`,
			providerTaskId: `provider-${suffix}`,
			verifiedAt: new Date(),
			envelope: { id: `provider-${suffix}`, status: "succeeded" },
		};
		const event = await ingestProviderEvent(eventInput, client);
		const duplicateEvent = await ingestProviderEvent(eventInput, client);
		expect(duplicateEvent.replayed).toBe(true);
		await processProviderEvent(
			{ providerWebhookEventId: event.event.id },
			{ store: createProviderEventStore(event.event.id), getProvider: () => mockProvider },
		);

		const finalizationStore = createFinalizationStore(first.job.id, ownerId);
		await finalizeMedia(
			{ jobId: first.job.id, version: 0 },
			{
				store: finalizationStore,
				persistCandidate: async (_claim, candidate) => {
					const checksum = "a".repeat(64);
					const outputVerificationValidUntil = new Date(Date.now() + 60_000);
					const asset = await client.mediaAsset.create({
						data: {
							ownerType: "USER",
							ownerId,
							kind: "OUTPUT",
							status: "VERIFYING",
							objectKey: `users/${ownerId}/assets/${suffix}/output.png`,
							mimeType: "image/png",
							byteSize: 64n,
							checksum,
							finalizedAt: new Date(),
							verificationGeneration: 1,
							verificationAttemptCount: 1,
							verificationProvider: "test",
							verificationRuleVersion: "test-rule-v1",
							verificationPolicyVersion: "test-policy-v1",
							verificationValidUntil: outputVerificationValidUntil,
							sourceUrl: `provider-output:${candidate.key}`,
						},
					});
					await client.assetModerationResult.create({
						data: {
							assetId: asset.id,
							assetChecksum: checksum,
							verificationGeneration: 1,
							attemptNumber: 1,
							evidenceKind: "OUTPUT",
							provider: "test",
							ruleVersion: "test-rule-v1",
							policyVersion: "test-policy-v1",
							status: "APPROVED",
							reasonCode: "TEST_ALLOW",
							categories: {},
							rawEnvelope: { decision: "ALLOW" },
							validUntil: outputVerificationValidUntil,
						},
					});
					await client.mediaAsset.update({
						where: { id: asset.id },
						data: { status: "READY" },
					});
					return { assetId: asset.id, approved: true };
				},
			},
		);
		const settlementStore = createSettlementStore(first.job.id);
		await settleGeneration({ jobId: first.job.id, version: 0 }, { store: settlementStore });
		await settleGeneration({ jobId: first.job.id, version: 0 }, { store: settlementStore });

		expect(
			await client.creditLedgerEntry.count({ where: { referenceKey: `settle:${first.job.id}` } }),
		).toBe(1);
		expect(
			await client.generationJob.findUniqueOrThrow({ where: { id: first.job.id } }),
		).toMatchObject({
			status: "SUCCEEDED",
		});
		expect(
			await client.generationJobAsset.count({ where: { jobId: first.job.id, role: "OUTPUT" } }),
		).toBe(1);
	});
});

function createDispatchStore(jobId: string): DispatchStore {
	return {
		async claimDispatch() {
			return client.$transaction(async (tx) => {
				const job = await tx.generationJob.findFirst({ where: { id: jobId, status: "RESERVED" } });
				if (!job) return null;
				const attempt = await tx.generationAttempt.create({
					data: {
						jobId,
						attemptNumber: 1,
						provider: "replicate",
						providerModelId: "test-model",
						requestSnapshot: {},
					},
				});
				await tx.generationJob.update({ where: { id: jobId }, data: { status: "SUBMITTING" } });
				return {
					attemptId: attempt.id,
					attemptNumber: attempt.attemptNumber,
					serviceClass: "STANDARD",
					provider: "replicate",
					providerModelId: "test-model",
					mediaKind: "image",
					queueKey: "replicate:test-model",
					input: { kind: "text-to-image", prompt: "test" },
				};
			});
		},
		async recordSubmissionStarted() {},
		async recordSubmission(attemptId, submission) {
			await client.$transaction([
				client.generationAttempt.update({
					where: { id: attemptId },
					data: { status: "SUBMITTED", providerTaskId: submission.providerTaskId },
				}),
				client.generationJob.update({ where: { id: jobId }, data: { status: "PROVIDER_PENDING" } }),
			]);
		},
		async recordSynchronousCompletion() {},
		async recordUncertainSubmission() {},
		async recordProviderAdapterUnavailable() {},
		async recordRejectedSubmission() {},
	};
}

function createProviderEventStore(eventId: string): ProviderEventStore {
	return {
		async claimProviderEvent() {
			const event = await client.providerWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
			const attempt = await client.generationAttempt.findFirstOrThrow({
				where: { provider: event.provider, providerTaskId: event.providerTaskId },
			});
			return {
				eventId,
				attemptId: attempt.id,
				provider: "replicate",
				receivedAt: event.receivedAt,
				processingToken: "test-lease",
				snapshot: {
					providerTaskId: attempt.providerTaskId!,
					status: "SUCCEEDED",
					raw: event.envelope,
				},
			};
		},
		async recordProviderProgress(claim, result) {
			const attempt = await client.generationAttempt.findUniqueOrThrow({
				where: { id: claim.attemptId },
			});
			await client.$transaction([
				client.generationAttempt.update({
					where: { id: attempt.id },
					data: { status: "SUCCEEDED", responseSnapshot: { outputs: result.outputs } },
				}),
				client.generationJob.update({
					where: { id: attempt.jobId },
					data: { status: "FINALIZING" },
				}),
				client.providerWebhookEvent.update({
					where: { id: eventId },
					data: { status: "PROCESSED", processedAt: new Date() },
				}),
			]);
		},
		async markProviderRecoveryUnavailable() {},
		async recordProviderEventFailure() {},
	};
}

function createFinalizationStore(jobId: string, ownerId: string): FinalizationStore {
	return {
		async claimFinalization() {
			const attempt = await client.generationAttempt.findFirstOrThrow({
				where: { jobId, status: "SUCCEEDED" },
			});
			const response = attempt.responseSnapshot as {
				outputs: Array<{ kind: "remote-url"; url: string; trust: "untrusted-transfer-candidate" }>;
			};
			return {
				jobId,
				ownerId,
				mediaKind: "image",
				candidates: response.outputs.map((output, index) => ({
					key: `${attempt.id}:${index}`,
					output,
				})),
			};
		},
		async findPersistedCandidate() {
			return null;
		},
		async recordFinalization(_claim, results) {
			for (const [position, result] of results.entries()) {
				const asset = await client.mediaAsset.findUniqueOrThrow({
					where: { id: result.assetId },
					select: { checksum: true },
				});
				if (!asset.checksum) throw new Error("Missing output checksum");
				await client.generationJobAsset.create({
					data: {
						jobId,
						assetId: result.assetId,
						assetChecksum: asset.checksum,
						role: "OUTPUT",
						position,
					},
				});
			}
		},
		async recordFinalizationRetry() {},
	};
}

function createSettlementStore(jobId: string): SettlementStore {
	return {
		async claimSettlement() {
			const job = await client.generationJob.findFirst({
				where: { id: jobId, status: "FINALIZING" },
				include: { reservation: true, assets: { where: { role: "OUTPUT" } } },
			});
			if (!job?.reservation || job.reservation.status !== "ACTIVE") return null;
			return {
				jobId,
				reservationId: job.reservation.id,
				reservedCredits: job.creditsReserved,
				chargeCredits: job.creditsReserved,
				readyOutputCount: job.assets.length,
				providerCostMicros: 3_000n,
			};
		},
		async settle(claim) {
			await settleCredits(
				{
					reservationId: claim.reservationId,
					amount: claim.chargeCredits,
					referenceKey: `settle:${jobId}`,
				},
				client,
			);
			await client.generationJob.update({ where: { id: jobId }, data: { status: "SUCCEEDED" } });
		},
	};
}

function assertSafeTestDatabaseUrl(value: string | undefined): void {
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(value);
	const safeDatabase =
		parsed.pathname === "/ai_media_foundation_test" ||
		/^\/ezpic_[a-z0-9_]+_test$/.test(parsed.pathname);
	if (parsed.hostname !== "127.0.0.1" || parsed.port !== "55432" || !safeDatabase) {
		throw new Error(
			"TEST_DATABASE_URL must target 127.0.0.1:55432/ai_media_foundation_test or a dedicated ezpic_*_test database",
		);
	}
}
