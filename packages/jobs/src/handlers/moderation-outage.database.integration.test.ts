import { PrismaPg } from "@prisma/adapter-pg";
import {
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
	TestMediaSafetyAdapter,
} from "@repo/ai";
import { MODERATION_BYPASS_REASON } from "@repo/config";
import {
	applyAdminModerationReview,
	completeAdminTextRecheck,
	createCreditGrant,
	createGenerationJobTransaction,
	createModeratedGenerationQuoteTransaction,
	fingerprintGenerationQuoteSecurityPayload,
	getOwnedMediaAssetReadState,
	recordModerationOutcome,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDatabaseVerifyUploadDependencies, createDatabaseSettlementStore } from "../runtime";
import { settleGeneration } from "./settle-generation";

let client: PrismaClient;
const contract = {
	provider: "test",
	ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
	policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
};
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
beforeAll(() => {
	const url = new URL(process.env.TEST_DATABASE_URL!);
	if (
		url.hostname !== "127.0.0.1" ||
		url.port !== "55432" ||
		!(
			url.pathname === "/ai_media_foundation_test" || /^\/ezpic_[a-z0-9_]+_test$/.test(url.pathname)
		)
	)
		throw new Error("Unsafe test database");
	client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
});
afterAll(() => client?.$disconnect());

async function asset(kind: "INPUT" | "OUTPUT" = "INPUT") {
	const id = crypto.randomUUID();
	return client.mediaAsset.create({
		data: {
			ownerType: "USER",
			ownerId: `outage-${id}`,
			kind,
			status: "VERIFYING",
			objectKey: `tests/${id}.png`,
			mimeType: "image/png",
			byteSize: 16n,
			checksum: "a".repeat(64),
			finalizedAt: new Date(),
		},
	});
}
function verifier(
	decision: "ALLOW" | "ERROR" | "REJECT" | "REVIEW" = "ERROR",
	provider = `test-${crypto.randomUUID()}`,
) {
	const safety = new TestMediaSafetyAdapter(decision);
	const scan = vi.spyOn(safety, "moderateImage").mockResolvedValue({
		decision,
		reasonCode:
			decision === "ERROR"
				? "MODERATION_UNAVAILABLE"
				: decision === "REJECT"
					? "SEEAPI_CONTENT_NOT_ALLOWED"
					: "NO_POLICY_MATCH",
		ruleVersion: contract.ruleVersion,
	});
	const options = {
		safety,
		moderationProvider: provider,
		headObject: async () => ({
			contentLength: 16,
			contentType: "image/png",
			etag: "etag",
			metadata: {},
		}),
		readMediaHeader: async () => PNG,
		createSignedReadUrl: async () => "https://private.example/signed.png",
	};
	return {
		scan,
		safety,
		options,
		verify: createDatabaseVerifyUploadDependencies(client, options).verify,
		provider,
	};
}
async function exhaust(id: string, verify: (id: string) => Promise<void>) {
	for (let attempt = 0; attempt < 4; attempt++) {
		await client.mediaAsset.update({ where: { id }, data: { verificationNextAttemptAt: null } });
		await verify(id);
	}
}
async function reviewFor(targetId: string) {
	return client.moderationReview.findUniqueOrThrow({
		where: { targetType_targetId: { targetType: "ASSET", targetId } },
	});
}
function action(
	review: { id: string; version: number },
	selected: "APPROVE" | "REJECT" | "RECHECK",
	provider: string,
) {
	return {
		reviewId: review.id,
		version: review.version,
		action: selected,
		reason: "Reviewed the original content and detector history",
		idempotencyKey: crypto.randomUUID(),
		actorUserId: "admin-outage-test",
		verification: { ...contract, provider },
	};
}

describe("durable moderation outage handling", () => {
	it("does not treat a failed file inspection as detector recovery", async () => {
		const media = await asset();
		const worker = verifier();
		await exhaust(media.id, worker.verify);
		const review = await reviewFor(media.id);
		const broken = createDatabaseVerifyUploadDependencies(client, {
			...worker.options,
			readMediaHeader: async () => Buffer.from("not an image"),
		});
		await broken.verify((await asset()).id);
		expect(
			(await client.moderationIncident.findUniqueOrThrow({ where: { id: review.incidentId! } }))
				.status,
		).toBe("OPEN");
	});
	it("keeps a recheck requiring human review blocked and actionable while recording service recovery", async () => {
		const media = await asset();
		const worker = verifier();
		await exhaust(media.id, worker.verify);
		const original = await reviewFor(media.id);
		await applyAdminModerationReview(action(original, "RECHECK", worker.provider), client);
		worker.scan.mockResolvedValue({
			decision: "REVIEW",
			reasonCode: "SEEAPI_CONTENT_REVIEW",
			ruleVersion: contract.ruleVersion,
		});
		await worker.verify(media.id);
		const review = await reviewFor(media.id);
		expect(review).toMatchObject({ status: "BLOCKED", bypassed: true });
		expect(
			(await client.moderationIncident.findUniqueOrThrow({ where: { id: original.incidentId! } }))
				.status,
		).toBe("RECOVERED");
		await applyAdminModerationReview(action(review, "REJECT", worker.provider), client);
		expect((await reviewFor(media.id)).status).toBe("REJECTED");
	});
	it.each(["REJECT", "REVIEW"] as const)(
		"fences outputs when a prompt recheck returns %s",
		async (decision) => {
			const media = await asset("OUTPUT");
			const worker = verifier();
			const account = await client.creditAccount.create({
				data: { ownerType: "USER", ownerId: media.ownerId },
			});
			await createCreditGrant(
				{ accountId: account.id, amount: 20n, referenceKey: `prompt-fence:${media.id}` },
				client,
			);
			const base = {
				ownerType: "USER" as const,
				ownerId: media.ownerId,
				submittedByUserId: media.ownerId,
				productKey: "image-fast",
				catalogVersion: "v1",
				pricingVersion: "v1",
				credits: 4n,
				inputSnapshot: { prompt: "Review this original instruction" },
				expiresAt: new Date(Date.now() + 300_000),
			};
			const now = new Date().toISOString();
			const quote = await createModeratedGenerationQuoteTransaction(
				{
					...base,
					moderation: {
						decision: "BYPASS",
						provider: worker.provider,
						ruleVersion: "v1",
						reasonCode: MODERATION_BYPASS_REASON,
						inputFingerprint: fingerprintGenerationQuoteSecurityPayload(base),
						retry: {
							failures: 4,
							lastErrorCode: "MODERATION_TIMEOUT",
							startedAt: now,
							lastFailureAt: now,
						},
					},
				},
				client,
			);
			const created = await createGenerationJobTransaction(
				{
					ownerType: "USER",
					ownerId: media.ownerId,
					submittedByUserId: media.ownerId,
					quoteId: quote.id,
					idempotencyKey: `prompt-fence:${media.id}`,
					inputAssetIds: [],
					expectedModerationRuleVersion: "v1",
				},
				client,
			);
			await client.generationJobAsset.create({
				data: {
					jobId: created.job.id,
					assetId: media.id,
					role: "OUTPUT",
					position: 0,
					assetChecksum: media.checksum!,
				},
			});
			if (decision === "REVIEW") {
				worker.scan.mockResolvedValue({
					decision: "ALLOW",
					reasonCode: "NO_POLICY_MATCH",
					ruleVersion: contract.ruleVersion,
				});
				await worker.verify(media.id);
			} else {
				await exhaust(media.id, worker.verify);
			}
			const promptReview = await client.moderationReview.findUniqueOrThrow({
				where: { targetType_targetId: { targetType: "QUOTE", targetId: quote.id } },
			});
			await applyAdminModerationReview(action(promptReview, "RECHECK", worker.provider), client);
			const checkedAt = new Date().toISOString();
			await completeAdminTextRecheck(
				{
					reviewId: promptReview.id,
					version: promptReview.version + 1,
					moderation: {
						decision,
						provider: worker.provider,
						ruleVersion: "v1",
						retry: {
							failures: 0,
							lastErrorCode: "",
							startedAt: checkedAt,
							lastFailureAt: checkedAt,
						},
					},
				},
				client,
			);
			await expect(
				applyAdminModerationReview(
					action(await reviewFor(media.id), "APPROVE", worker.provider),
					client,
				),
			).rejects.toThrow("MODERATION_PROMPT_REJECTED");
			await worker.verify(media.id);
			expect((await client.mediaAsset.findUniqueOrThrow({ where: { id: media.id } })).status).toBe(
				"QUARANTINED",
			);
			expect(
				await client.assetModerationResult.findFirst({
					where: { assetId: media.id },
					orderBy: { attemptNumber: "desc" },
				}),
			).toMatchObject({ status: "REJECTED", reasonCode: "ADMIN_CONTENT_REJECTED" });
			if (decision === "REVIEW") {
				const pendingPrompt = await client.moderationReview.findUniqueOrThrow({
					where: { id: promptReview.id },
				});
				expect(pendingPrompt.status).toBe("BLOCKED");
				expect(await reviewFor(media.id)).toMatchObject({
					status: "BLOCKED",
					lastErrorCode: "CONTENT_REVIEW_REQUIRED",
				});
				await applyAdminModerationReview(action(pendingPrompt, "APPROVE", worker.provider), client);
				// Prompt approval alone cannot silently restore its quarantined image.
				expect(
					(await client.mediaAsset.findUniqueOrThrow({ where: { id: media.id } })).status,
				).toBe("QUARANTINED");
				await applyAdminModerationReview(
					action(await reviewFor(media.id), "APPROVE", worker.provider),
					client,
				);
				expect(
					(await client.mediaAsset.findUniqueOrThrow({ where: { id: media.id } })).status,
				).toBe("READY");
			}
		},
	);
	it("allows an inspected image only after the fourth technical failure, with a review and one alert", async () => {
		const media = await asset();
		const worker = verifier();
		await exhaust(media.id, worker.verify);
		expect(worker.scan).toHaveBeenCalledTimes(4);
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: media.id } }),
		).resolves.toMatchObject({
			status: "READY",
			verificationLastErrorCode: MODERATION_BYPASS_REASON,
		});
		const review = await reviewFor(media.id);
		expect(review).toMatchObject({ status: "PENDING_REVIEW", bypassed: true, failureCount: 4 });
		expect(
			await client.assetModerationResult.count({
				where: { assetId: media.id, status: "APPROVED" },
			}),
		).toBe(0);
		expect(
			await client.assetModerationResult.count({
				where: { assetId: media.id, status: "BYPASSED" },
			}),
		).toBe(1);
		await worker.verify(media.id);
		expect(worker.scan).toHaveBeenCalledTimes(4);
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: review.incidentId!, eventType: "MODERATION_INCIDENT_ALERT" },
			}),
		).toBe(1);
		await expect(
			getOwnedMediaAssetReadState(
				{
					assetId: media.id,
					ownerId: media.ownerId,
					verification: { ...contract, provider: worker.provider, now: new Date() },
				},
				client,
			),
		).resolves.toMatchObject({ readable: true });
		await expect(
			getOwnedMediaAssetReadState(
				{
					assetId: media.id,
					ownerId: "another-owner",
					verification: { ...contract, provider: worker.provider, now: new Date() },
				},
				client,
			),
		).resolves.toBeNull();
	});
	it("aggregates simultaneous affected images and recovers without silently approving the backlog", async () => {
		const [one, two] = await Promise.all([asset(), asset()]);
		const worker = verifier();
		await Promise.all([exhaust(one.id, worker.verify), exhaust(two.id, worker.verify)]);
		const first = await reviewFor(one.id);
		const second = await reviewFor(two.id);
		expect(first.incidentId).toBe(second.incidentId);
		const incident = await client.moderationIncident.findUniqueOrThrow({
			where: { id: first.incidentId! },
			include: { targets: true },
		});
		expect(incident.failureCount).toBe(8);
		expect(incident.targets).toHaveLength(2);
		await client.$transaction((tx) =>
			recordModerationOutcome(
				{
					targetType: "ASSET",
					targetId: "later-success",
					provider: worker.provider,
					stage: "IMAGE",
					epoch: "1",
					failures: 0,
					lastErrorCode: "",
					startedAt: new Date(Date.now() + 1),
					lastFailureAt: new Date(),
					status: "APPROVED",
				},
				tx,
			),
		);
		await expect(
			client.moderationIncident.findUniqueOrThrow({ where: { id: incident.id } }),
		).resolves.toMatchObject({ status: "RECOVERED", activeKey: null });
		expect((await reviewFor(one.id)).status).toBe("PENDING_REVIEW");
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: incident.id, eventType: "MODERATION_INCIDENT_ALERT" },
			}),
		).toBe(2);
	});
	it.each(["REJECT", "REVIEW"] as const)("keeps a %s verdict blocked", async (decision) => {
		const media = await asset();
		const worker = verifier(decision);
		await worker.verify(media.id);
		expect((await client.mediaAsset.findUniqueOrThrow({ where: { id: media.id } })).status).toBe(
			"QUARANTINED",
		);
		expect(
			await client.moderationReview.count({ where: { targetId: media.id, bypassed: true } }),
		).toBe(0);
	});
	it("does not bypass broken storage or incorrect image bytes", async () => {
		const media = await asset();
		const worker = verifier();
		const verify = createDatabaseVerifyUploadDependencies(client, {
			...worker.options,
			readMediaHeader: async () => Buffer.from("not an image"),
		}).verify;
		await exhaust(media.id, verify);
		expect(worker.scan).not.toHaveBeenCalled();
		expect((await client.mediaAsset.findUniqueOrThrow({ where: { id: media.id } })).status).toBe(
			"QUARANTINED",
		);
	});
	it("does not resubmit an uncertain SeeAPI inference while retrying recovery", async () => {
		const media = await asset();
		const worker = verifier();
		const submit = vi.fn(async () => {
			throw new Error("MODERATION_TIMEOUT");
		});
		const retrieve = vi.fn();
		const verify = createDatabaseVerifyUploadDependencies(client, {
			...worker.options,
			safety: {
				moderateText: worker.safety.moderateText.bind(worker.safety),
				moderateImage: worker.scan,
				submitVideo: worker.safety.submitVideo.bind(worker.safety),
				retrieveVideo: worker.safety.retrieveVideo.bind(worker.safety),
				submitImage: submit,
				retrieveImage: retrieve,
			},
		}).verify;
		await exhaust(media.id, verify);
		expect(submit).toHaveBeenCalledOnce();
		expect(retrieve).not.toHaveBeenCalled();
		const review = await reviewFor(media.id);
		expect(review.status).toBe("PENDING_REVIEW");
		await expect(
			applyAdminModerationReview(action(review, "RECHECK", worker.provider), client),
		).rejects.toThrow("MODERATION_UNCERTAIN_REQUIRES_MANUAL_REVIEW");
	});
	it("makes manual rejection idempotent, revokes access, and rejects conflicting replay", async () => {
		const media = await asset();
		const worker = verifier();
		await exhaust(media.id, worker.verify);
		const input = action(await reviewFor(media.id), "REJECT", worker.provider);
		await applyAdminModerationReview(input, client);
		expect((await applyAdminModerationReview(input, client)).replayed).toBe(true);
		await expect(
			applyAdminModerationReview({ ...input, action: "APPROVE" }, client),
		).rejects.toThrow("IDEMPOTENCY_CONFLICT");
		await worker.verify(media.id);
		await expect(
			getOwnedMediaAssetReadState(
				{
					assetId: media.id,
					ownerId: media.ownerId,
					verification: { ...contract, provider: worker.provider, now: new Date() },
				},
				client,
			),
		).resolves.toMatchObject({ readable: false });
	});
	it("rechecks the original output and preserves already settled credits", async () => {
		const media = await asset("OUTPUT");
		const worker = verifier("ERROR", "test");
		const account = await client.creditAccount.create({
			data: { ownerType: "USER", ownerId: media.ownerId },
		});
		await createCreditGrant(
			{ accountId: account.id, amount: 20n, referenceKey: `outage-grant:${media.id}` },
			client,
		);
		const base = {
			ownerType: "USER" as const,
			ownerId: media.ownerId,
			submittedByUserId: media.ownerId,
			productKey: "image-fast",
			catalogVersion: "v1",
			pricingVersion: "v1",
			credits: 4n,
			inputSnapshot: { prompt: "A mountain" },
			pricingSnapshot: {},
			expiresAt: new Date(Date.now() + 300_000),
		};
		const quote = await createModeratedGenerationQuoteTransaction(
			{
				...base,
				moderation: {
					decision: "ALLOW",
					provider: "test",
					ruleVersion: "v1",
					reasonCode: "NO_POLICY_MATCH",
					inputFingerprint: fingerprintGenerationQuoteSecurityPayload(base),
				},
			},
			client,
		);
		const created = await createGenerationJobTransaction(
			{
				ownerType: "USER",
				ownerId: media.ownerId,
				submittedByUserId: media.ownerId,
				quoteId: quote.id,
				idempotencyKey: `outage-job:${media.id}`,
				inputAssetIds: [],
				expectedModerationRuleVersion: "v1",
			},
			client,
		);
		await client.generationJob.update({
			where: { id: created.job.id },
			data: { status: "FINALIZING" },
		});
		await client.generationJobAsset.create({
			data: {
				jobId: created.job.id,
				assetId: media.id,
				role: "OUTPUT",
				position: 0,
				assetChecksum: media.checksum!,
			},
		});
		await exhaust(media.id, worker.verify);
		const payload = { jobId: created.job.id, version: 0 };
		await settleGeneration(payload, { store: createDatabaseSettlementStore(client) });
		const before = await client.creditLedgerEntry.findMany({
			where: { accountId: account.id },
			orderBy: { id: "asc" },
		});
		expect(
			(await client.generationJob.findUniqueOrThrow({ where: { id: created.job.id } })).status,
		).toBe("SUCCEEDED");
		const review = await reviewFor(media.id);
		await applyAdminModerationReview(action(review, "RECHECK", worker.provider), client);
		worker.scan.mockResolvedValue({
			decision: "REJECT",
			reasonCode: "SEEAPI_CONTENT_NOT_ALLOWED",
			ruleVersion: contract.ruleVersion,
		});
		await worker.verify(media.id);
		expect((await reviewFor(media.id)).status).toBe("REJECTED");
		expect((await client.mediaAsset.findUniqueOrThrow({ where: { id: media.id } })).status).toBe(
			"QUARANTINED",
		);
		await settleGeneration(payload, { store: createDatabaseSettlementStore(client) });
		expect(
			await client.creditLedgerEntry.findMany({
				where: { accountId: account.id },
				orderBy: { id: "asc" },
			}),
		).toEqual(before);
		expect(await client.generationJob.count({ where: { ownerId: media.ownerId } })).toBe(1);
		expect(
			(await client.creditAccount.findUniqueOrThrow({ where: { id: account.id } }))
				.outputModerationGraceJobId,
		).toBeNull();
	});
	it("keeps the historical permission and recheck queue visible during another transient failure", async () => {
		const media = await asset();
		const worker = verifier();
		await exhaust(media.id, worker.verify);
		await applyAdminModerationReview(
			action(await reviewFor(media.id), "RECHECK", worker.provider),
			client,
		);
		await worker.verify(media.id);
		expect(await reviewFor(media.id)).toMatchObject({
			status: "RECHECKING",
			bypassed: true,
			failureCount: 5,
		});
	});
	it("recovers the service through a real successful verification without approving older pending content", async () => {
		const media = await asset();
		const worker = verifier();
		await exhaust(media.id, worker.verify);
		const original = await reviewFor(media.id);
		worker.scan.mockResolvedValue({
			decision: "ALLOW",
			reasonCode: "NO_POLICY_MATCH",
			ruleVersion: contract.ruleVersion,
		});
		await worker.verify((await asset()).id);
		expect((await reviewFor(media.id)).status).toBe("PENDING_REVIEW");
		expect(
			await client.moderationIncident.findUniqueOrThrow({ where: { id: original.incidentId! } }),
		).toMatchObject({ status: "RECOVERED" });
	});
	it("finishes an image still processing at its deadline without submitting it again", async () => {
		const media = await asset();
		const worker = verifier();
		const submit = vi.fn(async (input: { idempotencyKey: string; ruleVersion: string }) => ({
			moderationTaskId: "detector-task",
			status: "RUNNING" as const,
			ruleVersion: input.ruleVersion,
			idempotency: { key: input.idempotencyKey, providerSupported: true, replayed: false },
		}));
		const retrieve = vi.fn(async () => ({
			decision: "REVIEW" as const,
			reasonCode: "IMAGE_PROCESSING",
			ruleVersion: contract.ruleVersion,
		}));
		const verify = createDatabaseVerifyUploadDependencies(client, {
			...worker.options,
			safety: {
				moderateText: worker.safety.moderateText.bind(worker.safety),
				moderateImage: worker.scan,
				submitVideo: worker.safety.submitVideo.bind(worker.safety),
				retrieveVideo: worker.safety.retrieveVideo.bind(worker.safety),
				submitImage: submit,
				retrieveImage: retrieve,
			},
		}).verify;
		for (let i = 0; i < 3; i++) {
			await client.mediaAsset.update({
				where: { id: media.id },
				data: { verificationNextAttemptAt: null },
			});
			await verify(media.id);
		}
		await client.mediaAsset.update({
			where: { id: media.id },
			data: {
				verificationNextAttemptAt: null,
				verificationDeadlineAt: new Date(Date.now() - 1_000),
			},
		});
		await verify(media.id);
		expect(submit).toHaveBeenCalledOnce();
		expect(retrieve).toHaveBeenCalledTimes(3);
		expect(await reviewFor(media.id)).toMatchObject({
			status: "PENDING_REVIEW",
			bypassed: true,
			failureCount: 4,
		});
		expect((await client.mediaAsset.findUniqueOrThrow({ where: { id: media.id } })).status).toBe(
			"READY",
		);
	});
	it("does not cut off the bounded technical retries when the worker is delayed", async () => {
		const media = await asset();
		const worker = verifier();
		await worker.verify(media.id);
		await client.mediaAsset.update({
			where: { id: media.id },
			data: { verificationDeadlineAt: new Date(Date.now() - 1_000) },
		});
		for (let i = 0; i < 3; i++) {
			await client.mediaAsset.update({
				where: { id: media.id },
				data: { verificationNextAttemptAt: null },
			});
			await worker.verify(media.id);
		}
		expect(worker.scan).toHaveBeenCalledTimes(4);
		expect(await reviewFor(media.id)).toMatchObject({ status: "PENDING_REVIEW", failureCount: 4 });
	});
});
