import { createRouteGraphSnapshot } from "@repo/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatchOrder = vi.hoisted(() => [] as string[]);
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database", async (importOriginal) => ({
	prepareGenerationSubmissionInTransaction: (
		await importOriginal<typeof import("@repo/database")>()
	).prepareGenerationSubmissionInTransaction,
	getImagePhaseOwner: async () => undefined,
	runReadCommitted: async (
		database: { $transaction(operation: unknown, options: unknown): Promise<unknown> },
		operation: unknown,
	) =>
		database.$transaction(operation, {
			isolationLevel: "ReadCommitted",
			maxWait: 5_000,
			timeout: 20_000,
		}),
	PROVIDER_DISPATCH_RETRY_MS: 5_000,
	resolveGuestRuntimeConfigOverride: vi.fn(async () => true),
	expireGuestJobBeforeProvider: vi.fn(async (input: { jobId: string }) => ({
		outcome: "EXPIRED",
		jobId: input.jobId,
	})),
}));

import { createDatabaseDispatchStore, createDatabaseGuestAdmissionDependencies } from "./runtime";

const now = new Date("2026-10-19T12:00:00Z");
const route = {
	provider: "kie" as const,
	providerModelId: "nano-banana-2-lite",
	providerCostMicros: 20_000,
	weight: 100,
};

function fixture(guest = false) {
	const job = {
		id: "provider-queue-job",
		version: 4,
		ownerType: "USER",
		ownerId: "funded-owner",
		status: "DISPATCH_QUEUED",
		serviceClass: "STANDARD",
		productKey: "image-nano-banana-2-lite",
		catalogVersion: "2026-09-07.2",
		pricingVersion: "2026-09-07.2",
		dispatchEligibleAt: null as Date | null,
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
		},
		quote: { costMicros: 20_000n, moderationDecision: "ALLOW" },
		attempts: [] as Array<Record<string, unknown>>,
		assets: [],
		guestTrial: null,
	};
	if (guest) {
		Object.assign(job, {
			ownerId: "guest-owner",
			serviceClass: "GUEST_SLOW",
			guestTrialId: "guest-trial",
			creditsReserved: 10n,
			createdAt: new Date(now.getTime() - 1_000),
			guestTrial: {
				id: "guest-trial",
				ownerId: "guest-owner",
				promotionPeriod: "queue-test",
				eligibility: "IN_FLIGHT",
				riskState: "HELD",
				frozenQuotedRiskMicros: 20_000n,
				sponsorCredits: 10n,
				currentJobId: job.id,
				consumedJobId: null,
				expiresAt: new Date(now.getTime() + 60_000),
				linkedAt: null,
				providerBoundaryAt: null,
				linkIntents: [],
			},
		});
	}
	const events = new Map<string, { id: string; availableAt: Date; payload: unknown }>();
	const tx = {
		$executeRaw: vi.fn(async (_query: unknown, key: string) => {
			dispatchOrder.push(`lock:${key}`);
			return 0;
		}),
		$queryRaw: vi.fn(async (sql: TemplateStringsArray, ..._values: unknown[]) =>
			sql.join("?").includes('UPDATE "generation_attempt" AS attempt')
				? [{ attemptRowVersion: "101", jobRowVersion: "101" }]
				: [{ id: "guest-trial" }],
		),
		generationJob: {
			findUnique: vi.fn(async () => job),
			count: vi.fn(async () => 0),
			findFirst: vi.fn(async (args: { select?: unknown }) => {
				if (args.select) return null;
				dispatchOrder.push("read-job");
				return job;
			}),
			updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				if (data.dispatchEligibleAt) job.dispatchEligibleAt = data.dispatchEligibleAt as Date;
				if (typeof data.status === "string") job.status = data.status;
				return { count: 1 };
			}),
		},
		generationAttempt: {
			create: vi.fn(async () => ({ id: "attempt-1", attemptNumber: 1 })),
			update: vi.fn(async () => ({})),
		},
		guestRiskBudgetBucket: {
			findUnique: vi.fn(async () => ({
				expiresAt: new Date(now.getTime() + 60_000),
				reservedMicros: 20_000n,
				consumedMicros: 0n,
				hardLimitMicros: 250_000n,
			})),
			updateMany: vi.fn(async () => ({ count: 1 })),
		},
		guestMediaTrial: { updateMany: vi.fn(async () => ({ count: 1 })) },
		runtimeConfigOverride: { findFirst: vi.fn(async () => null) },
		outboxEvent: {
			upsert: vi.fn(async ({ where, create }) => {
				if (!events.has(where.dedupeKey)) {
					events.set(where.dedupeKey, { id: `event-${events.size + 1}`, ...create });
				}
				return events.get(where.dedupeKey)!;
			}),
		},
	};
	const database = {
		$transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
	};
	const options = {
		environment: {
			NODE_ENV: "test",
			MEDIA_GENERATION_ENABLED: "true",
			MEDIA_NANO_BANANA_2_LITE_ENABLED: "true",
			VIDEO_V1_PROVIDER_CONCURRENCY: "5",
			GUEST_MEDIA_ENABLED: "true",
			GUEST_PROMOTION_PERIOD: "queue-test",
			GUEST_RISK_BUDGET_MICROS: "250000",
		},
		enabledProviders: new Set(["kie"] as const),
	};
	const store = createDatabaseDispatchStore(database as never, options);
	return { job, tx, database, store, events, options };
}

describe("durable provider dispatch waiting", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		dispatchOrder.length = 0;
	});
	afterEach(() => vi.useRealTimers());

	it("dispatches four independently accepted jobs despite an unverified project limit of two", async () => {
		const fixtures = Array.from({ length: 4 }, (_, index) => {
			const f = fixture();
			f.job.id = `accepted-job-${index}`;
			f.job.ownerId = `funded-owner-${index}`;
			f.options.environment.VIDEO_V1_PROVIDER_CONCURRENCY = "2";
			return f;
		});
		const claims = await Promise.all(
			fixtures.map((f) => f.store.claimDispatch({ jobId: f.job.id, version: 4 })),
		);
		for (const [index, claim] of claims.entries()) {
			expect(claim).toMatchObject({ attemptId: "attempt-1", provider: "kie" });
			expect(fixtures[index]!.tx.generationAttempt.create).toHaveBeenCalledOnce();
			const preparation = fixtures[index]!.tx.$queryRaw.mock.calls.find(([sql]) =>
				sql.join("?").includes('UPDATE "generation_attempt" AS attempt'),
			);
			expect(preparation?.[0].join("?")).toContain('"uncertainSubmission" = true');
			expect(JSON.parse(preparation?.[3] as string)).toMatchObject({ submissionPhase: "pre_send" });
			expect(fixtures[index]!.tx.generationAttempt.update).not.toHaveBeenCalled();
		}
		expect(dispatchOrder.filter((value) => value.startsWith("lock:"))).toEqual(
			fixtures.map((f) => `lock:generation-dispatch:${f.job.id}`),
		);
	});

	it("preserves an already persisted due time without crossing the provider send fence", async () => {
		const f = fixture();
		f.job.dispatchEligibleAt = new Date(now.getTime() + 5_000);
		const result = await f.store.claimDispatch({ jobId: f.job.id, version: f.job.version });
		expect(result).toEqual({
			deferred: true,
			retryAfterMs: 5_000,
			continuation: { eventIds: ["event-1"], notBefore: now.getTime() + 5_000 },
		});
		expect(f.job.dispatchEligibleAt).toEqual(new Date(now.getTime() + 5_000));
		expect([...f.events.values()]).toEqual([
			expect.objectContaining({
				eventType: "GENERATION_DISPATCH",
				availableAt: f.job.dispatchEligibleAt,
				payload: { jobId: f.job.id, version: 4 },
			}),
		]);
		expect(f.tx.generationAttempt.create).not.toHaveBeenCalled();
		expect(f.tx.generationAttempt.update).not.toHaveBeenCalled();
		expect(f.tx.guestRiskBudgetBucket.updateMany).not.toHaveBeenCalled();
		expect(f.tx.guestMediaTrial.updateMany).not.toHaveBeenCalled();
		expect(f.tx.generationJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: { dispatchEligibleAt: f.job.dispatchEligibleAt } }),
		);
		expect(dispatchOrder).toEqual([`lock:generation-dispatch:${f.job.id}`, "read-job"]);
		expect(f.database.$transaction).toHaveBeenCalledWith(expect.any(Function), {
			isolationLevel: "ReadCommitted",
			maxWait: 5_000,
			timeout: 20_000,
		});
	});

	it("keeps a waiting guest's trial and risk reservation untouched", async () => {
		const f = fixture(true);
		f.job.dispatchEligibleAt = new Date(now.getTime() + 5_000);
		expect(await f.store.claimDispatch({ jobId: f.job.id, version: 4 })).toMatchObject({
			deferred: true,
		});
		expect(f.tx.generationAttempt.create).not.toHaveBeenCalled();
		expect(f.tx.guestRiskBudgetBucket.updateMany).not.toHaveBeenCalled();
		expect(f.tx.guestMediaTrial.updateMany).not.toHaveBeenCalled();
		expect(f.job).toMatchObject({
			guestTrial: { eligibility: "IN_FLIGHT", riskState: "HELD", consumedJobId: null },
		});
	});

	it("reuses the persisted deadline on early replay and can resume from it after process loss", async () => {
		const f = fixture();
		f.job.dispatchEligibleAt = new Date(now.getTime() + 5_000);
		await f.store.claimDispatch({ jobId: f.job.id, version: 4 });
		vi.setSystemTime(new Date(now.getTime() + 1_000));
		expect(await f.store.claimDispatch({ jobId: f.job.id, version: 4 })).toMatchObject({
			deferred: true,
			retryAfterMs: 4_000,
			continuation: { eventIds: ["event-1"], notBefore: now.getTime() + 5_000 },
		});
		expect(f.events.size).toBe(1);
		expect(f.tx.generationAttempt.create).not.toHaveBeenCalled();
		vi.setSystemTime(new Date(now.getTime() + 5_000));
		const restartedStore = createDatabaseDispatchStore(f.database as never, f.options);
		expect(await restartedStore.claimDispatch({ jobId: f.job.id, version: 4 })).toMatchObject({
			attemptId: "attempt-1",
			provider: "kie",
		});
		expect(f.tx.generationAttempt.create).toHaveBeenCalledOnce();
	});

	it("validates the pinned route from one authoritative read under the job lock", async () => {
		const f = fixture();
		await f.store.claimDispatch({
			jobId: f.job.id,
			version: 4,
			provider: "kie",
			providerModelId: route.providerModelId,
		});
		expect(dispatchOrder).toEqual([`lock:generation-dispatch:${f.job.id}`, "read-job"]);
	});

	it.each([
		{ uncertainSubmission: true },
		{ submittedAt: now },
		{ providerTaskId: "provider-accepted-task" },
	])("never resends a historical CREATED attempt with send evidence %j", async (evidence) => {
		const f = fixture();
		f.job.attempts.push({
			id: "historical-attempt",
			attemptNumber: 1,
			status: "CREATED",
			provider: "kie",
			providerModelId: route.providerModelId,
			uncertainSubmission: false,
			submittedAt: null,
			providerTaskId: null,
			...evidence,
		});
		expect(await f.store.claimDispatch({ jobId: f.job.id, version: 4 })).toBeNull();
		expect(f.tx.generationAttempt.create).not.toHaveBeenCalled();
		expect(f.tx.generationAttempt.update).not.toHaveBeenCalled();
		expect(f.tx.generationJob.updateMany).not.toHaveBeenCalled();
	});

	it("allows a queued guest to reach provider scheduling while another guest is active", async () => {
		const f = fixture(true);
		f.job.status = "RESERVED";
		f.tx.generationJob.findFirst.mockImplementation(
			async () => ({ id: "another-active-guest" }) as never,
		);
		const admission = createDatabaseGuestAdmissionDependencies(f.database as never, f.options);
		await expect(
			admission.admit({ jobId: f.job.id, trialId: "guest-trial", now }),
		).resolves.toMatchObject({ outcome: "ADMITTED" });
		expect(f.tx.generationAttempt.create).not.toHaveBeenCalled();
		expect(f.tx.generationJob.findFirst).not.toHaveBeenCalled();
	});

	it("keeps a provider-waiting guest after ten minutes while the real trial is valid", async () => {
		const f = fixture(true);
		Object.assign(f.job, { status: "RESERVED", createdAt: new Date(now.getTime() - 15 * 60_000) });
		const admission = createDatabaseGuestAdmissionDependencies(f.database as never, f.options);
		await expect(
			admission.admit({ jobId: f.job.id, trialId: "guest-trial", now }),
		).resolves.toMatchObject({ outcome: "ADMITTED" });
		expect(f.tx.generationAttempt.create).not.toHaveBeenCalled();
	});

	it("does not inherit a historical estimate as a pre-provider scheduling delay", async () => {
		const f = fixture(true);
		f.job.status = "RESERVED";
		f.job.dispatchEligibleAt = new Date(now.getTime() + 30_000);
		const admission = createDatabaseGuestAdmissionDependencies(f.database as never, f.options);
		await expect(
			admission.admit({ jobId: f.job.id, trialId: "guest-trial", now }),
		).resolves.toMatchObject({ outcome: "ADMITTED" });
		expect(f.job.dispatchEligibleAt).toEqual(now);
		await expect(
			admission.admit({ jobId: f.job.id, trialId: "guest-trial", now }),
		).resolves.toMatchObject({ outcome: "SKIPPED" });
		expect(f.events.size).toBe(1);
	});

	it("does not suppress provider dispatch just because another guest has unfinished work", async () => {
		const f = fixture(true);
		f.tx.generationJob.findFirst.mockImplementation(async (args: { select?: unknown }) => {
			if (args.select) return { id: "another-active-guest" } as never;
			return f.job;
		});
		await expect(f.store.claimDispatch({ jobId: f.job.id, version: 4 })).resolves.toMatchObject({
			attemptId: "attempt-1",
			provider: "kie",
		});
		expect(f.tx.generationAttempt.create).toHaveBeenCalledOnce();
		expect(f.tx.guestRiskBudgetBucket.updateMany).toHaveBeenCalledOnce();
		expect(f.tx.guestMediaTrial.updateMany).toHaveBeenCalledOnce();
	});
});
