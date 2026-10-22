import { PrismaPg } from "@prisma/adapter-pg";
import {
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
	TestMediaSafetyAdapter,
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
			await client.mediaWorkflowPhaseOwner.deleteMany({ where: { subjectId: { in: assetIds } } });
			await client.outboxEvent.deleteMany({ where: { id: { in: pointerIds } } });
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

	async function fixture(kind: "INPUT" | "OUTPUT" = "OUTPUT", verificationEngine = "legacy") {
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
				verificationProvider: "seeapi",
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
		const submit = vi.fn(async () => {
			throw new Error("QUERY_MUST_NOT_SUBMIT");
		});
		const retrieve = vi.fn(async () => ({
			decision: "ALLOW" as const,
			reasonCode: "NO_POLICY_MATCH",
			ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
		}));
		const sign = vi.fn(async () => "https://private.invalid/signed");
		const deps = createDatabaseVerifyUploadDependencies(client, {
			moderationProvider: "seeapi",
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
		const run = (expectedOwner = true) =>
			deps.verify(id, {
				queryOnly: true,
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
		});
	});
});
