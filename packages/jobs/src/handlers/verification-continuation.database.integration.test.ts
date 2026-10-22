import { PrismaPg } from "@prisma/adapter-pg";
import {
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
	TestMediaSafetyAdapter,
} from "@repo/ai";
import {
	beginWorkflowOutboxExecution,
	completeWorkflowOutboxExecution,
	getObservedAssetGenerationContinuation,
	prepareWorkflowOutboxEvent,
	readTerminalMediaVerificationObservation,
} from "@repo/database";
import { PrismaClient, type Prisma } from "@repo/database/generated-client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { appendVerificationEvidence, createDatabaseVerifyUploadDependencies } from "../runtime";

const boundary = {
	provider: "seeapi",
	ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
	policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
};
const pngHeader = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("committed and observed verification continuations with real PostgreSQL", () => {
	let client: PrismaClient;
	const aggregateIds: string[] = [];
	beforeAll(() => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString) throw new Error("EXPLICIT_TEST_DATABASE_REQUIRED");
		const url = new URL(connectionString);
		if (
			!["postgres:", "postgresql:"].includes(url.protocol) ||
			url.hostname !== "127.0.0.1" ||
			url.port !== "55432" ||
			(url.pathname !== "/ai_media_foundation_test" &&
				!/^\/ezpic_[a-z0-9_]+_test$/.test(url.pathname)) ||
			url.search !== "" ||
			url.hash !== ""
		)
			throw new Error("UNSAFE_TEST_DATABASE");
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 6 }) });
	});
	afterEach(() => vi.restoreAllMocks());
	afterAll(async () => {
		if (!client) return;
		try {
			await client.outboxEvent.deleteMany({ where: { aggregateId: { in: aggregateIds } } });
			// The isolated fixtures retain append-only proof rows; never disable their trigger.
		} finally {
			await client.$disconnect();
		}
	});

	async function fixture(kind: "INPUT" | "OUTPUT" = "OUTPUT", jobCount = 1) {
		const assetId = crypto.randomUUID();
		aggregateIds.push(assetId);
		const asset = await client.mediaAsset.create({
			data: {
				id: assetId,
				ownerType: "USER",
				ownerId: assetId,
				kind,
				status: "VERIFYING",
				objectKey: `users/${assetId}/assets/${assetId}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
				checksum: "c".repeat(64),
				finalizedAt: new Date(),
				verificationGeneration: 1,
				verificationProvider: boundary.provider,
				verificationRuleVersion: boundary.ruleVersion,
				verificationPolicyVersion: boundary.policyVersion,
			},
		});
		const jobs = [];
		for (let index = 0; index < jobCount; index++) {
			const identity = {
				ownerType: "USER" as const,
				ownerId: assetId,
				submittedByUserId: assetId,
				productKey: "image-nano-banana-2-lite",
				catalogVersion: "verification-receipt-test",
				pricingVersion: "test",
				inputSnapshot: {},
				pricingSnapshot: {},
			};
			const job = await client.generationJob.create({
				data: {
					...identity,
					idempotencyKey: `${assetId}-${index}`,
					creditsReserved: 5n,
					status: kind === "INPUT" ? "RESERVED" : "FINALIZING",
					quote: { create: { ...identity, credits: 5n, costMicros: 10n, expiresAt: new Date() } },
					assets: { create: { assetId, role: kind, assetChecksum: asset.checksum! } },
				},
			});
			jobs.push(job);
			aggregateIds.push(job.id);
		}
		const read = () => client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
		const observation = () =>
			readTerminalMediaVerificationObservation({ assetId, ...boundary }, client);
		const terminal = async (status: "READY" | "QUARANTINED" = "READY") => {
			const validUntil = new Date("2036-10-22T00:00:00Z");
			return client.$transaction(async (tx) => {
				if (status === "READY")
					await appendVerificationEvidence(tx, {
						assetId,
						assetChecksum: asset.checksum,
						verificationGeneration: 1,
						attemptNumber: 1,
						evidenceKind: kind,
						...boundary,
						providerTaskId: null,
						status: "APPROVED",
						reasonCode: "SAFE",
						rawEnvelope: { decision: "ALLOW" },
						validUntil,
					});
				return tx.mediaAsset.update({
					where: { id: assetId },
					data: { status, verificationAttemptCount: 1, verificationValidUntil: validUntil },
				});
			});
		};
		return { assetId, asset, jobs, read, observation, terminal };
	}

	function dependencies(
		database = client,
		decision: "ALLOW" | "REJECT" = "ALLOW",
		beforeVerdict?: () => Promise<void>,
	) {
		const safety = new TestMediaSafetyAdapter(decision);
		const original = safety.moderateImage.bind(safety);
		const moderate = vi.spyOn(safety, "moderateImage").mockImplementation(async (input) => {
			await beforeVerdict?.();
			return original(input);
		});
		return {
			moderate,
			verify: createDatabaseVerifyUploadDependencies(database, {
				environment: {},
				moderationProvider: boundary.provider,
				safety,
				headObject: async () => ({
					contentLength: 16,
					contentType: "image/png",
					etag: "fixture",
					metadata: {},
				}),
				readMediaHeader: async () => pngHeader,
				createSignedReadUrl: async () => "https://private.example/fixture.png",
			}).verify,
		};
	}

	it.each(["INPUT", "OUTPUT"] as const)(
		"returns actual committed %s follow-up IDs and reuses a conflicting durable identity",
		async (kind) => {
			const f = await fixture(kind);
			const job = f.jobs[0]!;
			const prefix =
				kind === "INPUT"
					? "generation-dispatch-after-verification"
					: "generation-finalize-after-output-verification";
			const existing = await client.outboxEvent.create({
				data: {
					eventType: kind === "INPUT" ? "GENERATION_DISPATCH" : "GENERATION_FINALIZE_RETRY",
					aggregateType: "GENERATION_JOB",
					aggregateId: job.id,
					dedupeKey: `${prefix}:${job.id}:${f.assetId}:g1`,
					payload: { jobId: job.id, version: job.version },
				},
			});
			const deps = dependencies();
			const result = await deps.verify(f.assetId);
			expect(result.verificationCommit).toEqual({
				assetId: f.assetId,
				generation: 1,
				status: "READY",
				eventIds: [existing.id],
			});
			expect(result.verificationObservation).toBeUndefined();
			expect(deps.moderate).toHaveBeenCalledOnce();
			expect((await f.read()).status).toBe("READY");
			expect(await client.assetModerationResult.count({ where: { assetId: f.assetId } })).toBe(1);
		},
	);

	it("returns a committed quarantine receipt after input rejection, without acknowledging pending review work", async () => {
		const f = await fixture("INPUT");
		const result = await dependencies(client, "REJECT").verify(f.assetId);
		expect(result.verificationCommit).toMatchObject({
			assetId: f.assetId,
			generation: 1,
			status: "QUARANTINED",
		});
		const events = await client.outboxEvent.findMany({
			where: { id: { in: result.verificationCommit!.eventIds } },
		});
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			status: "PENDING",
			eventType: "GENERATION_SETTLE",
			aggregateId: f.jobs[0]!.id,
		});
	});

	it("does not expose a receipt or proof when the verdict transaction rolls back", async () => {
		const f = await fixture();
		let calls = 0;
		const transaction = client.$transaction.bind(client);
		const database = new Proxy(client, {
			get(target, property) {
				if (property === "$transaction")
					return async (operation: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
						const rollback = ++calls === 2;
						return transaction(async (tx) => {
							const result = await operation(tx);
							if (rollback) throw new Error("INJECTED_VERDICT_ROLLBACK");
							return result;
						});
					};
				return Reflect.get(target, property);
			},
		});
		await expect(dependencies(database).verify(f.assetId)).rejects.toThrow(
			"INJECTED_VERDICT_ROLLBACK",
		);
		expect((await f.read()).status).toBe("VERIFYING");
		expect(await client.assetModerationResult.count({ where: { assetId: f.assetId } })).toBe(0);
		expect(await client.outboxEvent.count({ where: { aggregateId: f.jobs[0]!.id } })).toBe(0);
	});

	it("does not return a commit receipt after losing its verification lease", async () => {
		const f = await fixture();
		const deps = dependencies(client, "ALLOW", async () => {
			await client.mediaAsset.update({
				where: { id: f.assetId },
				data: { verificationLeaseToken: null, verificationLeasedUntil: null },
			});
		});
		expect(await deps.verify(f.assetId)).toEqual({ outboxCommitted: false });
		expect((await f.read()).status).toBe("VERIFYING");
		expect(await client.assetModerationResult.count({ where: { assetId: f.assetId } })).toBe(0);
	});

	it("atomically deduplicates concurrent proof appends and retains the first immutable evidence", async () => {
		const f = await fixture("OUTPUT", 0);
		const proof = {
			assetId: f.assetId,
			assetChecksum: "a".repeat(64),
			verificationGeneration: 1,
			attemptNumber: 1,
			evidenceKind: "OUTPUT" as const,
			...boundary,
			providerTaskId: "first",
			status: "APPROVED" as const,
			reasonCode: "SAFE",
			validUntil: new Date("2036-10-22T00:00:00Z"),
			rawEnvelope: { source: "first" },
		};
		await Promise.all(
			Array.from({ length: 8 }, () =>
				client.$transaction((tx) => appendVerificationEvidence(tx, proof)),
			),
		);
		const first = await client.assetModerationResult.findMany({ where: { assetId: f.assetId } });
		expect(first).toHaveLength(1);
		await client.$transaction((tx) =>
			appendVerificationEvidence(tx, {
				...proof,
				status: "REJECTED",
				providerTaskId: "conflicting",
				assetChecksum: "b".repeat(64),
				rawEnvelope: { source: "conflicting" },
			}),
		);
		expect(await client.assetModerationResult.findMany({ where: { assetId: f.assetId } })).toEqual(
			first,
		);
	});

	it.each(["READY", "QUARANTINED", "VERIFICATION_FAILED", "DELETED"] as const)(
		"returns explicit empty continuation for unchanged %s observation without claiming a lease",
		async (status) => {
			const f = await fixture("OUTPUT", 0);
			if (status === "READY") await f.terminal();
			await client.mediaAsset.update({
				where: { id: f.assetId },
				data: { status, deletedAt: status === "DELETED" ? new Date() : null },
			});
			const before = await f.read();
			const deps = dependencies();
			expect(await deps.verify(f.assetId, { queryOnly: true })).toEqual({
				outboxCommitted: false,
				verificationObservation: { assetId: f.assetId, generation: 1, status, eventIds: [] },
			});
			expect(deps.moderate).not.toHaveBeenCalled();
			expect(await f.read()).toEqual(before);
		},
	);

	it.each([
		{ status: "VERIFYING" as const, verificationGeneration: 2 },
		{ status: "QUARANTINED" as const },
		{ status: "DELETED" as const, deletedAt: new Date("2026-10-22T00:00:00Z") },
		{ verificationGeneration: 2 },
		{ verificationProvider: "retired" },
		{ verificationSubmissionUncertain: true },
		{
			verificationLeaseToken: "unique-per-fixture",
			verificationLeasedUntil: new Date("2036-10-22T00:00:00Z"),
		},
	])("invalidates an observation changed before the event snapshot: %j", async (mutation) => {
		const f = await fixture("OUTPUT", 0);
		await f.terminal(
			!("status" in mutation) &&
				("verificationGeneration" in mutation || "verificationProvider" in mutation)
				? "QUARANTINED"
				: "READY",
		);
		const observed = (await f.observation())!;
		await client.mediaAsset.update({
			where: { id: f.assetId },
			data: {
				...mutation,
				// Fixtures keep append-only evidence, so repeat runs need distinct leases.
				...("verificationLeaseToken" in mutation ? { verificationLeaseToken: f.assetId } : {}),
			},
		});
		expect(await getObservedAssetGenerationContinuation(observed, client)).toBeUndefined();
	});

	it("falls back to authority when re-verification starts between its two observation reads", async () => {
		const f = await fixture("OUTPUT", 0);
		await f.terminal();
		const original = client.mediaAsset.findUnique.bind(client.mediaAsset);
		let observedOnce = false;
		vi.spyOn(client.mediaAsset, "findUnique").mockImplementation((async (
			args: Parameters<typeof original>[0],
		) => {
			const value = await original(args);
			if (!observedOnce && args.where.id === f.assetId) {
				observedOnce = true;
				await client.mediaAsset.update({
					where: { id: f.assetId },
					data: {
						status: "VERIFYING",
						verificationGeneration: 2,
						verificationProviderTaskId: null,
					},
				});
			}
			return value;
		}) as unknown as typeof client.mediaAsset.findUnique);
		const deps = dependencies();
		expect(await deps.verify(f.assetId, { queryOnly: true })).toEqual({ outboxCommitted: false });
		expect(deps.moderate).not.toHaveBeenCalled();
		expect(await f.read()).toMatchObject({ status: "VERIFYING", verificationGeneration: 2 });
	});

	it("uses only this generation's durable keys across bindings with ordering, deduplication and the 100-event bound", async () => {
		const f = await fixture("OUTPUT", 36);
		await f.terminal();
		const rows: Prisma.OutboxEventCreateManyInput[] = [];
		for (const [index, job] of f.jobs.entries()) {
			await client.generationJobAsset.create({
				data: {
					jobId: job.id,
					assetId: f.assetId,
					role: "INPUT",
					assetChecksum: f.asset.checksum!,
				},
			});
			for (const [offset, prefix] of [
				"generation-finalize-after-output-verification",
				"generation-settle-after-output-verification",
				"generation-settle",
			].entries())
				rows.push({
					id: `event-${f.assetId}-${String(index * 3 + offset).padStart(3, "0")}`,
					eventType: offset === 0 ? "GENERATION_FINALIZE_RETRY" : "GENERATION_SETTLE",
					aggregateType: "GENERATION_JOB",
					aggregateId: job.id,
					dedupeKey: offset === 2 ? `${prefix}:${job.id}` : `${prefix}:${job.id}:${f.assetId}:g1`,
					payload: { jobId: job.id },
					availableAt: new Date(1_000 + (35 - index) * 100),
				});
			rows.push({
				eventType: "GENERATION_SETTLE",
				aggregateType: "GENERATION_JOB",
				aggregateId: job.id,
				dedupeKey: `generation-settle-after-output-verification:${job.id}:${f.assetId}:g2`,
				payload: { jobId: job.id },
				availableAt: new Date(0),
			});
		}
		await client.outboxEvent.createMany({ data: rows });
		const expected = await client.outboxEvent.findMany({
			where: { id: { in: rows.flatMap((row) => (row.id ? [row.id] : [])) } },
			orderBy: [{ availableAt: "asc" }, { id: "asc" }],
			take: 100,
			select: { id: true },
		});
		const continuation = await getObservedAssetGenerationContinuation(
			(await f.observation())!,
			client,
		);
		expect(continuation).toEqual({ eventIds: expected.map(({ id }) => id) });
		expect(continuation!.eventIds).toHaveLength(100);
	});

	it("an old terminal observation and receipt never ACK a new generation's durable work", async () => {
		const f = await fixture("OUTPUT", 0);
		await f.terminal();
		const old = await client.outboxEvent.create({
			data: {
				eventType: "MEDIA_ASSET_VERIFY",
				aggregateType: "MEDIA_ASSET",
				aggregateId: f.assetId,
				dedupeKey: `verify:${f.assetId}:g1`,
				payload: { assetId: f.assetId },
			},
		});
		const prepared = await prepareWorkflowOutboxEvent(
			{ eventId: old.id, workerId: "old-workflow" },
			client,
		);
		const receipt = { eventId: old.id, workerId: "old-workflow", leaseToken: prepared!.leaseToken };
		const begun = await beginWorkflowOutboxExecution({ ...receipt, timeoutSeconds: 30 }, client);
		expect(begun.state).toBe("active");
		if (begun.state !== "active") throw new Error("Expected an active execution receipt");
		expect(begun.event.lastError).toMatch(/^EXECUTION_IN_PROGRESS:/);
		const executionReceipt = { ...receipt, executionMarker: begun.event.lastError! };
		expect(await getObservedAssetGenerationContinuation((await f.observation())!, client)).toEqual({
			eventIds: [],
		});
		// A later generation starts after the validated observation, just as it can
		// after the legacy final read. Its distinct durable intent cannot be ACKed.
		const next = await client.$transaction(async (tx) => {
			await tx.mediaAsset.update({
				where: { id: f.assetId },
				data: { status: "VERIFYING", verificationGeneration: 2 },
			});
			return tx.outboxEvent.create({
				data: {
					eventType: "MEDIA_ASSET_VERIFY",
					aggregateType: "MEDIA_ASSET",
					aggregateId: f.assetId,
					dedupeKey: `verify:${f.assetId}:g2`,
					payload: { assetId: f.assetId },
				},
			});
		});
		const [leased] = await client.$queryRaw<Array<{ leasedUntil: Date; now: Date }>>`
			SELECT "leasedUntil", clock_timestamp() AS "now"
			FROM "outbox_event" WHERE "id" = ${old.id}`;
		expect(leased!.leasedUntil.getTime()).toBeGreaterThan(leased!.now.getTime());
		// A live lease alone cannot ACK work after execution begins: the current
		// execution marker must match, and it never grants authority over g2.
		expect(await completeWorkflowOutboxExecution(receipt, client)).toBe(false);
		expect(await completeWorkflowOutboxExecution(executionReceipt, client)).toBe(true);
		expect(
			await completeWorkflowOutboxExecution({ ...executionReceipt, eventId: next.id }, client),
		).toBe(false);
		expect(await client.outboxEvent.findUnique({ where: { id: old.id } })).toMatchObject({
			status: "PROCESSED",
		});
		expect(await client.outboxEvent.findUnique({ where: { id: next.id } })).toMatchObject({
			status: "PENDING",
		});
		expect(await f.read()).toMatchObject({ status: "VERIFYING", verificationGeneration: 2 });
	});
});
