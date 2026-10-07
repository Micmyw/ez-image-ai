import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import type { VideoEffectId } from "@repo/config/video-effects";
import { createVideoEffectTemplateSnapshot } from "@repo/config/video-effects.server";
import { createVideoAudioSafetyPolicy } from "@repo/config/video-output";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";

import { runWithDatabaseClient } from "../../client";
import { PrismaClient, type Prisma } from "../../generated/client";
import { createMediaUploadSessionTransaction } from "./assets";
import { createCreditGrant, releaseCredits } from "./credits";
import {
	createVideoTemplateQuoteRecord,
	createVideoTemplateJobRecord,
	findExistingVideoTemplateAdmission,
} from "./video-template-admission";
import {
	claimVideoTemplateSceneSubmission,
	recordVideoTemplateReview,
	recordVideoTemplateImageReview,
	recordVideoTemplateSceneAccepted,
	recordVideoTemplateSceneProviderResult,
	prepareVideoTemplateSceneAsset,
	recordVideoTemplateSceneAsset,
	sealVideoTemplateResolvedInput,
	getVideoTemplateExecution,
	persistVideoTemplateSceneWebhook,
	markVideoTemplateNeedsReview,
	markVideoTemplateSceneFailed,
} from "./video-template-execution";
import { createVideoJobRecord, createVideoQuoteRecord } from "./video-v1";
import {
	claimVideoResourceCleanup,
	completeVideoResourceCleanup,
	listVideoResourceCleanupCandidates,
	listVideoStagingCleanup,
	completeVideoStagingCleanup,
} from "./video-v1-cleanup";
import {
	failVideoExecution,
	claimVideoProviderSubmission,
	listPendingVideoWebhookEvents,
	markVideoWebhookNotified,
	postponeVideoWebhookNotification,
} from "./video-v1-execution";
import { failVideoDelivery } from "./video-v1-fulfillment";
const profile = createVideoTextSafetyProfile();
const object = (v: unknown) => v as Record<string, unknown>;
let db: PrismaClient;
const owners: string[] = [];
const run = <T>(f: () => T) => runWithDatabaseClient(db, f);
beforeAll(() => {
	const raw = process.env.TEST_DATABASE_URL;
	if (!raw) throw new Error("TEST_DATABASE_URL_REQUIRED");
	const u = new URL(raw);
	if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || !u.pathname.includes("test"))
		throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
	db = new PrismaClient({ adapter: new PrismaPg({ connectionString: raw, max: 30 }) });
});
afterAll(async () => {
	if (!db) return;
	for (const ownerId of owners) {
		const jobs = await db.generationJob.findMany({
			where: { ownerId },
			include: { reservation: true },
		});
		for (const job of jobs) {
			if (job.reservation?.status === "ACTIVE")
				await releaseCredits(
					{ reservationId: job.reservation.id, referenceKey: `template-test-cleanup:${job.id}` },
					db,
				);
			await db.videoExecution.update({ where: { jobId: job.id }, data: { stage: "FAILED" } });
			await db.generationJob.update({
				where: { id: job.id },
				data: { status: "FAILED", terminalAt: new Date() },
			});
		}
	}
	await db.$disconnect();
});
async function fixture(credits = 100n, effectId: VideoEffectId = "hotel-lobby-duo") {
	const ownerId = `template-db-test-${randomUUID()}`;
	owners.push(ownerId);
	const account = await db.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	await createCreditGrant(
		{ accountId: account.id, amount: credits, referenceKey: `grant:${ownerId}` },
		db,
	);
	const assets = await Promise.all(
		[0, 1].map((i) =>
			db.mediaAsset.create({
				data: {
					ownerType: "USER",
					ownerId,
					kind: "INPUT",
					status: "VERIFYING",
					verificationEngine: "video-workflow-v1",
					objectKey: `users/${ownerId}/${i}.template-source.template-input.png`,
					mimeType: "image/png",
					byteSize: 1000n,
					width: 720,
					height: 1280,
					checksum: String(i + 1).repeat(64),
					storageEtag: `etag-${i}`,
					verificationGeneration: 1,
					finalizedAt: new Date(),
				},
			}),
		),
	);
	const request = {
		effectId,
		presetKey: "standard" as const,
		inputs: {
			leftAssetId: assets[0]!.id,
			rightAssetId: assets[effectId === "raindance-solo" ? 0 : 1]!.id,
		},
	};
	const template = createVideoEffectTemplateSnapshot(request);
	if (template.schemaVersion !== 1) throw new Error("SCENE_TEMPLATE_FIXTURE_REQUIRED");
	const base = {
		ownerId,
		request,
		template,
		price: {
			credits: 7n,
			providerCostMicros: 107500n,
			moderationCostMicros: 10000n,
			pricingBasis: "ISOLATED_TEST_NOT_FORMAL",
			pricingVersion: "TEMPLATE_TEST_V1",
			pricingDetails: { validUntil: new Date(Date.now() + 3600000).toISOString() },
		},
		visualSafetyProfile: createVideoVisualSafetyProfile("seeapi", 5),
		textSafetyProfile: profile,
		audioSafetyPolicy: createVideoAudioSafetyPolicy(),
	};
	const limits = {
		ownerConcurrency: 50,
		globalConcurrency: 10000,
		providerConcurrency: 10000,
		maximumStorageBytes: 1000000000n,
		maximumInputBytes: 10000000,
	};
	const quote = await createVideoTemplateQuoteRecord({ ...base, maximumInputBytes: 10000000 }, db);
	const input = { ...base, quoteId: quote.quoteId, idempotencyKey: randomUUID(), limits };
	return { ownerId, assets, base, quote, input };
}
async function accepted() {
	const f = await fixture();
	const { jobId } = await createVideoTemplateJobRecord(f.input, db);
	return { ...f, jobId };
}
const decision = {
	decision: "ALLOW",
	reasonCode: "WAFFO_PROMPT_ALLOWED",
	ruleVersion: profile.ruleVersion,
	evidence: {
		requestId: "test-waffo-1",
		models: ["waffo-prompt-sift"],
		operations: 1,
		waffo: {
			requestId: "test-waffo-1",
			action: "allow",
			semanticStatus: "scored",
			matchedCategories: [],
		},
	},
};
async function reviewInputs(jobId: string) {
	const e = await run(() => getVideoTemplateExecution(jobId));
	for (const value of e!.orderedRoleIdentities as Prisma.JsonArray) {
		const i = object(value);
		await run(() =>
			recordVideoTemplateImageReview(jobId, i.role as "left" | "right", {
				...i,
				decision: { decision: "ALLOW" },
				ruleVersion: "test-video-rule",
				safetyPolicyVersion: object(e!.templateSnapshot).safetyPolicyVersion,
				validUntil: new Date(Date.now() + 3600000).toISOString(),
			}),
		);
	}
	await run(() =>
		recordVideoTemplateReview(jobId, "inputs", {
			status: "ALLOW",
			requestFingerprint: object(e!.job.inputSnapshot).requestFingerprint,
			textSafetyProfile: profile,
			sceneTextDecision: decision,
			motionTextDecision: decision,
		}),
	);
}
async function storedScene(jobId: string) {
	await reviewInputs(jobId);
	await run(() => claimVideoTemplateSceneSubmission({ jobId, callbackTokenHash: randomUUID() }));
	const taskId = randomUUID();
	await run(() => recordVideoTemplateSceneAccepted(jobId, taskId));
	await run(() =>
		recordVideoTemplateSceneProviderResult({
			jobId,
			taskId,
			evidence: { status: "SUCCEEDED", outputUrl: "https://fixture.invalid/scene.png" },
		}),
	);
	const asset = await run(() => prepareVideoTemplateSceneAsset(jobId));
	await run(() =>
		recordVideoTemplateSceneAsset({
			jobId,
			transferToken: asset.outputTransferToken!,
			asset: {
				id: asset.id,
				objectKey: asset.objectKey,
				mimeType: "image/png",
				byteSize: 2000n,
				checksum: "a".repeat(64),
				width: 720,
				height: 1280,
				storageEtag: "scene-etag",
				storageVersionId: null,
			},
		}),
	);
	const e = await run(() => getVideoTemplateExecution(jobId));
	await run(() =>
		recordVideoTemplateImageReview(jobId, "scene", {
			assetId: asset.id,
			objectKey: asset.objectKey,
			checksum: "a".repeat(64),
			storageEtag: "scene-etag",
			storageVersionId: null,
			verificationGeneration: 1,
			decision: { decision: "ALLOW" },
			ruleVersion: "test-video-rule",
			safetyPolicyVersion: object(e!.templateSnapshot).safetyPolicyVersion,
			validUntil: new Date(Date.now() + 3600000).toISOString(),
		}),
	);
	await run(() => recordVideoTemplateReview(jobId, "scene", { status: "ALLOW" }));
	return asset;
}
describe("template admission and durable scene PostgreSQL regressions", () => {
	it.each([
		{ name: "missing effect", snapshot: {} },
		{ name: "null effect", snapshot: { effectId: null } },
		{ name: "unknown effect", snapshot: { effectId: "unapproved-template" } },
		{ name: "non-object snapshot", snapshot: [] },
		{ name: "reversed roles", roles: [{ role: "right" }, { role: "left" }] },
		{ name: "missing role", roles: [{ role: "left" }] },
		{ name: "unknown state", state: "UNAPPROVED" },
		{ name: "provider task without submission", providerTaskId: "unsubmitted-task" },
		{ name: "resolved identity without stored scene", resolvedIdentity: { assetId: "missing" } },
	])("installed template CHECK rejects $name", async (input) => {
		// Copy the installed CHECK into a disposable table to test it independently
		// of the parent-identity trigger without disabling any production guard.
		await expect(
			db.$transaction(async (tx) => {
				await tx.$executeRaw`CREATE TEMP TABLE template_shape_regression
					(LIKE video_template_execution INCLUDING DEFAULTS INCLUDING CONSTRAINTS)
					ON COMMIT DROP`;
				await tx.$executeRaw`INSERT INTO template_shape_regression
					("jobId", "templateSnapshot", "orderedRoleIdentities", "sceneState",
					 "sceneProviderTaskId", "resolvedInputIdentity", "updatedAt")
					VALUES (${randomUUID()},
					 ${JSON.stringify(input.snapshot ?? { effectId: "raindance-solo" })}::jsonb,
					 ${JSON.stringify(input.roles ?? [{ role: "left" }, { role: "right" }])}::jsonb,
					 ${input.state ?? "PENDING"}, ${input.providerTaskId ?? null},
					 ${input.resolvedIdentity ? JSON.stringify(input.resolvedIdentity) : null}::jsonb,
					 NOW())`;
			}),
		).rejects.toThrow(/video_template_shape_check/);
	});
	it.each(["raindance-solo", "raindance-duo"] as const)(
		"persists %s identities with one idempotent reservation and no Outbox",
		async (effectId) => {
			const f = await fixture(100n, effectId);
			const first = await createVideoTemplateJobRecord(f.input, db);
			expect(await createVideoTemplateJobRecord(f.input, db)).toEqual({
				jobId: first.jobId,
				replayed: true,
			});
			const execution = await run(() => getVideoTemplateExecution(first.jobId));
			expect(object(execution!.templateSnapshot).effectId).toBe(effectId);
			const identities = execution!.orderedRoleIdentities as Prisma.JsonArray;
			expect(identities.map((identity) => object(identity).assetId)).toEqual([
				f.base.request.inputs.leftAssetId,
				f.base.request.inputs.rightAssetId,
			]);
			expect(await db.creditReservation.count({ where: { jobId: first.jobId } })).toBe(1);
			expect(await db.outboxEvent.count({ where: { aggregateId: first.jobId } })).toBe(0);
			await storedScene(first.jobId);
		},
	);
	it("20 concurrent retries create one commercial job, reservation, workflow and two capacity rows", async () => {
		const f = await fixture();
		const results = await Promise.all(
			Array.from({ length: 20 }, () => createVideoTemplateJobRecord(f.input, db)),
		);
		expect(new Set(results.map((r) => r.jobId)).size).toBe(1);
		expect(results.filter((r) => !r.replayed)).toHaveLength(1);
		expect(
			await createVideoTemplateJobRecord(
				{
					...f.input,
					template: {
						...f.input.template,
						video: { ...f.input.template.video, prompt: "A new server prompt for new orders" },
					},
					price: { ...f.input.price, credits: 99n },
				},
				db,
			),
		).toEqual({ jobId: results[0]!.jobId, replayed: true });
		expect(
			await db.auditLog.count({ where: { id: `video-effect:${results[0]!.jobId}:accepted` } }),
		).toBe(1);
		const jobId = results[0]!.jobId;
		expect(await db.creditReservation.count({ where: { jobId } })).toBe(1);
		expect(await db.generationJob.count({ where: { quoteId: f.quote.quoteId } })).toBe(1);
		expect(await db.videoExecution.count({ where: { jobId } })).toBe(1);
		const capacity = await db.storageUsageReservation.findMany({
			where: { ownerId: f.ownerId, status: "ACTIVE" },
		});
		expect(capacity).toHaveLength(2);
		expect(capacity.reduce((s, r) => s + r.bytes, 0n)).toBe(124857600n);
		await expect(
			createVideoTemplateJobRecord({ ...f.input, idempotencyKey: randomUUID() }, db),
		).rejects.toThrow("VIDEO_QUOTE_ALREADY_USED");
		expect(
			(
				await findExistingVideoTemplateAdmission(
					{ ownerId: f.ownerId, idempotencyKey: f.input.idempotencyKey, request: f.base.request },
					db,
				)
			)?.id,
		).toBe(jobId);
	});
	it("freezes both ordered identities and rejects role swap, foreign input, insufficient balance and cross-kind replay", async () => {
		const f = await fixture();
		const flipped = {
			...f.base.request,
			inputs: { leftAssetId: f.assets[1]!.id, rightAssetId: f.assets[0]!.id },
		};
		await expect(
			createVideoTemplateJobRecord({ ...f.input, request: flipped }, db),
		).rejects.toThrow();
		const swapped = await createVideoTemplateQuoteRecord(
			{ ...f.base, request: flipped, maximumInputBytes: 10000000 },
			db,
		);
		expect(swapped.requestFingerprint).not.toBe(f.quote.requestFingerprint);
		const sameLeft = {
			...f.base.request,
			inputs: { leftAssetId: f.assets[0]!.id, rightAssetId: f.assets[0]!.id },
		};
		expect(
			(
				await createVideoTemplateQuoteRecord(
					{ ...f.base, request: sameLeft, maximumInputBytes: 10000000 },
					db,
				)
			).requestFingerprint,
		).not.toBe(f.quote.requestFingerprint);
		const foreign = await fixture();
		await expect(
			createVideoTemplateQuoteRecord(
				{
					...f.base,
					request: {
						...f.base.request,
						inputs: { ...f.base.request.inputs, rightAssetId: foreign.assets[1]!.id },
					},
					maximumInputBytes: 10000000,
				},
				db,
			),
		).rejects.toThrow("VIDEO_INPUT_NOT_AVAILABLE");
		const ordinary = {
			productKey: f.base.template.video.productKey,
			mode: "image-to-video" as const,
			prompt: f.base.template.video.prompt,
			duration: 5 as const,
			resolution: "720p" as const,
			aspectRatio: "9:16" as const,
			sound: false as const,
			inputAssetId: f.assets[0]!.id,
		};
		const { template: _, ...plain } = f.input;
		await expect(createVideoJobRecord({ ...plain, request: ordinary }, db)).rejects.toThrow(
			"INVALID_VIDEO_QUOTE_KIND",
		);
		const ordinaryQuote = await createVideoQuoteRecord(
			{ ...f.base, template: undefined, request: ordinary, maximumInputBytes: 10000000 },
			db,
		);
		await expect(
			createVideoTemplateJobRecord({ ...f.input, quoteId: ordinaryQuote.quoteId }, db),
		).rejects.toThrow("VIDEO_TEMPLATE_QUOTE_INPUT_MISMATCH");
		const poor = await fixture(1n);
		await expect(createVideoTemplateJobRecord(poor.input, db)).rejects.toThrow();
		expect(await db.generationJob.count({ where: { ownerId: poor.ownerId } })).toBe(0);
		expect(await db.storageUsageReservation.count({ where: { ownerId: poor.ownerId } })).toBe(0);
	});
	it("keeps full capacity and credits through uncertain first paid scene with zero final attempts", async () => {
		const f = await accepted();
		await reviewInputs(f.jobId);
		const claims = await Promise.all(
			Array.from({ length: 5 }, () =>
				run(() =>
					claimVideoTemplateSceneSubmission({ jobId: f.jobId, callbackTokenHash: randomUUID() }),
				),
			),
		);
		expect(claims.filter((c) => c.claimed)).toHaveLength(1);
		expect(await db.generationAttempt.count({ where: { jobId: f.jobId } })).toBe(0);
		expect(await run(() => failVideoExecution(f.jobId, "TEST_TIMEOUT"))).toBe(false);
		expect(await run(() => failVideoExecution(f.jobId, "TEST_TIMEOUT", false, true))).toBe(false);
		await expect(run(() => failVideoDelivery(f.jobId, "TEST_TIMEOUT"))).rejects.toThrow(
			"VIDEO_UNCERTAIN_RESERVATION_MUST_REMAIN",
		);
		expect((await db.creditReservation.findUnique({ where: { jobId: f.jobId } }))?.status).toBe(
			"ACTIVE",
		);
		expect(
			await db.storageUsageReservation.count({ where: { ownerId: f.ownerId, status: "ACTIVE" } }),
		).toBe(2);
		for (const asset of f.assets) {
			await db.mediaAsset.update({ where: { id: asset.id }, data: { deleteAfter: new Date(0) } });
			expect(await claimVideoResourceCleanup(asset.id, new Date(), db)).toBeNull();
		}
	});
	it("binds early scene callbacks exactly once and rejects role/task confusion", async () => {
		const f = await accepted();
		await reviewInputs(f.jobId);
		const token = randomUUID();
		await run(() =>
			claimVideoTemplateSceneSubmission({ jobId: f.jobId, callbackTokenHash: token }),
		);
		const payload = {
			callbackTokenHash: token,
			taskId: randomUUID(),
			timestamp: "test1",
			receivedAt: new Date(),
		};
		const first = await run(() => persistVideoTemplateSceneWebhook(payload));
		const second = await run(() => persistVideoTemplateSceneWebhook(payload));
		expect(second.eventId).toBe(first.eventId);
		expect(second.replayed).toBe(true);
		await expect(
			run(() => persistVideoTemplateSceneWebhook({ ...payload, taskId: randomUUID() })),
		).rejects.toThrow("VIDEO_TEMPLATE_SCENE_TASK_CONFLICT");
		await expect(
			run(() => persistVideoTemplateSceneWebhook({ ...payload, callbackTokenHash: randomUUID() })),
		).rejects.toThrow("VIDEO_TEMPLATE_CALLBACK_INVALID");
		expect(
			await run(() =>
				claimVideoTemplateSceneSubmission({ jobId: f.jobId, callbackTokenHash: randomUUID() }),
			),
		).toMatchObject({ claimed: false });
	});
	it("seals derived content once without rewriting parent or creating a final OUTPUT/attempt", async () => {
		const f = await accepted();
		const before = (await db.generationJob.findUniqueOrThrow({ where: { id: f.jobId } }))
			.inputSnapshot;
		const asset = await storedScene(f.jobId);
		const one = await run(() => sealVideoTemplateResolvedInput(f.jobId));
		const two = await run(() => sealVideoTemplateResolvedInput(f.jobId));
		expect(two).toEqual(one);
		expect(
			(await db.generationJob.findUniqueOrThrow({ where: { id: f.jobId } })).inputSnapshot,
		).toEqual(before);
		expect(await db.generationAttempt.count({ where: { jobId: f.jobId } })).toBe(0);
		expect(await db.generationJobAsset.count({ where: { jobId: f.jobId, role: "OUTPUT" } })).toBe(
			0,
		);
		await expect(
			db.generationJob.update({
				where: { id: f.jobId },
				data: { inputSnapshot: { changed: true } },
			}),
		).rejects.toThrow(/immutable/);
		await expect(
			db.videoTemplateExecution.update({
				where: { jobId: f.jobId },
				data: { resolvedInputIdentity: { assetId: "different" } },
			}),
		).rejects.toThrow(/immutable/);
		await expect(
			db.videoTemplateExecution.update({
				where: { jobId: f.jobId },
				data: { templateSnapshot: { changed: true } },
			}),
		).rejects.toThrow();
		await expect(
			db.generationJobAsset.create({
				data: { jobId: f.jobId, assetId: asset.id, role: "OUTPUT", assetChecksum: "a".repeat(64) },
			}),
		).rejects.toThrow(/OUTPUT/);
		await expect(
			db.mediaAsset.update({
				where: { id: asset.id },
				data: { status: "VERIFYING", verificationGeneration: 2 },
			}),
		).rejects.toThrow(/immutable/);
	});
	it("retains physical scene capacity after terminal failure until explicit successful cleanup", async () => {
		const f = await accepted();
		const asset = await storedScene(f.jobId);
		await run(() => sealVideoTemplateResolvedInput(f.jobId));
		await db.mediaAsset.update({ where: { id: asset.id }, data: { deleteAfter: new Date(0) } });
		expect(await claimVideoResourceCleanup(asset.id, new Date(), db)).toBeNull();
		const candidates = await listVideoResourceCleanupCandidates(
			{ limit: 100, now: new Date() },
			db,
		);
		expect(candidates.some((a) => a.id === asset.id)).toBe(false);
		await run(() => failVideoDelivery(f.jobId, "TEST_FINAL_FAILED"));
		expect(
			(
				await db.storageUsageReservation.findUnique({
					where: { referenceKey: `video-template-scene:${f.jobId}` },
				})
			)?.status,
		).toBe("ACTIVE");
		const claim = await claimVideoResourceCleanup(asset.id, new Date(), db);
		expect(claim).not.toBeNull();
		expect(claim!.objectKeys).toContain(asset.objectKey);
		expect(claim!.objectKeys).toContain(asset.outputStagingObjectKey);
		expect(
			(
				await db.storageUsageReservation.findUnique({
					where: { referenceKey: `video-template-scene:${f.jobId}` },
				})
			)?.status,
		).toBe("ACTIVE");
		await completeVideoResourceCleanup(claim!, new Date(), db);
		await completeVideoResourceCleanup(claim!, new Date(), db);
		expect(
			(
				await db.storageUsageReservation.findUnique({
					where: { referenceKey: `video-template-scene:${f.jobId}` },
				})
			)?.status,
		).toBe("RELEASED");
	});
	it("reserves scene plus final before accepting and rolls back insufficient storage", async () => {
		const f = await fixture();
		await expect(
			createVideoTemplateJobRecord(
				{ ...f.input, limits: { ...f.input.limits, maximumStorageBytes: 124857599n } },
				db,
			),
		).rejects.toThrow("STORAGE_QUOTA_EXCEEDED");
		expect(await db.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(await db.creditReservation.count({ where: { account: { ownerId: f.ownerId } } })).toBe(
			0,
		);
	});
});

it("honors explicit scene retention after terminal state even when older than orphan age", async () => {
	const f = await accepted();
	const asset = await storedScene(f.jobId);
	await run(() => sealVideoTemplateResolvedInput(f.jobId));
	await run(() => failVideoDelivery(f.jobId, "TEST_TERMINAL"));
	await db.mediaAsset.update({
		where: { id: asset.id },
		data: {
			createdAt: new Date(Date.now() - 172800000),
			deleteAfter: new Date(Date.now() + 28 * 86400000),
		},
	});
	expect(await claimVideoResourceCleanup(asset.id, new Date(), db)).toBeNull();
	expect(
		(await listVideoResourceCleanupCandidates({ limit: 100, now: new Date() }, db)).some(
			(a) => a.id === asset.id,
		),
	).toBe(false);
});
it("expired frozen scene review prevents final paid submit without replacing evidence", async () => {
	const f = await accepted();
	await storedScene(f.jobId);
	await run(() => sealVideoTemplateResolvedInput(f.jobId));
	const frozen = (await run(() => getVideoTemplateExecution(f.jobId)))!.resolvedInputIdentity;
	const now = Date.now();
	const spy = vi.spyOn(Date, "now").mockReturnValue(now + 7200000);
	try {
		await expect(
			run(() =>
				claimVideoProviderSubmission({
					jobId: f.jobId,
					callbackTokenHash: randomUUID(),
					providerModelId: "seedance-test",
					ruleVersion: "test",
				}),
			),
		).rejects.toThrow("VIDEO_TEMPLATE_SCENE_REVIEW_EXPIRED");
	} finally {
		spy.mockRestore();
	}
	expect(await db.generationAttempt.count({ where: { jobId: f.jobId } })).toBe(0);
	expect((await run(() => getVideoTemplateExecution(f.jobId)))!.resolvedInputIdentity).toEqual(
		frozen,
	);
	expect(
		await run(() =>
			failVideoExecution(f.jobId, "VIDEO_PRICE_EXPIRED", false, false, {
				onlyBeforeSubmission: true,
			}),
		),
	).toBe(true);
	expect((await db.creditReservation.findUnique({ where: { jobId: f.jobId } }))?.status).toBe(
		"RELEASED",
	);
	expect(
		(
			await db.storageUsageReservation.findUnique({
				where: { referenceKey: `video-template-scene:${f.jobId}` },
			})
		)?.status,
	).toBe("ACTIVE");
});
it("recovers canonical template upload source cleanup after browser disappeared", async () => {
	const f = await accepted();
	const asset = f.assets[0]!;
	const session = await db.mediaUploadSession.create({
		data: {
			assetId: asset.id,
			tokenHash: randomUUID(),
			status: "COMPLETED",
			expectedBytes: 1000n,
			expiresAt: new Date(Date.now() + 3600000),
			completedAt: new Date(Date.now() - 700000),
		},
	});
	await db.storageUsageReservation.create({
		data: {
			ownerType: "USER",
			ownerId: f.ownerId,
			referenceKey: `media-upload:${session.id}`,
			status: "COMMITTED",
			bytes: 2000n,
			expiresAt: new Date(Date.now() + 3600000),
		},
	});
	const rows = await listVideoStagingCleanup({ limit: 100, now: new Date() }, db);
	const row = rows.find((r) => r.sessionId === session.id);
	expect(row?.sourceKey).toBe(asset.objectKey.slice(0, -".template-input.png".length));
	expect(
		(
			await db.storageUsageReservation.findUnique({
				where: { referenceKey: `media-upload:${session.id}` },
			})
		)?.bytes,
	).toBe(2000n);
	await completeVideoStagingCleanup(
		{ sessionId: session.id, stagingKey: null, sourceKey: row!.sourceKey },
		db,
	);
	expect(
		(
			await db.storageUsageReservation.findUnique({
				where: { referenceKey: `media-upload:${session.id}` },
			})
		)?.bytes,
	).toBe(1000n);
});
it("leases scene writes before transfer so terminal cleanup cannot race an in-flight object", async () => {
	const f = await accepted();
	await reviewInputs(f.jobId);
	await run(() =>
		claimVideoTemplateSceneSubmission({ jobId: f.jobId, callbackTokenHash: randomUUID() }),
	);
	const taskId = randomUUID();
	await run(() => recordVideoTemplateSceneAccepted(f.jobId, taskId));
	await run(() =>
		recordVideoTemplateSceneProviderResult({
			jobId: f.jobId,
			taskId,
			evidence: { status: "SUCCEEDED", outputUrl: "https://fixture.invalid/scene.png" },
		}),
	);
	const asset = await run(() => prepareVideoTemplateSceneAsset(f.jobId));
	expect(asset.outputTransferToken).toBeTruthy();
	expect(asset.objectKey.startsWith(`users/${f.ownerId}/`)).toBe(true);
	await expect(run(() => prepareVideoTemplateSceneAsset(f.jobId))).rejects.toThrow(
		"VIDEO_TEMPLATE_SCENE_TRANSFER_BUSY",
	);
	await run(() => failVideoDelivery(f.jobId, "TEST_TRANSFER_FAILED"));
	await db.mediaAsset.update({ where: { id: asset.id }, data: { deleteAfter: new Date(0) } });
	expect(await claimVideoResourceCleanup(asset.id, new Date(), db)).toBeNull();
	await db.mediaAsset.update({
		where: { id: asset.id },
		data: { outputTransferLeaseExpiresAt: new Date(0) },
	});
	expect(await claimVideoResourceCleanup(asset.id, new Date(), db)).not.toBeNull();
	expect(
		(
			await db.storageUsageReservation.findUnique({
				where: { referenceKey: `video-template-scene:${f.jobId}` },
			})
		)?.status,
	).toBe("ACTIVE");
});

it.each(["left", "right"] as const)(
	"rejects expired %s role at quote and admission before any paid scene",
	async (role) => {
		const f = await fixture();
		const asset = f.assets[role === "left" ? 0 : 1]!;
		await db.mediaAsset.update({ where: { id: asset.id }, data: { deleteAfter: new Date(0) } });
		await expect(
			createVideoTemplateQuoteRecord({ ...f.base, maximumInputBytes: 10000000 }, db),
		).rejects.toThrow("VIDEO_INPUT_NOT_AVAILABLE");
		await expect(createVideoTemplateJobRecord(f.input, db)).rejects.toThrow(
			"VIDEO_INPUT_NOT_AVAILABLE",
		);
		expect(await db.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(await db.storageUsageReservation.count({ where: { ownerId: f.ownerId } })).toBe(0);
	},
);
it.each(["left", "right"] as const)(
	"rejects changed %s role after quote and again at the first paid fence",
	async (role) => {
		const f = await fixture();
		const asset = f.assets[role === "left" ? 0 : 1]!;
		await db.mediaAsset.update({ where: { id: asset.id }, data: { checksum: "c".repeat(64) } });
		await expect(createVideoTemplateJobRecord(f.input, db)).rejects.toThrow(
			"ASSET_CONTENT_CHANGED",
		);
		expect(await db.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		const acceptedJob = await accepted();
		await reviewInputs(acceptedJob.jobId);
		const original = acceptedJob.assets[role === "left" ? 0 : 1]!;
		await db.mediaAsset.update({ where: { id: original.id }, data: { checksum: "d".repeat(64) } });
		await expect(
			run(() =>
				claimVideoTemplateSceneSubmission({
					jobId: acceptedJob.jobId,
					callbackTokenHash: randomUUID(),
				}),
			),
		).rejects.toThrow("VIDEO_INPUT_IDENTITY_CHANGED");
		expect((await run(() => getVideoTemplateExecution(acceptedJob.jobId)))?.submittedAt).toBeNull();
		expect(await db.generationAttempt.count({ where: { jobId: acceptedJob.jobId } })).toBe(0);
	},
);
it.each(["left", "right"] as const)(
	"a %s input moderation rejection blocks the scene fence and releases exactly once",
	async (role) => {
		const f = await accepted();
		await reviewInputs(f.jobId);
		await run(() =>
			recordVideoTemplateImageReview(f.jobId, role, {
				decision: { decision: "REJECT", reasonCode: "TEST_INPUT_REJECT" },
			}),
		);
		await expect(
			run(() =>
				claimVideoTemplateSceneSubmission({ jobId: f.jobId, callbackTokenHash: randomUUID() }),
			),
		).rejects.toThrow("VIDEO_TEMPLATE_INPUT_REVIEW_REQUIRED");
		await run(() => failVideoDelivery(f.jobId, "TEST_INPUT_REJECT", true));
		await run(() => failVideoDelivery(f.jobId, "TEST_INPUT_REJECT", true));
		const reservation = await db.creditReservation.findUniqueOrThrow({ where: { jobId: f.jobId } });
		expect(reservation.status).toBe("RELEASED");
		expect(
			await db.creditLedgerEntry.count({
				where: { reservationId: reservation.id, type: "RELEASE" },
			}),
		).toBe(1);
		expect((await run(() => getVideoTemplateExecution(f.jobId)))?.submittedAt).toBeNull();
		expect(await db.generationAttempt.count({ where: { jobId: f.jobId } })).toBe(0);
	},
);
it("scene moderation rejection cannot seal or submit video and preserves physical capacity until cleanup", async () => {
	const f = await accepted();
	await storedScene(f.jobId);
	await run(() =>
		recordVideoTemplateImageReview(f.jobId, "scene", {
			decision: { decision: "REJECT", reasonCode: "TEST_SCENE_REJECT" },
		}),
	);
	await expect(run(() => sealVideoTemplateResolvedInput(f.jobId))).rejects.toThrow(
		"VIDEO_TEMPLATE_SCENE_REVIEW_REQUIRED",
	);
	await expect(
		run(() =>
			claimVideoProviderSubmission({
				jobId: f.jobId,
				callbackTokenHash: randomUUID(),
				providerModelId: "test-video",
				ruleVersion: "test",
			}),
		),
	).rejects.toThrow("VIDEO_TEMPLATE_SCENE_NOT_READY");
	await run(() => markVideoTemplateSceneFailed(f.jobId, "TEST_SCENE_REJECT"));
	await run(() => failVideoDelivery(f.jobId, "TEST_SCENE_REJECT", true));
	await run(() => failVideoDelivery(f.jobId, "TEST_SCENE_REJECT", true));
	const reservation = await db.creditReservation.findUniqueOrThrow({ where: { jobId: f.jobId } });
	expect(
		await db.creditLedgerEntry.count({ where: { reservationId: reservation.id, type: "RELEASE" } }),
	).toBe(1);
	expect(await db.generationAttempt.count({ where: { jobId: f.jobId } })).toBe(0);
	expect((await run(() => getVideoTemplateExecution(f.jobId)))?.resolvedInputIdentity).toBeNull();
	expect(
		(
			await db.storageUsageReservation.findUnique({
				where: { referenceKey: `video-template-scene:${f.jobId}` },
			})
		)?.status,
	).toBe("ACTIVE");
});
it("a concurrent ordinary image upload cannot steal the accepted template combined capacity", async () => {
	const f = await fixture();
	const id = randomUUID();
	const ceiling = 124857600n;
	const upload = () =>
		createMediaUploadSessionTransaction(
			{
				ownerType: "USER",
				ownerId: f.ownerId,
				assetId: `image-race-${id}`,
				sessionId: id,
				kind: "INPUT",
				objectKey: `users/${f.ownerId}/ordinary/${id}.png`,
				stagingObjectKey: `users/${f.ownerId}/staging/${id}.png`,
				mimeType: "image/png",
				expectedBytes: 1n,
				tokenHash: id,
				multipartUploadId: null,
				expiresAt: new Date(Date.now() + 60000),
				limits: { maximumActiveSessions: 5, maximumReservedBytes: ceiling },
			},
			db,
		);
	const results = await Promise.allSettled([
		createVideoTemplateJobRecord(
			{ ...f.input, limits: { ...f.input.limits, maximumStorageBytes: ceiling } },
			db,
		),
		upload(),
	]);
	expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
	expect(
		(results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.message,
	).toBe("STORAGE_QUOTA_EXCEEDED");
	const bytes = await db.storageUsageReservation.aggregate({
		where: { ownerId: f.ownerId, status: { in: ["ACTIVE", "COMMITTED"] } },
		_sum: { bytes: true },
	});
	expect(bytes._sum.bytes! <= ceiling).toBe(true);
	if (results[0]!.status === "fulfilled") {
		expect(bytes._sum.bytes).toBe(ceiling);
		expect(
			await db.storageUsageReservation.count({ where: { ownerId: f.ownerId, status: "ACTIVE" } }),
		).toBe(2);
	} else {
		expect(await db.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(await db.creditReservation.count({ where: { account: { ownerId: f.ownerId } } })).toBe(
			0,
		);
	}
});
it("manual-review scene and both original roles remain protected after retention expiry", async () => {
	const f = await accepted();
	const scene = await storedScene(f.jobId);
	await run(() => markVideoTemplateNeedsReview(f.jobId, "VIDEO_TEMPLATE_SCENE_REVIEW_UNCERTAIN"));
	await run(() => markVideoTemplateNeedsReview(f.jobId, "VIDEO_TEMPLATE_SCENE_REVIEW_UNCERTAIN"));
	for (const asset of [...f.assets, scene]) {
		await db.mediaAsset.update({ where: { id: asset.id }, data: { deleteAfter: new Date(0) } });
		expect(await claimVideoResourceCleanup(asset.id, new Date(), db)).toBeNull();
	}
	const candidates = await listVideoResourceCleanupCandidates({ limit: 100, now: new Date() }, db);
	expect(candidates.some((row) => row.id === scene.id)).toBe(false);
	expect((await db.creditReservation.findUnique({ where: { jobId: f.jobId } }))?.status).toBe(
		"ACTIVE",
	);
	expect(
		await db.storageUsageReservation.count({ where: { ownerId: f.ownerId, status: "ACTIVE" } }),
	).toBe(2);
	expect(await db.auditLog.count({ where: { id: `video-effect:${f.jobId}:held` } })).toBe(1);
});

it("keeps scene callbacks in bounded live recovery without any final-video attempt", async () => {
	const f = await accepted();
	await reviewInputs(f.jobId);
	const token = randomUUID();
	await run(() => claimVideoTemplateSceneSubmission({ jobId: f.jobId, callbackTokenHash: token }));
	const now = new Date();
	const event = await run(() =>
		persistVideoTemplateSceneWebhook({
			callbackTokenHash: token,
			taskId: randomUUID(),
			timestamp: "pending-scene",
			receivedAt: now,
		}),
	);
	expect(await db.generationAttempt.count({ where: { jobId: f.jobId } })).toBe(0);
	const rows = await run(() => listPendingVideoWebhookEvents(100, now));
	expect(rows).toContainEqual({
		eventId: event.eventId,
		jobId: f.jobId,
		workflowInstanceId: `video-v1-${f.jobId}`,
	});
	expect((await run(() => listPendingVideoWebhookEvents(1, now))).length).toBeLessThanOrEqual(1);
	await run(() => postponeVideoWebhookNotification(event.eventId, now));
	expect(
		(await run(() => listPendingVideoWebhookEvents(100, now))).some(
			(row) => row.eventId === event.eventId,
		),
	).toBe(false);
	expect(
		(await run(() => listPendingVideoWebhookEvents(100, new Date(now.getTime() + 120001)))).some(
			(row) => row.eventId === event.eventId,
		),
	).toBe(true);
	await run(() => markVideoWebhookNotified(event.eventId));
	expect(
		(await run(() => listPendingVideoWebhookEvents(100, new Date(now.getTime() + 120001)))).some(
			(row) => row.eventId === event.eventId,
		),
	).toBe(false);
	expect(
		(await db.providerWebhookEvent.findUniqueOrThrow({ where: { id: event.eventId } })).status,
	).toBe("RECEIVED");
});
it("preserves manual and unconfirmed terminal scene inbox evidence without blocking live recovery", async () => {
	for (const stage of ["NEEDS_REVIEW", "FAILED"] as const) {
		const f = await accepted();
		await reviewInputs(f.jobId);
		const token = randomUUID();
		await run(() =>
			claimVideoTemplateSceneSubmission({ jobId: f.jobId, callbackTokenHash: token }),
		);
		const event = await run(() =>
			persistVideoTemplateSceneWebhook({
				callbackTokenHash: token,
				taskId: randomUUID(),
				timestamp: stage,
				receivedAt: new Date(),
			}),
		);
		await db.videoExecution.update({ where: { jobId: f.jobId }, data: { stage } });
		const before = await db.providerWebhookEvent.findUniqueOrThrow({
			where: { id: event.eventId },
		});
		expect(
			(await run(() => listPendingVideoWebhookEvents(100))).some(
				(row) => row.eventId === event.eventId,
			),
		).toBe(false);
		expect(
			await db.providerWebhookEvent.findUniqueOrThrow({ where: { id: event.eventId } }),
		).toEqual(before);
	}
});
it("scene recovery rejects mismatched provider task job workflow and unverified envelopes", async () => {
	const f = await accepted();
	await reviewInputs(f.jobId);
	const token = randomUUID();
	const taskId = randomUUID();
	await run(() => claimVideoTemplateSceneSubmission({ jobId: f.jobId, callbackTokenHash: token }));
	const original = await run(() =>
		persistVideoTemplateSceneWebhook({
			callbackTokenHash: token,
			taskId,
			timestamp: "identity",
			receivedAt: new Date(),
		}),
	);
	await run(() => markVideoWebhookNotified(original.eventId));
	await expect(
		db.$executeRaw`UPDATE "provider_webhook_event" SET "verifiedAt"=NULL WHERE "id"=${original.eventId}`,
	).rejects.toThrow(/null/i);
	const variants = [
		{ provider: "kie-video-v1" },
		{ providerTaskId: "foreign-task" },
		{ envelope: { jobId: "foreign-job" } },
		{ envelope: { taskId: "foreign-task" } },
		{ envelope: { workflowInstanceId: "video-v1-foreign" } },
	];
	const ids: string[] = [];
	try {
		for (const variant of variants) {
			const row = await db.providerWebhookEvent.create({
				data: {
					provider: "kie-video-template-scene",
					providerEventId: randomUUID(),
					providerTaskId: taskId,
					verifiedAt: new Date(),
					...variant,
					envelope: {
						jobId: f.jobId,
						taskId,
						workflowInstanceId: `video-v1-${f.jobId}`,
						notifiedAt: null,
						...variant.envelope,
					},
				},
			});
			ids.push(row.id);
		}
		const pending = await run(() => listPendingVideoWebhookEvents(100));
		for (const id of ids) {
			expect(pending.some((row) => row.eventId === id)).toBe(false);
			expect((await db.providerWebhookEvent.findUniqueOrThrow({ where: { id } })).status).toBe(
				"RECEIVED",
			);
		}
	} finally {
		// Deliberately invalid inbox rows must not leak into the later full-database audit.
		await db.providerWebhookEvent.deleteMany({ where: { id: { in: ids } } });
	}
});
