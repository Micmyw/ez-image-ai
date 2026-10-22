import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("../../client", () => ({
	getDatabaseClient: () => {
		throw new Error("explicit transaction required");
	},
}));

import { completePersistedImageFinalizationInTransaction } from "./persisted-image-finalization";

function fixture(outputCount = 1) {
	const now = new Date("2026-10-22T12:00:00Z");
	const validUntil = new Date("2036-10-22T12:00:00Z");
	const checksum = "a".repeat(64);
	const input: Parameters<typeof completePersistedImageFinalizationInTransaction>[0] = {
		job: {
			id: "job",
			version: 3,
			productKey: "image-nano-banana-2-lite",
			status: "FINALIZING",
			executionEngine: "legacy",
			ownerType: "USER",
			ownerId: "owner",
			serviceClass: "STANDARD",
			guestTrialId: null,
			fundingSource: "CREDITS",
			failureCode: null,
		},
		verification: { provider: "seeapi", ruleVersion: "rule", policyVersion: "policy", now },
	};
	const attempt = { attemptId: "attempt", uncertainSubmission: false, outputCount };
	const bindings = Array.from({ length: outputCount }, (_, position) => {
		const assetId = `asset_${createHash("sha256").update(`job:attempt:${position}`).digest("base64url").slice(0, 32)}`;
		return {
			id: `binding-${position}`,
			assetId,
			assetChecksum: checksum,
			position,
			asset: {
				id: assetId,
				ownerType: "USER",
				ownerId: "owner",
				kind: "OUTPUT",
				status: "READY",
				retentionClass: "ACCOUNT",
				deleteAfter: null,
				deletedAt: null,
				objectKey: `users/owner/assets/${assetId}/original.png`,
				mimeType: "image/png",
				byteSize: 512n,
				checksum,
				finalizedAt: now,
				outputTransferToken: null,
				outputTransferLeaseExpiresAt: null,
				outputStagingObjectKey: null,
				outputPromotionMultipartUploadId: null,
				sourceUrl: `provider-output:attempt:${position}`,
				verificationEngine: "legacy",
				verificationGeneration: 1,
				verificationAttemptCount: 1,
				verificationProvider: "seeapi",
				verificationRuleVersion: "rule",
				verificationPolicyVersion: "policy",
				verificationProviderTaskId: `review-${position}`,
				verificationLeaseToken: null,
				verificationLeasedUntil: null,
				verificationSubmissionUncertain: false,
				verificationValidUntil: validUntil,
				moderationResults: [
					{
						assetChecksum: checksum,
						verificationGeneration: 1,
						attemptNumber: 1,
						evidenceKind: "OUTPUT",
						provider: "seeapi",
						providerTaskId: `review-${position}`,
						ruleVersion: "rule",
						policyVersion: "policy",
						status: "APPROVED",
						reasonCode: "SAFE",
						validUntil,
					},
				],
			},
		};
	});
	const tx = {
		$queryRaw: vi.fn(async () => [attempt]),
		generationJobAsset: {
			findMany: vi.fn(async () => bindings),
			updateMany: vi.fn(async () => ({ count: 1 })),
		},
		generationJob: { updateMany: vi.fn(async () => ({ count: 1 })) },
		outboxEvent: {
			upsert: vi.fn(async () => ({ id: "settle", status: "PENDING", availableAt: now })),
		},
	};
	return {
		input,
		attempt,
		bindings,
		tx,
		run: () => completePersistedImageFinalizationInTransaction(input, tx as never),
	};
}

describe("persisted image finalization", () => {
	it("collects the actual committed settlement identity and schedule while preserving its boolean contract", async () => {
		const state = fixture();
		state.input.settlementEvents = [];
		expect(await state.run()).toBe(true);
		expect(state.input.settlementEvents).toEqual([
			{ id: "settle", availableAt: state.input.verification.now },
		]);
	});

	it("queues settlement for the exact fully persisted and approved set without reading bodies", async () => {
		const state = fixture(2);
		state.bindings[1]!.position = 0;
		expect(await state.run()).toBe(true);
		expect(state.tx.generationJobAsset.updateMany).toHaveBeenCalledOnce();
		expect(state.tx.generationJobAsset.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "binding-1" }),
				data: { position: 1 },
			}),
		);
		expect(state.tx.generationJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					version: 3,
					executionEngine: "legacy",
					status: "FINALIZING",
				}),
				data: { finalizationStage: null, finalizationErrorCode: null, nextFinalizeAt: null },
			}),
		);
		expect(state.tx.outboxEvent.upsert).toHaveBeenCalledWith({
			where: { dedupeKey: "generation-settle:job" },
			create: {
				eventType: "GENERATION_SETTLE",
				aggregateType: "GENERATION_JOB",
				aggregateId: "job",
				dedupeKey: "generation-settle:job",
				payload: { jobId: "job", version: 3 },
			},
			update: {},
		});
		const query = state.tx.$queryRaw.mock.calls[0]! as unknown as [TemplateStringsArray];
		expect(query[0].join("?")).toContain("LEFT JOIN");
		expect(query[0].join("?")).toContain("jsonb_array_length");
		const projection = state.tx.generationJobAsset.findMany.mock.calls[0] as unknown as [
			Record<string, unknown>,
		];
		expect(JSON.stringify(projection)).not.toMatch(/rawEnvelope|responseSnapshot|transferEnvelope/);
	});
	it.each([
		["missing output", (state: ReturnType<typeof fixture>) => state.bindings.pop()],
		[
			"extra output",
			(state: ReturnType<typeof fixture>) => state.bindings.push(state.bindings[0]!),
		],
		[
			"pending sibling",
			(state: ReturnType<typeof fixture>) => {
				state.bindings[1]!.asset.status = "VERIFYING";
			},
		],
		[
			"wrong source",
			(state: ReturnType<typeof fixture>) => {
				state.bindings[0]!.asset.sourceUrl = "provider-output:old:0";
			},
		],
		[
			"wrong asset",
			(state: ReturnType<typeof fixture>) => {
				state.bindings[0]!.asset.id = "other";
			},
		],
		[
			"wrong owner",
			(state: ReturnType<typeof fixture>) => {
				state.bindings[0]!.asset.ownerId = "other";
			},
		],
		[
			"wrong engine",
			(state: ReturnType<typeof fixture>) => {
				state.bindings[0]!.asset.verificationEngine = "video-workflow-v1";
			},
		],
		[
			"binding checksum drift",
			(state: ReturnType<typeof fixture>) => {
				state.bindings[0]!.assetChecksum = "b".repeat(64);
			},
		],
		[
			"wrong private key",
			(state: ReturnType<typeof fixture>) => {
				state.bindings[0]!.asset.objectKey = "other/image.png";
			},
		],
		[
			"unsupported MIME",
			(state: ReturnType<typeof fixture>) => {
				state.bindings[0]!.asset.mimeType = "video/mp4";
			},
		],
		[
			"empty output",
			(state: ReturnType<typeof fixture>) => {
				state.bindings[0]!.asset.byteSize = 0n;
			},
		],
		[
			"uncertain review",
			(state: ReturnType<typeof fixture>) => {
				state.bindings[0]!.asset.verificationSubmissionUncertain = true;
			},
		],
		[
			"stale evidence generation",
			(state: ReturnType<typeof fixture>) => {
				state.bindings[0]!.asset.moderationResults[0]!.verificationGeneration = 0;
			},
		],
		[
			"stale review task",
			(state: ReturnType<typeof fixture>) => {
				state.bindings[0]!.asset.moderationResults[0]!.providerTaskId = "other-review";
			},
		],
		[
			"stale evidence checksum",
			(state: ReturnType<typeof fixture>) => {
				state.bindings[0]!.asset.moderationResults[0]!.assetChecksum = "b".repeat(64);
			},
		],
		[
			"unapproved evidence",
			(state: ReturnType<typeof fixture>) => {
				state.bindings[0]!.asset.moderationResults[0]!.status = "REVIEW";
			},
		],
		[
			"missing evidence",
			(state: ReturnType<typeof fixture>) => {
				state.bindings[0]!.asset.moderationResults = [];
			},
		],
		[
			"expired evidence",
			(state: ReturnType<typeof fixture>) => {
				state.bindings[0]!.asset.verificationValidUntil = new Date(0);
			},
		],
	] as const)("keeps the full finalizer for %s without writes", async (_name, mutate) => {
		const state = fixture(2);
		mutate(state);
		expect(await state.run()).toBe(false);
		expect(state.tx.generationJobAsset.updateMany).not.toHaveBeenCalled();
		expect(state.tx.generationJob.updateMany).not.toHaveBeenCalled();
		expect(state.tx.outboxEvent.upsert).not.toHaveBeenCalled();
	});
	it.each([
		["outputTransferToken", "active"],
		["outputTransferLeaseExpiresAt", new Date()],
		["outputStagingObjectKey", "staged"],
		["outputPromotionMultipartUploadId", "multipart"],
		["verificationLeaseToken", "review-lease"],
		["verificationLeasedUntil", new Date()],
		["deletedAt", new Date()],
		["deleteAfter", new Date()],
		["finalizedAt", null],
	] as const)("refuses nonterminal or expired storage field %s", async (field, value) => {
		const state = fixture();
		Object.assign(state.bindings[0]!.asset, { [field]: value });
		expect(await state.run()).toBe(false);
		expect(state.tx.outboxEvent.upsert).not.toHaveBeenCalled();
	});
	it.each([null, 0, 5, 1.5])(
		"rejects unknown or invalid envelope cardinality %s",
		async (outputCount) => {
			const state = fixture();
			Object.assign(state.attempt, { outputCount });
			expect(await state.run()).toBe(false);
			expect(state.tx.generationJobAsset.findMany).not.toHaveBeenCalled();
			expect(state.tx.outboxEvent.upsert).not.toHaveBeenCalled();
		},
	);
	it("does not replace guest watermark/retention or image-pass cardinality validation", async () => {
		const guest = fixture();
		guest.input.job.serviceClass = "GUEST_SLOW";
		expect(await guest.run()).toBe(false);
		expect(guest.tx.$queryRaw).not.toHaveBeenCalled();
		const pass = fixture(2);
		pass.input.job.fundingSource = "IMAGE_PASS";
		expect(await pass.run()).toBe(false);
		expect(pass.tx.outboxEvent.upsert).not.toHaveBeenCalled();
		const singlePass = fixture();
		singlePass.input.job.fundingSource = "IMAGE_PASS";
		expect(await singlePass.run()).toBe(true);
	});
	it("cannot queue settlement after the job version or binding changed", async () => {
		const staleJob = fixture();
		staleJob.tx.generationJob.updateMany.mockResolvedValue({ count: 0 });
		expect(await staleJob.run()).toBe(false);
		expect(staleJob.tx.outboxEvent.upsert).not.toHaveBeenCalled();
		const staleBinding = fixture(2);
		staleBinding.bindings[1]!.position = 0;
		staleBinding.tx.generationJobAsset.updateMany.mockResolvedValue({ count: 0 });
		expect(await staleBinding.run()).toBe(false);
		expect(staleBinding.tx.outboxEvent.upsert).not.toHaveBeenCalled();
	});
});
