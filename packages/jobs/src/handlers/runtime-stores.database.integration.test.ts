import { createHash } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import {
	FalProviderAdapter,
	GeminiProviderAdapter,
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
	ReplicateProviderAdapter,
	TestMediaSafetyAdapter,
	type ProviderKey,
} from "@repo/ai";
import {
	beginGuestLinkIntentTransaction,
	completeGuestLinkIntentTransaction,
	createCreditGrant,
	createGenerationJobTransaction,
	createRuntimeConfigOverride,
	revertRuntimeConfigOverride,
	resolveAdminUncertainSubmission,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { MediaValidationError } from "@repo/storage";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DispatchAdmissionBlockedError } from "../contracts";
import {
	createDatabaseDispatchStore,
	createDatabaseGuestAdmissionDependencies,
	createFinalizationDependencies,
	createDatabaseFinalizationStore,
	createDatabaseProviderEventStore,
	createDatabaseReconciliationStore,
	createDatabaseSettlementStore,
	createDatabaseVerifyUploadDependencies,
	resolveDatabaseDispatchRoute,
	type DispatchRuntimeOptions,
} from "../runtime";
import { dispatchGeneration } from "./dispatch-generation";
import { finalizeMedia } from "./finalize-media";
import { reconcileGenerations } from "./reconcile-generations";
import { settleGeneration } from "./settle-generation";
import { verifyUpload } from "./verify-upload";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_EXECUTABLE_PROVIDERS = new Set<ProviderKey>(["replicate", "fal", "kie", "gemini"]);
let client: PrismaClient;

function createTestDispatchStore(options: Omit<DispatchRuntimeOptions, "enabledProviders"> = {}) {
	return createDatabaseDispatchStore(client, {
		createSignedReadUrl: async () => "https://private.example/runtime-input.png",
		...options,
		enabledProviders: TEST_EXECUTABLE_PROVIDERS,
	});
}

describe("production media runtime stores", () => {
	beforeAll(() => {
		assertSafeTestDatabaseUrl(TEST_DATABASE_URL);
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL! }),
		});
	});

	afterAll(async () => client?.$disconnect());

	it("queues a catalog-approved route after a retryable rejected submission", async () => {
		const seeded = await seedReservedJob("image-fast");
		const store = createTestDispatchStore();
		const claim = await store.claimDispatch({ jobId: seeded.jobId, version: 0 });
		expect(claim).not.toBeNull();

		await store.recordRejectedSubmission(claim!.attemptId, {
			code: "PROVIDER_TEMPORARY",
			message: "temporary rejection",
			retryable: true,
		});

		const job = await client.generationJob.findUniqueOrThrow({
			where: { id: seeded.jobId },
			include: { attempts: { orderBy: { attemptNumber: "asc" } }, reservation: true },
		});
		expect(job.status).toBe("DISPATCH_QUEUED");
		expect(job.reservation?.status).toBe("ACTIVE");
		expect(job.attempts[0]).toMatchObject({
			status: "FAILED",
			provider: claim!.provider,
			attemptNumber: 1,
		});
		expect(job.attempts[1]).toMatchObject({ status: "CREATED", attemptNumber: 2 });
		expect(job.attempts[1]?.provider).not.toBe(claim!.provider);
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_DISPATCH" },
			}),
		).toBe(1);
	});

	it("atomically closes an unavailable Outbox route into manual reconciliation", async () => {
		const seeded = await seedReservedJob("image-fast");
		const options = {
			database: client,
			enabledProviders: new Set<ProviderKey>(),
			environment: { MEDIA_GENERATION_ENABLED: "true" },
		} as DispatchRuntimeOptions & { database: PrismaClient };

		await expect(resolveDatabaseDispatchRoute(seeded.jobId, options)).resolves.toBeNull();
		const [job, reservation, audits] = await Promise.all([
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
			client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
			client.auditLog.count({
				where: { action: "MEDIA_DISPATCH_ROUTE_UNAVAILABLE", targetId: seeded.jobId },
			}),
		]);
		expect(job).toMatchObject({ status: "NEEDS_RECONCILIATION" });
		expect(reservation).toMatchObject({ status: "ACTIVE", settledAmount: 0n, releasedAmount: 0n });
		expect(audits).toBe(1);
	});

	it("resolves an API dispatch route from configured providers without worker credentials", async () => {
		const seeded = await seedReservedJob("image-fast");

		await expect(
			resolveDatabaseDispatchRoute(seeded.jobId, {
				database: client,
				environment: {
					MEDIA_GENERATION_ENABLED: "true",
					MEDIA_ENABLED_PROVIDERS: "replicate",
				},
			}),
		).resolves.toMatchObject({ provider: "replicate" });

		const [job, attemptCount, auditCount] = await Promise.all([
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
			client.generationAttempt.count({ where: { jobId: seeded.jobId } }),
			client.auditLog.count({
				where: { action: "MEDIA_DISPATCH_ROUTE_UNAVAILABLE", targetId: seeded.jobId },
			}),
		]);
		expect(job.status).toBe("RESERVED");
		expect(attemptCount).toBe(0);
		expect(auditCount).toBe(0);
	});

	it("persists a stable pre-send fingerprint without signed input material", async () => {
		const seeded = await seedReservedImageEditJob();
		const signedUrl =
			"https://private.example/input.png?X-Amz-Credential=temporary&X-Amz-Signature=secret";
		const store = createTestDispatchStore({ createSignedReadUrl: async () => signedUrl });
		const claim = await store.claimDispatch({ jobId: seeded.jobId, version: 0 });
		if (!claim) throw new Error("Expected a dispatch claim");
		const before = await client.generationAttempt.findUniqueOrThrow({
			where: { id: claim.attemptId },
			select: { requestSnapshot: true },
		});
		await store.recordSubmissionStarted(claim.attemptId);
		await store.recordSubmissionStarted(claim.attemptId);
		const after = await client.generationAttempt.findUniqueOrThrow({
			where: { id: claim.attemptId },
			select: { requestSnapshot: true },
		});
		const requestSnapshot = after.requestSnapshot as Record<string, unknown>;

		expect(requestSnapshot).toMatchObject({
			attemptNumber: 1,
			provider: claim.provider,
			providerModelId: claim.providerModelId,
			submissionPhase: "pre_send",
		});
		expect(requestSnapshot.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(after.requestSnapshot).toEqual(before.requestSnapshot);
		expect(JSON.stringify(after.requestSnapshot)).not.toContain("X-Amz-Signature");
		expect(JSON.stringify(after.requestSnapshot)).not.toContain(signedUrl);
	});

	it("allows two racing workers to submit a guest trial only once", async () => {
		const guest = await seedGuestDispatchJob();
		const submit = vi.fn(async () => ({
			providerTaskId: `guest-provider-${crypto.randomUUID()}`,
			status: "QUEUED" as const,
			outcome: "accepted" as const,
			idempotency: { key: guest.jobId, providerSupported: true, replayed: false },
			reconciliation: { submissionToken: guest.jobId },
		}));
		const provider = {
			provider: "replicate" as const,
			submit,
			retrieve: vi.fn(),
			normalizeResult: vi.fn(),
		};
		const store = createTestDispatchStore({
			environment: guest.environment,
		});
		try {
			await Promise.all([
				dispatchGeneration(
					{ jobId: guest.jobId, version: 0 },
					{ store, getProvider: () => provider },
				),
				dispatchGeneration(
					{ jobId: guest.jobId, version: 0 },
					{ store, getProvider: () => provider },
				),
			]);

			expect(submit).toHaveBeenCalledTimes(1);
			expect(await client.generationAttempt.count({ where: { jobId: guest.jobId } })).toBe(1);
			await expect(
				client.generationJob.findUniqueOrThrow({ where: { id: guest.jobId } }),
			).resolves.toMatchObject({ status: "PROVIDER_PENDING", serviceClass: "GUEST_SLOW" });
			await expect(
				client.guestMediaTrial.findUniqueOrThrow({ where: { id: guest.trialId } }),
			).resolves.toMatchObject({
				eligibility: "CONSUMED",
				riskState: "COMMITTED",
				consumedJobId: guest.jobId,
			});
		} finally {
			await client.generationJob.updateMany({
				where: { id: guest.jobId },
				data: { status: "FAILED", terminalAt: new Date() },
			});
			await revertRuntimeConfigOverride(guest.overrideId, "task4-guest-test", client);
		}
	});

	it("keeps internal guest polling separate from the public capacity estimate", async () => {
		await client.$executeRawUnsafe(
			'TRUNCATE TABLE "user", "guest_abuse_bucket", "guest_risk_budget_bucket", "outbox_event", "generation_quote" CASCADE',
		);
		const active = await seedGuestDispatchJob();
		const waiting = await seedGuestDispatchJob();
		await client.generationJob.update({
			where: { id: waiting.jobId },
			data: { status: "RESERVED", version: 0 },
		});
		const dependencies = createDatabaseGuestAdmissionDependencies(client, {
			environment: waiting.environment,
			retryDelayMs: 5_000,
		});
		try {
			const result = await dependencies.admit({
				jobId: waiting.jobId,
				trialId: waiting.trialId,
				now: waiting.now,
			});
			expect(result).toEqual({
				outcome: "BUSY",
				retryAt: new Date(waiting.now.getTime() + 5_000),
			});
			await expect(
				client.guestMediaTrial.findUniqueOrThrow({ where: { id: waiting.trialId } }),
			).resolves.toMatchObject({
				projectedDispatchAt: new Date(waiting.now.getTime() + 60_000),
				estimateExpiresAt: new Date(waiting.now.getTime() + 2 * 60_000),
			});
			await expect(
				client.generationJob.findUniqueOrThrow({ where: { id: waiting.jobId } }),
			).resolves.toMatchObject({
				dispatchEligibleAt: new Date(waiting.now.getTime() + 5_000),
			});
		} finally {
			await client.generationJob.updateMany({
				where: { id: { in: [active.jobId, waiting.jobId] } },
				data: { status: "FAILED", terminalAt: new Date() },
			});
			await Promise.all([
				revertRuntimeConfigOverride(active.overrideId, "task4-guest-test", client),
				revertRuntimeConfigOverride(waiting.overrideId, "task4-guest-test", client),
			]);
		}
	});

	it("keeps a waiting guest job admissible while its account link is in progress", async () => {
		await client.$executeRawUnsafe(
			'TRUNCATE TABLE "user", "guest_abuse_bucket", "guest_risk_budget_bucket", "outbox_event", "generation_quote" CASCADE',
		);
		const guest = await seedGuestDispatchJob();
		const trial = await client.guestMediaTrial.findUniqueOrThrow({ where: { id: guest.trialId } });
		if (trial.ownerId === null) throw new Error("Active guest trial owner is required");
		await client.generationJob.update({
			where: { id: guest.jobId },
			data: { status: "RESERVED", version: 0 },
		});
		await client.guestLinkIntent.create({
			data: {
				trialId: guest.trialId,
				anonymousOwnerId: trial.ownerId,
				promotionPeriod: trial.promotionPeriod,
				sourceSessionHash: guest.sourceSessionHash,
				deviceHash: guest.deviceHash,
				returnPath: "/try",
				state: "LINKING",
				tokenHash: createHash("sha256").update(`link:${guest.jobId}`).digest("hex"),
				idempotencyKey: `link:${guest.jobId}`,
				expiresAt: trial.expiresAt,
			},
		});
		const dependencies = createDatabaseGuestAdmissionDependencies(client, {
			environment: guest.environment,
		});
		try {
			await expect(
				dependencies.admit({ jobId: guest.jobId, trialId: guest.trialId, now: guest.now }),
			).resolves.toMatchObject({ outcome: "ADMITTED", jobId: guest.jobId });
			await expect(
				client.generationJob.findUniqueOrThrow({ where: { id: guest.jobId } }),
			).resolves.toMatchObject({ status: "DISPATCH_QUEUED", failureCode: null });
		} finally {
			await client.generationJob.updateMany({
				where: { id: guest.jobId },
				data: { status: "FAILED", terminalAt: new Date() },
			});
			await revertRuntimeConfigOverride(guest.overrideId, "task4-guest-test", client);
		}
	});

	it.each(["link-then-dispatch", "dispatch-then-link", "concurrent"] as const)(
		"%s preserves one canonical guest job and one Provider attempt",
		async (ordering) => {
			const fixture = await seedGuestLinkDispatchFixture(ordering);
			try {
				const { claim, linked } = await runGuestLinkDispatchOrdering(fixture, ordering);

				expect(claim).not.toBeNull();
				expect(linked).toMatchObject({ mode: "RESULT", jobId: fixture.jobId });
				await expect(fixture.completeLink("replay")).resolves.toMatchObject({
					mode: "RESULT",
					jobId: fixture.jobId,
				});
				await expect(fixture.claimDispatch()).resolves.toBeNull();

				const [job, trial, grants, attempt, registeredGraph, guestAccounts] = await Promise.all([
					client.generationJob.findUniqueOrThrow({
						where: { id: fixture.jobId },
						include: { attempts: true, quote: true },
					}),
					client.guestMediaTrial.findUniqueOrThrow({ where: { id: fixture.trialId } }),
					client.guestResultAccessGrant.findMany({
						where: {
							guestJobId: fixture.jobId,
							registeredUserId: fixture.registeredUserId,
						},
					}),
					client.generationAttempt.findUniqueOrThrow({ where: { id: claim!.attemptId } }),
					Promise.all([
						client.creditAccount.count({ where: { ownerId: fixture.registeredUserId } }),
						client.creditLot.count({
							where: { account: { ownerId: fixture.registeredUserId } },
						}),
						client.creditLedgerEntry.count({
							where: { account: { ownerId: fixture.registeredUserId } },
						}),
						client.generationQuote.count({ where: { ownerId: fixture.registeredUserId } }),
						client.generationJob.count({ where: { ownerId: fixture.registeredUserId } }),
						client.mediaAsset.count({ where: { ownerId: fixture.registeredUserId } }),
					]),
					client.creditAccount.count({ where: { ownerId: fixture.ownerId } }),
				]);

				expect(job).toMatchObject({
					ownerId: fixture.ownerId,
					status: "SUBMITTING",
					failureCode: null,
				});
				expect(job.quote.ownerId).toBe(fixture.ownerId);
				expect(job.attempts).toHaveLength(1);
				expect(attempt).toMatchObject({ jobId: fixture.jobId, attemptNumber: 1 });
				expect(trial).toMatchObject({
					ownerId: fixture.ownerId,
					currentJobId: null,
					consumedJobId: fixture.jobId,
					eligibility: "CONSUMED",
					riskState: "COMMITTED",
				});
				expect(trial.providerBoundaryAt).not.toBeNull();
				expect(grants).toHaveLength(1);
				expect(grants[0]).toMatchObject({
					trialId: fixture.trialId,
					guestJobId: fixture.jobId,
					registeredUserId: fixture.registeredUserId,
					expiresAt: trial.expiresAt,
				});
				expect(registeredGraph).toEqual([0, 0, 0, 0, 0, 0]);
				expect(guestAccounts).toBe(1);
			} finally {
				await cleanupGuestLinkDispatchFixture(fixture);
			}
		},
	);

	it("rejects both linking and final dispatch after immutable guest expiry", async () => {
		const fixture = await seedGuestLinkDispatchFixture("expired");
		const expiredAt = new Date(Date.now() - 1_000);
		const createdAt = new Date(expiredAt.getTime() - 10 * 60_000);
		try {
			await client.guestMediaTrial.update({
				where: { id: fixture.trialId },
				data: {
					createdAt,
					projectedDispatchAt: createdAt,
					estimateExpiresAt: expiredAt,
					expiresAt: expiredAt,
				},
			});

			await expect(fixture.completeLink("expired", new Date())).rejects.toThrow(
				"GUEST_LINK_UNAVAILABLE",
			);
			await expect(fixture.claimDispatch()).resolves.toBeNull();
			await expect(
				Promise.all([
					client.generationJob.findUniqueOrThrow({ where: { id: fixture.jobId } }),
					client.guestMediaTrial.findUniqueOrThrow({ where: { id: fixture.trialId } }),
					client.generationAttempt.count({ where: { jobId: fixture.jobId } }),
					client.guestResultAccessGrant.count({ where: { guestJobId: fixture.jobId } }),
				]),
			).resolves.toEqual([
				expect.objectContaining({ status: "FAILED", failureCode: "GUEST_QUEUE_EXPIRED" }),
				expect.objectContaining({
					currentJobId: null,
					consumedJobId: null,
					eligibility: "EXPIRED",
					riskState: "RELEASED",
				}),
				0,
				0,
			]);
		} finally {
			await cleanupGuestLinkDispatchFixture(fixture);
		}
	});

	it("expires a busy guest job when its public queue estimate would exceed immutable expiry", async () => {
		await client.$executeRawUnsafe(
			'TRUNCATE TABLE "user", "guest_abuse_bucket", "guest_risk_budget_bucket", "outbox_event", "generation_quote" CASCADE',
		);
		const active = await seedGuestDispatchJob();
		const waiting = await seedGuestDispatchJob();
		const nearExpiry = new Date(waiting.now.getTime() + 30_000);
		await client.generationJob.update({
			where: { id: waiting.jobId },
			data: { status: "RESERVED", version: 0 },
		});
		await client.guestMediaTrial.update({
			where: { id: waiting.trialId },
			data: {
				projectedDispatchAt: waiting.now,
				estimateExpiresAt: nearExpiry,
				expiresAt: nearExpiry,
			},
		});
		const dependencies = createDatabaseGuestAdmissionDependencies(client, {
			environment: waiting.environment,
			retryDelayMs: 5_000,
			serviceTimeMs: 60_000,
		});
		try {
			await expect(
				dependencies.admit({
					jobId: waiting.jobId,
					trialId: waiting.trialId,
					now: waiting.now,
				}),
			).resolves.toEqual({ outcome: "EXPIRED", jobId: waiting.jobId });
			const trial = await client.guestMediaTrial.findUniqueOrThrow({
				where: { id: waiting.trialId },
			});
			if (trial.ownerId === null) throw new Error("Active guest trial owner is required");
			await expect(
				Promise.all([
					client.generationJob.findUniqueOrThrow({ where: { id: waiting.jobId } }),
					client.creditReservation.findUniqueOrThrow({ where: { jobId: waiting.jobId } }),
					client.guestRiskBudgetBucket.findUniqueOrThrow({
						where: {
							promotionPeriod_subjectHash: {
								promotionPeriod: trial.promotionPeriod,
								subjectHash: "global",
							},
						},
					}),
					client.generationJob.count({ where: { ownerId: trial.ownerId } }),
					client.generationAttempt.count(),
				]),
			).resolves.toEqual([
				expect.objectContaining({
					status: "FAILED",
					failureCode: "GUEST_QUEUE_EXPIRED",
					terminalAt: waiting.now,
				}),
				expect.objectContaining({
					status: "RELEASED",
					releasedAmount: 4n,
				}),
				expect.objectContaining({ reservedMicros: 0n }),
				1,
				0,
			]);
			expect(trial).toMatchObject({
				currentJobId: null,
				eligibility: "AVAILABLE",
				riskState: "RELEASED",
				projectedDispatchAt: waiting.now,
				estimateExpiresAt: nearExpiry,
				expiresAt: nearExpiry,
				terminalAt: waiting.now,
			});
		} finally {
			await client.generationJob.updateMany({
				where: { id: { in: [active.jobId, waiting.jobId] } },
				data: { status: "FAILED", terminalAt: new Date() },
			});
			await Promise.all([
				revertRuntimeConfigOverride(active.overrideId, "task4-guest-test", client),
				revertRuntimeConfigOverride(waiting.overrideId, "task4-guest-test", client),
			]);
		}
	});

	it("rejects dispatch when a ready input no longer matches the job-bound checksum", async () => {
		const seeded = await seedReservedImageEditJob();
		const replacementChecksum = "b".repeat(64);
		await client.generationJobAsset.updateMany({
			where: { jobId: seeded.jobId, assetId: seeded.assetId, role: "INPUT" },
			data: { assetChecksum: replacementChecksum },
		});

		const store = createDatabaseDispatchStore(client);
		await expect(store.claimDispatch({ jobId: seeded.jobId, version: 0 })).rejects.toThrow(
			"Input asset checksum no longer matches job binding",
		);
		await expect(
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
		).resolves.toMatchObject({ status: "RESERVED", version: 0 });
	});

	it("rejects dispatch when later moderation evidence supersedes the approval", async () => {
		const seeded = await seedReservedImageEditJob();
		const asset = await client.mediaAsset.findUniqueOrThrow({ where: { id: seeded.assetId } });
		await client.assetModerationResult.create({
			data: {
				assetId: asset.id,
				assetChecksum: asset.checksum,
				verificationGeneration: asset.verificationGeneration,
				attemptNumber: asset.verificationAttemptCount + 1,
				evidenceKind: asset.kind,
				provider: asset.verificationProvider!,
				providerTaskId: asset.verificationProviderTaskId,
				ruleVersion: asset.verificationRuleVersion!,
				policyVersion: asset.verificationPolicyVersion!,
				status: "ERROR",
				reasonCode: "LATER_MODERATION_FAILURE",
				categories: {},
				rawEnvelope: { decision: "ERROR" },
			},
		});

		const store = createDatabaseDispatchStore(client);
		await expect(store.claimDispatch({ jobId: seeded.jobId, version: 0 })).rejects.toThrow(
			"Input asset moderation evidence is stale",
		);
		await expect(
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
		).resolves.toMatchObject({ status: "RESERVED", version: 0 });
	});

	it("serializes input authorization with stale-asset reverification", async () => {
		const seeded = await seedReservedImageEditJob(1_000);
		let releaseAuthorization!: () => void;
		let authorizationReached!: () => void;
		const reached = new Promise<void>((resolve) => {
			authorizationReached = resolve;
		});
		const released = new Promise<void>((resolve) => {
			releaseAuthorization = resolve;
		});
		const store = createDatabaseDispatchStore(client, {
			createSignedReadUrl: async () => "https://private.example/input.png",
			afterInputAuthorization: async () => {
				authorizationReached();
				await released;
			},
		});

		const dispatching = store.claimDispatch({ jobId: seeded.jobId, version: 0 });
		await reached;
		await new Promise((resolve) =>
			setTimeout(resolve, Math.max(0, seeded.verificationValidUntil.getTime() - Date.now()) + 25),
		);
		let verificationFinished = false;
		let verificationError: unknown;
		const verifying = verifyUpload(
			{ assetId: seeded.assetId },
			createOutputVerificationDependencies("ALLOW", (error) => {
				verificationError = error;
			}),
		).then(() => {
			verificationFinished = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(verificationFinished).toBe(false);

		releaseAuthorization();
		await expect(dispatching).resolves.not.toBeNull();
		await verifying;
		expect(verificationError).toBeUndefined();
		await expect(
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
		).resolves.toMatchObject({ status: "SUBMITTING", version: 1 });
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: seeded.assetId } }),
		).resolves.toMatchObject({ status: "READY", verificationGeneration: 2 });
	});

	it.each([429, 503])(
		"preserves HTTP %i submission ambiguity through the handler and production store",
		async (status) => {
			const seeded = await seedReservedJobWithRoute("replicate");
			const outcome = await dispatchGeneration(
				{ jobId: seeded.jobId, version: 0 },
				{
					store: createTestDispatchStore(),
					getProvider: () =>
						new ReplicateProviderAdapter({
							apiToken: "test",
							fetch: responseFetch(status, { detail: "temporarily unavailable" }),
						}),
				},
			);
			expect(outcome.outcome).toBe("RECONCILE");
			const job = await client.generationJob.findUniqueOrThrow({
				where: { id: seeded.jobId },
				include: { attempts: { orderBy: { attemptNumber: "asc" } } },
			});
			expect(job.status).toBe("PROVIDER_PENDING");
			expect(job.attempts).toMatchObject([
				{ provider: "replicate", status: "SUBMISSION_UNCERTAIN", uncertainSubmission: true },
			]);
		},
	);

	it("does not claim a job for provider submission when the database kill switch is active", async () => {
		const seeded = await seedReservedJob("image-fast");
		const override = await createRuntimeConfigOverride(
			{
				configKey: "media.generation.enabled",
				value: false,
				reason: "test worker kill switch",
				createdByUserId: "admin-test",
			},
			client,
		);
		try {
			await expect(
				createTestDispatchStore().claimDispatch({
					jobId: seeded.jobId,
					version: 0,
				}),
			).rejects.toBeInstanceOf(DispatchAdmissionBlockedError);
			const job = await client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } });
			expect(job).toMatchObject({ status: "RESERVED", version: 1 });
			expect(await client.generationAttempt.count({ where: { jobId: seeded.jobId } })).toBe(0);
			expect(
				await client.outboxEvent.findUniqueOrThrow({
					where: { dedupeKey: `generation-dispatch-kill-switch:${seeded.jobId}:1` },
				}),
			).toMatchObject({
				eventType: "GENERATION_DISPATCH",
				aggregateId: seeded.jobId,
				payload: { jobId: seeded.jobId, version: 1 },
			});
		} finally {
			await revertRuntimeConfigOverride(override.id, "admin-test", client);
		}
	});

	it("finalizes a non-retryable rejection and releases the entire reservation", async () => {
		const seeded = await seedReservedJob("image-fast");
		const dispatchStore = createTestDispatchStore();
		const claim = await dispatchStore.claimDispatch({ jobId: seeded.jobId, version: 0 });

		await dispatchStore.recordRejectedSubmission(claim!.attemptId, {
			code: "PROVIDER_REJECTED",
			message: "terminal rejection",
			retryable: false,
		});

		const finalizing = await client.generationJob.findUniqueOrThrow({
			where: { id: seeded.jobId },
			include: { reservation: true },
		});
		expect(finalizing.status).toBe("FINALIZING");
		expect(finalizing.reservation?.status).toBe("ACTIVE");
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_SETTLE" },
			}),
		).toBe(1);

		await settleGeneration(
			{ jobId: seeded.jobId, version: finalizing.version },
			{ store: createDatabaseSettlementStore(client) },
		);

		const [job, reservation, account] = await Promise.all([
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
			client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
			client.creditAccount.findUniqueOrThrow({ where: { id: seeded.accountId } }),
		]);
		expect(job).toMatchObject({ status: "FAILED", failureCode: "NO_USABLE_OUTPUT" });
		expect(reservation.releasedAmount).toBe(reservation.amount);
		expect(account.reservedCredits).toBe(0n);
		expect(
			await client.creditLedgerEntry.count({
				where: { referenceKey: `settle:${seeded.jobId}`, type: "SETTLE", amount: 0n },
			}),
		).toBe(1);
	});

	it("routes a real HTTP 400 adapter rejection through zero-charge settlement", async () => {
		const seeded = await seedReservedJobWithRoute("fal");
		const outcome = await dispatchGeneration(
			{ jobId: seeded.jobId, version: 0 },
			{
				store: createTestDispatchStore(),
				getProvider: () =>
					new FalProviderAdapter({
						apiKey: "test",
						fetch: responseFetch(400, { detail: "invalid request" }),
					}),
			},
		);
		expect(outcome.outcome).toBe("REJECTED");
		const finalizing = await client.generationJob.findUniqueOrThrow({
			where: { id: seeded.jobId },
		});
		expect(finalizing.status).toBe("FINALIZING");
		await settleGeneration(
			{ jobId: seeded.jobId, version: finalizing.version },
			{ store: createDatabaseSettlementStore(client) },
		);
		const [job, reservation] = await Promise.all([
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
			client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
		]);
		expect(job).toMatchObject({ status: "FAILED", failureCode: "NO_USABLE_OUTPUT" });
		expect(reservation).toMatchObject({
			status: "SETTLED",
			settledAmount: 0n,
			releasedAmount: reservation.amount,
		});
	});

	it("freezes Gemini transport uncertainty for manual reconciliation without settling credits", async () => {
		const seeded = await seedReservedJob("image-quality");
		const outcome = await dispatchGeneration(
			{ jobId: seeded.jobId, version: 0 },
			{
				store: createTestDispatchStore(),
				getProvider: () =>
					new GeminiProviderAdapter({
						apiKey: "test",
						fetch: async () => {
							throw new DOMException("timed out", "AbortError");
						},
					}),
			},
		);
		expect(outcome.outcome).toBe("RECONCILE");
		const uncertain = await client.generationJob.findUniqueOrThrow({
			where: { id: seeded.jobId },
			include: { attempts: true },
		});
		expect(uncertain.status).toBe("PROVIDER_PENDING");
		expect(uncertain.attempts).toMatchObject([
			{
				provider: "gemini",
				providerTaskId: null,
				status: "SUBMISSION_UNCERTAIN",
				uncertainSubmission: true,
			},
		]);
		expect(uncertain.attempts).toHaveLength(1);

		await client.generationAttempt.update({
			where: { id: uncertain.attempts[0]!.id },
			data: { reconciliationCount: 4, nextReconcileAt: new Date(0) },
		});
		await reconcileGenerations(
			{ limit: 100 },
			{
				store: createDatabaseReconciliationStore(client),
				getProvider: () =>
					new GeminiProviderAdapter({ apiKey: "unused", fetch: responseFetch(200, {}) }),
				now: () => new Date(),
			},
		);
		const needsReconciliation = await client.generationJob.findUniqueOrThrow({
			where: { id: seeded.jobId },
			include: { attempts: true },
		});
		expect(needsReconciliation).toMatchObject({
			status: "NEEDS_RECONCILIATION",
			failureCode: "SUBMISSION_UNCERTAIN_NEEDS_RECONCILIATION",
		});
		expect(needsReconciliation.attempts[0]).toMatchObject({
			status: "NEEDS_RECONCILIATION",
			uncertainSubmission: true,
			nextReconcileAt: null,
		});
		expect(
			await client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
		).toMatchObject({
			status: "ACTIVE",
			settledAmount: 0n,
			releasedAmount: 0n,
		});
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_SETTLE" },
			}),
		).toBe(0);
		expect(
			await client.auditLog.count({
				where: {
					targetId: needsReconciliation.attempts[0]!.id,
					action: "MEDIA_SUBMISSION_NEEDS_RECONCILIATION",
				},
			}),
		).toBe(1);
	});

	it("settles a provider-confirmed rejection at zero credits and preserves the decision", async () => {
		const seeded = await seedReservedJob("image-fast");
		const attempt = await client.generationAttempt.create({
			data: {
				jobId: seeded.jobId,
				attemptNumber: 1,
				provider: "replicate",
				providerModelId: "test-model",
				status: "NEEDS_RECONCILIATION",
				uncertainSubmission: true,
				requestSnapshot: {},
			},
		});
		await client.generationJob.update({
			where: { id: seeded.jobId },
			data: {
				status: "NEEDS_RECONCILIATION",
				failureCode: "SUBMISSION_UNCERTAIN_NEEDS_RECONCILIATION",
			},
		});
		await resolveAdminUncertainSubmission(
			{
				attemptId: attempt.id,
				resolution: "REJECTED",
				providerEvidenceReference: "provider-dashboard-rejection-123",
				actorUserId: "admin-reconciliation",
				idempotencyKey: `reject-${crypto.randomUUID()}`,
				reason: "Provider confirmed that no task was created",
			},
			client,
		);
		const finalizing = await client.generationJob.findUniqueOrThrow({
			where: { id: seeded.jobId },
		});
		await settleGeneration(
			{ jobId: seeded.jobId, version: finalizing.version },
			{ store: createDatabaseSettlementStore(client) },
		);

		const [job, reservation, account, ledgerCount] = await Promise.all([
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
			client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
			client.creditAccount.findUniqueOrThrow({ where: { id: seeded.accountId } }),
			client.creditLedgerEntry.count({
				where: { referenceKey: `settle:${seeded.jobId}`, type: "SETTLE", amount: 0n },
			}),
		]);
		expect(job).toMatchObject({
			status: "FAILED",
			failureCode: "SUBMISSION_REJECTED_CONFIRMED",
		});
		expect(reservation).toMatchObject({
			status: "SETTLED",
			settledAmount: 0n,
			releasedAmount: seeded.credits,
		});
		expect(account.reservedCredits).toBe(0n);
		expect(ledgerCount).toBe(1);
	});

	it("persists typed Fal reconciliation endpoints without inventing provider task IDs", async () => {
		const seeded = await seedReservedJob("video-fast");
		const providerTaskId = `fal-real-task-${crypto.randomUUID()}`;
		const store = createTestDispatchStore();
		const claim = await store.claimDispatch({ jobId: seeded.jobId, version: 0 });

		await store.recordSubmission(claim!.attemptId, {
			providerTaskId,
			status: "QUEUED",
			outcome: "accepted",
			idempotency: { key: claim!.attemptId, providerSupported: true, replayed: false },
			reconciliation: {
				statusUrl: `https://queue.fal.run/${providerTaskId}/status`,
				resultUrl: `https://queue.fal.run/${providerTaskId}/result`,
				submissionToken: claim!.attemptId,
			},
		});

		const attempt = await client.generationAttempt.findUniqueOrThrow({
			where: { id: claim!.attemptId },
		});
		expect(attempt).toMatchObject({
			providerTaskId,
			providerStatusUrl: `https://queue.fal.run/${providerTaskId}/status`,
			providerResultUrl: `https://queue.fal.run/${providerTaskId}/result`,
			submissionToken: claim!.attemptId,
		});
	});

	it("does not expose the Gemini finalization outbox before normalized outputs commit", async () => {
		const seeded = await seedReservedJob("image-quality");
		let releaseCommit!: () => void;
		let reachedBarrier!: () => void;
		const barrierReached = new Promise<void>((resolve) => {
			reachedBarrier = resolve;
		});
		const commitReleased = new Promise<void>((resolve) => {
			releaseCommit = resolve;
		});
		const store = createTestDispatchStore({
			beforeSynchronousCommit: async () => {
				reachedBarrier();
				await commitReleased;
			},
		});
		const claim = await store.claimDispatch({ jobId: seeded.jobId, version: 0 });
		const submission = {
			providerTaskId: claim!.attemptId,
			status: "SUCCEEDED" as const,
			outcome: "accepted" as const,
			idempotency: { key: claim!.attemptId, providerSupported: true, replayed: false },
			reconciliation: { submissionToken: claim!.attemptId },
		};
		const result = {
			outputs: [
				{
					kind: "inline-base64" as const,
					mimeType: "image/png",
					data: "aGVsbG8=",
					trust: "untrusted-transfer-candidate" as const,
				},
			],
			progress: 100,
			providerCostMicros: 8_000,
			failure: null,
			retryable: false,
			providerCharged: true,
		};
		const completing = store.recordSynchronousCompletion(claim!.attemptId, submission, result);
		await barrierReached;
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_FINALIZE" },
			}),
		).toBe(0);
		releaseCommit();
		await completing;
		const [attempt, transferEnvelope, outboxCount] = await Promise.all([
			client.generationAttempt.findUniqueOrThrow({ where: { id: claim!.attemptId } }),
			client.generationAttemptTransferEnvelope.findUniqueOrThrow({
				where: { attemptId: claim!.attemptId },
			}),
			client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_FINALIZE" },
			}),
		]);
		expect(attempt.responseSnapshot).toEqual({ providerCharged: true, outputCount: 1 });
		expect(transferEnvelope.payload).toEqual({
			version: 1,
			outputs: [{ kind: "inline-base64", mimeType: "image/png", data: "aGVsbG8=" }],
		});
		expect(outboxCount).toBe(1);
	});

	it("promotes a legacy output snapshot once and scrubs ordinary attempt diagnostics", async () => {
		const seeded = await seedFinalizingJob();
		const attempt = await client.generationAttempt.findFirstOrThrow({
			where: { jobId: seeded.jobId, status: "SUCCEEDED" },
		});
		await client.$transaction([
			client.generationAttemptTransferEnvelope.delete({ where: { attemptId: attempt.id } }),
			client.generationAttempt.update({
				where: { id: attempt.id },
				data: {
					responseSnapshot: {
						providerCharged: true,
						outputs: [
							{
								kind: "remote-url",
								url: "https://replicate.delivery/legacy-signed.png?signature=secret",
								trust: "untrusted-transfer-candidate",
							},
						],
					},
				},
			}),
		]);

		const claim = await createDatabaseFinalizationStore(client).claimFinalization({
			jobId: seeded.jobId,
			version: seeded.version,
		});
		expect(claim?.candidates).toEqual([
			{
				key: `${attempt.id}:0`,
				output: {
					kind: "remote-url",
					url: "https://replicate.delivery/legacy-signed.png?signature=secret",
					trust: "untrusted-transfer-candidate",
				},
			},
		]);
		const [updatedAttempt, transferEnvelope] = await Promise.all([
			client.generationAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
			client.generationAttemptTransferEnvelope.findUniqueOrThrow({
				where: { attemptId: attempt.id },
			}),
		]);
		expect(updatedAttempt.responseSnapshot).toEqual({ providerCharged: true, outputCount: 1 });
		expect(JSON.stringify(updatedAttempt.responseSnapshot)).not.toContain("signature=secret");
		expect(transferEnvelope.payload).toMatchObject({
			version: 1,
			outputs: [{ kind: "remote-url" }],
		});
	});

	it("settles a guest success with zero outputs without publishing media", async () => {
		const seeded = await seedGuestFinalizingJob();
		await replaceFinalizationOutputs(seeded.jobId, []);

		await expect(
			createDatabaseFinalizationStore(client).claimFinalization({
				jobId: seeded.jobId,
				version: seeded.version,
			}),
		).resolves.toBeNull();

		const [failedJob, attempt, outputCount, settlementEvents] = await Promise.all([
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
			client.generationAttempt.findFirstOrThrow({ where: { jobId: seeded.jobId } }),
			client.generationJobAsset.count({ where: { jobId: seeded.jobId, role: "OUTPUT" } }),
			client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_SETTLE" },
			}),
		]);
		expect(failedJob).toMatchObject({
			status: "FINALIZING",
			failureCode: "GUEST_OUTPUT_CARDINALITY_INVALID",
		});
		expect(attempt).toMatchObject({
			status: "SUCCEEDED",
			errorSnapshot: expect.objectContaining({ code: "GUEST_OUTPUT_CARDINALITY_INVALID" }),
		});
		expect(outputCount).toBe(0);
		expect(settlementEvents).toBe(1);

		await expect(
			settleGeneration(
				{ jobId: seeded.jobId, version: failedJob.version },
				{ store: createDatabaseSettlementStore(client) },
			),
		).resolves.toEqual({ outcome: "SETTLED" });
		await expect(
			Promise.all([
				client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
				client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
			]),
		).resolves.toEqual([
			expect.objectContaining({
				status: "FAILED",
				failureCode: "GUEST_OUTPUT_CARDINALITY_INVALID",
			}),
			expect.objectContaining({ status: "SETTLED", settledAmount: 0n, releasedAmount: 4n }),
		]);
	});

	it("settles a guest success with multiple outputs without publishing media", async () => {
		const seeded = await seedGuestFinalizingJob();
		await replaceFinalizationOutputs(seeded.jobId, [
			{
				kind: "remote-url",
				url: "https://replicate.delivery/guest-output-1.png",
			},
			{
				kind: "remote-url",
				url: "https://replicate.delivery/guest-output-2.png",
			},
		]);

		await expect(
			createDatabaseFinalizationStore(client).claimFinalization({
				jobId: seeded.jobId,
				version: seeded.version,
			}),
		).resolves.toBeNull();
		const failedJob = await client.generationJob.findUniqueOrThrow({
			where: { id: seeded.jobId },
		});
		await expect(
			Promise.all([
				client.generationJobAsset.count({ where: { jobId: seeded.jobId, role: "OUTPUT" } }),
				client.outboxEvent.count({
					where: { aggregateId: seeded.jobId, eventType: "GENERATION_SETTLE" },
				}),
			]),
		).resolves.toEqual([0, 1]);

		await settleGeneration(
			{ jobId: seeded.jobId, version: failedJob.version },
			{ store: createDatabaseSettlementStore(client) },
		);
		await expect(
			Promise.all([
				client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
				client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
			]),
		).resolves.toEqual([
			expect.objectContaining({
				status: "FAILED",
				failureCode: "GUEST_OUTPUT_CARDINALITY_INVALID",
			}),
			expect.objectContaining({ status: "SETTLED", settledAmount: 0n, releasedAmount: 4n }),
		]);
	});

	it("preserves multiple registered outputs as finalization candidates", async () => {
		const seeded = await seedFinalizingJob();
		await replaceFinalizationOutputs(seeded.jobId, [
			{
				kind: "remote-url",
				url: "https://replicate.delivery/registered-output-1.png",
			},
			{
				kind: "remote-url",
				url: "https://replicate.delivery/registered-output-2.png",
			},
		]);

		const claim = await createDatabaseFinalizationStore(client).claimFinalization({
			jobId: seeded.jobId,
			version: seeded.version,
		});

		expect(claim?.candidates).toHaveLength(2);
		expect(claim?.candidates.map((candidate) => candidate.output)).toEqual([
			expect.objectContaining({ url: "https://replicate.delivery/registered-output-1.png" }),
			expect.objectContaining({ url: "https://replicate.delivery/registered-output-2.png" }),
		]);
		await expect(
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
		).resolves.toMatchObject({ status: "FINALIZING", failureCode: null });
	});

	it("freezes an invalid persisted transfer envelope without releasing credits", async () => {
		const seeded = await seedFinalizingJob();
		const attempt = await client.generationAttempt.findFirstOrThrow({
			where: { jobId: seeded.jobId, status: "SUCCEEDED" },
		});
		await client.generationAttemptTransferEnvelope.update({
			where: { attemptId: attempt.id },
			data: {
				payload: {
					version: 1,
					outputs: [{ kind: "remote-url", url: "http://unsafe.example/output.png" }],
				},
			},
		});

		await expect(
			createDatabaseFinalizationStore(client).claimFinalization({
				jobId: seeded.jobId,
				version: seeded.version,
			}),
		).resolves.toBeNull();
		const [job, updatedAttempt, reservation] = await Promise.all([
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
			client.generationAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
			client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
		]);
		expect(job).toMatchObject({
			status: "NEEDS_RECONCILIATION",
			failureCode: "TRANSFER_ENVELOPE_INVALID",
		});
		expect(updatedAttempt).toMatchObject({
			status: "NEEDS_RECONCILIATION",
			uncertainSubmission: true,
		});
		expect(reservation).toMatchObject({ status: "ACTIVE", settledAmount: 0n, releasedAmount: 0n });
	});

	it("keeps finalization pending and queues retry when transfer fails transiently", async () => {
		const seeded = await seedFinalizingJob();
		await client.generationJob.update({
			where: { id: seeded.jobId },
			data: { finalizationStage: "MODERATION", finalizationRetryCount: 4 },
		});
		const outcome = await finalizeMedia(
			{ jobId: seeded.jobId, version: seeded.version },
			{
				store: createDatabaseFinalizationStore(client),
				persistCandidate: async () => {
					throw Object.assign(new Error("temporary storage timeout"), {
						code: "STORAGE_TRANSFER_RETRYABLE",
						stage: "TRANSFER",
						retryable: true,
					});
				},
			},
		);
		expect(outcome).toMatchObject({ outcome: "RETRY_SCHEDULED", readyOutputs: 0 });
		const [job] = await client.$queryRaw<
			Array<{
				status: string;
				finalizationStage: string | null;
				finalizationRetryCount: number;
				finalizationErrorCode: string | null;
				nextFinalizeAt: Date | null;
			}>
		>`SELECT "status", "finalizationStage", "finalizationRetryCount",
		          "finalizationErrorCode", "nextFinalizeAt"
		   FROM "generation_job" WHERE "id" = ${seeded.jobId}`;
		expect(job).toMatchObject({
			status: "FINALIZING",
			finalizationStage: "TRANSFER",
			finalizationRetryCount: 1,
			finalizationErrorCode: "STORAGE_TRANSFER_RETRYABLE",
		});
		expect(job?.nextFinalizeAt).toBeInstanceOf(Date);
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_SETTLE" },
			}),
		).toBe(0);
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_FINALIZE_RETRY" },
			}),
		).toBe(1);
	});

	it("retries finalization after terminalizing an exhausted output transfer before settlement", async () => {
		const seeded = await seedFinalizingJob();
		const store = createDatabaseFinalizationStore(client);
		const claim = await store.claimFinalization({ jobId: seeded.jobId, version: seeded.version });
		if (!claim?.candidates[0]) throw new Error("Expected a finalization candidate");
		const candidate = claim.candidates[0];
		const assetId = `asset_${createHash("sha256")
			.update(`${seeded.jobId}:${candidate.key}`)
			.digest("base64url")
			.slice(0, 32)}`;
		const transferToken = crypto.randomUUID();
		const transferLeaseExpiresAt = new Date(Date.now() + 60_000);
		const stagingObjectKey = `users/${claim.ownerId}/staging/${assetId}/${transferToken}.png`;
		const objectKey = `users/${claim.ownerId}/assets/${assetId}/original.png`;
		await client.$transaction([
			client.generationJob.update({
				where: { id: seeded.jobId },
				data: {
					finalizationStage: "TRANSFER",
					finalizationRetryCount: 4,
					finalizationErrorCode: "STORAGE_TRANSFER_RETRYABLE",
				},
			}),
			client.mediaAsset.create({
				data: {
					id: assetId,
					ownerType: "USER",
					ownerId: claim.ownerId,
					kind: "OUTPUT",
					status: "VERIFYING",
					objectKey,
					mimeType: "image/png",
					byteSize: 0n,
					sourceUrl: `provider-output:${candidate.key}`,
					outputTransferToken: transferToken,
					outputTransferLeaseExpiresAt: transferLeaseExpiresAt,
					outputStagingObjectKey: stagingObjectKey,
					outputPromotionMultipartUploadId: `promotion-${assetId}`,
				},
			}),
			client.generationJobAsset.create({
				data: { jobId: seeded.jobId, assetId, assetChecksum: "", role: "OUTPUT" },
			}),
		]);
		await expect(store.findPersistedCandidate(seeded.jobId, candidate.key)).resolves.toBeNull();

		const failure = {
			code: "STORAGE_TRANSFER_RETRYABLE",
			stage: "TRANSFER" as const,
			retryable: true,
			assetId,
			transferToken,
			candidateKey: candidate.key,
		};
		await Promise.all([
			store.recordFinalizationRetry(claim, failure),
			store.recordFinalizationRetry(claim, failure),
		]);

		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
		).resolves.toMatchObject({
			status: "VERIFICATION_FAILED",
			verificationLastErrorCode: "STORAGE_TRANSFER_EXHAUSTED",
			outputTransferToken: null,
			outputTransferLeaseExpiresAt: null,
			outputStagingObjectKey: null,
			outputPromotionMultipartUploadId: null,
		});
		await expect(store.findPersistedCandidate(seeded.jobId, candidate.key)).resolves.toBeNull();
		await expect(
			createFinalizationDependencies(
				{ MEDIA_SAFETY_ADAPTER: "test" },
				{ store, safety: new TestMediaSafetyAdapter("ALLOW"), database: client },
			).persistCandidate(claim, candidate),
		).rejects.toMatchObject({
			code: "STORAGE_TRANSFER_EXHAUSTED",
			stage: "TRANSFER",
			retryable: false,
		});
		await expect(
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
		).resolves.toMatchObject({
			status: "FINALIZING",
			finalizationStage: "TRANSFER",
			finalizationRetryCount: 5,
			finalizationErrorCode: "STORAGE_TRANSFER_EXHAUSTED",
			nextFinalizeAt: expect.any(Date),
		});
		await expect(
			client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_FINALIZE_RETRY" },
			}),
		).resolves.toBe(1);
		await expect(
			client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_SETTLE" },
			}),
		).resolves.toBe(0);
		await expect(client.outboxEvent.findMany({ where: { aggregateId: assetId } })).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: "MEDIA_UPLOAD_CLEANUP",
					payload: expect.objectContaining({
						objectKey: stagingObjectKey,
						promotionObjectKey: objectKey,
						promotionMultipartUploadId: `promotion-${assetId}`,
						storageReservationReferenceKey: `generation-output:${assetId}`,
					}),
				}),
			]),
		);
		const cleanup = await client.outboxEvent.findUniqueOrThrow({
			where: { dedupeKey: `generation-output-terminal-cleanup:${assetId}:${transferToken}` },
		});
		expect(cleanup.availableAt.getTime()).toBeGreaterThanOrEqual(transferLeaseExpiresAt.getTime());
		const siblingWaitAt = new Date(Date.now() + 60_000);
		await client.generationJob.update({
			where: { id: seeded.jobId },
			data: {
				finalizationErrorCode: "OUTPUT_TRANSFER_IN_PROGRESS",
				nextFinalizeAt: siblingWaitAt,
			},
		});
		await store.recordFinalizationRetry(claim, failure);
		await expect(
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
		).resolves.toMatchObject({
			finalizationRetryCount: 5,
			finalizationErrorCode: "OUTPUT_TRANSFER_IN_PROGRESS",
			nextFinalizeAt: siblingWaitAt,
		});
		const finalizationDependencies = createFinalizationDependencies(
			{ MEDIA_SAFETY_ADAPTER: "test" },
			{ store, safety: new TestMediaSafetyAdapter("ALLOW"), database: client },
		);

		await expect(
			finalizeMedia(
				{ jobId: seeded.jobId, version: seeded.version },
				{
					store,
					persistCandidate: (candidateClaim, candidateToPersist) =>
						finalizationDependencies.persistCandidate(candidateClaim, candidateToPersist),
				},
			),
		).resolves.toEqual({ outcome: "FINALIZED", readyOutputs: 0 });
		await expect(
			client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_SETTLE" },
			}),
		).resolves.toBe(1);

		await settleGeneration(
			{ jobId: seeded.jobId, version: seeded.version },
			{ store: createDatabaseSettlementStore(client) },
		);
		await expect(
			client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
		).resolves.toMatchObject({
			status: "SETTLED",
			settledAmount: 0n,
			releasedAmount: seeded.credits,
		});
	});

	it("does not count an in-progress transfer or terminalize its expired token", async () => {
		const seeded = await seedFinalizingJob();
		const store = createDatabaseFinalizationStore(client);
		const claim = await store.claimFinalization({ jobId: seeded.jobId, version: seeded.version });
		if (!claim?.candidates[0]) throw new Error("Expected a finalization candidate");
		const candidate = claim.candidates[0];
		const assetId = `asset_${createHash("sha256")
			.update(`${seeded.jobId}:${candidate.key}`)
			.digest("base64url")
			.slice(0, 32)}`;
		const transferToken = crypto.randomUUID();
		await client.$transaction([
			client.generationJob.update({
				where: { id: seeded.jobId },
				data: {
					finalizationStage: "MODERATION",
					finalizationRetryCount: 4,
					finalizationErrorCode: "MODERATION_RETRYABLE",
				},
			}),
			client.mediaAsset.create({
				data: {
					id: assetId,
					ownerType: "USER",
					ownerId: claim.ownerId,
					kind: "OUTPUT",
					status: "VERIFYING",
					objectKey: `users/${claim.ownerId}/assets/${assetId}/original.png`,
					mimeType: "image/png",
					byteSize: 0n,
					sourceUrl: `provider-output:${candidate.key}`,
					outputTransferToken: transferToken,
					outputTransferLeaseExpiresAt: new Date(Date.now() + 60_000),
					outputStagingObjectKey: `users/${claim.ownerId}/staging/${assetId}/${transferToken}.png`,
				},
			}),
			client.generationJobAsset.create({
				data: { jobId: seeded.jobId, assetId, assetChecksum: "", role: "OUTPUT" },
			}),
		]);

		await expect(
			createFinalizationDependencies(
				{ MEDIA_SAFETY_ADAPTER: "test" },
				{ store, safety: new TestMediaSafetyAdapter("ALLOW"), database: client },
			).persistCandidate(claim, candidate),
		).rejects.toMatchObject({
			code: "OUTPUT_TRANSFER_IN_PROGRESS",
			stage: "TRANSFER",
			retryable: true,
		});
		const inProgress = {
			code: "OUTPUT_TRANSFER_IN_PROGRESS",
			stage: "TRANSFER" as const,
			retryable: true,
		};
		await Promise.all([
			store.recordFinalizationRetry(claim, inProgress),
			store.recordFinalizationRetry(claim, inProgress),
		]);
		await expect(
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
		).resolves.toMatchObject({
			finalizationStage: "TRANSFER",
			finalizationRetryCount: 0,
			finalizationErrorCode: "OUTPUT_TRANSFER_IN_PROGRESS",
			nextFinalizeAt: expect.any(Date),
		});
		await client.generationJob.update({
			where: { id: seeded.jobId },
			data: {
				finalizationStage: "TRANSFER",
				finalizationRetryCount: 4,
				finalizationErrorCode: "STORAGE_TRANSFER_RETRYABLE",
			},
		});
		await store.recordFinalizationRetry(claim, {
			code: "STORAGE_TRANSFER_RETRYABLE",
			stage: "TRANSFER",
			retryable: true,
			assetId,
			transferToken: crypto.randomUUID(),
			candidateKey: candidate.key,
		});
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
		).resolves.toMatchObject({
			status: "VERIFYING",
			outputTransferToken: transferToken,
		});
		await client.mediaAsset.update({
			where: { id: assetId },
			data: { outputTransferLeaseExpiresAt: new Date(Date.now() - 60_000) },
		});

		await store.recordFinalizationRetry(claim, {
			code: "STORAGE_TRANSFER_RETRYABLE",
			stage: "TRANSFER",
			retryable: true,
			assetId,
			transferToken,
			candidateKey: candidate.key,
		});

		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
		).resolves.toMatchObject({
			status: "VERIFYING",
			outputTransferToken: transferToken,
		});
		await expect(
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
		).resolves.toMatchObject({
			finalizationRetryCount: 6,
			finalizationErrorCode: "STORAGE_TRANSFER_RETRYABLE",
			nextFinalizeAt: expect.any(Date),
		});
		await expect(
			client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_SETTLE" },
			}),
		).resolves.toBe(0);
	});

	it("re-arms a transfer wait after each expired transfer token loses its fence", async () => {
		const seeded = await seedFinalizingJob();
		const store = createDatabaseFinalizationStore(client);
		const claim = await store.claimFinalization({ jobId: seeded.jobId, version: seeded.version });
		if (!claim?.candidates[0]) throw new Error("Expected a finalization candidate");
		const candidate = claim.candidates[0];
		const assetId = createHash("sha256")
			.update(`${seeded.jobId}:${candidate.key}`)
			.digest("base64url")
			.slice(0, 32);
		const activeToken = crypto.randomUUID();
		await client.$transaction([
			client.mediaAsset.create({
				data: {
					id: assetId,
					ownerType: "USER",
					ownerId: claim.ownerId,
					kind: "OUTPUT",
					status: "VERIFYING",
					objectKey: `users/${claim.ownerId}/assets/${assetId}/original.png`,
					mimeType: "image/png",
					byteSize: 0n,
					sourceUrl: `provider-output:${candidate.key}`,
					outputTransferToken: activeToken,
					outputTransferLeaseExpiresAt: new Date(Date.now() + 60_000),
					outputStagingObjectKey: `users/${claim.ownerId}/staging/${assetId}/${activeToken}.png`,
				},
			}),
			client.generationJobAsset.create({
				data: { jobId: seeded.jobId, assetId, assetChecksum: "", role: "OUTPUT" },
			}),
		]);
		const waitEvents = {
			aggregateId: seeded.jobId,
			eventType: "GENERATION_FINALIZE_RETRY",
			dedupeKey: { startsWith: `generation-finalize-transfer-wait:${seeded.jobId}:` },
		} as const;

		await store.recordFinalizationRetry(claim, {
			code: "OUTPUT_TRANSFER_FENCE_LOST",
			stage: "TRANSFER",
			retryable: true,
			assetId,
			transferToken: activeToken,
			candidateKey: candidate.key,
		});
		await expect(client.outboxEvent.count({ where: waitEvents })).resolves.toBe(1);
		await client.outboxEvent.updateMany({
			where: { ...waitEvents, status: "PENDING" },
			data: { status: "PROCESSED", processedAt: new Date() },
		});

		const expiredTokenA = crypto.randomUUID();
		await client.mediaAsset.update({
			where: { id: assetId },
			data: {
				outputTransferToken: expiredTokenA,
				outputTransferLeaseExpiresAt: new Date(Date.now() - 60_000),
			},
		});
		await store.recordFinalizationRetry(claim, {
			code: "OUTPUT_TRANSFER_FENCE_LOST",
			stage: "TRANSFER",
			retryable: true,
			assetId,
			transferToken: expiredTokenA,
			candidateKey: candidate.key,
		});
		await expect(client.outboxEvent.count({ where: waitEvents })).resolves.toBe(2);
		await client.outboxEvent.updateMany({
			where: { ...waitEvents, status: "PENDING" },
			data: { status: "PROCESSED", processedAt: new Date() },
		});

		const expiredTokenB = crypto.randomUUID();
		await client.mediaAsset.update({
			where: { id: assetId },
			data: { outputTransferToken: expiredTokenB },
		});
		await store.recordFinalizationRetry(claim, {
			code: "OUTPUT_TRANSFER_FENCE_LOST",
			stage: "TRANSFER",
			retryable: true,
			assetId,
			transferToken: expiredTokenB,
			candidateKey: candidate.key,
		});

		await expect(client.outboxEvent.count({ where: waitEvents })).resolves.toBe(3);
		await expect(
			client.outboxEvent.count({ where: { ...waitEvents, status: "PENDING" } }),
		).resolves.toBe(1);
	});

	it("does not settle a moderation ERROR and keeps REVIEW assets non-ready", async () => {
		const errorSeed = await seedFinalizingJob();
		const errorOutcome = await finalizeMedia(
			{ jobId: errorSeed.jobId, version: errorSeed.version },
			{
				store: createDatabaseFinalizationStore(client),
				persistCandidate: async () => {
					throw {
						code: "MODERATION_RETRYABLE",
						stage: "MODERATION",
						retryable: true,
					};
				},
			},
		);
		expect(errorOutcome.outcome).toBe("RETRY_SCHEDULED");
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: errorSeed.jobId, eventType: "GENERATION_SETTLE" },
			}),
		).toBe(0);

		const reviewSeed = await seedFinalizingJob();
		const reviewChecksum = "b".repeat(64);
		const reviewAsset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId: `review-${crypto.randomUUID()}`,
				kind: "OUTPUT",
				status: "QUARANTINED",
				objectKey: `review/${crypto.randomUUID()}.png`,
				mimeType: "image/png",
				byteSize: 1n,
				checksum: reviewChecksum,
				verificationGeneration: 1,
				verificationAttemptCount: 1,
				verificationProvider: "test",
				verificationRuleVersion: "test-rule-v1",
				verificationPolicyVersion: "test-policy-v1",
			},
		});
		await client.assetModerationResult.create({
			data: {
				assetId: reviewAsset.id,
				assetChecksum: reviewChecksum,
				verificationGeneration: 1,
				attemptNumber: 1,
				evidenceKind: "OUTPUT",
				provider: "test",
				ruleVersion: "test-rule-v1",
				policyVersion: "test-policy-v1",
				status: "REVIEW",
				reasonCode: "MANUAL_REVIEW",
				categories: { reason: "manual" },
				rawEnvelope: { decision: "REVIEW" },
			},
		});
		const reviewOutcome = await finalizeMedia(
			{ jobId: reviewSeed.jobId, version: reviewSeed.version },
			{
				store: createDatabaseFinalizationStore(client),
				persistCandidate: async () => ({ assetId: reviewAsset.id, approved: false }),
			},
		);
		expect(reviewOutcome).toMatchObject({ outcome: "FINALIZED", readyOutputs: 0 });
		expect(
			await client.mediaAsset.findUniqueOrThrow({ where: { id: reviewAsset.id } }),
		).toMatchObject({ status: "QUARANTINED" });
		const reviewFinalizing = await client.generationJob.findUniqueOrThrow({
			where: { id: reviewSeed.jobId },
		});
		await settleGeneration(
			{ jobId: reviewSeed.jobId, version: reviewFinalizing.version },
			{ store: createDatabaseSettlementStore(client) },
		);
		const [reviewJob, reviewReservation, reviewLedger] = await Promise.all([
			client.generationJob.findUniqueOrThrow({ where: { id: reviewSeed.jobId } }),
			client.creditReservation.findUniqueOrThrow({ where: { id: reviewSeed.reservationId } }),
			client.creditLedgerEntry.findUniqueOrThrow({
				where: { referenceKey: `settle:${reviewSeed.jobId}` },
			}),
		]);
		expect(reviewJob).toMatchObject({ status: "FAILED", failureCode: "NO_USABLE_OUTPUT" });
		expect(reviewReservation).toMatchObject({
			status: "SETTLED",
			settledAmount: 0n,
			releasedAmount: reviewSeed.credits,
		});
		expect(reviewLedger).toMatchObject({ type: "SETTLE", amount: 0n });
	});

	it("preserves the provider candidate position when an earlier output is rejected", async () => {
		const seeded = await seedFinalizingJob();
		const job = await client.generationJob.findUniqueOrThrow({
			where: { id: seeded.jobId },
			include: { attempts: { where: { status: "SUCCEEDED" }, take: 1 } },
		});
		const attempt = job.attempts[0]!;
		await client.$transaction([
			client.generationAttempt.update({
				where: { id: attempt.id },
				data: { responseSnapshot: { providerCharged: true, outputCount: 2 } },
			}),
			client.generationAttemptTransferEnvelope.upsert({
				where: { attemptId: attempt.id },
				create: {
					attemptId: attempt.id,
					payload: {
						version: 1,
						outputs: [
							{
								kind: "remote-url",
								url: "https://replicate.delivery/rejected.png",
							},
							{
								kind: "remote-url",
								url: "https://replicate.delivery/approved.png",
							},
						],
					},
				},
				update: {
					payload: {
						version: 1,
						outputs: [
							{ kind: "remote-url", url: "https://replicate.delivery/rejected.png" },
							{ kind: "remote-url", url: "https://replicate.delivery/approved.png" },
						],
					},
				},
			}),
		]);

		const checksum = "d".repeat(64);
		const verificationValidUntil = new Date(Date.now() + 60_000);
		const approvedAsset = await client.mediaAsset.create({
			data: {
				ownerType: job.ownerType,
				ownerId: job.ownerId,
				kind: "OUTPUT",
				status: "VERIFYING",
				objectKey: `users/${job.ownerId}/generated/${crypto.randomUUID()}.png`,
				mimeType: "image/png",
				byteSize: 16n,
				checksum,
				finalizedAt: new Date(),
				verificationGeneration: 1,
				verificationAttemptCount: 1,
				verificationProvider: "test",
				verificationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				verificationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				verificationValidUntil,
			},
		});
		await client.assetModerationResult.create({
			data: {
				assetId: approvedAsset.id,
				assetChecksum: checksum,
				verificationGeneration: 1,
				attemptNumber: 1,
				evidenceKind: "OUTPUT",
				provider: "test",
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				status: "APPROVED",
				reasonCode: "TEST_ALLOW_POSITION",
				categories: {},
				rawEnvelope: { decision: "ALLOW" },
				validUntil: verificationValidUntil,
			},
		});
		await client.mediaAsset.update({
			where: { id: approvedAsset.id },
			data: { status: "READY" },
		});

		await finalizeMedia(
			{ jobId: seeded.jobId, version: seeded.version },
			{
				store: createDatabaseFinalizationStore(client),
				persistCandidate: async (_claim, candidate) => {
					if (candidate.key.endsWith(":0")) {
						throw new MediaValidationError(
							"OUTPUT_MEDIA_TYPE_MISMATCH",
							"The first provider output is invalid",
						);
					}
					return { assetId: approvedAsset.id, approved: true };
				},
			},
		);

		await expect(
			client.generationJobAsset.findUniqueOrThrow({
				where: {
					jobId_assetId_role: {
						jobId: seeded.jobId,
						assetId: approvedAsset.id,
						role: "OUTPUT",
					},
				},
			}),
		).resolves.toMatchObject({ position: 1, assetChecksum: checksum });
	});

	it("waits for a bound output verification and charges only after approval", async () => {
		const seeded = await seedFinalizingJob();
		const output = await seedBoundOutputAsset(seeded.jobId, "VERIFYING");

		const premature = await settleGeneration(
			{ jobId: seeded.jobId, version: seeded.version },
			{ store: createDatabaseSettlementStore(client) },
		);
		expect(premature.outcome).toBe("SKIPPED");
		await expect(
			client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
		).resolves.toMatchObject({ status: "ACTIVE", settledAmount: 0n, releasedAmount: 0n });
		await expect(
			client.creditLedgerEntry.count({ where: { referenceKey: `settle:${seeded.jobId}` } }),
		).resolves.toBe(0);

		await recordCompletedFinalizationScan(seeded.jobId);
		await verifyUpload({ assetId: output.assetId }, createOutputVerificationDependencies("ALLOW"));
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: output.assetId } }),
		).resolves.toMatchObject({ status: "READY" });
		await expect(
			client.outboxEvent.count({
				where: {
					aggregateId: seeded.jobId,
					eventType: "GENERATION_SETTLE",
					dedupeKey: { startsWith: "generation-settle-after-output-verification:" },
				},
			}),
		).resolves.toBe(1);

		const finalizing = await client.generationJob.findUniqueOrThrow({
			where: { id: seeded.jobId },
		});
		const settled = await settleGeneration(
			{ jobId: seeded.jobId, version: finalizing.version },
			{ store: createDatabaseSettlementStore(client) },
		);
		expect(settled.outcome).toBe("SETTLED");
		await expect(
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
		).resolves.toMatchObject({ status: "SUCCEEDED", failureCode: null });
		await expect(
			client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
		).resolves.toMatchObject({
			status: "SETTLED",
			settledAmount: seeded.credits,
			releasedAmount: 0n,
		});
	});

	it("does not queue output settlement before finalization records a complete scan", async () => {
		const seeded = await seedFinalizingJob();
		const output = await seedBoundOutputAsset(seeded.jobId, "VERIFYING");

		await verifyUpload({ assetId: output.assetId }, createOutputVerificationDependencies("ALLOW"));

		await expect(
			client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_SETTLE" },
			}),
		).resolves.toBe(0);
	});

	it("charges only approved output units and releases the rejected-output remainder", async () => {
		const seeded = await seedReservedJob("image-fast", {
			credits: 8n,
			pricingSnapshot: {
				credits: "8",
				settlementPolicy: {
					unitCredits: "4",
					requestedOutputCount: 2,
					maxCharge: "8",
				},
			},
		});
		await client.generationJob.update({
			where: { id: seeded.jobId },
			data: { status: "FINALIZING" },
		});
		await seedBoundOutputAsset(seeded.jobId, "READY");
		await seedRejectedOutputAsset(seeded.jobId);

		const first = await settleGeneration(
			{ jobId: seeded.jobId, version: 0 },
			{ store: createDatabaseSettlementStore(client) },
		);
		const replay = await settleGeneration(
			{ jobId: seeded.jobId, version: 0 },
			{ store: createDatabaseSettlementStore(client) },
		);

		expect(first.outcome).toBe("SETTLED");
		expect(replay.outcome).toBe("SKIPPED");
		await expect(
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
		).resolves.toMatchObject({ status: "SUCCEEDED", failureCode: null });
		await expect(
			client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
		).resolves.toMatchObject({
			status: "SETTLED",
			settledAmount: 4n,
			releasedAmount: 4n,
		});
		await expect(
			client.creditLedgerEntry.count({ where: { referenceKey: `settle:${seeded.jobId}` } }),
		).resolves.toBe(1);
	});

	it("fails closed when a settlement policy changes after the claim", async () => {
		const seeded = await seedReservedJob("image-fast", {
			credits: 8n,
			pricingSnapshot: {
				credits: "8",
				settlementPolicy: {
					unitCredits: "4",
					requestedOutputCount: 2,
					maxCharge: "8",
				},
			},
		});
		await client.generationJob.update({
			where: { id: seeded.jobId },
			data: { status: "FINALIZING" },
		});
		await seedBoundOutputAsset(seeded.jobId, "READY");
		const store = createDatabaseSettlementStore(client);
		const claim = await store.claimSettlement({ jobId: seeded.jobId, version: 0 });
		expect(claim).toMatchObject({ chargeCredits: 4n, readyOutputCount: 1 });

		await client.generationJob.update({
			where: { id: seeded.jobId },
			data: {
				pricingSnapshot: {
					credits: "8",
					settlementPolicy: {
						unitCredits: "4",
						requestedOutputCount: 2,
						maxCharge: "7",
					},
				},
			},
		});

		await expect(store.settle(claim!)).rejects.toThrow("INVALID_SETTLEMENT_POLICY");
		await expect(
			client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
		).resolves.toMatchObject({ status: "ACTIVE", settledAmount: 0n, releasedAmount: 0n });
		await expect(
			client.creditLedgerEntry.count({ where: { referenceKey: `settle:${seeded.jobId}` } }),
		).resolves.toBe(0);
	});

	it("does not release a canceled zero-output reservation with a malformed pricing snapshot", async () => {
		const seeded = await seedReservedJob("image-fast");
		await client.generationJob.update({
			where: { id: seeded.jobId },
			data: { status: "CANCELED", pricingSnapshot: [] },
		});
		const store = createDatabaseSettlementStore(client);

		await expect(settleGeneration({ jobId: seeded.jobId, version: 0 }, { store })).rejects.toThrow(
			"INVALID_SETTLEMENT_POLICY",
		);
		await expect(
			client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
		).resolves.toMatchObject({ status: "ACTIVE", settledAmount: 0n, releasedAmount: 0n });
		await expect(
			client.creditLedgerEntry.count({ where: { referenceKey: `settle:${seeded.jobId}` } }),
		).resolves.toBe(0);
	});

	it("settles at zero only after a bound output verification rejects the asset", async () => {
		const seeded = await seedFinalizingJob();
		const output = await seedBoundOutputAsset(seeded.jobId, "VERIFYING");

		await recordCompletedFinalizationScan(seeded.jobId);
		await verifyUpload({ assetId: output.assetId }, createOutputVerificationDependencies("REJECT"));
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: output.assetId } }),
		).resolves.toMatchObject({ status: "QUARANTINED" });
		await expect(
			client.outboxEvent.count({
				where: {
					aggregateId: seeded.jobId,
					eventType: "GENERATION_SETTLE",
					dedupeKey: { startsWith: "generation-settle-after-output-verification:" },
				},
			}),
		).resolves.toBe(1);

		const finalizing = await client.generationJob.findUniqueOrThrow({
			where: { id: seeded.jobId },
		});
		await settleGeneration(
			{ jobId: seeded.jobId, version: finalizing.version },
			{ store: createDatabaseSettlementStore(client) },
		);
		await expect(
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
		).resolves.toMatchObject({ status: "FAILED", failureCode: "NO_USABLE_OUTPUT" });
		await expect(
			client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
		).resolves.toMatchObject({
			status: "SETTLED",
			settledAmount: 0n,
			releasedAmount: seeded.credits,
		});
	});

	it("does not charge a bound READY output after its moderation evidence expires", async () => {
		const seeded = await seedFinalizingJob();
		await seedBoundOutputAsset(seeded.jobId, "READY", 100);
		await new Promise((resolve) => setTimeout(resolve, 150));

		const outcome = await settleGeneration(
			{ jobId: seeded.jobId, version: seeded.version },
			{ store: createDatabaseSettlementStore(client) },
		);
		expect(outcome.outcome).toBe("SKIPPED");
		await expect(
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
		).resolves.toMatchObject({ status: "FINALIZING" });
		await expect(
			client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
		).resolves.toMatchObject({ status: "ACTIVE", settledAmount: 0n, releasedAmount: 0n });
	});

	it("does not zero-settle a legacy-quarantined output before mandatory reverification", async () => {
		const seeded = await seedFinalizingJob();
		const output = await seedBoundOutputAsset(seeded.jobId, "READY");
		await client.mediaAsset.update({
			where: { id: output.assetId },
			data: {
				status: "QUARANTINED",
				verificationLastErrorCode: "LEGACY_EVIDENCE_UNTRUSTED",
			},
		});

		const premature = await settleGeneration(
			{ jobId: seeded.jobId, version: seeded.version },
			{ store: createDatabaseSettlementStore(client) },
		);
		expect(premature.outcome).toBe("SKIPPED");
		await expect(
			client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
		).resolves.toMatchObject({ status: "ACTIVE", settledAmount: 0n, releasedAmount: 0n });

		await verifyUpload(
			{ assetId: output.assetId, allowQuarantinedReverification: true },
			createOutputVerificationDependencies("ALLOW"),
		);
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: output.assetId } }),
		).resolves.toMatchObject({ status: "READY", verificationGeneration: 2 });
		const finalizing = await client.generationJob.findUniqueOrThrow({
			where: { id: seeded.jobId },
		});
		await settleGeneration(
			{ jobId: seeded.jobId, version: finalizing.version },
			{ store: createDatabaseSettlementStore(client) },
		);
		await expect(
			client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
		).resolves.toMatchObject({ status: "SETTLED", settledAmount: seeded.credits });
	});

	it("revalidates output authorization atomically when reverification wins the settle race", async () => {
		const seeded = await seedFinalizingJob();
		const output = await seedBoundOutputAsset(seeded.jobId, "READY", 1_000);
		const store = createDatabaseSettlementStore(client);
		const claim = await store.claimSettlement({ jobId: seeded.jobId, version: seeded.version });
		expect(claim).not.toBeNull();
		await new Promise((resolve) =>
			setTimeout(resolve, Math.max(0, output.verificationValidUntil.getTime() - Date.now()) + 25),
		);

		let moderationReached!: () => void;
		let releaseModeration!: () => void;
		const reached = new Promise<void>((resolve) => {
			moderationReached = resolve;
		});
		const released = new Promise<void>((resolve) => {
			releaseModeration = resolve;
		});
		class BlockingRejectSafetyAdapter extends TestMediaSafetyAdapter {
			override async moderateImage(input: { assetUrl: string; ruleVersion: string }) {
				moderationReached();
				await released;
				return super.moderateImage(input);
			}
		}
		const verifying = verifyUpload(
			{ assetId: output.assetId },
			createOutputVerificationDependencies(
				"REJECT",
				undefined,
				new BlockingRejectSafetyAdapter("REJECT"),
			),
		);
		await reached;
		await store.settle(claim!);
		await expect(
			client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
		).resolves.toMatchObject({ status: "ACTIVE", settledAmount: 0n, releasedAmount: 0n });
		await expect(
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
		).resolves.toMatchObject({ status: "FINALIZING" });

		releaseModeration();
		await verifying;
		const finalizing = await client.generationJob.findUniqueOrThrow({
			where: { id: seeded.jobId },
		});
		await settleGeneration({ jobId: seeded.jobId, version: finalizing.version }, { store });
		await expect(
			client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
		).resolves.toMatchObject({
			status: "SETTLED",
			settledAmount: 0n,
			releasedAmount: seeded.credits,
		});
		await expect(
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
		).resolves.toMatchObject({ status: "FAILED", failureCode: "NO_USABLE_OUTPUT" });
	});

	it("claims one webhook worker and keeps the first terminal response canonical", async () => {
		const seeded = await seedPendingProviderJob();
		const store = createDatabaseProviderEventStore(client);
		const occurredAt = new Date("2026-08-13T12:00:00.000Z");
		const success = await createProviderEvent(
			seeded.provider,
			seeded.providerTaskId,
			"succeeded",
			occurredAt,
			20n,
		);
		const [firstClaim, concurrentClaim] = await Promise.all([
			store.claimProviderEvent(success.id),
			store.claimProviderEvent(success.id),
		]);
		expect([firstClaim, concurrentClaim].filter(Boolean)).toHaveLength(1);
		const claimed = firstClaim ?? concurrentClaim!;
		await store.recordProviderProgress(claimed!, normalizedResult("canonical-output"));

		const laterFailure = await createProviderEvent(
			seeded.provider,
			seeded.providerTaskId,
			"failed",
			new Date("2026-08-13T12:05:00.000Z"),
			21n,
		);
		expect(await store.claimProviderEvent(laterFailure.id)).toBeNull();
		const staleSuccess = await createProviderEvent(
			seeded.provider,
			seeded.providerTaskId,
			"succeeded",
			new Date("2026-08-13T11:00:00.000Z"),
			19n,
		);
		expect(await store.claimProviderEvent(staleSuccess.id)).toBeNull();

		const [attempt, transferEnvelope] = await Promise.all([
			client.generationAttempt.findUniqueOrThrow({ where: { id: seeded.attemptId } }),
			client.generationAttemptTransferEnvelope.findUniqueOrThrow({
				where: { attemptId: seeded.attemptId },
			}),
		]);
		expect(attempt.status).toBe("SUCCEEDED");
		expect(attempt.responseSnapshot).toEqual({ providerCharged: true, outputCount: 1 });
		expect(transferEnvelope.payload).toMatchObject({
			outputs: [
				expect.objectContaining({ url: "https://replicate.delivery/canonical-output.png" }),
			],
		});
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_FINALIZE" },
			}),
		).toBe(1);
	});

	it("recovers a late verified success from manual reconciliation without a second submission", async () => {
		const seeded = await seedPendingProviderJob();
		await client.$transaction([
			client.generationAttempt.update({
				where: { id: seeded.attemptId },
				data: {
					status: "NEEDS_RECONCILIATION",
					uncertainSubmission: true,
					nextReconcileAt: null,
				},
			}),
			client.generationJob.update({
				where: { id: seeded.jobId },
				data: {
					status: "NEEDS_RECONCILIATION",
					failureCode: "SUBMISSION_UNCERTAIN_NEEDS_RECONCILIATION",
				},
			}),
		]);
		const event = await createProviderEvent(
			seeded.provider,
			seeded.providerTaskId,
			"succeeded",
			new Date("2026-08-13T13:00:00.000Z"),
			40n,
		);
		const store = createDatabaseProviderEventStore(client);
		const claim = await store.claimProviderEvent(event.id);
		expect(claim).not.toBeNull();
		await store.recordProviderProgress(claim!, normalizedResult("late-recovered-success"));

		const [job, attempt, transferEnvelope, reservation, auditCount] = await Promise.all([
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
			client.generationAttempt.findUniqueOrThrow({ where: { id: seeded.attemptId } }),
			client.generationAttemptTransferEnvelope.findUniqueOrThrow({
				where: { attemptId: seeded.attemptId },
			}),
			client.creditReservation.findUniqueOrThrow({ where: { jobId: seeded.jobId } }),
			client.auditLog.count({
				where: { action: "MEDIA_PROVIDER_SUCCESS_RECOVERED", targetId: seeded.attemptId },
			}),
		]);
		expect(job).toMatchObject({ status: "FINALIZING", failureCode: null });
		expect(attempt).toMatchObject({
			status: "SUCCEEDED",
			uncertainSubmission: false,
			responseSnapshot: { providerCharged: true, outputCount: 1 },
		});
		expect(transferEnvelope.payload).toMatchObject({
			outputs: [
				expect.objectContaining({ url: expect.stringContaining("late-recovered-success") }),
			],
		});
		expect(reservation.status).toBe("ACTIVE");
		expect(auditCount).toBe(1);
	});

	it("persists provider cancellation as terminal and prevents later progress from reviving it", async () => {
		const seeded = await seedPendingProviderJob();
		const store = createDatabaseProviderEventStore(client);
		const canceled = await createProviderEvent(
			seeded.provider,
			seeded.providerTaskId,
			"cancelled",
			new Date("2026-08-13T12:00:00.000Z"),
			20n,
		);
		const canceledClaim = await store.claimProviderEvent(canceled.id);
		expect(canceledClaim).not.toBeNull();
		await store.recordProviderProgress(canceledClaim!, {
			outputs: [],
			progress: null,
			providerCostMicros: null,
			failure: null,
			retryable: false,
			providerCharged: false,
		});

		const laterRunning = await createProviderEvent(
			seeded.provider,
			seeded.providerTaskId,
			"processing",
			new Date("2026-08-13T12:05:00.000Z"),
			21n,
		);
		expect(await store.claimProviderEvent(laterRunning.id)).toBeNull();

		expect(
			await client.generationAttempt.findUniqueOrThrow({ where: { id: seeded.attemptId } }),
		).toMatchObject({ status: "CANCELED" });
		expect(
			await client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
		).toMatchObject({ status: "FINALIZING" });
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_SETTLE" },
			}),
		).toBe(1);
	});

	it("serializes different provider events and ignores an older event after newer success", async () => {
		const seeded = await seedPendingProviderJob();
		let releaseNewer!: () => void;
		let newerLocked!: () => void;
		const newerHasLock = new Promise<void>((resolve) => {
			newerLocked = resolve;
		});
		const allowNewerCommit = new Promise<void>((resolve) => {
			releaseNewer = resolve;
		});
		const newer = await createProviderEvent(
			seeded.provider,
			seeded.providerTaskId,
			"succeeded",
			new Date("2026-08-13T13:00:00.000Z"),
			30n,
		);
		const older = await createProviderEvent(
			seeded.provider,
			seeded.providerTaskId,
			"failed",
			new Date("2026-08-13T12:00:00.000Z"),
			29n,
		);
		const store = createDatabaseProviderEventStore(client, {
			afterAttemptLock: async (claim) => {
				if (claim.eventId === newer.id) {
					newerLocked();
					await allowNewerCommit;
				}
			},
		});
		const [newerClaim, olderClaim] = await Promise.all([
			store.claimProviderEvent(newer.id),
			store.claimProviderEvent(older.id),
		]);
		expect(newerClaim).not.toBeNull();
		expect(olderClaim).not.toBeNull();

		const newerWrite = store.recordProviderProgress(newerClaim!, normalizedResult("newer-success"));
		await newerHasLock;
		const olderWrite = store.recordProviderProgress(olderClaim!, {
			outputs: [],
			progress: 100,
			providerCostMicros: null,
			failure: { code: "OLDER_FAILURE", message: "older", retryable: false },
			retryable: false,
			providerCharged: false,
		});
		releaseNewer();
		await Promise.all([newerWrite, olderWrite]);

		const [attempt, transferEnvelope, olderEvent, finalizeCount, settleCount] = await Promise.all([
			client.generationAttempt.findUniqueOrThrow({ where: { id: seeded.attemptId } }),
			client.generationAttemptTransferEnvelope.findUniqueOrThrow({
				where: { attemptId: seeded.attemptId },
			}),
			client.providerWebhookEvent.findUniqueOrThrow({ where: { id: older.id } }),
			client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_FINALIZE" },
			}),
			client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_SETTLE" },
			}),
		]);
		expect(attempt).toMatchObject({
			status: "SUCCEEDED",
			lastProviderSequence: 30n,
			responseSnapshot: { providerCharged: true, outputCount: 1 },
		});
		expect(transferEnvelope.payload).toMatchObject({
			outputs: [expect.objectContaining({ url: "https://replicate.delivery/newer-success.png" })],
		});
		expect(olderEvent).toMatchObject({
			status: "PROCESSED",
			failureReason: "STALE_EVENT_IGNORED",
		});
		expect(finalizeCount).toBe(1);
		expect(settleCount).toBe(0);
	});

	it("applies a terminal event when local arrival order is inverted and provider ordering is absent", async () => {
		const seeded = await seedPendingProviderJob();
		const completion = await client.providerWebhookEvent.create({
			data: {
				provider: seeded.provider,
				providerEventId: `completion-${crypto.randomUUID()}`,
				providerTaskId: seeded.providerTaskId,
				verifiedAt: new Date("2026-08-14T10:00:00.000Z"),
				receivedAt: new Date("2026-08-14T10:00:00.000Z"),
				envelope: { id: seeded.providerTaskId, status: "succeeded" },
			},
		});
		const running = await client.providerWebhookEvent.create({
			data: {
				provider: seeded.provider,
				providerEventId: `running-${crypto.randomUUID()}`,
				providerTaskId: seeded.providerTaskId,
				verifiedAt: new Date("2026-08-14T10:00:05.000Z"),
				receivedAt: new Date("2026-08-14T10:00:05.000Z"),
				envelope: { id: seeded.providerTaskId, status: "processing" },
			},
		});
		const store = createDatabaseProviderEventStore(client);
		const completionClaim = await store.claimProviderEvent(completion.id);
		const runningClaim = await store.claimProviderEvent(running.id);
		expect(completionClaim).not.toBeNull();
		expect(runningClaim).not.toBeNull();

		await store.recordProviderProgress(runningClaim!, {
			...normalizedResult("running"),
			outputs: [],
			progress: 40,
		});
		await store.recordProviderProgress(completionClaim!, normalizedResult("terminal-wins"));

		const [attempt, transferEnvelope] = await Promise.all([
			client.generationAttempt.findUniqueOrThrow({ where: { id: seeded.attemptId } }),
			client.generationAttemptTransferEnvelope.findUniqueOrThrow({
				where: { attemptId: seeded.attemptId },
			}),
		]);
		expect(attempt).toMatchObject({
			status: "SUCCEEDED",
			responseSnapshot: { providerCharged: true, outputCount: 1 },
		});
		expect(transferEnvelope.payload).toMatchObject({
			outputs: [expect.objectContaining({ url: expect.stringContaining("terminal-wins") })],
		});
		expect(
			await client.providerWebhookEvent.findUniqueOrThrow({ where: { id: completion.id } }),
		).toMatchObject({ status: "PROCESSED", failureReason: null });
	});

	it("freezes an unverified terminal reconciliation without settling credits", async () => {
		const seeded = await seedPendingProviderJob();
		await client.generationAttempt.update({
			where: { id: seeded.attemptId },
			data: { nextReconcileAt: new Date(0) },
		});
		const store = createDatabaseReconciliationStore(client);
		const leases = await store.claimStale({ limit: 100, leaseSeconds: 60, now: new Date() });
		const lease = leases.find((candidate) => candidate.attemptId === seeded.attemptId);
		expect(lease).toBeDefined();
		await store.recordReconciled(
			lease!,
			{ providerTaskId: seeded.providerTaskId, status: "FAILED", raw: { error: "terminal" } },
			{
				outputs: [],
				progress: null,
				providerCostMicros: null,
				failure: { code: "PROVIDER_REJECTED", message: "terminal", retryable: false },
				retryable: false,
				providerCharged: false,
			},
		);
		const [job, attempt, reservation] = await Promise.all([
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
			client.generationAttempt.findUniqueOrThrow({ where: { id: seeded.attemptId } }),
			client.creditReservation.findUniqueOrThrow({ where: { jobId: seeded.jobId } }),
		]);
		expect(job).toMatchObject({
			status: "NEEDS_RECONCILIATION",
			failureCode: "RECONCILIATION_TERMINAL_UNVERIFIED",
		});
		expect(attempt).toMatchObject({ status: "NEEDS_RECONCILIATION", uncertainSubmission: true });
		expect(reservation).toMatchObject({ status: "ACTIVE", settledAmount: 0n, releasedAmount: 0n });
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_SETTLE" },
			}),
		).toBe(0);
	});
});

async function seedGuestDispatchJob() {
	const seeded = await seedReservedJob("image-fast");
	const job = await client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } });
	const suffix = crypto.randomUUID();
	const promotionPeriod = `task4-${suffix}`;
	const now = new Date();
	const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000);
	await client.user.create({
		data: {
			id: job.ownerId,
			name: "Guest",
			email: `${suffix}@anonymous.invalid`,
			emailVerified: false,
			isAnonymous: true,
			createdAt: now,
			updatedAt: now,
		},
	});
	await client.guestRiskBudgetBucket.create({
		data: {
			promotionPeriod,
			subjectHash: "global",
			reservedMicros: 3_500n,
			consumedMicros: 0n,
			hardLimitMicros: 250_000n,
			expiresAt,
		},
	});
	const sourceSessionHash = createHash("sha256").update(`session-${suffix}`).digest("hex");
	const deviceHash = createHash("sha256").update(`device-${suffix}`).digest("hex");
	const trial = await client.guestMediaTrial.create({
		data: {
			ownerId: job.ownerId,
			promotionPeriod,
			eligibility: "IN_FLIGHT",
			sponsorCredits: 4n,
			sourceSessionHash,
			deviceHash,
			ipHash: `ip-${suffix}`,
			subnetHash: `subnet-${suffix}`,
			capabilityVersion: "task4-guest-dispatch-v1",
			idempotencyFingerprint: `fingerprint-${suffix}`,
			abuseEvidenceExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
			frozenQuotedRiskMicros: 3_500n,
			riskState: "HELD",
			projectedDispatchAt: now,
			estimateExpiresAt: new Date(now.getTime() + 30_000),
			currentJobId: job.id,
			expiresAt,
		},
	});
	await client.generationJob.update({
		where: { id: job.id },
		data: {
			status: "DISPATCH_QUEUED",
			serviceClass: "GUEST_SLOW",
			dispatchEligibleAt: now,
			guestTrialId: trial.id,
		},
	});
	const override = await createRuntimeConfigOverride(
		{
			configKey: "media.guestGeneration.enabled",
			value: true,
			reason: "task4 guest dispatch integration test",
			createdByUserId: "task4-guest-test",
		},
		client,
	);
	return {
		jobId: job.id,
		trialId: trial.id,
		ownerId: job.ownerId,
		promotionPeriod,
		sourceSessionHash,
		deviceHash,
		expiresAt,
		overrideId: override.id,
		now,
		environment: {
			NODE_ENV: "test",
			MEDIA_GENERATION_ENABLED: "true",
			GUEST_MEDIA_ENABLED: "true",
			GUEST_PROMOTION_PERIOD: promotionPeriod,
			GUEST_RISK_BUDGET_MICROS: "250000",
		},
	};
}

async function seedGuestLinkDispatchFixture(label: string) {
	const guest = await seedGuestDispatchJob();
	const suffix = `${label}-${crypto.randomUUID()}`;
	const registeredUserId = `task1-registered-${suffix}`;
	const tokenHash = createHash("sha256").update(`link:${suffix}`).digest("hex");
	await client.user.create({
		data: {
			id: registeredUserId,
			name: "Registered",
			email: `${registeredUserId}@example.test`,
			emailVerified: true,
			isAnonymous: false,
			createdAt: guest.now,
			updatedAt: guest.now,
		},
	});
	await beginGuestLinkIntentTransaction(
		{
			anonymousOwnerId: guest.ownerId,
			promotionPeriod: guest.promotionPeriod,
			sourceSessionHash: guest.sourceSessionHash,
			deviceHash: guest.deviceHash,
			returnPath: "/try",
			idempotencyKey: `task1-link:${suffix}`,
			tokenHash,
			now: guest.now,
			expiresAt: new Date(guest.now.getTime() + 15 * 60_000),
		},
		client,
	);
	const store = createTestDispatchStore({ environment: guest.environment });
	return {
		...guest,
		registeredUserId,
		claimDispatch: () => store.claimDispatch({ jobId: guest.jobId, version: 0 }),
		completeLink: (replayLabel = "initial", now = guest.now) =>
			completeGuestLinkIntentTransaction(
				{
					tokenHash,
					registeredUserId,
					grantTokenHash: createHash("sha256")
						.update(`grant:${suffix}:${replayLabel}`)
						.digest("hex"),
					now,
				},
				client,
			),
	};
}

type GuestLinkDispatchFixture = Awaited<ReturnType<typeof seedGuestLinkDispatchFixture>>;

async function runGuestLinkDispatchOrdering(
	fixture: GuestLinkDispatchFixture,
	ordering: "link-then-dispatch" | "dispatch-then-link" | "concurrent",
) {
	if (ordering === "link-then-dispatch") {
		const linked = await fixture.completeLink();
		const claim = await fixture.claimDispatch();
		return { claim, linked };
	}
	if (ordering === "dispatch-then-link") {
		const claim = await fixture.claimDispatch();
		const linked = await fixture.completeLink();
		return { claim, linked };
	}

	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const dispatching = (async () => {
		await gate;
		return fixture.claimDispatch();
	})();
	const linking = (async () => {
		await gate;
		return fixture.completeLink();
	})();
	release();
	const [claim, linked] = await Promise.all([dispatching, linking]);
	return { claim, linked };
}

async function cleanupGuestLinkDispatchFixture(fixture: GuestLinkDispatchFixture) {
	await client.generationJob.updateMany({
		where: { id: fixture.jobId },
		data: { status: "FAILED", terminalAt: new Date() },
	});
	await revertRuntimeConfigOverride(fixture.overrideId, "task4-guest-test", client);
}

async function seedReservedJob(
	productKey: "image-fast" | "image-quality" | "video-fast",
	options?: {
		credits?: bigint;
		pricingSnapshot?: {
			credits: string;
			settlementPolicy: {
				unitCredits: string;
				requestedOutputCount: number;
				maxCharge: string;
			};
		};
	},
) {
	const suffix = crypto.randomUUID();
	const ownerId = `task4-runtime-${suffix}`;
	const inputAssetId = productKey.startsWith("video")
		? undefined
		: await seedReadyImageInput(ownerId, suffix);
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	await createCreditGrant(
		{ accountId: account.id, amount: 100n, referenceKey: `task4-runtime-grant:${suffix}` },
		client,
	);
	const inputSnapshot = productKey.startsWith("video")
		? { kind: "text-to-video", prompt: "test" }
		: { kind: "image-to-image", prompt: "test", sourceAssetId: inputAssetId! };
	const credits =
		options?.credits ??
		(productKey.startsWith("video") ? 25n : productKey === "image-quality" ? 10n : 4n);
	const costMicros =
		productKey === "video-fast" ? 100_000n : productKey === "image-quality" ? 8_000n : 3_500n;
	const quoteInput = {
		ownerType: "USER",
		ownerId,
		submittedByUserId: ownerId,
		productKey,
		catalogVersion: "2026-08-13.1",
		pricingVersion: "2026-08-13.1",
		credits,
		costMicros,
		inputSnapshot,
		pricingSnapshot: options?.pricingSnapshot ?? { credits: credits.toString() },
		expiresAt: new Date(Date.now() + 60_000),
	} as const;
	const { createModeratedGenerationQuoteTransaction, fingerprintGenerationQuoteSecurityPayload } =
		await import("@repo/database");
	const quote = await createModeratedGenerationQuoteTransaction(
		{
			...quoteInput,
			moderation: {
				decision: "ALLOW",
				provider: "test",
				ruleVersion: "TEST_ALLOW_RUNTIME_STORES_V1",
				reasonCode: "TEST_ALLOW_RUNTIME_STORES",
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quoteInput),
			},
		},
		client,
	);
	const created = await createGenerationJobTransaction(
		{
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			quoteId: quote.id,
			idempotencyKey: `task4-runtime:${suffix}`,
			inputAssetIds: inputAssetId ? [inputAssetId] : [],
			expectedModerationRuleVersion: "TEST_ALLOW_RUNTIME_STORES_V1",
			...(inputAssetId
				? {
						expectedAssetModerationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
						expectedAssetModerationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
					}
				: {}),
		},
		client,
	);
	return {
		jobId: created.job.id,
		reservationId: created.reservation.id,
		accountId: account.id,
		credits,
	};
}

async function seedReadyImageInput(ownerId: string, suffix: string): Promise<string> {
	const checksum = createHash("sha256").update(`runtime-input:${suffix}`).digest("hex");
	const verificationValidUntil = new Date(Date.now() + 60_000);
	const asset = await client.mediaAsset.create({
		data: {
			id: `asset_${suffix}`,
			ownerType: "USER",
			ownerId,
			kind: "INPUT",
			status: "VERIFYING",
			objectKey: `users/${ownerId}/assets/${suffix}/original.png`,
			mimeType: "image/png",
			byteSize: 16n,
			checksum,
			finalizedAt: new Date(),
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: "test",
			verificationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			verificationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
			verificationValidUntil,
		},
	});
	await client.assetModerationResult.create({
		data: {
			assetId: asset.id,
			assetChecksum: checksum,
			verificationGeneration: 1,
			attemptNumber: 1,
			evidenceKind: "INPUT",
			provider: "test",
			ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
			status: "APPROVED",
			reasonCode: "TEST_ALLOW",
			categories: {},
			rawEnvelope: { decision: "ALLOW" },
			validUntil: verificationValidUntil,
		},
	});
	await client.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY" } });
	return asset.id;
}

async function seedReservedImageEditJob(validForMs = 60_000) {
	const suffix = crypto.randomUUID();
	const ownerId = `task4-runtime-edit-${suffix}`;
	const checksum = "a".repeat(64);
	const verificationValidUntil = new Date(Date.now() + validForMs);
	const assetId = `asset_${suffix}`;
	const asset = await client.mediaAsset.create({
		data: {
			id: assetId,
			ownerType: "USER",
			ownerId,
			kind: "INPUT",
			status: "VERIFYING",
			objectKey: `users/${ownerId}/assets/${suffix}/original.png`,
			mimeType: "image/png",
			byteSize: 16n,
			checksum,
			finalizedAt: new Date(),
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: "test",
			verificationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			verificationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
			verificationValidUntil,
		},
	});
	await client.assetModerationResult.create({
		data: {
			assetId: asset.id,
			assetChecksum: checksum,
			verificationGeneration: 1,
			attemptNumber: 1,
			evidenceKind: "INPUT",
			provider: "test",
			ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
			status: "APPROVED",
			reasonCode: "TEST_ALLOW",
			categories: {},
			rawEnvelope: { decision: "ALLOW" },
			validUntil: verificationValidUntil,
		},
	});
	await client.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY" } });
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	await createCreditGrant(
		{ accountId: account.id, amount: 100n, referenceKey: `task4-runtime-edit-grant:${suffix}` },
		client,
	);
	const quoteInput = {
		ownerType: "USER",
		ownerId,
		submittedByUserId: ownerId,
		productKey: "image-fast",
		catalogVersion: "2026-08-13.1",
		pricingVersion: "2026-08-13.1",
		credits: 4n,
		costMicros: 3_500n,
		inputSnapshot: { kind: "image-to-image", prompt: "test", sourceAssetId: asset.id },
		pricingSnapshot: { credits: "4" },
		expiresAt: new Date(Date.now() + 60_000),
	} as const;
	const { createModeratedGenerationQuoteTransaction, fingerprintGenerationQuoteSecurityPayload } =
		await import("@repo/database");
	const quote = await createModeratedGenerationQuoteTransaction(
		{
			...quoteInput,
			moderation: {
				decision: "ALLOW",
				provider: "test",
				ruleVersion: "TEST_ALLOW_RUNTIME_STORES_V1",
				reasonCode: "TEST_ALLOW_RUNTIME_STORES",
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quoteInput),
			},
		},
		client,
	);
	const created = await createGenerationJobTransaction(
		{
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			quoteId: quote.id,
			idempotencyKey: `task4-runtime-edit:${suffix}`,
			inputAssetIds: [asset.id],
			expectedModerationRuleVersion: "TEST_ALLOW_RUNTIME_STORES_V1",
			expectedAssetModerationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			expectedAssetModerationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
		},
		client,
	);
	return { jobId: created.job.id, assetId: asset.id, verificationValidUntil };
}

async function seedReservedJobWithRoute(provider: "replicate" | "fal") {
	const seeded = await seedReservedJob("image-fast");
	await client.generationAttempt.create({
		data: {
			jobId: seeded.jobId,
			attemptNumber: 1,
			provider,
			providerModelId:
				provider === "replicate" ? "black-forest-labs/flux-schnell" : "fal-ai/flux/schnell",
			requestSnapshot: { catalogRoute: provider },
		},
	});
	return seeded;
}

function responseFetch(status: number, body: unknown): typeof fetch {
	return (async () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		})) as typeof fetch;
}

async function seedFinalizingJob(
	productKey: "image-fast" | "image-quality" | "video-fast" = "image-quality",
) {
	const seeded = await seedReservedJob(productKey);
	const store = createTestDispatchStore();
	const claim = await store.claimDispatch({ jobId: seeded.jobId, version: 0 });
	await store.recordSynchronousCompletion(
		claim!.attemptId,
		{
			providerTaskId: claim!.attemptId,
			status: "SUCCEEDED",
			outcome: "accepted",
			idempotency: { key: claim!.attemptId, providerSupported: true, replayed: false },
			reconciliation: { submissionToken: claim!.attemptId },
		},
		{
			outputs: [
				{
					kind: "remote-url",
					url: "https://replicate.delivery/transient.png",
					trust: "untrusted-transfer-candidate",
				},
			],
			progress: 100,
			providerCostMicros: 8_000,
			failure: null,
			retryable: false,
			providerCharged: true,
		},
	);
	const job = await client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } });
	return { ...seeded, jobId: job.id, version: job.version };
}

async function seedGuestFinalizingJob() {
	const seeded = await seedFinalizingJob("image-fast");
	const job = await client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } });
	const suffix = crypto.randomUUID();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000);
	await client.user.create({
		data: {
			id: job.ownerId,
			name: "Guest",
			email: `${suffix}@anonymous.invalid`,
			emailVerified: false,
			isAnonymous: true,
			createdAt: now,
			updatedAt: now,
		},
	});
	const trial = await client.guestMediaTrial.create({
		data: {
			ownerId: job.ownerId,
			promotionPeriod: `task4-finalization-${suffix}`,
			eligibility: "CONSUMED",
			sponsorCredits: 4n,
			sourceSessionHash: `session-${suffix}`,
			deviceHash: `device-${suffix}`,
			ipHash: `ip-${suffix}`,
			subnetHash: `subnet-${suffix}`,
			capabilityVersion: "task4-guest-finalization-v1",
			idempotencyFingerprint: `fingerprint-${suffix}`,
			abuseEvidenceExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
			frozenQuotedRiskMicros: 3_500n,
			riskState: "COMMITTED",
			projectedDispatchAt: now,
			estimateExpiresAt: new Date(now.getTime() + 60_000),
			consumedJobId: job.id,
			providerBoundaryAt: now,
			consumedAt: now,
			expiresAt,
		},
	});
	await client.generationJob.update({
		where: { id: job.id },
		data: { serviceClass: "GUEST_SLOW", guestTrialId: trial.id },
	});
	return seeded;
}

async function replaceFinalizationOutputs(
	jobId: string,
	outputs: Array<{ kind: "remote-url"; url: string }>,
) {
	const attempt = await client.generationAttempt.findFirstOrThrow({
		where: { jobId, status: "SUCCEEDED" },
	});
	await client.generationAttemptTransferEnvelope.update({
		where: { attemptId: attempt.id },
		data: { payload: { version: 1, outputs } },
	});
}

async function seedBoundOutputAsset(
	jobId: string,
	status: "VERIFYING" | "READY",
	validForMs = 60_000,
) {
	const job = await client.generationJob.findUniqueOrThrow({ where: { id: jobId } });
	const suffix = crypto.randomUUID();
	const checksum = "c".repeat(64);
	const verificationValidUntil = new Date(Date.now() + validForMs);
	const asset = await client.mediaAsset.create({
		data: {
			ownerType: job.ownerType,
			ownerId: job.ownerId,
			kind: "OUTPUT",
			status: "VERIFYING",
			objectKey: `users/${job.ownerId}/generated/${suffix}.png`,
			mimeType: "image/png",
			byteSize: 16n,
			checksum,
			finalizedAt: new Date(),
			verificationGeneration: 1,
			verificationAttemptCount: status === "READY" ? 1 : 0,
			verificationProvider: status === "READY" ? "test" : null,
			verificationRuleVersion: status === "READY" ? MEDIA_VERIFICATION_RULE_VERSION : null,
			verificationPolicyVersion: status === "READY" ? MEDIA_VERIFICATION_POLICY_VERSION : null,
			verificationValidUntil: status === "READY" ? verificationValidUntil : null,
		},
	});
	if (status === "READY") {
		await client.assetModerationResult.create({
			data: {
				assetId: asset.id,
				assetChecksum: checksum,
				verificationGeneration: 1,
				attemptNumber: 1,
				evidenceKind: "OUTPUT",
				provider: "test",
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				status: "APPROVED",
				reasonCode: "TEST_ALLOW",
				categories: {},
				rawEnvelope: { decision: "ALLOW" },
				validUntil: verificationValidUntil,
			},
		});
		await client.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY" } });
	}
	await client.generationJobAsset.create({
		data: { jobId, assetId: asset.id, assetChecksum: checksum, role: "OUTPUT" },
	});
	return { assetId: asset.id, checksum, verificationValidUntil };
}

async function seedRejectedOutputAsset(jobId: string) {
	const job = await client.generationJob.findUniqueOrThrow({ where: { id: jobId } });
	const suffix = crypto.randomUUID();
	const checksum = "d".repeat(64);
	const asset = await client.mediaAsset.create({
		data: {
			ownerType: job.ownerType,
			ownerId: job.ownerId,
			kind: "OUTPUT",
			status: "QUARANTINED",
			objectKey: `users/${job.ownerId}/generated/${suffix}.png`,
			mimeType: "image/png",
			byteSize: 16n,
			checksum,
			finalizedAt: new Date(),
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: "test",
			verificationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			verificationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
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
			ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
			status: "REJECTED",
			reasonCode: "TEST_REJECT",
			categories: {},
			rawEnvelope: { decision: "REJECT" },
		},
	});
	await client.generationJobAsset.create({
		data: { jobId, assetId: asset.id, assetChecksum: checksum, role: "OUTPUT" },
	});
	return asset.id;
}

async function recordCompletedFinalizationScan(jobId: string) {
	await client.outboxEvent.create({
		data: {
			eventType: "GENERATION_SETTLE",
			aggregateType: "GENERATION_JOB",
			aggregateId: jobId,
			dedupeKey: `generation-settle:${jobId}`,
			payload: { jobId },
			status: "PROCESSED",
			processedAt: new Date(),
		},
	});
}

function createOutputVerificationDependencies(
	decision: "ALLOW" | "REJECT",
	onVerificationError?: (error: unknown) => void,
	safety: TestMediaSafetyAdapter = new TestMediaSafetyAdapter(decision),
) {
	return createDatabaseVerifyUploadDependencies(client, {
		headObject: async () => ({
			contentLength: 16,
			contentType: "image/png",
			etag: '"output-etag"',
			metadata: {},
		}),
		readMediaHeader: async () => Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
		inspectPrivateMediaObject: async () => ({
			bytes: 16,
			sha256: "c".repeat(64),
			etag: '"output-etag"',
			versionId: "output-version",
		}),
		createSignedReadUrl: async () => "https://private.example/generated-output.png",
		safety,
		moderationProvider: "test",
		onVerificationError,
	});
}

async function seedPendingProviderJob() {
	const seeded = await seedReservedJob("image-fast");
	const store = createTestDispatchStore();
	const claim = await store.claimDispatch({ jobId: seeded.jobId, version: 0 });
	const providerTaskId = `provider-${crypto.randomUUID()}`;
	await store.recordSubmission(claim!.attemptId, {
		providerTaskId,
		status: "QUEUED",
		outcome: "accepted",
		idempotency: { key: claim!.attemptId, providerSupported: true, replayed: false },
		reconciliation: { submissionToken: claim!.attemptId },
	});
	return {
		jobId: seeded.jobId,
		attemptId: claim!.attemptId,
		provider: claim!.provider,
		providerTaskId,
	};
}

async function createProviderEvent(
	provider: "replicate" | "fal" | "kie" | "gemini",
	providerTaskId: string,
	status: "succeeded" | "failed" | "cancelled" | "processing",
	providerOccurredAt: Date,
	providerSequence: bigint,
) {
	return client.providerWebhookEvent.create({
		data: {
			provider,
			providerEventId: `provider-event-${crypto.randomUUID()}`,
			providerTaskId,
			verifiedAt: new Date(),
			providerOccurredAt,
			providerSequence,
			envelope: { id: providerTaskId, status },
		},
	});
}

function normalizedResult(outputKey: string) {
	return {
		outputs: [
			{
				kind: "remote-url" as const,
				url: `https://replicate.delivery/${outputKey}.png`,
				trust: "untrusted-transfer-candidate" as const,
			},
		],
		progress: 100,
		providerCostMicros: 3_000,
		failure: null,
		retryable: false,
		providerCharged: true,
	};
}

function assertSafeTestDatabaseUrl(value: string | undefined): void {
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(value);
	const safeDatabase =
		parsed.pathname === "/ai_media_foundation_test" ||
		/^\/ezpic_[a-z0-9_]+_test(?:ing)?$/.test(parsed.pathname);
	if (parsed.hostname !== "127.0.0.1" || parsed.port !== "55432" || !safeDatabase) {
		throw new Error(
			"TEST_DATABASE_URL must target 127.0.0.1:55432/ai_media_foundation_test or a dedicated ezpic_*_test database",
		);
	}
}
