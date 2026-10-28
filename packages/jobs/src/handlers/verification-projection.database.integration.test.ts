import { PrismaPg } from "@prisma/adapter-pg";
import {
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
	TestMediaSafetyAdapter,
	type ModerationDecision,
	type ModerationSubmission,
} from "@repo/ai";
import { PrismaClient } from "@repo/database/generated-client";
import {
	readMediaVerificationQueryProjection,
	readMediaVerificationVerdictProjection,
} from "@repo/database/media-verification-projections";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDatabaseVerifyUploadDependencies } from "../runtime";

describe("verification projections with real PostgreSQL", () => {
	let client: PrismaClient;
	const assetIds: string[] = [];
	const auditIds: string[] = [];
	const reviewIds: string[] = [];
	const pointerIds: string[] = [];
	const jobIds: string[] = [];
	const quoteIds: string[] = [];
	const userIds: string[] = [];
	beforeAll(async () => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString) throw new Error("EXPLICIT_TEST_DATABASE_REQUIRED");
		const url = new URL(connectionString);
		if (
			!["postgres:", "postgresql:"].includes(url.protocol) ||
			url.hostname !== "127.0.0.1" ||
			url.port !== "55432" ||
			url.search ||
			url.hash ||
			(url.pathname !== "/scanless_phase_owner_migration_test" &&
				url.pathname !== "/ai_media_foundation_test" &&
				!/^\/ezpic_[a-z0-9_]+_test$/.test(url.pathname))
		)
			throw new Error("UNSAFE_TEST_DATABASE");
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 4 }) });
		await client.$queryRaw`SELECT 1`;
	});
	afterAll(async () => {
		if (!client) return;
		try {
			await client.generationJobAsset.deleteMany({ where: { jobId: { in: jobIds } } });
			await client.generationJob.deleteMany({ where: { id: { in: jobIds } } });
			await client.generationQuote.deleteMany({ where: { id: { in: quoteIds } } });
			await client.user.deleteMany({ where: { id: { in: userIds } } });
			await client.mediaWorkflowPhaseOwner.deleteMany({ where: { subjectId: { in: assetIds } } });
			await client.outboxEvent.deleteMany({
				where: { OR: [{ id: { in: pointerIds } }, { aggregateId: { in: assetIds } }] },
			});
			await client.auditLog.deleteMany({ where: { id: { in: auditIds } } });
			await client.moderationReview.deleteMany({ where: { id: { in: reviewIds } } });
			// Immutable moderation evidence and its asset remain in this disposable database.
			await client.mediaAsset.deleteMany({
				where: { id: { in: assetIds }, moderationResults: { none: {} } },
			});
		} finally {
			await client.$disconnect();
		}
	});

	async function fixture(
		kind: "INPUT" | "OUTPUT" = "OUTPUT",
		verificationEngine = "legacy",
		moderationProvider = "seeapi",
	) {
		const id = crypto.randomUUID();
		assetIds.push(id);
		const asset = await client.mediaAsset.create({
			data: {
				id,
				ownerType: "USER",
				ownerId: `projection-${id}`,
				kind,
				status: "VERIFYING",
				objectKey: `users/projection/assets/${id}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
				checksum: "a".repeat(64),
				storageEtag: "etag",
				storageVersionId: "v1",
				finalizedAt: new Date(),
				verificationGeneration: 1,
				verificationEngine,
				verificationAttemptCount: 1,
				verificationProvider: moderationProvider,
				verificationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				verificationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				verificationProviderTaskId: `task-${id}`,
				verificationSubmissionToken: crypto.randomUUID(),
				verificationDeadlineAt: new Date(Date.now() + 120_000),
				verificationLastErrorCode: "IMAGE_PROCESSING",
			},
		});
		const phase = await client.mediaWorkflowPhaseOwner.create({
			data: {
				phaseKind: "verification",
				subjectId: id,
				generation: 1,
				workflowId: `workflow-${id}`,
				epoch: 7,
				leasedUntil: new Date(Date.now() + 600_000),
			},
		});
		const owner = { phaseKey: phase.phaseKey, workflowId: phase.workflowId, epoch: phase.epoch };
		const submit = vi.fn(
			async (_input: { idempotencyKey: string }): Promise<ModerationSubmission> => {
				throw new Error("QUERY_MUST_NOT_SUBMIT");
			},
		);
		const retrieve = vi.fn(
			async (): Promise<ModerationDecision> => ({
				decision: "ALLOW" as const,
				reasonCode: "NO_POLICY_MATCH",
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			}),
		);
		const sign = vi.fn(async () => "https://private.invalid/signed");
		const deps = createDatabaseVerifyUploadDependencies(client, {
			moderationProvider,
			safety: Object.assign(new TestMediaSafetyAdapter("ERROR"), {
				submitImage: submit,
				retrieveImage: retrieve,
			}),
			createSignedReadUrl: sign,
			headObject: async () => ({
				contentLength: 16,
				contentType: "image/png",
				etag: "etag",
				metadata: {},
			}),
			readMediaHeader: async () => Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
			onVerificationError: (error) => {
				throw error;
			},
		});
		const run = (expectedOwner = true, queryOnly = true) =>
			deps.verify(id, {
				queryOnly,
				workflowId: owner.workflowId,
				...(expectedOwner ? { phaseOwner: owner } : {}),
			});
		return { id, asset, owner, run, retrieve, submit, sign };
	}

	async function queryProjection(assetId: string) {
		return client.$transaction(async (tx) => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${assetId}`}, 0))`;
			return readMediaVerificationQueryProjection(assetId, tx);
		});
	}

	it.each(["INPUT", "OUTPUT"] as const)(
		"queries one existing %s task and commits immutable approval",
		async (kind) => {
			const f = await fixture(kind);
			expect(await f.run()).toMatchObject({
				verificationCommit: { assetId: f.id, generation: 1, status: "READY", eventIds: [] },
			});
			expect(f.retrieve).toHaveBeenCalledOnce();
			expect(f.submit).not.toHaveBeenCalled();
			expect(f.sign).not.toHaveBeenCalled();
			expect(await client.assetModerationResult.findMany({ where: { assetId: f.id } })).toEqual([
				expect.objectContaining({
					status: "APPROVED",
					providerTaskId: f.asset.verificationProviderTaskId,
					verificationGeneration: 1,
				}),
			]);
		},
	);

	it.each(["INPUT", "OUTPUT"] as const)(
		"submits one fresh %s task using the locked projection and commits its approval",
		async (kind) => {
			const f = await fixture(kind);
			await client.mediaAsset.update({
				where: { id: f.id },
				data: {
					verificationProviderTaskId: null,
					verificationSubmissionToken: null,
					verificationAttemptCount: 0,
					verificationLastErrorCode: null,
				},
			});
			const taskId = `fresh-${f.id}`;
			f.submit.mockImplementationOnce(async ({ idempotencyKey }) => ({
				moderationTaskId: taskId,
				status: "QUEUED",
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				idempotency: { key: idempotencyKey, providerSupported: true, replayed: false },
			}));
			expect(await f.run(true, false)).toMatchObject({
				verificationCommit: { assetId: f.id, generation: 1, status: "READY", eventIds: [] },
			});
			expect(f.submit).toHaveBeenCalledOnce();
			expect(f.retrieve).toHaveBeenCalledOnce();
			expect(await client.assetModerationResult.findMany({ where: { assetId: f.id } })).toEqual([
				expect.objectContaining({
					status: "APPROVED",
					providerTaskId: taskId,
					verificationGeneration: 1,
				}),
			]);
		},
	);

	it.each(["workflow", "epoch", "expiry"] as const)(
		"does not commit a verdict when its phase %s changes during retrieval",
		async (change) => {
			const f = await fixture();
			f.retrieve.mockImplementationOnce(async () => {
				await client.mediaWorkflowPhaseOwner.update({
					where: { phaseKey: f.owner.phaseKey },
					data:
						change === "workflow"
							? { workflowId: `other-${f.id}` }
							: change === "epoch"
								? { epoch: f.owner.epoch + 1 }
								: { leasedUntil: new Date(0) },
				});
				return {
					decision: "ALLOW",
					reasonCode: "NO_POLICY_MATCH",
					ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				};
			});
			expect(await f.run()).toMatchObject({ phaseOwnershipLost: true });
			expect(f.retrieve).toHaveBeenCalledOnce();
			expect(f.submit).not.toHaveBeenCalled();
			expect(await client.assetModerationResult.count({ where: { assetId: f.id } })).toBe(0);
			expect(await client.mediaAsset.findUnique({ where: { id: f.id } })).toMatchObject({
				status: "VERIFYING",
			});
		},
	);

	it("keeps an uncertain first submission held when the non-query projection path is retried", async () => {
		const f = await fixture("INPUT", "legacy", `projection-unknown-${crypto.randomUUID()}`);
		const submissionToken = crypto.randomUUID();
		await client.mediaAsset.update({
			where: { id: f.id },
			data: {
				verificationProviderTaskId: null,
				verificationSubmissionToken: submissionToken,
				verificationSubmissionUncertain: true,
				verificationLastErrorCode: "MODERATION_SUBMISSION_UNCERTAIN",
			},
		});
		for (let attempt = 0; attempt < 2; attempt++) {
			await client.mediaAsset.update({
				where: { id: f.id },
				data: { verificationNextAttemptAt: new Date(0) },
			});
			await f.run(true, false);
			expect(await client.mediaAsset.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({
				status: "VERIFYING",
				verificationGeneration: 1,
				verificationProviderTaskId: null,
				verificationSubmissionToken: submissionToken,
				verificationSubmissionUncertain: true,
			});
		}
		expect(f.submit).not.toHaveBeenCalled();
		expect(f.retrieve).not.toHaveBeenCalled();
		expect(
			await client.assetModerationResult.count({ where: { assetId: f.id, status: "APPROVED" } }),
		).toBe(0);
	});

	it("uses database time for an owned verdict despite a skewed caller clock", async () => {
		const f = await fixture();
		const leaseToken = crypto.randomUUID();
		const read = (now: Date) =>
			client.$transaction(async (tx) => {
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${f.id}`}, 0))`;
				return readMediaVerificationVerdictProjection(
					{ assetId: f.id, generation: 1, leaseToken, now, phaseOwner: f.owner },
					tx,
				);
			});
		await client.mediaAsset.update({
			where: { id: f.id },
			data: { verificationLeaseToken: leaseToken, verificationLeasedUntil: new Date(0) },
		});
		expect(await read(new Date("1900-01-01T00:00:00Z"))).toBeNull();
		await client.mediaAsset.update({
			where: { id: f.id },
			data: { verificationLeasedUntil: new Date(Date.now() + 60_000) },
		});
		expect(await read(new Date("2100-01-01T00:00:00Z"))).toMatchObject({
			asset: { id: f.id },
			phaseOwnerCurrent: true,
		});
	});

	it("distinguishes invalid asset leases from owner loss even when both are invalid", async () => {
		const f = await fixture();
		const read = () =>
			client.$transaction(async (tx) => {
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${f.id}`}, 0))`;
				return readMediaVerificationVerdictProjection(
					{
						assetId: f.id,
						generation: 1,
						leaseToken: "wrong-lease",
						now: new Date(0),
						phaseOwner: f.owner,
					},
					tx,
				);
			});
		expect(await read()).toBeNull();
		await client.mediaWorkflowPhaseOwner.update({
			where: { phaseKey: f.owner.phaseKey },
			data: { leasedUntil: new Date(0) },
		});
		expect(await read()).toMatchObject({ asset: null, phaseOwnerCurrent: false });
	});

	it("checks owner expiry after waiting for the output job row lock", async () => {
		const f = await fixture();
		await client.user.create({
			data: {
				id: f.asset.ownerId,
				email: `${f.id}@example.test`,
				emailVerified: true,
				name: "Projection fixture",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		userIds.push(f.asset.ownerId);
		const quote = await client.generationQuote.create({
			data: {
				submittedByUserId: f.asset.ownerId,
				ownerType: "USER",
				ownerId: f.asset.ownerId,
				productKey: "image-nano-banana-2-lite",
				catalogVersion: "test",
				pricingVersion: "test",
				credits: 1n,
				costMicros: 1n,
				inputSnapshot: {},
				pricingSnapshot: {},
				expiresAt: new Date(Date.now() + 60_000),
			},
		});
		quoteIds.push(quote.id);
		const job = await client.generationJob.create({
			data: {
				submittedByUserId: f.asset.ownerId,
				idempotencyKey: f.id,
				quoteId: quote.id,
				ownerType: "USER",
				ownerId: f.asset.ownerId,
				productKey: "image-nano-banana-2-lite",
				catalogVersion: "test",
				pricingVersion: "test",
				creditsReserved: 1n,
				inputSnapshot: {},
				pricingSnapshot: {},
				executionEngine: "legacy",
				status: "FINALIZING",
			},
		});
		jobIds.push(job.id);
		await client.generationJobAsset.create({
			data: {
				jobId: job.id,
				assetId: f.id,
				role: "OUTPUT",
				position: 0,
				assetChecksum: f.asset.checksum!,
			},
		});
		let release!: () => void;
		let locked!: () => void;
		const held = new Promise<void>((resolve) => {
			locked = resolve;
		});
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const blocker = client.$transaction(
			async (tx) => {
				await tx.$queryRaw`SELECT "id" FROM "generation_job" WHERE "id" = ${job.id} FOR NO KEY UPDATE`;
				locked();
				await wait;
			},
			{ timeout: 10_000 },
		);
		await held;
		const pending = f.run();
		try {
			await expect
				.poll(
					async () => {
						const [row] = await client.$queryRaw<Array<{ waiting: boolean }>>`
				 SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid()
				  AND datname = current_database() AND wait_event_type = 'Lock'
				  AND query LIKE '%FOR NO KEY UPDATE OF job%') AS "waiting"`;
						return row?.waiting === true;
					},
					{ timeout: 3_000, interval: 10 },
				)
				.toBe(true);
			await client.mediaWorkflowPhaseOwner.update({
				where: { phaseKey: f.owner.phaseKey },
				data: { leasedUntil: new Date(0) },
			});
		} finally {
			release();
			await blocker;
		}
		expect(await pending).toMatchObject({ phaseOwnershipLost: true });
		expect(f.retrieve).toHaveBeenCalledOnce();
		expect(f.submit).not.toHaveBeenCalled();
		expect(await client.assetModerationResult.count({ where: { assetId: f.id } })).toBe(0);
		expect(await client.mediaAsset.findUnique({ where: { id: f.id } })).toMatchObject({
			status: "VERIFYING",
		});
	});

	it("rejects an expired expected owner and preserves its epoch for ownerless takeover", async () => {
		const f = await fixture();
		await client.mediaWorkflowPhaseOwner.update({
			where: { phaseKey: f.owner.phaseKey },
			data: { leasedUntil: new Date(0) },
		});
		expect((await queryProjection(f.id))?.phaseOwner).toBeUndefined();
		expect(await f.run()).toMatchObject({ phaseOwnershipLost: true });
		expect(f.retrieve).not.toHaveBeenCalled();
		expect(await f.run(false)).toMatchObject({
			phaseOwner: { ...f.owner, epoch: 8 },
			verificationCommit: { status: "READY" },
		});
		expect(
			await client.mediaWorkflowPhaseOwner.findUnique({ where: { phaseKey: f.owner.phaseKey } }),
		).toMatchObject({ epoch: 8, workflowId: f.owner.workflowId });
	});

	it("retains a historical marker, prior ERROR evidence and copy pointer instead of treating them as absent", async () => {
		const f = await fixture("INPUT");
		const audit = await client.auditLog.create({
			data: {
				action: "MEDIA_ASSET_LEGACY_REVERIFICATION_STARTED",
				targetType: "MEDIA_ASSET",
				targetId: f.id,
				metadata: {},
			},
		});
		auditIds.push(audit.id);
		await client.assetModerationResult.create({
			data: {
				assetId: f.id,
				verificationGeneration: 1,
				attemptNumber: 1,
				evidenceKind: "INPUT",
				provider: "seeapi",
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				status: "ERROR",
				reasonCode: "MODERATION_UNAVAILABLE",
				categories: {},
				rawEnvelope: {},
			},
		});
		const pointer = await client.outboxEvent.create({
			data: {
				eventType: "ACCOUNT_INPUT_COPY_TARGET",
				aggregateType: "MEDIA_ASSET",
				aggregateId: f.id,
				dedupeKey: `account-input-copy-target:${f.id}`,
				payload: { invalid: true },
				status: "PROCESSED",
			},
		});
		pointerIds.push(pointer.id);
		expect(await queryProjection(f.id)).toMatchObject({
			failureCount: 1,
			hasLegacyReverificationMarker: true,
			hasAccountInputCopy: true,
		});
		await expect(f.run()).rejects.toThrow("ACCOUNT_INPUT_COPY_INTENT_INVALID");
		expect(f.retrieve).not.toHaveBeenCalled();
	});

	it("checks current generation, engine and lease when reading verdict evidence", async () => {
		const f = await fixture();
		const leaseToken = crypto.randomUUID();
		await client.mediaAsset.update({
			where: { id: f.id },
			data: {
				verificationLeaseToken: leaseToken,
				verificationLeasedUntil: new Date(Date.now() + 60_000),
			},
		});
		const previous = await client.moderationReview.create({
			data: {
				targetType: "ASSET",
				targetId: f.id,
				provider: "seeapi",
				stage: "IMAGE",
				attemptEpoch: "1",
				lastErrorCode: "HISTORICAL",
				firstFailureAt: new Date(0),
				lastFailureAt: new Date(1),
			},
		});
		reviewIds.push(previous.id);
		const read = (generation = 1, token: string = leaseToken, assetId: string = f.id) =>
			client.$transaction(async (tx) => {
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${assetId}`}, 0))`;
				return readMediaVerificationVerdictProjection(
					{ assetId, generation, leaseToken: token, now: new Date() },
					tx,
				);
			});
		expect(await read()).toMatchObject({
			previousReview: { id: previous.id, lastErrorCode: "HISTORICAL", lastFailureAt: new Date(1) },
			failureCount: 0,
			hasAccountInputCopy: false,
		});
		expect(await read(2)).toBeNull();
		expect(await read(1, "wrong-lease")).toBeNull();
		await client.mediaAsset.update({
			where: { id: f.id },
			data: { verificationLeasedUntil: new Date(0) },
		});
		expect(await read()).toBeNull();
		const otherEngine = await fixture("OUTPUT", "video-workflow-v1");
		const otherLease = crypto.randomUUID();
		await client.mediaAsset.update({
			where: { id: otherEngine.id },
			data: {
				verificationLeaseToken: otherLease,
				verificationLeasedUntil: new Date(Date.now() + 60_000),
			},
		});
		expect(await read(1, otherLease, otherEngine.id)).toBeNull();
		expect(await queryProjection(otherEngine.id)).toBeNull();
	});

	it("permits only one supplier query while a second tick sees the active lease", async () => {
		const f = await fixture();
		let finishQuery!: () => void;
		let started!: () => void;
		const start = new Promise<void>((resolve) => {
			started = resolve;
		});
		const finish = new Promise<void>((resolve) => {
			finishQuery = resolve;
		});
		f.retrieve.mockImplementationOnce(async () => {
			started();
			await finish;
			return {
				decision: "ALLOW",
				reasonCode: "NO_POLICY_MATCH",
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			};
		});
		const first = f.run();
		try {
			await Promise.race([
				start,
				first.then(() => {
					throw new Error("FIRST_QUERY_DID_NOT_START");
				}),
			]);
			await f.run();
			expect(f.retrieve).toHaveBeenCalledOnce();
		} finally {
			finishQuery();
			await first;
		}
		expect(
			await client.assetModerationResult.count({ where: { assetId: f.id, status: "APPROVED" } }),
		).toBe(1);
	});

	it("reads a changed generation only after a contended verification lock is acquired", async () => {
		const f = await fixture();
		let release!: () => void;
		let locked!: () => void;
		const held = new Promise<void>((resolve) => {
			locked = resolve;
		});
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const blocker = client.$transaction(
			async (tx) => {
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${f.id}`}, 0))`;
				locked();
				await wait;
				await tx.mediaAsset.update({
					where: { id: f.id },
					data: { verificationGeneration: 2, verificationProviderTaskId: `new-task-${f.id}` },
				});
			},
			{ timeout: 10_000 },
		);
		await held;
		const pending = f.run();
		try {
			await expect
				.poll(
					async () => {
						const [row] = await client.$queryRaw<Array<{ waiting: boolean }>>`
				 SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid()
				  AND datname = current_database() AND wait_event = 'advisory'
				  AND query LIKE '%pg_advisory_xact_lock%') AS "waiting"`;
						return row?.waiting === true;
					},
					{ timeout: 3_000, interval: 10 },
				)
				.toBe(true);
		} finally {
			release();
			await blocker;
		}
		expect(await pending).toMatchObject({ phaseOwnershipLost: true });
		expect(f.retrieve).not.toHaveBeenCalled();
		expect(f.submit).not.toHaveBeenCalled();
		expect(await client.mediaAsset.findUnique({ where: { id: f.id } })).toMatchObject({
			verificationGeneration: 2,
			verificationProviderTaskId: `new-task-${f.id}`,
		});
	});

	it("commits a retrieved verdict after a lock wait exceeds Prisma's default transaction timeout", async () => {
		const f = await fixture();
		let release!: () => void;
		let locked!: () => void;
		const held = new Promise<void>((resolve) => {
			locked = resolve;
		});
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const blocker = client.$transaction(
			async (tx) => {
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`moderation-incident:${f.asset.verificationProvider}:IMAGE`}, 0))`;
				locked();
				await wait;
			},
			{ timeout: 15_000 },
		);
		await held;
		// Observe rejection immediately so the intentional long wait cannot create an unhandled promise.
		const pending = f.run().then(
			(value) => ({ value, error: undefined }),
			(error: unknown) => ({ value: undefined, error }),
		);
		try {
			await expect
				.poll(
					async () => {
						const [row] = await client.$queryRaw<Array<{ waiting: boolean }>>`
					SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid()
					AND datname = current_database() AND wait_event_type = 'Lock'
					AND query LIKE '%pg_advisory_xact_lock_shared%') AS "waiting"`;
						return row?.waiting === true;
					},
					{ timeout: 3_000, interval: 10 },
				)
				.toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 5_500));
		} finally {
			release();
			await blocker;
		}
		const result = await pending;
		expect(result.error).toBeUndefined();
		expect(result.value).toMatchObject({ verificationCommit: { status: "READY" } });
		expect(f.retrieve).toHaveBeenCalledOnce();
		expect(f.submit).not.toHaveBeenCalled();
		expect(await client.assetModerationResult.findMany({ where: { assetId: f.id } })).toEqual([
			expect.objectContaining({
				status: "APPROVED",
				providerTaskId: f.asset.verificationProviderTaskId,
			}),
		]);
	});

	it.each(["ALLOW", "REJECT"] as const)(
		"retrieves the same task after an expired verdict lease and deadline, honoring %s",
		async (decision) => {
			const f = await fixture();
			const deadline = new Date(Date.now() - 1_000);
			await client.mediaAsset.update({
				where: { id: f.id },
				data: {
					verificationLeaseToken: crypto.randomUUID(),
					verificationLeasedUntil: new Date(0),
					verificationDeadlineAt: deadline,
				},
			});
			f.retrieve.mockResolvedValueOnce({
				decision,
				reasonCode: decision === "ALLOW" ? "NO_POLICY_MATCH" : "NSFW",
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			});
			expect(await f.run()).toMatchObject({
				verificationCommit: { status: decision === "ALLOW" ? "READY" : "QUARANTINED" },
			});
			await f.run();
			expect(f.retrieve).toHaveBeenCalledExactlyOnceWith({
				moderationTaskId: f.asset.verificationProviderTaskId,
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				assetUrl: "",
			});
			expect(f.submit).not.toHaveBeenCalled();
			expect(f.sign).not.toHaveBeenCalled();
			expect(await client.mediaAsset.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({
				verificationProviderTaskId: f.asset.verificationProviderTaskId,
				verificationSubmissionToken: f.asset.verificationSubmissionToken,
				verificationGeneration: 1,
				verificationDeadlineAt: deadline,
			});
			expect(
				await client.assetModerationResult.findMany({
					where: { assetId: f.id },
					orderBy: { attemptNumber: "asc" },
				}),
			).toEqual([
				expect.objectContaining({
					status: "ERROR",
					reasonCode: "VERIFICATION_LEASE_EXPIRED",
					attemptNumber: 1,
				}),
				expect.objectContaining({
					status: decision === "ALLOW" ? "APPROVED" : "REJECTED",
					attemptNumber: 2,
				}),
			]);
		},
	);

	it.each(["missing task", "unknown submission", "temporary reference"] as const)(
		"does not widen expired-lease recovery for %s",
		async (boundary) => {
			const f = await fixture(boundary === "temporary reference" ? "INPUT" : "OUTPUT");
			await client.mediaAsset.update({
				where: { id: f.id },
				data: {
					verificationLeaseToken: crypto.randomUUID(),
					verificationLeasedUntil: new Date(0),
					verificationDeadlineAt: new Date(0),
					...(boundary === "missing task" ? { verificationProviderTaskId: null } : {}),
					...(boundary === "unknown submission" ? { verificationSubmissionUncertain: true } : {}),
					...(boundary === "temporary reference"
						? {
								objectKey: `users/temporary-references/v1/${f.asset.ownerId}/${f.id}`,
								deleteAfter: new Date(Date.now() + 60_000),
							}
						: {}),
				},
			});
			await f.run();
			await f.run(true, false);
			expect(f.retrieve).not.toHaveBeenCalled();
			expect(f.submit).not.toHaveBeenCalled();
			expect(
				await client.assetModerationResult.count({ where: { assetId: f.id, status: "APPROVED" } }),
			).toBe(0);
		},
	);

	it("includes newly appended expired-lease evidence in the failure budget", async () => {
		const f = await fixture();
		await client.assetModerationResult.createMany({
			data: [1, 2, 3].map((attemptNumber) => ({
				assetId: f.id,
				verificationGeneration: 1,
				attemptNumber,
				evidenceKind: "OUTPUT" as const,
				provider: "seeapi",
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				status: "ERROR" as const,
				reasonCode: "MODERATION_UNAVAILABLE",
				categories: {},
				rawEnvelope: {},
			})),
		});
		await client.mediaAsset.update({
			where: { id: f.id },
			data: {
				verificationAttemptCount: 4,
				verificationLeaseToken: crypto.randomUUID(),
				verificationLeasedUntil: new Date(0),
				verificationDeadlineAt: new Date(0),
			},
		});
		expect((await queryProjection(f.id))?.failureCount).toBe(3);
		await f.run();
		expect(f.retrieve).not.toHaveBeenCalled();
		expect(f.submit).not.toHaveBeenCalled();
		expect(
			await client.assetModerationResult.count({ where: { assetId: f.id, status: "ERROR" } }),
		).toBe(4);
		expect(await client.mediaAsset.findUnique({ where: { id: f.id } })).toMatchObject({
			status: "VERIFICATION_FAILED",
			verificationLeaseToken: null,
			verificationLastErrorCode: "VERIFICATION_LEASE_EXPIRED",
		});
	});
});
