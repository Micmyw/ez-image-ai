import { Readable } from "node:stream";

import { PrismaPg } from "@prisma/adapter-pg";
import {
	TestMediaSafetyAdapter,
	SeeapiSafetyAdapter,
	MEDIA_VERIFICATION_RULE_VERSION,
	MEDIA_VERIFICATION_POLICY_VERSION,
	type ModerationDecision,
	type ModerationSubmission,
} from "@repo/ai";
import {
	createCreditGrant,
	reserveCredits,
	claimProviderOriginalArchive,
	reserveProviderOriginalArchive,
	completeProviderOriginalArchive,
	retryProviderOriginalArchive,
	recoverProviderOriginalArchives,
	prepareWorkflowOutboxEvent,
	beginWorkflowOutboxExecution,
	completeWorkflowOutboxExecution,
	deferWorkflowOutboxExecution,
	failWorkflowOutboxExecution,
	getOwnedMediaAssetReadState,
	getGuestJobSnapshot,
} from "@repo/database";
import { runWithDatabaseClient } from "@repo/database/client";
import { PrismaClient } from "@repo/database/generated-client";
import { persistApprovedImageResult } from "@repo/database/media-approved-image-result";
import { getImageResultAccess } from "@repo/database/media-image-result-access";
import { runWithImageProcessor } from "@repo/storage/image-processing/context";
import { createSharpImageProcessor } from "@repo/storage/image-processing/sharp";
import { runWithRequestDefer } from "@repo/utils/request-lifecycle";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { parseTaskContinuation } from "../orchestration/contracts";
import { executeTask } from "../orchestration/executor";
import { executePollingTick } from "../orchestration/polling";
import { runWithMediaJobEvents } from "../realtime/context";
import { imageResultAssetId, mergeImageResult } from "../realtime/image-result";
import { imageResultFixture } from "../realtime/image-result.fixture";
import {
	createFinalizationDependencies,
	createDatabaseVerifyUploadDependencies,
	createDatabaseFinalizationStore,
	createDatabaseSettlementStore,
} from "../runtime";
import { archiveProviderOriginal } from "./archive-provider-original";
import { deliverCompletedProviderOriginal } from "./deliver-completed-original";
import { finalizeMedia } from "./finalize-media";
import { settleGeneration } from "./settle-generation";
import { executeTargetedEvent, prepareTargetedEvent } from "./targeted-event-delivery";

const mocks = vi.hoisted(() => ({ write: vi.fn(), open: vi.fn() }));
vi.mock("@repo/storage", async () => ({
	...(await vi.importActual<typeof import("@repo/storage")>("@repo/storage")),
	tryWriteImmutableGenerationImage: mocks.write,
	openInspectedRemoteMedia: mocks.open,
}));

let db: PrismaClient;
beforeAll(() => {
	const url = new URL(process.env.TEST_DATABASE_URL!);
	if (url.hostname !== "127.0.0.1" || !url.pathname.endsWith("_test") || Number(url.port) < 49152)
		throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
	db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString(), max: 4 }) });
});
afterAll(async () => db?.$disconnect());
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const verificationBoundary = () => ({
	provider: "test",
	ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
	policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
	now: new Date(),
});

const twoFrameGif = () =>
	Buffer.concat([
		Buffer.from("GIF89a"),
		Buffer.from([1, 0, 1, 0, 0x80, 0, 0, 255, 0, 0, 0, 0, 255]),
		...Array.from({ length: 2 }, (_, color) =>
			Buffer.from([
				0x21,
				0xf9,
				4,
				4,
				20,
				0,
				0,
				0,
				0x2c,
				0,
				0,
				0,
				0,
				1,
				0,
				1,
				0,
				0,
				2,
				2,
				4 + (color << 3) + 64,
				1,
				0,
			]),
		),
		Buffer.from([0x3b]),
	]);

function continuousReview(
	assetId: string,
	retrieveDecision: ModerationDecision["decision"] = "ALLOW",
	wait = vi.fn(async (_milliseconds: number) => {}),
) {
	const taskId = `continuous-${assetId}`;
	const retrieve = vi.fn(
		async (input: { ruleVersion: string }): Promise<ModerationDecision> => ({
			decision: retrieveDecision,
			reasonCode:
				retrieveDecision === "REVIEW"
					? "IMAGE_PROCESSING"
					: retrieveDecision === "REJECT"
						? "CONTENT_REJECTED"
						: "NO_POLICY_MATCH",
			ruleVersion: input.ruleVersion,
		}),
	);
	const submit = vi.fn(
		async (input: {
			idempotencyKey: string;
			ruleVersion: string;
		}): Promise<ModerationSubmission> => ({
			moderationTaskId: taskId,
			ruleVersion: input.ruleVersion,
			status: "RUNNING" as const,
			nonterminalState: "processing" as const,
			idempotency: { key: input.idempotencyKey, providerSupported: true, replayed: false },
		}),
	);
	const prepare = vi.fn(async () => ({
		assetUrl: "data:image/jpeg;base64,AA==",
		bytes: 32,
		checksum: "a".repeat(64),
	}));
	const review = createDatabaseVerifyUploadDependencies(db, {
		moderationProvider: "seeapi",
		safety: Object.assign(new TestMediaSafetyAdapter("ERROR"), {
			submitImage: submit,
			retrieveImage: retrieve,
		}),
		continuousOutputReview: { wait },
		prepareProviderImageModeration: prepare,
		environment: {
			...process.env,
			NEXT_PUBLIC_SAAS_URL: "https://app.test",
			WORKFLOWS_DISPATCH_SECRET: "fixture-only-secret-at-least-32-characters",
			SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({ whkey_test: `whsec_${"k".repeat(20)}` }),
		},
	});
	return { review, retrieve, submit, prepare, wait, taskId };
}

async function seedOriginal(guest = false) {
	const ownerId = `origin-${crypto.randomUUID()}`;
	const common = {
		ownerId,
		ownerType: "USER" as const,
		submittedByUserId: ownerId,
		productKey: "image-nano-banana-2-lite",
		catalogVersion: "test",
		pricingVersion: "test",
		inputSnapshot: {},
		pricingSnapshot: {
			settlementPolicy: { unitCredits: "5", requestedOutputCount: 1, maxCharge: "5" },
		},
	};
	const account = await db.creditAccount.create({ data: { ownerId, ownerType: "USER" } });
	await createCreditGrant(
		{ accountId: account.id, amount: 20n, referenceKey: `grant:${ownerId}` },
		db,
	);
	const quote = await db.generationQuote.create({
		data: { ...common, credits: 5n, costMicros: 1n, expiresAt: new Date(Date.now() + 60_000) },
	});
	const job = await db.generationJob.create({
		data: {
			...common,
			quoteId: quote.id,
			idempotencyKey: ownerId,
			creditsReserved: 5n,
			status: "FINALIZING",
		},
	});
	await reserveCredits(
		{ accountId: account.id, jobId: job.id, amount: 5n, referenceKey: `reserve:${ownerId}` },
		db,
	);
	if (guest) {
		const now = new Date();
		await db.user.create({
			data: {
				id: ownerId,
				name: "Guest fixture",
				email: `${ownerId}@anonymous.invalid`,
				emailVerified: false,
				isAnonymous: true,
				createdAt: now,
				updatedAt: now,
			},
		});
		const trial = await db.guestMediaTrial.create({
			data: {
				ownerId,
				promotionPeriod: `period:${ownerId}`,
				eligibility: "CONSUMED",
				sponsorCredits: 5n,
				sourceSessionHash: `session:${ownerId}`,
				deviceHash: `device:${ownerId}`,
				ipHash: `ip:${ownerId}`,
				subnetHash: `subnet:${ownerId}`,
				capabilityVersion: "test",
				idempotencyFingerprint: ownerId,
				abuseEvidenceExpiresAt: new Date(Date.now() + 86_400_000),
				frozenQuotedRiskMicros: 3_500n,
				riskState: "COMMITTED",
				projectedDispatchAt: now,
				estimateExpiresAt: new Date(Date.now() + 60_000),
				consumedJobId: job.id,
				providerBoundaryAt: now,
				consumedAt: now,
				expiresAt: new Date(Date.now() + 86_400_000),
			},
		});
		await db.generationJob.update({
			where: { id: job.id },
			data: { serviceClass: "GUEST_SLOW", guestTrialId: trial.id },
		});
	}
	const attempt = await db.generationAttempt.create({
		data: {
			jobId: job.id,
			attemptNumber: 1,
			provider: "kie",
			providerModelId: "nano-banana-2-lite",
			status: "SUCCEEDED",
			requestSnapshot: {},
		},
	});
	const output = {
		kind: "remote-url" as const,
		url: "https://tempfile.aiquickdraw.com/original.png",
		trust: "untrusted-transfer-candidate" as const,
	};
	await db.generationAttemptTransferEnvelope.create({
		data: { attemptId: attempt.id, payload: { version: 1, outputs: [output] } },
	});
	return { ownerId, job, attempt, output };
}

async function fixture(dispatchOverride?: (eventId: string) => Promise<void>, guest = false) {
	const { job, ownerId, output } = await seedOriginal(guest);
	const write = vi.fn(async () => {
		throw new Error("R2 must not gate finalization");
	});
	const dispatch = vi.fn(async (_eventId: string) => {});
	const deps = createFinalizationDependencies(
		{ ...process.env, MEDIA_PROVIDER_ORIGINAL_DELIVERY_ENABLED: "true" },
		{
			database: db,
			deferOutputReview: true,
			dispatchArchive: dispatchOverride ?? dispatch,
			storage: {
				openInspectedRemoteMedia: async () => ({
					contentType: "image/png",
					headers: { "content-length": "32" },
					status: 200,
					url: new URL(output.url),
					stream: Readable.from([Buffer.alloc(32)]),
				}),
				tryWriteImmutableGenerationImage: write,
			},
		},
	);
	const result = await finalizeMedia({ jobId: job.id, version: job.version }, deps);
	const asset = await db.mediaAsset.findFirstOrThrow({ where: { ownerId, kind: "OUTPUT" } });
	return { job, asset, result, dispatch, write, deps };
}

describe("approved callback result import", () => {
	async function reviewed(guest = false) {
		const seed = await seedOriginal(guest);
		const receipt = imageResultFixture();
		receipt.context = {
			...receipt.context,
			jobId: seed.job.id,
			ownerId: seed.ownerId,
			attemptId: seed.attempt.id,
			guest,
		};
		receipt.assetId = imageResultAssetId(seed.job.id, seed.attempt.id);
		receipt.completion.outputUrl = seed.output.url;
		receipt.submission.moderationTaskId = `review-${seed.attempt.id}`;
		receipt.submission.idempotency.key = `request-${seed.attempt.id}`;
		receipt.decision!.evidence!.requestId = receipt.submission.moderationTaskId;
		receipt.decision!.evidence!.seeapi!.taskId = receipt.submission.moderationTaskId;
		await db.generationAttempt.update({
			where: { id: seed.attempt.id },
			data: { providerTaskId: (receipt.completion.providerTaskId = `remote-${seed.attempt.id}`) },
		});
		return { ...seed, receipt };
	}
	it.each([false, true])(
		"atomically imports approved metadata and archive intent, keeping credit reservation active (guest=%s)",
		async (guest) => {
			const f = await reviewed(guest);
			const input = {
				receipt: f.receipt,
				checksum: "b".repeat(64),
				bytes: 256,
				policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
			};
			expect(await persistApprovedImageResult(input, db)).toBe(true);
			expect(await persistApprovedImageResult(input, db)).toBe(true);
			const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id: f.receipt.assetId } });
			expect(asset.status).toBe("READY");
			expect(await db.assetModerationResult.count({ where: { assetId: asset.id } })).toBe(1);
			expect(
				await db.generationJobAsset.count({ where: { jobId: f.job.id, assetId: asset.id } }),
			).toBe(1);
			expect(
				(await db.creditReservation.findUniqueOrThrow({ where: { jobId: f.job.id } })).status,
			).toBe("ACTIVE");
			expect(
				(await db.mediaOutputOrigin.findUniqueOrThrow({ where: { assetId: asset.id } }))
					.archiveState,
			).toBe("PENDING");
			expect(
				await db.outboxEvent.count({
					where: { dedupeKey: `provider-original-archive:${asset.id}:0` },
				}),
			).toBe(1);
			expect(
				(
					await getOwnedMediaAssetReadState(
						{
							assetId: asset.id,
							ownerId: f.ownerId,
							verification: { ...verificationBoundary(), provider: "seeapi" },
						},
						db,
					)
				)?.readable,
			).toBe(true);
			expect((await getImageResultAccess(f.job.id, asset.id, db))?.attemptId).toBe(f.attempt.id);
			if (!guest) {
				vi.stubEnv("MEDIA_SAFETY_ADAPTER", "configured");
				vi.stubEnv("MODERATION_IMAGE_SEEAPI_ENABLED", "true");
				const store = createDatabaseSettlementStore(db);
				await settleGeneration({ jobId: f.job.id, version: f.job.version }, { store });
				await settleGeneration({ jobId: f.job.id, version: f.job.version }, { store });
				expect(
					(await db.creditReservation.findUniqueOrThrow({ where: { jobId: f.job.id } }))
						.settledAmount,
				).toBe(5n);
			}
		},
	);
	it("refuses altered task identity and cannot resurrect a deleted output", async () => {
		const f = await reviewed();
		const input = {
			receipt: f.receipt,
			checksum: "c".repeat(64),
			bytes: 32,
			policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
		};
		expect(
			await persistApprovedImageResult(
				{
					...input,
					receipt: {
						...f.receipt,
						completion: { ...f.receipt.completion, providerTaskId: "another-task" },
					},
				},
				db,
			),
		).toBe(false);
		expect(await persistApprovedImageResult(input, db)).toBe(true);
		await db.mediaAsset.update({
			where: { id: f.receipt.assetId },
			data: { status: "DELETED", deletedAt: new Date() },
		});
		expect(await persistApprovedImageResult(input, db)).toBe(false);
	});
	it("can complete the same pending output after publication without resubmitting review", async () => {
		const f = await reviewed();
		const { createProviderOriginal } = await import("@repo/database");
		await createProviderOriginal(
			{
				jobId: f.job.id,
				ownerId: f.ownerId,
				assetId: f.receipt.assetId,
				objectKey: `provider-original-v1/users/${f.ownerId}/assets/${f.receipt.assetId}/original.png`,
				mimeType: "image/png",
				candidateKey: `${f.attempt.id}:0`,
				url: f.output.url,
			},
			db,
		);
		expect(
			await persistApprovedImageResult(
				{
					receipt: f.receipt,
					checksum: "d".repeat(64),
					bytes: 32,
					policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				},
				db,
			),
		).toBe(true);
		expect(
			(await db.mediaAsset.findUniqueOrThrow({ where: { id: f.receipt.assetId } })).status,
		).toBe("READY");
	});
	it.each(["new", "accepted", "interrupted", "converted"])(
		"recovers a %s direct review using the accepted task without another POST",
		async (state) => {
			const f = await reviewed();
			const { createProviderOriginal } = await import("@repo/database");
			await createProviderOriginal(
				{
					jobId: f.job.id,
					ownerId: f.ownerId,
					assetId: f.receipt.assetId,
					objectKey: `provider-original-v1/users/${f.ownerId}/assets/${f.receipt.assetId}/original.png`,
					mimeType: "image/png",
					candidateKey: `${f.attempt.id}:0`,
					url: f.output.url,
				},
				db,
			);
			await db.generationAttempt.update({
				where: { id: f.attempt.id },
				data: { requestSnapshot: { directOutputReview: true } },
			});
			await db.mediaAsset.update({
				where: { id: f.receipt.assetId },
				data: {
					checksum: "a".repeat(64),
					byteSize: 32n,
					finalizedAt: new Date(),
					verificationGeneration: 1,
					verificationProvider: "seeapi",
					verificationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
					verificationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
					...(state === "new"
						? {}
						: {
								verificationSubmissionToken: f.receipt.submission.idempotency.key,
								verificationSubmissionUncertain: state === "interrupted",
								verificationSubmittedAt: new Date(),
								verificationProviderTaskId:
									state === "accepted" ? f.receipt.submission.moderationTaskId : null,
							}),
				},
			});
			const approved = f.receipt.decision!;
			if (state === "converted") {
				f.receipt.priorReview = {
					moderationTaskId: f.receipt.submission.moderationTaskId,
					idempotencyKey: f.receipt.submission.idempotency.key,
					decision: {
						decision: "ERROR",
						reasonCode: "MODERATION_MEDIA_INVALID",
						ruleVersion: f.receipt.submission.ruleVersion,
						evidence: {
							requestId: f.receipt.submission.moderationTaskId,
							models: ["nsfw-filter-2"],
							operations: 1,
							scores: {},
							seeapiFailure: {
								taskId: f.receipt.submission.moderationTaskId,
								status: "failed",
								code: "MEDIA_INVALID",
							},
						},
					},
				};
				await db.mediaAsset.update({
					where: { id: f.receipt.assetId },
					data: { verificationProviderTaskId: f.receipt.submission.moderationTaskId },
				});
				f.receipt.submission = {
					...f.receipt.submission,
					moderationTaskId: `converted-${f.attempt.id}`,
					idempotency: {
						...f.receipt.submission.idempotency,
						key: `converted-key-${f.attempt.id}`,
					},
				};
				approved.evidence!.requestId = f.receipt.submission.moderationTaskId;
				approved.evidence!.seeapi!.taskId = f.receipt.submission.moderationTaskId;
			}
			let saved = {
				...f.receipt,
				reviewInput: "thumbnail" as const,
				decision: undefined as typeof f.receipt.decision,
				approvedAt: undefined as number | undefined,
				preparedIdentity: { checksum: "a".repeat(64), bytes: 32 },
			};
			const publishedStates: string[] = [];
			const submit = vi.fn(async () => {
				throw new Error("Must adopt the accepted SeeAPI task");
			});
			const retrieve = vi.fn(async () => approved);
			const review = createDatabaseVerifyUploadDependencies(db, {
				moderationProvider: "seeapi",
				safety: Object.assign(new TestMediaSafetyAdapter(), {
					submitImage: submit,
					retrieveImage: retrieve,
				}),
				onVerificationError: (error) => {
					throw error;
				},
			});
			await runWithMediaJobEvents(
				{
					idFromName: (value) => value,
					get: () => ({
						fetch: async (request) => {
							const body = (await request.json()) as { receipt?: typeof f.receipt };
							if (body.receipt) {
								saved = mergeImageResult(saved, body.receipt) as typeof saved;
								if (body.receipt.decision?.decision === "ALLOW")
									publishedStates.push(
										(await db.mediaAsset.findUniqueOrThrow({ where: { id: f.receipt.assetId } }))
											.status,
									);
							}
							return Response.json(saved);
						},
					}),
				},
				() => review.verify(f.receipt.assetId),
			);
			expect(submit).not.toHaveBeenCalled();
			expect(retrieve).toHaveBeenCalledOnce();
			expect(publishedStates.length).toBeGreaterThan(0);
			expect(publishedStates.every((value) => value === "VERIFYING")).toBe(true);
			expect(await db.mediaAsset.findUnique({ where: { id: f.receipt.assetId } })).toMatchObject({
				status: "READY",
				verificationProviderTaskId: f.receipt.submission.moderationTaskId,
				verificationSubmissionUncertain: false,
			});
		},
	);
	it("requires the exact registered guest grant and its current trial expiry before import", async () => {
		const f = await reviewed(true);
		const trial = await db.guestMediaTrial.findFirstOrThrow({ where: { consumedJobId: f.job.id } });
		const user = await db.user.create({
			data: {
				name: "Registered fixture",
				emailVerified: true,
				email: `${crypto.randomUUID()}@example.test`,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		const grant = await db.guestResultAccessGrant.create({
			data: {
				trialId: trial.id,
				guestJobId: f.job.id,
				registeredUserId: user.id,
				grantTokenHash: crypto.randomUUID(),
				expiresAt: trial.expiresAt,
			},
		});
		expect(
			(await getImageResultAccess(f.job.id, f.receipt.assetId, db, user.id))?.grantedUserId,
		).toBe(user.id);
		expect(
			(await getImageResultAccess(f.job.id, f.receipt.assetId, db, "other"))?.grantedUserId,
		).toBeNull();
		await db.guestResultAccessGrant.update({
			where: { id: grant.id },
			data: { expiresAt: new Date(trial.expiresAt.getTime() - 1_000) },
		});
		expect(
			(await getImageResultAccess(f.job.id, f.receipt.assetId, db, user.id))?.grantedUserId,
		).toBeNull();
		expect(await db.mediaAsset.findUnique({ where: { id: f.receipt.assetId } })).toBeNull();
	});
});

async function approve(assetId: string) {
	const review = createDatabaseVerifyUploadDependencies(db, {
		safety: new TestMediaSafetyAdapter("ALLOW"),
		moderationProvider: "test",
		prepareProviderImageModeration: async () => ({
			assetUrl: "data:image/jpeg;base64,AA==",
			bytes: 32,
			checksum: "a".repeat(64),
		}),
		headObject: async () => {
			throw new Error("R2 HEAD must not run");
		},
	});
	await review.verify(assetId);
}

async function preparedArchive(f: Awaited<ReturnType<typeof fixture>>) {
	return (await prepareTargetedEvent(
		{ eventId: f.dispatch.mock.calls[0]![0], workerId: `archive:${f.asset.id}` },
		{
			prepare: (input) => prepareWorkflowOutboxEvent(input, db),
			resolve: async () => null,
			complete: (input) => completeWorkflowOutboxExecution(input, db),
		},
	))!;
}

function archiveDelivery() {
	return {
		begin: (input: Parameters<typeof beginWorkflowOutboxExecution>[0]) =>
			beginWorkflowOutboxExecution(input, db),
		complete: (input: Parameters<typeof completeWorkflowOutboxExecution>[0]) =>
			completeWorkflowOutboxExecution(input, db),
		defer: (input: Parameters<typeof deferWorkflowOutboxExecution>[0]) =>
			deferWorkflowOutboxExecution(input, db),
		fail: (input: Parameters<typeof failWorkflowOutboxExecution>[0]) =>
			failWorkflowOutboxExecution(input, db),
		execute: (task: { payload: Record<string, unknown> }) =>
			archiveProviderOriginal(task.payload.assetId as string, db),
		recover: async () => ({ continuation: { eventIds: [] } }),
	};
}

describe("approved provider originals independent of archival", () => {
	it.each(["svg", "gif"] as const)(
		"keeps an invalid %s original private before any detector submission",
		async (format) => {
			const f = await seedOriginal();
			await db.generationJob.update({
				where: { id: f.job.id },
				data: {
					productKey: "image-gpt-image-2-6-flare",
					inputSnapshot: {
						skuKey: "gpt-image-2-6-flare-1k",
						aspectRatio: "1:1",
						outputFormat: format,
						...(format === "gif" ? { frameCount: 3, frameDurationMs: 200 } : {}),
					},
				},
			});
			const bytes =
				format === "gif"
					? twoFrameGif()
					: Buffer.from(
							'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><script>alert(1)</script></svg>',
						);
			const safety = new TestMediaSafetyAdapter("ALLOW");
			const submitted = vi.spyOn(safety, "moderateImage");
			const write = vi.fn(async () => {
				throw new Error("R2 must not gate review");
			});
			const dependencies = createFinalizationDependencies(
				{ ...process.env, MEDIA_PROVIDER_ORIGINAL_DELIVERY_ENABLED: "true" },
				{
					database: db,
					safety,
					directOriginalReview: true,
					dispatchArchive: async () => {},
					storage: {
						openInspectedRemoteMedia: async () => ({
							contentType: format === "gif" ? "image/gif" : "image/svg+xml",
							headers: { "content-length": String(bytes.length) },
							status: 200,
							url: new URL(f.output.url),
							stream: Readable.from([bytes]),
						}),
						tryWriteImmutableGenerationImage: write,
					},
				},
			);
			await finalizeMedia({ jobId: f.job.id, version: f.job.version }, dependencies);
			const asset = await db.mediaAsset.findFirstOrThrow({
				where: { ownerId: f.ownerId, kind: "OUTPUT" },
			});
			expect(asset.status).not.toBe("READY");
			expect(asset.verificationLastErrorCode).toBe(
				format === "gif" ? "OUTPUT_MEDIA_TYPE_MISMATCH" : "OUTPUT_MEDIA_TYPE_UNSUPPORTED",
			);
			expect(submitted).not.toHaveBeenCalled();
			expect(write).not.toHaveBeenCalled();
			expect(
				await db.assetModerationResult.count({ where: { assetId: asset.id, status: "APPROVED" } }),
			).toBe(0);
		},
	);
	it.each([
		[false, "image-nano-banana-2-lite", "png"],
		[true, "image-nano-banana-2-lite", "png"],
		[false, "image-gpt-image-2-6-flare", "png"],
		[false, "image-gpt-image-2-6-flare", "svg"],
		[false, "image-gpt-image-2-6-flare", "gif"],
	] as const)(
		"delivers the completed model output to READY in the same poll without an R2 write (guest=%s, product=%s, format=%s)",
		async (guest, productKey, format) => {
			const f = await seedOriginal(guest);
			if (productKey === "image-gpt-image-2-6-flare")
				await db.generationJob.update({
					where: { id: f.job.id },
					data: {
						productKey,
						inputSnapshot: {
							skuKey: "gpt-image-2-6-flare-1k",
							aspectRatio: "1:1",
							outputFormat: format,
							...(format === "gif" ? { frameCount: 2, frameDurationMs: 200 } : {}),
						},
					},
				});
			await db.outboxEvent.create({
				data: {
					aggregateType: "GENERATION_JOB",
					aggregateId: f.job.id,
					eventType: "GENERATION_FINALIZE",
					dedupeKey: `generation-finalize:${f.job.id}:${f.attempt.id}`,
					payload: { jobId: f.job.id, version: 0 },
				},
			});
			const bytes =
				format === "svg"
					? Buffer.from(
							'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="red"/></svg>',
						)
					: format === "gif"
						? twoFrameGif()
						: Buffer.from(
								"iVBORw0KGgoAAAANSUhEUgAAAKAAAACgCAMAAAC8EZcfAAAAA1BMVEUAAP+KeNJXAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAL0lEQVR42u3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPBqZKAAAbE2mIIAAAAASUVORK5CYII=",
								"base64",
							);
			mocks.open.mockReset().mockImplementation(async () => ({
				contentType: format === "svg" ? "image/svg+xml" : `image/${format}`,
				headers: { "content-length": String(bytes.length) },
				status: 200,
				url: new URL(f.output.url),
				stream: Readable.from([bytes]),
			}));
			mocks.write.mockClear();
			vi.stubEnv("MEDIA_PROVIDER_ORIGINAL_DELIVERY_ENABLED", "true");
			// Exercise the deployed processor predicate with local deterministic bytes;
			// the real Cloudflare Images service is not invoked by this database test.
			const deliver = () =>
				runWithDatabaseClient(db, () =>
					runWithImageProcessor(
						{ ...createSharpImageProcessor(), key: guest ? "cloudflare-images" : "sharp" },
						() =>
							executePollingTick({ attemptId: f.attempt.id }, undefined, {
								workflowId: `workflow-${f.job.id}`,
							}),
					),
				);
			const delivered = await deliver();
			expect(delivered).toMatchObject({ done: true });
			expect(mocks.open).toHaveBeenCalledOnce();
			expect(mocks.write).not.toHaveBeenCalled();
			const asset = await db.mediaAsset.findFirstOrThrow({
				where: { ownerId: f.ownerId, kind: "OUTPUT" },
			});
			expect(asset).toMatchObject({ status: "READY", verificationAttemptCount: 1 });
			expect(await db.mediaOutputOrigin.findUnique({ where: { assetId: asset.id } })).toMatchObject(
				{ archiveState: "PENDING" },
			);
			expect(await db.creditReservation.findUnique({ where: { jobId: f.job.id } })).toMatchObject({
				status: "ACTIVE",
			});
			if (guest)
				expect(
					await getGuestJobSnapshot(
						{
							jobId: f.job.id,
							ownerId: f.ownerId,
							now: new Date(),
							verification: verificationBoundary(),
						},
						db,
					),
				).toMatchObject({ stage: "READY", resultAssetId: asset.id });
			else
				expect(
					await getOwnedMediaAssetReadState(
						{ assetId: asset.id, ownerId: f.ownerId, verification: verificationBoundary() },
						db,
					),
				).toMatchObject({ readable: true });
			await deliver();
			expect(mocks.open).toHaveBeenCalledOnce();
			expect(await db.mediaAsset.count({ where: { ownerId: f.ownerId, kind: "OUTPUT" } })).toBe(1);
			// Drain the returned exact receipts, including the original review intent.
			// No scanner or newly dispatched Workflow is used by this test.
			const events = [...delivered.continuation!.eventIds];
			const seen = new Set<string>();
			while (events.length) {
				const eventId = events.shift()!;
				if (seen.has(eventId)) continue;
				seen.add(eventId);
				expect(seen.size).toBeLessThan(10);
				const task = await prepareTargetedEvent(
					{ eventId, workerId: `test:${f.job.id}` },
					{
						prepare: (input) => prepareWorkflowOutboxEvent(input, db),
						resolve: async () => null,
						complete: (input) => completeWorkflowOutboxExecution(input, db),
					},
				);
				if (!task) continue;
				const result = (await runWithDatabaseClient(db, () =>
					executeTask(task, {
						attempt: 1,
						maxAttempts: 3,
						runId: `workflow-${f.job.id}`,
						workflowId: `workflow-${f.job.id}`,
					}),
				)) as { continuation?: unknown };
				events.push(...(parseTaskContinuation(result.continuation)?.eventIds ?? []));
			}
			expect(
				await db.outboxEvent.count({
					where: {
						aggregateId: { in: [f.job.id, asset.id] },
						eventType: {
							in: [
								"GENERATION_FINALIZE",
								"GENERATION_FINALIZE_RETRY",
								"GENERATION_SETTLE",
								"MEDIA_ASSET_VERIFY",
							],
						},
						status: { in: ["PENDING", "LEASED"] },
					},
				}),
			).toBe(0);
			expect(mocks.open).toHaveBeenCalledOnce();
			const settlement = { store: createDatabaseSettlementStore(db) };
			await settleGeneration({ jobId: f.job.id, version: 0 }, settlement);
			await settleGeneration({ jobId: f.job.id, version: 0 }, settlement);
			expect(await db.creditReservation.findUnique({ where: { jobId: f.job.id } })).toMatchObject({
				settledAmount: 5n,
			});
		},
	);

	it("finishes a short accepted SeeAPI review under one lease without writing a PENDING verdict", async () => {
		const f = await fixture();
		const { review, submit, retrieve, wait, taskId } = continuousReview(f.asset.id);
		await review.verify(f.asset.id);
		expect(submit).toHaveBeenCalledOnce();
		expect(retrieve).toHaveBeenCalledOnce();
		expect(wait).toHaveBeenCalledWith(1000);
		expect(await db.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
			status: "READY",
			verificationAttemptCount: 1,
			verificationProviderTaskId: taskId,
		});
		expect(
			(
				await db.assetModerationResult.findMany({
					where: { assetId: f.asset.id },
					select: { status: true },
				})
			).map((row) => row.status),
		).toEqual(["APPROVED"]);
		// The approval transaction only queues finalization; it does not prepare settlement.
		expect(
			await db.outboxEvent.findUnique({ where: { dedupeKey: `generation-settle:${f.job.id}` } }),
		).toBeNull();
		expect(
			await db.outboxEvent.findFirst({
				where: { aggregateId: f.job.id, eventType: "GENERATION_FINALIZE_RETRY", status: "PENDING" },
			}),
		).not.toBeNull();
	});

	it("honors the two-second acceptance hint, then queries at one second without a further hint", async () => {
		const f = await fixture();
		const c = continuousReview(f.asset.id);
		const submit = c.submit.getMockImplementation()!;
		c.submit.mockImplementation(async (input) => ({
			...(await submit(input)),
			retryAfterMs: 2_000,
		}));
		c.retrieve.mockResolvedValueOnce({
			decision: "REVIEW",
			reasonCode: "IMAGE_PROCESSING",
			ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
		});
		await c.review.verify(f.asset.id);
		expect(c.wait.mock.calls.map(([delay]) => delay)).toEqual([2_000, 1_000]);
		expect(c.submit).toHaveBeenCalledOnce();
		expect(c.retrieve).toHaveBeenCalledTimes(2);
		expect(await db.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
			status: "READY",
		});
	});
	it("persists a provider delay beyond the short-review budget without querying early", async () => {
		const f = await fixture();
		const c = continuousReview(f.asset.id);
		const submit = c.submit.getMockImplementation()!;
		c.submit.mockImplementation(async (input) => ({
			...(await submit(input)),
			retryAfterMs: 30_000,
		}));
		const before = Date.now();
		await c.review.verify(f.asset.id);
		expect(c.wait).not.toHaveBeenCalled();
		expect(c.retrieve).not.toHaveBeenCalled();
		expect(c.submit).toHaveBeenCalledOnce();
		const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id: f.asset.id } });
		expect(asset).toMatchObject({
			status: "VERIFYING",
			verificationProviderTaskId: c.taskId,
			verificationLeaseToken: null,
		});
		expect(asset.verificationNextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 30_000);
	});
	it("returns to durable polling when a delayed timer exhausts the fifteen-second budget", async () => {
		const f = await fixture();
		const realNow = Date.now.bind(Date);
		let elapsed = 0;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + elapsed);
		try {
			const c = continuousReview(
				f.asset.id,
				"ALLOW",
				vi.fn(async () => {
					elapsed = 16_000;
				}),
			);
			await c.review.verify(f.asset.id);
			expect(c.retrieve).not.toHaveBeenCalled();
			expect(c.submit).toHaveBeenCalledOnce();
			expect(await db.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
				status: "VERIFYING",
				verificationProviderTaskId: c.taskId,
				verificationLeaseToken: null,
			});
		} finally {
			clock.mockRestore();
		}
	});
	it("returns a slow review to durable polling and never resubmits its accepted task", async () => {
		const f = await fixture();
		const c = continuousReview(f.asset.id, "REVIEW");
		await c.review.verify(f.asset.id);
		expect(c.submit).toHaveBeenCalledOnce();
		expect(c.retrieve).toHaveBeenCalledTimes(15);
		expect(await db.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
			status: "VERIFYING",
			verificationProviderTaskId: c.taskId,
			verificationLeaseToken: null,
		});
		c.retrieve.mockImplementationOnce(async ({ ruleVersion }) => ({
			decision: "ALLOW",
			reasonCode: "NO_POLICY_MATCH",
			ruleVersion,
		}));
		await db.mediaAsset.update({
			where: { id: f.asset.id },
			data: { verificationNextAttemptAt: new Date(0) },
		});
		await c.review.verify(f.asset.id, { queryOnly: true });
		expect(c.submit).toHaveBeenCalledOnce();
		expect(c.prepare).toHaveBeenCalledOnce();
		expect(await db.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
			status: "READY",
		});
	});

	it("stops short polling when the verification lease is lost, retaining the task for query-only recovery", async () => {
		const f = await fixture();
		const wait = vi.fn(async () => {
			await db.mediaAsset.update({
				where: { id: f.asset.id },
				data: { verificationLeasedUntil: new Date(0) },
			});
		});
		const c = continuousReview(f.asset.id, "ALLOW", wait);
		expect(await c.review.verify(f.asset.id, { workflowId: `review-${f.job.id}` })).toMatchObject({
			phaseOwnershipLost: true,
		});
		expect(c.submit).toHaveBeenCalledOnce();
		expect(c.retrieve).not.toHaveBeenCalled();
		expect(await db.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
			status: "VERIFYING",
			verificationProviderTaskId: c.taskId,
		});
	});

	it("keeps a rejected continuous review private", async () => {
		const f = await fixture();
		const c = continuousReview(f.asset.id, "REJECT");
		await c.review.verify(f.asset.id);
		expect(c.retrieve).toHaveBeenCalledOnce();
		expect(await db.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
			status: "QUARANTINED",
		});
		expect(
			await getOwnedMediaAssetReadState(
				{
					assetId: f.asset.id,
					ownerId: f.job.ownerId,
					verification: { ...verificationBoundary(), provider: "seeapi" },
				},
				db,
			),
		).toMatchObject({ readable: false });
	});

	it("does not switch to storage transfer after an unknown original-source failure", async () => {
		const f = await seedOriginal();
		mocks.open.mockReset().mockRejectedValue(new Error("unknown source transport failure"));
		mocks.write.mockClear();
		const continuation = await deliverCompletedProviderOriginal(
			f.attempt.id,
			db,
			{ workflowId: `workflow-${f.job.id}` },
			{ ...process.env, MEDIA_PROVIDER_ORIGINAL_DELIVERY_ENABLED: "true" },
		);
		expect(continuation).not.toBeNull();
		expect(mocks.open).toHaveBeenCalledOnce();
		expect(mocks.write).not.toHaveBeenCalled();
		expect(await db.mediaAsset.count({ where: { ownerId: f.ownerId, kind: "OUTPUT" } })).toBe(0);
		expect(await db.creditReservation.findUnique({ where: { jobId: f.job.id } })).toMatchObject({
			status: "ACTIVE",
		});
	});

	it("submits SeeAPI before archival and retrieves the same accepted task without preparing or submitting twice", async () => {
		const f = await fixture();
		const taskId = `review_${f.asset.id}`;
		const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
			const pending = init?.method === "POST";
			return Response.json({
				id: taskId,
				object: "inference",
				model: "nsfw-filter-2",
				endpoint: "image-moderation",
				provider: "seeapi",
				status: pending ? "processing" : "succeeded",
				result: pending
					? null
					: { type: "json", data: { flagged: false, categories: { nsfw: [], special_care: [] } } },
				error: null,
			});
		});
		const adapter = new SeeapiSafetyAdapter({ apiKey: "fixture-only", fetch: fetcher });
		const prepare = vi.fn(async () => ({
			assetUrl: "data:image/jpeg;base64,AA==",
			bytes: 32,
			checksum: "a".repeat(64),
		}));
		const review = createDatabaseVerifyUploadDependencies(db, {
			moderationProvider: "seeapi",
			safety: Object.assign(new TestMediaSafetyAdapter("ERROR"), {
				imageInputProfile: "seeapi-nsfw-filter-2" as const,
				submitImage: adapter.submitImage.bind(adapter),
				retrieveImage: adapter.retrieveImage.bind(adapter),
			}),
			prepareProviderImageModeration: prepare,
			environment: {
				...process.env,
				NEXT_PUBLIC_SAAS_URL: "https://app.test",
				WORKFLOWS_DISPATCH_SECRET: "fixture-only-secret-at-least-32-characters",
				SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({ whkey_test: `whsec_${"k".repeat(20)}` }),
			},
		});
		await review.verify(f.asset.id);
		expect(fetcher).toHaveBeenCalledOnce();
		expect(await db.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
			status: "VERIFYING",
			verificationProviderTaskId: taskId,
		});
		await db.mediaAsset.update({
			where: { id: f.asset.id },
			data: { verificationNextAttemptAt: new Date(0) },
		});
		await review.verify(f.asset.id, { queryOnly: true });
		expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
		expect(prepare).toHaveBeenCalledOnce();
		expect(await db.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
			status: "READY",
		});
		expect(await db.mediaOutputOrigin.findUnique({ where: { assetId: f.asset.id } })).toMatchObject(
			{ archiveState: "PENDING" },
		);
	});

	it("makes the guest watermarked result ready without a clean R2 staging object", async () => {
		// Exercise the Workers-only producer predicate; external image bytes are
		// covered separately by the storage test, not claimed as a live Images test.
		const f = await runWithImageProcessor(
			{ ...createSharpImageProcessor(), key: "cloudflare-images" },
			() => fixture(undefined, true),
		);
		expect(f.write).not.toHaveBeenCalled();
		await approve(f.asset.id);
		const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id: f.asset.id } });
		expect(asset).toMatchObject({
			status: "READY",
			retentionClass: "GUEST_TRIAL",
			watermarkVersion: "ezpic-guest-origin-v1",
			cleanStagingDeletedAt: null,
			outputStagingObjectKey: null,
		});
		expect(asset.watermarkedAt).toBeInstanceOf(Date);
		const attempt = await db.generationAttempt.findFirstOrThrow({ where: { jobId: f.job.id } });
		expect(
			await createDatabaseFinalizationStore(db).findPersistedCandidate(f.job.id, `${attempt.id}:0`),
		).toMatchObject({ approved: true });
		await settleGeneration(
			{ jobId: f.job.id, version: f.job.version },
			{ store: createDatabaseSettlementStore(db) },
		);
		expect(await db.generationJob.findUnique({ where: { id: f.job.id } })).toMatchObject({
			status: "SUCCEEDED",
		});
	});

	it("continues to review while the managed archive wake is still in flight", async () => {
		let finish!: () => void;
		const pending: Promise<unknown>[] = [];
		const f = await runWithRequestDefer(
			(work) => {
				pending.push(work);
			},
			() =>
				fixture(
					() =>
						new Promise<void>((resolve) => {
							finish = resolve;
						}),
				),
		);
		try {
			expect(pending).toHaveLength(1);
			await approve(f.asset.id);
			expect(await db.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
				status: "READY",
			});
		} finally {
			finish();
			await Promise.all(pending);
		}
	});

	it("completes review and settlement while a receipt-bound R2 write is stalled, then ACKs the same archive once", async () => {
		const f = await fixture();
		const task = await preparedArchive(f);
		let finish!: () => void;
		mocks.write.mockImplementationOnce(async (input: { reserve(bytes: number): Promise<void> }) => {
			await input.reserve(32);
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			return { bytes: 32, sha256: "a".repeat(64), etag: '"stored"', versionId: null };
		});
		const running = executeTargetedEvent(task, archiveDelivery());
		try {
			await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
			await approve(f.asset.id);
			await settleGeneration(
				{ jobId: f.job.id, version: f.job.version },
				{ store: createDatabaseSettlementStore(db) },
			);
			expect(await db.generationJob.findUnique({ where: { id: f.job.id } })).toMatchObject({
				status: "SUCCEEDED",
			});
			expect(
				await db.mediaOutputOrigin.findUnique({ where: { assetId: f.asset.id } }),
			).toMatchObject({ archiveState: "PENDING" });
		} finally {
			finish?.();
			await running;
		}
		expect(
			await db.outboxEvent.findUnique({ where: { id: task.outboxReceipt!.eventId } }),
		).toMatchObject({ status: "PROCESSED" });
		const count = mocks.write.mock.calls.length;
		await executeTargetedEvent(task, archiveDelivery());
		expect(mocks.write).toHaveBeenCalledTimes(count);
		expect(await db.mediaOutputOrigin.findUnique({ where: { assetId: f.asset.id } })).toMatchObject(
			{ archiveState: "ARCHIVED" },
		);
	});

	it("recovers a lost begin/preflight before an archive lease exists without reopening paid work", async () => {
		const f = await fixture();
		const task = await preparedArchive(f);
		await beginWorkflowOutboxExecution({ ...task.outboxReceipt!, timeoutSeconds: 900 }, db);
		await recoverProviderOriginalArchives(db);
		expect(
			await db.outboxEvent.findUnique({ where: { id: task.outboxReceipt!.eventId } }),
		).toMatchObject({ status: "LEASED" });
		await db.outboxEvent.update({
			where: { id: task.outboxReceipt!.eventId },
			data: { leasedUntil: new Date(0) },
		});
		await recoverProviderOriginalArchives(db);
		expect(
			await db.outboxEvent.findUnique({ where: { id: task.outboxReceipt!.eventId } }),
		).toMatchObject({ status: "PENDING", lastError: null, leaseToken: null });
		expect(await preparedArchive(f)).toMatchObject({
			taskId: "media-archive-output",
			payload: { assetId: f.asset.id },
		});
	});

	it("retains successful output when archival fails and queues only an archival retry", async () => {
		const f = await fixture();
		await approve(f.asset.id);
		await settleGeneration(
			{ jobId: f.job.id, version: f.job.version },
			{ store: createDatabaseSettlementStore(db) },
		);
		mocks.write.mockRejectedValueOnce(new Error("R2 unavailable"));
		const result = (await executeTargetedEvent(await preparedArchive(f), archiveDelivery())) as {
			continuation: { eventIds: string[] };
		};
		expect(result.continuation.eventIds).toHaveLength(1);
		expect(
			await db.outboxEvent.findUnique({ where: { id: result.continuation.eventIds[0] } }),
		).toMatchObject({ eventType: "MEDIA_OUTPUT_ARCHIVE" });
		expect(await db.generationJob.findUnique({ where: { id: f.job.id } })).toMatchObject({
			status: "SUCCEEDED",
		});
		expect(await db.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
			status: "READY",
		});
	});

	it("recovers a scanned enqueue whose Workflow died before claiming storage", async () => {
		const f = await fixture();
		const eventId = f.dispatch.mock.calls[0]![0];
		await db.outboxEvent.update({
			where: { id: eventId },
			data: { status: "PROCESSED", createdAt: new Date(0) },
		});
		await db.generationJob.update({ where: { id: f.job.id }, data: { status: "SUCCEEDED" } });
		await recoverProviderOriginalArchives(db);
		await recoverProviderOriginalArchives(db);
		const pending = await db.outboxEvent.findMany({
			where: { eventType: "MEDIA_OUTPUT_ARCHIVE", aggregateId: f.asset.id, status: "PENDING" },
		});
		expect(pending).toHaveLength(1);
		expect(pending[0]!.id).not.toBe(eventId);
		expect(await db.mediaOutputOrigin.findUnique({ where: { assetId: f.asset.id } })).toMatchObject(
			{ attempts: 1, lastErrorCode: "ORIGINAL_ARCHIVE_EXECUTION_LOST" },
		);
	});

	it("marks an archive-first checksum mismatch without approving the different archived copy", async () => {
		const f = await fixture();
		const claim = (await claimProviderOriginalArchive(f.asset.id, db))!;
		await reserveProviderOriginalArchive(
			{
				assetId: f.asset.id,
				ownerId: f.job.ownerId,
				token: claim.token,
				bytes: 32,
				maximumStorageBytes: 1_000_000n,
			},
			db,
		);
		await completeProviderOriginalArchive(
			{
				assetId: f.asset.id,
				ownerId: f.job.ownerId,
				token: claim.token,
				bytes: 32,
				checksum: "b".repeat(64),
				etag: null,
				versionId: null,
			},
			db,
		);
		await approve(f.asset.id);
		expect(await db.mediaOutputOrigin.findUnique({ where: { assetId: f.asset.id } })).toMatchObject(
			{ archiveState: "FAILED", lastErrorCode: "ORIGINAL_ARCHIVE_IDENTITY_CHANGED" },
		);
		expect(await db.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
			status: "READY",
			checksum: "a".repeat(64),
		});
	});

	it("meters a write that finishes after deletion and durably queues its exact cleanup", async () => {
		const f = await fixture();
		const claim = (await claimProviderOriginalArchive(f.asset.id, db))!;
		await reserveProviderOriginalArchive(
			{
				assetId: f.asset.id,
				ownerId: f.job.ownerId,
				token: claim.token,
				bytes: 32,
				maximumStorageBytes: 1_000_000n,
			},
			db,
		);
		await db.mediaAsset.update({
			where: { id: f.asset.id },
			data: { status: "DELETED", deletedAt: new Date() },
		});
		await db.storageUsageReservation.update({
			where: { referenceKey: `generation-output:${f.asset.id}` },
			data: { status: "RELEASED", releasedAt: new Date() },
		});
		await db.mediaOutputOrigin.update({
			where: { assetId: f.asset.id },
			data: { leaseToken: null, leasedUntil: null },
		});
		await completeProviderOriginalArchive(
			{
				assetId: f.asset.id,
				ownerId: f.job.ownerId,
				token: claim.token,
				bytes: 32,
				checksum: "a".repeat(64),
				etag: null,
				versionId: null,
			},
			db,
		);
		expect(
			await db.storageUsageReservation.findUnique({
				where: { referenceKey: `generation-output:${f.asset.id}` },
			}),
		).toMatchObject({ status: "COMMITTED", bytes: 32n });
		expect(
			await db.outboxEvent.findFirst({
				where: { aggregateId: f.asset.id, eventType: "MEDIA_OBJECT_DELETE" },
			}),
		).toMatchObject({ payload: { objectKey: f.asset.objectKey } });
		expect(await claimProviderOriginalArchive(f.asset.id, db)).toBeNull();
	});

	it("starts review without a storage PUT and settles exactly once while R2 remains pending", async () => {
		const f = await fixture();
		expect(f.result.outcome).toBe("WAITING_MODERATION");
		expect(f.write).not.toHaveBeenCalled();
		expect(f.dispatch).toHaveBeenCalledOnce();
		const archiveId = f.dispatch.mock.calls[0]![0];
		expect(
			await prepareWorkflowOutboxEvent({ eventId: archiveId, workerId: "archive-test" }, db),
		).toMatchObject({ eventType: "MEDIA_OUTPUT_ARCHIVE" });
		const review = createDatabaseVerifyUploadDependencies(db, {
			safety: new TestMediaSafetyAdapter("ALLOW"),
			moderationProvider: "test",
			prepareProviderImageModeration: async () => ({
				assetUrl: "data:image/jpeg;base64,AA==",
				bytes: 32,
				checksum: "a".repeat(64),
			}),
			headObject: async () => {
				throw new Error("R2 HEAD must not run");
			},
			inspectPrivateMediaObject: async () => {
				throw new Error("R2 inspection must not run");
			},
		});
		await review.verify(f.asset.id);
		const ready = await db.mediaAsset.findUniqueOrThrow({ where: { id: f.asset.id } });
		expect(ready.status).toBe("READY");
		expect(ready.checksum).toBe("a".repeat(64));
		expect(await db.mediaOutputOrigin.findUnique({ where: { assetId: f.asset.id } })).toMatchObject(
			{ archiveState: "PENDING", archivedAt: null },
		);
		const finalizer = createDatabaseFinalizationStore(db);
		expect(
			await finalizer.findPersistedCandidate(
				f.job.id,
				`${(await db.generationAttempt.findFirstOrThrow({ where: { jobId: f.job.id } })).id}:0`,
			),
		).toMatchObject({ approved: true });
		const store = createDatabaseSettlementStore(db);
		await settleGeneration({ jobId: f.job.id, version: f.job.version }, { store });
		await settleGeneration({ jobId: f.job.id, version: f.job.version }, { store });
		expect(await db.generationJob.findUnique({ where: { id: f.job.id } })).toMatchObject({
			status: "SUCCEEDED",
		});
		expect(await db.creditReservation.findUnique({ where: { jobId: f.job.id } })).toMatchObject({
			settledAmount: 5n,
		});
	});

	it("archives independently, retains the detector identity, and recovers expired leases after job success", async () => {
		const f = await fixture();
		const claim = await claimProviderOriginalArchive(f.asset.id, db);
		expect(claim).not.toBeNull();
		await reserveProviderOriginalArchive(
			{
				assetId: f.asset.id,
				ownerId: f.job.ownerId,
				token: claim!.token,
				bytes: 32,
				maximumStorageBytes: 1_000_000n,
			},
			db,
		);
		await db.mediaAsset.update({ where: { id: f.asset.id }, data: { checksum: "a".repeat(64) } });
		await completeProviderOriginalArchive(
			{
				assetId: f.asset.id,
				ownerId: f.job.ownerId,
				token: claim!.token,
				bytes: 32,
				checksum: "b".repeat(64),
				etag: null,
				versionId: null,
			},
			db,
		);
		expect(await db.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
			checksum: "a".repeat(64),
			status: "VERIFYING",
		});
		expect(await db.mediaOutputOrigin.findUnique({ where: { assetId: f.asset.id } })).toMatchObject(
			{ archiveChecksum: "b".repeat(64) },
		);
		const other = await fixture();
		const lease = await claimProviderOriginalArchive(other.asset.id, db);
		await db.generationJob.update({ where: { id: other.job.id }, data: { status: "SUCCEEDED" } });
		await db.mediaOutputOrigin.update({
			where: { assetId: other.asset.id },
			data: { leasedUntil: new Date(0) },
		});
		await recoverProviderOriginalArchives(db);
		expect(
			await db.mediaOutputOrigin.findUnique({ where: { assetId: other.asset.id } }),
		).toMatchObject({ leaseToken: null, archiveState: "PENDING" });
		expect(await retryProviderOriginalArchive(other.asset.id, lease!.token, db)).toBeNull();
	});

	it("keeps rejected output private even when the R2 copy is complete", async () => {
		const f = await fixture();
		const review = createDatabaseVerifyUploadDependencies(db, {
			safety: new TestMediaSafetyAdapter("REJECT"),
			moderationProvider: "test",
			prepareProviderImageModeration: async () => ({
				assetUrl: "data:image/jpeg;base64,AA==",
				bytes: 32,
				checksum: "c".repeat(64),
			}),
		});
		await review.verify(f.asset.id);
		expect(await db.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
			status: "QUARANTINED",
		});
	});
});
