import { createRouteGraphSnapshot } from "@repo/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capacity = vi.hoisted(() => ({ available: false, order: [] as string[] }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database", () => ({
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
	lockProviderDispatchCapacity: vi.fn(async (_tx, provider: string) => {
		capacity.order.push(`provider-lock:${provider}`);
	}),
	hasProviderDispatchCapacity: vi.fn(async (_tx, provider: string) => {
		capacity.order.push(`capacity:${provider}`);
		return capacity.available;
	}),
	resolveGuestRuntimeConfigOverride: vi.fn(async () => true),
	expireGuestJobBeforeProvider: vi.fn(async (input: { jobId: string }) => ({
		outcome: "EXPIRED",
		jobId: input.jobId,
	})),
}));

import { createDatabaseDispatchStore } from "./runtime";

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
			capacity.order.push(`lock:${key}`);
			return 0;
		}),
		$queryRaw: vi.fn(async () => [{ id: "guest-trial" }]),
		generationJob: {
			findUnique: vi.fn(async () => job),
			count: vi.fn(async () => 0),
			findFirst: vi.fn(async (args: { select?: unknown }) => {
				if (args.select) return null;
				capacity.order.push("read-job");
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
			updateMany: vi.fn(),
		},
		guestMediaTrial: { updateMany: vi.fn() },
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
		capacity.available = false;
		capacity.order = [];
	});
	afterEach(() => vi.useRealTimers());

	it("commits a due Outbox event without crossing the provider send fence", async () => {
		const f = fixture();
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
		expect(capacity.order.indexOf("provider-lock:kie")).toBeLessThan(
			capacity.order.indexOf(`lock:generation-dispatch:${f.job.id}`),
		);
		expect(capacity.order.lastIndexOf("read-job")).toBeGreaterThan(
			capacity.order.indexOf("provider-lock:kie"),
		);
		expect(f.database.$transaction).toHaveBeenCalledWith(expect.any(Function), {
			isolationLevel: "ReadCommitted",
			maxWait: 5_000,
			timeout: 20_000,
		});
	});

	it("keeps a waiting guest's trial and risk reservation untouched", async () => {
		const f = fixture(true);
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
		await f.store.claimDispatch({ jobId: f.job.id, version: 4 });
		capacity.available = true;
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

	it("locks the pinned provider before reading or locking the job", async () => {
		const f = fixture();
		await f.store.claimDispatch({
			jobId: f.job.id,
			version: 4,
			provider: "kie",
			providerModelId: route.providerModelId,
		});
		expect(capacity.order.slice(0, 3)).toEqual([
			"provider-lock:kie",
			`lock:generation-dispatch:${f.job.id}`,
			"read-job",
		]);
	});

	it.each([
		{ uncertainSubmission: true },
		{ submittedAt: now },
		{ providerTaskId: "provider-accepted-task" },
	])("never resends a historical CREATED attempt with send evidence %j", async (evidence) => {
		const f = fixture();
		capacity.available = true;
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

	it("preserves the old guest single-active scheduling guard even when supplier capacity is free", async () => {
		const f = fixture(true);
		capacity.available = true;
		f.tx.generationJob.findFirst.mockImplementation(async (args: { select?: unknown }) =>
			args.select ? { ...f.job, id: "other-active-guest" } : f.job,
		);
		expect(await f.store.claimDispatch({ jobId: f.job.id, version: 4 })).toBeNull();
		expect(f.tx.generationAttempt.create).not.toHaveBeenCalled();
		expect(f.tx.guestRiskBudgetBucket.updateMany).not.toHaveBeenCalled();
	});
	it("preserves the old ten-minute unsent guest expiry guard", async () => {
		const f = fixture(true);
		capacity.available = true;
		Object.assign(f.job, { createdAt: new Date(now.getTime() - 10 * 60_000) });
		expect(await f.store.claimDispatch({ jobId: f.job.id, version: 4 })).toBeNull();
		expect(f.tx.generationAttempt.create).not.toHaveBeenCalled();
	});
});
