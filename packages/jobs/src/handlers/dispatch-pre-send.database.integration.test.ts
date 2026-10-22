import { PrismaPg } from "@prisma/adapter-pg";
import { createRouteGraphSnapshot, type MediaProviderAdapter } from "@repo/ai";
import {
	claimImagePhaseOwnerInTransaction,
	fingerprintGenerationQuoteSecurityPayload,
} from "@repo/database";
import { PrismaClient, type Prisma } from "@repo/database/generated-client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { DispatchClaim } from "../contracts";
import { createDatabaseDispatchStore } from "../runtime";
import { dispatchGeneration } from "./dispatch-generation";

describe("committed dispatch preparation with real PostgreSQL", () => {
	let client: PrismaClient;
	const jobIds: string[] = [];
	const quoteIds: string[] = [];
	const accountIds: string[] = [];
	const route = {
		provider: "kie" as const,
		providerModelId: "nano-banana-2-lite",
		providerCostMicros: 20_000,
		weight: 100,
	};

	beforeAll(() => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString) throw new Error("EXPLICIT_TEST_DATABASE_REQUIRED");
		const url = new URL(connectionString);
		if (
			!["postgres:", "postgresql:"].includes(url.protocol) ||
			url.hostname !== "127.0.0.1" ||
			url.port !== "55432" ||
			(url.pathname !== "/scanless_phase_owner_migration_test" &&
				url.pathname !== "/ai_media_foundation_test") ||
			url.search ||
			url.hash
		)
			throw new Error("UNSAFE_TEST_DATABASE");
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 6 }) });
	});

	afterEach(() => vi.useRealTimers());
	afterAll(async () => {
		if (!client) return;
		try {
			const attempts = await client.generationAttempt.findMany({
				where: { jobId: { in: jobIds } },
				select: { id: true },
			});
			await client.mediaWorkflowPhaseOwner.deleteMany({
				where: { subjectId: { in: attempts.map(({ id }) => id) } },
			});
			await client.outboxEvent.deleteMany({ where: { aggregateId: { in: jobIds } } });
			await client.creditReservation.deleteMany({ where: { jobId: { in: jobIds } } });
			await client.generationJob.deleteMany({ where: { id: { in: jobIds } } });
			await client.generationQuote.deleteMany({ where: { id: { in: quoteIds } } });
			await client.creditAccount.deleteMany({ where: { id: { in: accountIds } } });
		} finally {
			await client.$disconnect();
		}
	});

	function transactionObserver(
		options: {
			loseCommit?: number;
			before?: (tx: Prisma.TransactionClient, index: number) => Promise<void>;
		} = {},
	) {
		const state = { count: 0, committed: undefined as unknown };
		const database = new Proxy(client, {
			get(target, key, receiver) {
				if (key === "$transaction")
					return async (
						operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
						settings?: Parameters<PrismaClient["$transaction"]>[1],
					) => {
						const index = ++state.count;
						const result = await target.$transaction(async (tx) => {
							await options.before?.(tx, index);
							return operation(tx);
						}, settings);
						state.committed = result;
						if (options.loseCommit === index) throw new Error("COMMIT_RESPONSE_LOST");
						return result;
					};
				return Reflect.get(target, key, receiver);
			},
		});
		return { database, state };
	}

	async function fixture(options: { database?: PrismaClient; owned?: boolean } = {}) {
		const id = crypto.randomUUID();
		const snapshot = {
			ownerType: "USER" as const,
			ownerId: id,
			submittedByUserId: id,
			productKey: "image-nano-banana-2-lite",
			catalogVersion: "2026-09-07.2",
			pricingVersion: "2026-09-07.2",
			inputSnapshot: {
				kind: "text-to-image",
				prompt: "A calm lake",
				skuKey: "nano-banana-2-lite-1k",
				aspectRatio: "1:1",
			},
			pricingSnapshot: {
				routeGraph: createRouteGraphSnapshot({
					productKey: "image-nano-banana-2-lite",
					catalogVersion: "2026-09-07.2",
					pricingVersion: "2026-09-07.2",
					routes: [route],
				}),
			} as unknown as Prisma.InputJsonValue,
		};
		const quote = {
			...snapshot,
			credits: 5n,
			costMicros: 20_000n,
			expiresAt: new Date(Date.now() + 600_000),
		};
		const job = await client.generationJob.create({
			data: {
				...snapshot,
				quote: {
					create: {
						...quote,
						moderationDecision: "ALLOW",
						moderationProvider: "test",
						moderationRuleVersion: "TEST_DISPATCH_PRE_SEND_V1",
						moderationReasonCode: "TEST_ALLOW_DISPATCH_PRE_SEND",
						inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quote),
					},
				},
				idempotencyKey: id,
				creditsReserved: 5n,
				status: "DISPATCH_QUEUED",
				executionEngine: "legacy",
				reservation: {
					create: {
						amount: 5n,
						account: { create: { ownerType: "USER", ownerId: id, reservedCredits: 5n } },
					},
				},
			},
			include: { reservation: true },
		});
		jobIds.push(job.id);
		quoteIds.push(job.quoteId);
		accountIds.push(job.reservation!.accountId);
		const storeOptions = {
			...(options.owned === false ? {} : { workflowId: `dispatch-${id}` }),
			enabledProviders: new Set(["kie"] as const),
			environment: {
				NODE_ENV: "test",
				MEDIA_GENERATION_ENABLED: "true",
				MEDIA_NANO_BANANA_2_LITE_ENABLED: "true",
			},
		};
		const store = createDatabaseDispatchStore(options.database ?? client, storeOptions);
		const payload = { jobId: job.id, version: job.version };
		const submit = vi.fn(async () => ({
			outcome: "accepted" as const,
			providerTaskId: `task-${id}`,
			status: "RUNNING" as const,
			idempotency: { providerSupported: false, replayed: false },
			reconciliation: {},
		}));
		const getProvider = vi.fn(() => ({ submit }) as unknown as MediaProviderAdapter);
		return {
			job,
			store,
			storeOptions,
			payload,
			submit,
			dependencies: { store, getProvider, isGenerationEnabled: () => true },
			async claim() {
				const claim = await store.claimDispatch(payload);
				if (!claim || !("attemptId" in claim)) throw new Error("EXPECTED_DISPATCH_CLAIM");
				return claim;
			},
		};
	}

	async function tuples(claim: DispatchClaim) {
		const [result] = await client.$queryRaw<
			Array<{
				attemptRowVersion: string;
				jobRowVersion: string;
				attemptUpdatedAt: Date;
				jobUpdatedAt: Date;
				jobVersion: number;
				submittedAt: Date;
			}>
		>`SELECT attempt.xmin::text AS "attemptRowVersion", job.xmin::text AS "jobRowVersion",
		 attempt."updatedAt" AS "attemptUpdatedAt", job."updatedAt" AS "jobUpdatedAt",
		 job."version" AS "jobVersion", attempt."submittedAt"
		 FROM "generation_attempt" attempt JOIN "generation_job" job ON job.id = attempt."jobId"
		 WHERE attempt.id = ${claim.attemptId}`;
		if (!result) throw new Error("MISSING_ATTEMPT");
		return result;
	}

	it.each([true, false])(
		"accepts the actual committed UPDATE RETURNING tuples (owner=%s) without rewriting",
		async (owned) => {
			const f = await fixture({ owned });
			const claim = await f.claim();
			const before = await tuples(claim);
			expect(before.attemptRowVersion).toMatch(/^\d+$/);
			expect(before.jobRowVersion).toMatch(/^\d+$/);
			await expect(
				f.store.recordSubmissionStarted(claim.attemptId, claim.phaseOwner, claim),
			).resolves.toBeUndefined();
			expect(await tuples(claim)).toEqual(before);
			await expect(
				f.store.recordSubmissionStarted(claim.attemptId, claim.phaseOwner, claim),
			).resolves.toBe(false);
		},
	);

	it("uses the original immutable input and persists accepted provider identity once", async () => {
		const f = await fixture();
		await expect(dispatchGeneration(f.payload, f.dependencies)).resolves.toMatchObject({
			outcome: "SUBMITTED",
		});
		expect(f.submit).toHaveBeenCalledOnce();
		const sent = (f.submit.mock.calls as unknown as Array<[{ input: object }]>)[0]![0];
		expect(Object.isFrozen(sent.input)).toBe(true);
		const [attempt] = await client.generationAttempt.findMany({ where: { jobId: f.job.id } });
		expect(attempt).toMatchObject({ status: "RUNNING", uncertainSubmission: false });
		expect(attempt?.providerTaskId).toBeTruthy();
		await expect(dispatchGeneration(f.payload, f.dependencies)).resolves.toEqual({
			outcome: "SKIPPED",
		});
		expect(f.submit).toHaveBeenCalledOnce();
	});

	it.each(["errorSnapshot", "nextReconcileAt"] as const)(
		"rejects a raw attempt %s change preserving timestamps",
		async (field) => {
			const f = await fixture();
			const claim = await f.claim();
			const before = await tuples(claim);
			if (field === "errorSnapshot")
				await client.$executeRaw`UPDATE "generation_attempt" SET "errorSnapshot" = '{"code":"intervening"}'::jsonb WHERE id = ${claim.attemptId}`;
			else
				await client.$executeRaw`UPDATE "generation_attempt" SET "nextReconcileAt" = clock_timestamp() WHERE id = ${claim.attemptId}`;
			const after = await tuples(claim);
			expect(after.attemptUpdatedAt).toEqual(before.attemptUpdatedAt);
			expect(after.submittedAt).toEqual(before.submittedAt);
			expect(after.attemptRowVersion).not.toBe(before.attemptRowVersion);
			await expect(
				f.store.recordSubmissionStarted(claim.attemptId, claim.phaseOwner, claim),
			).resolves.toBe(false);
		},
	);

	it("rejects raw input mutation even when job version and timestamps are preserved", async () => {
		const f = await fixture();
		const claim = await f.claim();
		const before = await tuples(claim);
		await client.$executeRaw`UPDATE "generation_job" SET "inputSnapshot" = jsonb_set("inputSnapshot", '{prompt}', '"different instruction"'::jsonb) WHERE id = ${f.job.id}`;
		const after = await tuples(claim);
		expect(after.jobVersion).toBe(before.jobVersion);
		expect(after.jobUpdatedAt).toEqual(before.jobUpdatedAt);
		expect(after.jobRowVersion).not.toBe(before.jobRowVersion);
		await expect(
			f.store.recordSubmissionStarted(claim.attemptId, claim.phaseOwner, claim),
		).resolves.toBe(false);
	});

	it("retains the legacy writer and detects its rewrite within the same application millisecond", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const f = await fixture();
		const claim = await f.claim();
		const before = await tuples(claim);
		await expect(
			f.store.recordSubmissionStarted(claim.attemptId, claim.phaseOwner),
		).resolves.toBeUndefined();
		const after = await tuples(claim);
		expect(after.submittedAt).toEqual(before.submittedAt);
		expect(after.attemptRowVersion).not.toBe(before.attemptRowVersion);
		await expect(
			f.store.recordSubmissionStarted(claim.attemptId, claim.phaseOwner, claim),
		).resolves.toBe(false);
	});

	it("rejects copied and cross-store claims without a fallback transaction", async () => {
		const observer = transactionObserver();
		const f = await fixture({ database: observer.database });
		const claim = await f.claim();
		await expect(
			f.store.recordSubmissionStarted(claim.attemptId, claim.phaseOwner, structuredClone(claim)),
		).resolves.toBe(false);
		const other = createDatabaseDispatchStore(observer.database, f.storeOptions);
		await expect(
			other.recordSubmissionStarted(claim.attemptId, claim.phaseOwner, claim),
		).resolves.toBe(false);
		expect(observer.state.count).toBe(1);
		await expect(
			f.store.recordSubmissionStarted(claim.attemptId, claim.phaseOwner, claim),
		).resolves.toBeUndefined();
	});

	it("does not mint a proof or submit after an actual claim commit loses its response", async () => {
		const observer = transactionObserver({ loseCommit: 1 });
		const f = await fixture({ database: observer.database });
		await expect(dispatchGeneration(f.payload, f.dependencies)).rejects.toThrow(
			"COMMIT_RESPONSE_LOST",
		);
		const leaked = observer.state.committed as DispatchClaim;
		await expect(
			f.store.recordSubmissionStarted(leaked.attemptId, leaked.phaseOwner, leaked),
		).resolves.toBe(false);
		await expect(dispatchGeneration(f.payload, f.dependencies)).resolves.toEqual({
			outcome: "SKIPPED",
		});
		expect(f.submit).not.toHaveBeenCalled();
		expect(
			await client.generationAttempt.findUniqueOrThrow({ where: { id: leaked.attemptId } }),
		).toMatchObject({
			status: "SUBMISSION_UNCERTAIN",
			uncertainSubmission: true,
			providerTaskId: null,
		});
	});

	it("does not send, fallback or reuse a proof when final-check commit acknowledgement is lost", async () => {
		const observer = transactionObserver({ loseCommit: 2 });
		const f = await fixture({ database: observer.database });
		const claim = await f.claim();
		await expect(
			dispatchGeneration(f.payload, {
				...f.dependencies,
				store: { ...f.store, claimDispatch: async () => claim },
			}),
		).resolves.toMatchObject({ outcome: "RECONCILE" });
		expect(f.submit).not.toHaveBeenCalled();
		const checks = observer.state.count;
		await expect(
			f.store.recordSubmissionStarted(claim.attemptId, claim.phaseOwner, claim),
		).resolves.toBe(false);
		expect(observer.state.count).toBe(checks);
		expect(
			await client.generationAttempt.findUniqueOrThrow({ where: { id: claim.attemptId } }),
		).toMatchObject({
			status: "SUBMISSION_UNCERTAIN",
			uncertainSubmission: true,
			providerTaskId: null,
		});
		expect(
			await client.creditAccount.findUniqueOrThrow({ where: { id: f.job.reservation!.accountId } }),
		).toMatchObject({ reservedCredits: 5n });
	});

	it("reads owner takeover after a real attempt-row lock wait and never calls the provider", async () => {
		let checkerPid = 0;
		const observer = transactionObserver({
			before: async (tx, index) => {
				if (index === 2) {
					const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
					checkerPid = row!.pid;
				}
			},
		});
		const f = await fixture({ database: observer.database });
		const claim = await f.claim();
		if (!claim.phaseOwner) throw new Error("EXPECTED_PHASE_OWNER");
		const phaseOwner = claim.phaseOwner;
		let holderPid = 0;
		let locked!: () => void;
		const acquired = new Promise<void>((resolve) => {
			locked = resolve;
		});
		let takeOver!: () => void;
		const takeoverAllowed = new Promise<void>((resolve) => {
			takeOver = resolve;
		});
		const holder = client.$transaction(
			async (tx) => {
				const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
				holderPid = row!.pid;
				await tx.$queryRaw`SELECT id FROM "generation_attempt" WHERE id = ${claim.attemptId} FOR UPDATE`;
				locked();
				await takeoverAllowed;
				await tx.$executeRaw`UPDATE "media_workflow_phase_owner" SET "leasedUntil" = clock_timestamp() - INTERVAL '1 second' WHERE "phaseKey" = ${phaseOwner.phaseKey}`;
				return claimImagePhaseOwnerInTransaction(
					{ phase: { kind: "generation", attemptId: claim.attemptId }, workflowId: "replacement" },
					tx,
				);
			},
			{ timeout: 15_000 },
		);
		await acquired;
		const dispatched = dispatchGeneration(f.payload, {
			...f.dependencies,
			store: { ...f.store, claimDispatch: async () => claim },
		});
		let blocked = false;
		try {
			const deadline = performance.now() + 5_000;
			while (performance.now() < deadline) {
				if (checkerPid) {
					const [row] = await client.$queryRaw<
						Array<{ blocked: boolean }>
					>`SELECT ${holderPid}::int = ANY(pg_blocking_pids(${checkerPid}::int)) AS blocked`;
					if (row?.blocked) {
						blocked = true;
						break;
					}
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			await expect(
				f.store.recordSubmissionStarted(claim.attemptId, claim.phaseOwner, claim),
			).resolves.toBe(false);
		} finally {
			takeOver();
		}
		const replacement = await holder;
		const result = await dispatched;
		expect(blocked).toBe(true);
		expect(replacement.owned).toBe(true);
		expect(replacement.phaseOwner?.epoch).toBe(phaseOwner.epoch + 1);
		expect(result).toMatchObject({ outcome: "SKIPPED", phaseOwnershipLost: true });
		expect(f.submit).not.toHaveBeenCalled();
	});
});
