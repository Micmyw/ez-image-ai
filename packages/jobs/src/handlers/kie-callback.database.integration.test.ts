import { PrismaPg } from "@prisma/adapter-pg";
import type { MediaProviderAdapter, NormalizedResult } from "@repo/ai";
import { getAttemptGenerationContinuation, wakeKieGenerationAttempt } from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { executePollingTick } from "../orchestration/polling";
import {
	createDatabaseDispatchStore,
	createDatabaseProviderEventStore,
	createDatabaseReconciliationStore,
} from "../runtime";

const NOTICE_PROVIDER = "kie-image-completion-notice";
const pendingResult: NormalizedResult = {
	outputs: [],
	progress: 10,
	providerCostMicros: null,
	failure: null,
	retryable: false,
	providerCharged: false,
};

describe("Kie completion notices with real PostgreSQL leases", () => {
	let client: PrismaClient;
	let queryCount = 0;
	const jobIds: string[] = [];
	const quoteIds: string[] = [];
	const accountIds: string[] = [];
	const attemptIds: string[] = [];
	beforeAll(() => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString) throw new Error("EXPLICIT_TEST_DATABASE_REQUIRED");
		const url = new URL(connectionString);
		if (
			!["postgres:", "postgresql:"].includes(url.protocol) ||
			url.hostname !== "127.0.0.1" ||
			url.port !== "55432" ||
			(url.pathname !== "/ai_media_foundation_test" &&
				url.pathname !== "/scanless_one_second_fence_test" &&
				!/^\/ezpic_[a-z0-9_]+_test$/.test(url.pathname)) ||
			url.search !== "" ||
			url.hash !== ""
		)
			throw new Error("UNSAFE_TEST_DATABASE");
		const observed = new PrismaClient({
			adapter: new PrismaPg({ connectionString, max: 6 }),
			log: [{ level: "query", emit: "event" }],
		});
		observed.$on("query", () => queryCount++);
		client = observed;
	});
	afterAll(async () => {
		if (!client) return;
		await client.providerWebhookEvent.deleteMany({
			where: {
				provider: NOTICE_PROVIDER,
				OR: attemptIds.map((attemptId) => ({
					envelope: { path: ["attemptId"], equals: attemptId },
				})),
			},
		});
		await client.outboxEvent.deleteMany({ where: { aggregateId: { in: jobIds } } });
		await client.creditReservation.deleteMany({ where: { jobId: { in: jobIds } } });
		await client.generationJob.deleteMany({ where: { id: { in: jobIds } } });
		await client.generationQuote.deleteMany({ where: { id: { in: quoteIds } } });
		await client.creditAccount.deleteMany({ where: { id: { in: accountIds } } });
		await client.$disconnect();
	});

	async function fixture(options: { bound?: boolean; engine?: string; provider?: string } = {}) {
		const id = crypto.randomUUID();
		const providerTaskId = `task-${id}`;
		const quote = {
			ownerType: "USER" as const,
			ownerId: id,
			submittedByUserId: id,
			productKey: "image-nano-banana-2-lite",
			catalogVersion: "callback-test",
			pricingVersion: "callback-test",
			inputSnapshot: {},
			pricingSnapshot: {},
		};
		const job = await client.generationJob.create({
			data: {
				...quote,
				quote: { create: { ...quote, credits: 5n, costMicros: 10n, expiresAt: new Date() } },
				idempotencyKey: id,
				creditsReserved: 5n,
				status: options.bound === false ? "SUBMITTING" : "PROVIDER_PENDING",
				executionEngine: options.engine ?? "legacy",
				attempts: {
					create: {
						id,
						attemptNumber: 1,
						provider: options.provider ?? "kie",
						providerModelId: "nano-banana-2-lite",
						providerTaskId: options.bound === false ? null : providerTaskId,
						status: options.bound === false ? "SUBMISSION_UNCERTAIN" : "SUBMITTED",
						uncertainSubmission: options.bound === false,
						requestSnapshot: {},
						submittedAt: new Date(),
						nextReconcileAt: new Date(Date.now() + 60_000),
					},
				},
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
		attemptIds.push(id);
		return {
			attemptId: id,
			providerTaskId,
			job,
			wake: (taskId = providerTaskId) =>
				wakeKieGenerationAttempt({ attemptId: id, providerTaskId: taskId }, client),
			read: () => client.generationAttempt.findUniqueOrThrow({ where: { id } }),
			notices: () =>
				client.providerWebhookEvent.findMany({
					where: { provider: NOTICE_PROVIDER, envelope: { path: ["attemptId"], equals: id } },
				}),
		};
	}

	async function singleRead<T>(read: () => Promise<T>): Promise<T> {
		const before = queryCount;
		const result = await read();
		expect(queryCount - before).toBe(1);
		return result;
	}

	it("reads the active attempt and current job status in one fresh polling statement", async () => {
		const f = await fixture();
		const store = createDatabaseReconciliationStore(client);
		const attempt = await f.read();
		expect(await singleRead(() => store.getPollingState(f.attemptId))).toEqual({
			pollAt: attempt.nextReconcileAt,
			leasedUntil: null,
		});
		const leasedUntil = new Date(Date.now() + 120_000);
		await client.generationAttempt.update({
			where: { id: f.attemptId },
			data: { nextReconcileAt: new Date(0), reconcileLeasedUntil: leasedUntil },
		});
		expect(await singleRead(() => store.getPollingState(f.attemptId))).toEqual({
			pollAt: leasedUntil,
			leasedUntil,
		});
		await client.generationAttempt.update({
			where: { id: f.attemptId },
			data: { nextReconcileAt: null, reconcileLeasedUntil: null },
		});
		expect(await singleRead(() => store.getPollingState(f.attemptId))).toEqual({
			pollAt: new Date(0),
			leasedUntil: null,
		});
		await client.generationJob.update({
			where: { id: f.job.id },
			data: { status: "NEEDS_RECONCILIATION" },
		});
		expect(await singleRead(() => store.getPollingState(f.attemptId))).toBeNull();
		await client.generationJob.update({
			where: { id: f.job.id },
			data: { status: "PROVIDER_PENDING" },
		});
		const foreign = await fixture({ engine: "video-workflow-v1" });
		expect(await singleRead(() => store.getPollingState(foreign.attemptId))).toBeNull();
		await client.generationAttempt.update({
			where: { id: f.attemptId },
			data: { providerTaskId: "" },
		});
		expect(await singleRead(() => store.getPollingState(f.attemptId))).toBeNull();
		await client.generationAttempt.update({
			where: { id: f.attemptId },
			data: { providerTaskId: f.providerTaskId, status: "SUCCEEDED" },
		});
		expect(await singleRead(() => store.getPollingState(f.attemptId))).toBeNull();
		expect(await singleRead(() => store.getPollingState(crypto.randomUUID()))).toBeNull();
		const before = queryCount;
		await expect(store.getPollingState(" ")).rejects.toThrow("INVALID_GENERATION_ATTEMPT_ID");
		expect(queryCount).toBe(before);
	});

	it("reads only the attempt's pending or leased continuation events in one fresh statement", async () => {
		const f = await fixture();
		expect(await singleRead(() => getAttemptGenerationContinuation(f.attemptId, client))).toEqual({
			eventIds: [],
		});
		const finalizeId = crypto.randomUUID();
		const settleId = crypto.randomUUID();
		const availableAt = new Date(Date.now() + 60_000);
		await client.outboxEvent.createMany({
			data: [
				{
					id: finalizeId,
					eventType: "GENERATION_FINALIZE",
					aggregateType: "GENERATION_JOB",
					aggregateId: f.job.id,
					dedupeKey: `generation-finalize:${f.job.id}:${f.attemptId}`,
					payload: { jobId: f.job.id },
					availableAt,
				},
				{
					id: settleId,
					eventType: "GENERATION_SETTLE",
					aggregateType: "GENERATION_JOB",
					aggregateId: f.job.id,
					dedupeKey: `generation-settle:${f.job.id}`,
					payload: { jobId: f.job.id },
					status: "LEASED",
					availableAt,
				},
				{
					eventType: "GENERATION_FINALIZE",
					aggregateType: "GENERATION_JOB",
					aggregateId: f.job.id,
					dedupeKey: `generation-finalize:${f.job.id}:${crypto.randomUUID()}`,
					payload: { jobId: f.job.id },
				},
			],
		});
		expect(await singleRead(() => getAttemptGenerationContinuation(f.attemptId, client))).toEqual({
			eventIds: [finalizeId, settleId].sort(),
		});
		await client.outboxEvent.update({ where: { id: settleId }, data: { status: "PROCESSED" } });
		await client.outboxEvent.update({
			where: { id: finalizeId },
			data: { aggregateType: "MEDIA_ASSET" },
		});
		expect(await singleRead(() => getAttemptGenerationContinuation(f.attemptId, client))).toEqual({
			eventIds: [],
		});
		await client.outboxEvent.update({
			where: { id: finalizeId },
			data: { aggregateType: "GENERATION_JOB" },
		});
		expect(await singleRead(() => getAttemptGenerationContinuation(f.attemptId, client))).toEqual({
			eventIds: [finalizeId],
		});
		expect(
			await singleRead(() => getAttemptGenerationContinuation(crypto.randomUUID(), client)),
		).toEqual({
			eventIds: [],
		});
	});

	async function claim(f: Awaited<ReturnType<typeof fixture>>, forceDue = true) {
		if (forceDue)
			await client.generationAttempt.update({
				where: { id: f.attemptId },
				data: { nextReconcileAt: new Date(0) },
			});
		const leases = await createDatabaseReconciliationStore(client).claimStale({
			attemptId: f.attemptId,
			limit: 1,
			leaseSeconds: 60,
			now: new Date(),
		});
		expect(leases).toHaveLength(1);
		return leases[0]!;
	}
	async function recordAccepted(f: Awaited<ReturnType<typeof fixture>>, taskId = f.providerTaskId) {
		await createDatabaseDispatchStore(client).recordSubmission(f.attemptId, {
			outcome: "accepted",
			providerTaskId: taskId,
			status: "QUEUED",
			idempotency: { key: f.attemptId, providerSupported: false, replayed: false },
			reconciliation: { submissionToken: f.attemptId },
		});
	}

	it("persists an early notice without accepting a task and uses it after the real submission binds", async () => {
		const f = await fixture({ bound: false });
		const before = await f.read();
		expect(await f.wake()).toBe("recorded");
		expect(await f.read()).toEqual(before);
		expect(await f.notices()).toHaveLength(1);
		await recordAccepted(f);
		expect((await f.read()).nextReconcileAt!.getTime()).toBeLessThanOrEqual(Date.now());
		expect(
			await client.creditReservation.findUnique({ where: { id: f.job.reservation!.id } }),
		).toEqual(f.job.reservation);
		await claim(f, false);
		expect((await f.notices())[0]?.status).toBe("PROCESSED");
	});

	it("never binds or accelerates a mismatched early task notification", async () => {
		const f = await fixture({ bound: false });
		expect(await f.wake("untrusted-task")).toBe("recorded");
		await recordAccepted(f);
		expect(await f.read()).toMatchObject({
			providerTaskId: f.providerTaskId,
			uncertainSubmission: false,
		});
		expect((await f.read()).nextReconcileAt!.getTime()).toBeGreaterThan(Date.now() + 5_000);
		expect(await f.wake("untrusted-task")).toBe("invalid");
	});

	it("does not let an in-flight PENDING query overwrite the callback received during retrieval", async () => {
		const f = await fixture();
		const lease = await claim(f);
		let release!: () => void;
		let entered!: () => void;
		const blocker = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const store = createDatabaseReconciliationStore(client, {
			afterAttemptRead: async () => {
				entered();
				await blocker;
			},
		});
		const pending = store.recordReconciled(
			lease,
			{ providerTaskId: f.providerTaskId, status: "RUNNING", raw: {} },
			pendingResult,
		);
		await started;
		try {
			expect(await f.wake()).toBe("ready");
			expect((await f.read()).reconcileLeaseToken).toBe(lease.leaseToken);
		} finally {
			release();
		}
		await pending;
		expect((await f.read()).nextReconcileAt!.getTime()).toBeLessThanOrEqual(Date.now());
		const nextLease = await claim(f, false);
		await createDatabaseReconciliationStore(client).recordReconciled(
			nextLease,
			{ providerTaskId: f.providerTaskId, status: "RUNNING", raw: {} },
			pendingResult,
		);
		const after = await f.read();
		expect(after.nextReconcileAt!.getTime()).toBeGreaterThan(Date.now() + 5_000);
		expect(await f.wake()).toBe("recorded");
		expect(await f.read()).toEqual(after);
	});

	it.each(["RUNNING", "SUCCEEDED"] as const)(
		"one real polling tick immediately consumes a during-query notice and observes %s without resubmitting",
		async (secondStatus) => {
			const f = await fixture({ bound: false });
			const queryLeases: string[] = [];
			const adapter = {
				provider: "kie",
				submit: vi.fn<MediaProviderAdapter["submit"]>(async () => ({
					outcome: "accepted",
					providerTaskId: f.providerTaskId,
					status: "QUEUED",
					idempotency: { key: f.attemptId, providerSupported: false, replayed: false },
					reconciliation: { submissionToken: f.attemptId },
				})),
				retrieve: vi.fn<MediaProviderAdapter["retrieve"]>(async ({ providerTaskId }) => {
					expect(providerTaskId).toBe(f.providerTaskId);
					const leased = await f.read();
					expect(leased.reconcileLeaseToken).toEqual(expect.any(String));
					expect(leased.reconcileLeasedUntil!.getTime()).toBeGreaterThan(Date.now());
					queryLeases.push(leased.reconcileLeaseToken!);
					if (queryLeases.length === 1) {
						expect(await f.notices()).toEqual([]);
						expect(await f.wake()).toBe("ready");
						expect((await f.read()).reconcileLeaseToken).toBe(leased.reconcileLeaseToken);
						expect((await f.notices())[0]?.status).toBe("RECEIVED");
					} else {
						expect(queryLeases).toHaveLength(2);
						expect((await f.notices())[0]?.status).toBe("PROCESSED");
					}
					return {
						providerTaskId,
						status: queryLeases.length === 1 ? "RUNNING" : secondStatus,
						raw: {},
						retrieval: { source: "kie-record-info", observedAt: new Date().toISOString() },
					};
				}),
				normalizeResult: vi.fn<MediaProviderAdapter["normalizeResult"]>(async (snapshot) => ({
					...pendingResult,
					outputs:
						snapshot.status === "SUCCEEDED"
							? [
									{
										kind: "remote-url",
										url: `https://provider.example/${f.providerTaskId}.png`,
										trust: "untrusted-transfer-candidate",
									},
								]
							: [],
				})),
			} satisfies MediaProviderAdapter;
			// One simulated provider send and its actual persisted acknowledgement precede polling.
			await createDatabaseDispatchStore(client).recordSubmission(
				f.attemptId,
				await adapter.submit({
					attemptId: f.attemptId,
					providerModelId: "nano-banana-2-lite",
					input: { kind: "text-to-image", prompt: "callback polling regression" },
				}),
			);
			await client.generationAttempt.update({
				where: { id: f.attemptId },
				data: { nextReconcileAt: new Date(0) },
			});
			const getProvider = vi.fn(() => adapter);
			const tick = await executePollingTick(
				{ attemptId: f.attemptId },
				{
					store: createDatabaseReconciliationStore(client),
					getProvider,
					continuation: (attemptId) => getAttemptGenerationContinuation(attemptId, client),
				},
			);
			expect(adapter.submit).toHaveBeenCalledTimes(1);
			expect(adapter.retrieve).toHaveBeenCalledTimes(2);
			expect(getProvider.mock.calls).toEqual([["kie"], ["kie"]]);
			expect(new Set(queryLeases).size).toBe(2);
			expect(await client.generationAttempt.count({ where: { jobId: f.job.id } })).toBe(1);
			expect(
				await client.creditReservation.findUnique({ where: { id: f.job.reservation!.id } }),
			).toEqual(f.job.reservation);
			const attempt = await f.read();
			expect(attempt.reconcileLeaseToken).toBeNull();
			expect((await f.notices())[0]?.status).toBe("PROCESSED");
			if (secondStatus === "SUCCEEDED") {
				expect(tick).toMatchObject({ done: true, waitSeconds: 0, outboxCommitted: true });
				expect(tick.continuation?.eventIds).toHaveLength(1);
				expect(attempt.status).toBe("SUCCEEDED");
				expect(attempt.nextReconcileAt).toBeNull();
			} else {
				expect(tick).toMatchObject({ done: false, outboxCommitted: false });
				expect(tick.waitSeconds).toBeGreaterThan(0);
				expect(tick.retryImmediately).toBeUndefined();
				expect(attempt.nextReconcileAt!.getTime()).toBeGreaterThan(Date.now());
				expect(await f.wake()).toBe("recorded");
				expect(await f.read()).toEqual(attempt);
			}
		},
	);

	it("the real polling tick keeps backoff after a consumed-notice retrieval fails", async () => {
		const f = await fixture();
		expect(await f.wake()).toBe("ready");
		const adapter = {
			provider: "kie" as const,
			submit: vi.fn<MediaProviderAdapter["submit"]>(),
			retrieve: vi
				.fn<MediaProviderAdapter["retrieve"]>()
				.mockRejectedValue(new Error("provider unavailable")),
			normalizeResult: vi.fn<MediaProviderAdapter["normalizeResult"]>(),
		};
		const dependencies = {
			store: createDatabaseReconciliationStore(client),
			getProvider: () => adapter,
		};
		const tick = await executePollingTick({ attemptId: f.attemptId }, dependencies);
		expect(tick).toEqual({ done: false, waitSeconds: 60, outboxCommitted: false });
		expect(adapter.retrieve).toHaveBeenCalledTimes(1);
		expect(adapter.submit).not.toHaveBeenCalled();
		const attempt = await f.read();
		expect(attempt.nextReconcileAt!.getTime()).toBeGreaterThan(Date.now() + 100_000);
		expect(attempt.reconcileLeaseToken).toBeNull();
		expect((await f.notices())[0]?.status).toBe("PROCESSED");
		expect(await f.wake()).toBe("recorded");
		await executePollingTick({ attemptId: f.attemptId }, dependencies);
		expect(adapter.retrieve).toHaveBeenCalledTimes(1);
		expect(await f.read()).toEqual(attempt);
	});

	it("the real polling tick leaves an active query owner and its unconsumed notice alone", async () => {
		const f = await fixture();
		await claim(f);
		expect(await f.wake()).toBe("ready");
		const attempt = await f.read();
		const getProvider = vi.fn(() => {
			throw new Error("active lease must not retrieve");
		});
		const tick = await executePollingTick(
			{ attemptId: f.attemptId },
			{
				store: createDatabaseReconciliationStore(client),
				getProvider,
			},
		);
		expect(tick).toEqual({ done: false, waitSeconds: 5, outboxCommitted: false });
		expect(getProvider).not.toHaveBeenCalled();
		expect(await f.read()).toEqual(attempt);
		expect((await f.notices())[0]?.status).toBe("RECEIVED");
	});

	it("preserves a notice through a failed in-flight query, then respects backoff after consumption", async () => {
		const f = await fixture();
		const lease = await claim(f);
		expect(await f.wake()).toBe("ready");
		const store = createDatabaseReconciliationStore(client);
		await store.releaseReconciliationLease(
			lease,
			"RECONCILIATION_RETRY",
			new Date(Date.now() + 120_000),
		);
		expect((await f.read()).nextReconcileAt!.getTime()).toBeLessThanOrEqual(Date.now());
		const second = await claim(f, false);
		const retryAt = new Date(Date.now() + 120_000);
		await store.releaseReconciliationLease(second, "RECONCILIATION_RETRY", retryAt);
		expect(await f.wake()).toBe("recorded");
		expect((await f.read()).nextReconcileAt).toEqual(retryAt);
	});

	it("deduplicates concurrent notices and keeps them out of provider evidence processing", async () => {
		const f = await fixture();
		const outcomes = await Promise.all([f.wake(), f.wake(), f.wake(), f.wake()]);
		expect(outcomes).toEqual(["ready", "ready", "ready", "ready"]);
		const notices = await f.notices();
		expect(notices).toHaveLength(1);
		const [notice] = notices;
		expect(notice).toMatchObject({ status: "RECEIVED", providerTaskId: f.providerTaskId });
		const beforeRetry = await f.read();
		expect(await f.wake()).toBe("ready");
		expect(await f.read()).toEqual(beforeRetry);
		expect(
			await createDatabaseProviderEventStore(client).claimProviderEvent(notice!.id),
		).toBeNull();
		expect((await f.notices())[0]?.status).toBe("RECEIVED");
		expect(await client.outboxEvent.count({ where: { aggregateId: notice!.id } })).toBe(0);
	});

	it("retains unknown acceptance and credit holds for bound uncertain tasks", async () => {
		const f = await fixture();
		await client.generationAttempt.update({
			where: { id: f.attemptId },
			data: { status: "SUBMISSION_UNCERTAIN", uncertainSubmission: true },
		});
		expect(await f.wake()).toBe("ready");
		expect(await f.read()).toMatchObject({
			status: "SUBMISSION_UNCERTAIN",
			uncertainSubmission: true,
		});
		expect(
			await client.creditReservation.findUnique({ where: { id: f.job.reservation!.id } }),
		).toEqual(f.job.reservation);
	});

	it.each([false, true])(
		"early notices preserve unknown acceptance when real recovery has a task ID: %s",
		async (hasTaskId) => {
			const f = await fixture({ bound: false });
			expect(await f.wake()).toBe("recorded");
			await createDatabaseDispatchStore(client).recordUncertainSubmission(f.attemptId, {
				classification: "malformed_2xx",
				phase: "post_send",
				...(hasTaskId ? { providerTaskId: f.providerTaskId } : {}),
			});
			const attempt = await f.read();
			expect(attempt).toMatchObject({
				status: "SUBMISSION_UNCERTAIN",
				uncertainSubmission: true,
				providerTaskId: hasTaskId ? f.providerTaskId : null,
			});
			if (hasTaskId) expect(attempt.nextReconcileAt!.getTime()).toBeLessThanOrEqual(Date.now());
			else expect(attempt.nextReconcileAt!.getTime()).toBeGreaterThan(Date.now() + 20_000);
			expect(
				await client.creditReservation.findUnique({ where: { id: f.job.reservation!.id } }),
			).toEqual(f.job.reservation);
		},
	);

	it("a callback arriving behind the PENDING commit lock makes that committed retry immediately due", async () => {
		const f = await fixture();
		const lease = await claim(f);
		let release!: () => void;
		let entered!: () => void;
		const blocker = new Promise<void>((resolve) => {
			release = resolve;
		});
		const locked = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const store = createDatabaseReconciliationStore(client, {
			afterAttemptUpdate: async () => {
				entered();
				await blocker;
			},
		});
		const query = store.recordReconciled(
			lease,
			{ providerTaskId: f.providerTaskId, status: "RUNNING", raw: {} },
			pendingResult,
		);
		await locked;
		const callback = f.wake();
		release();
		const [, outcome] = await Promise.all([query, callback]);
		expect(outcome).toBe("ready");
		expect((await f.read()).nextReconcileAt!.getTime()).toBeLessThanOrEqual(Date.now());
		await claim(f, false);
	});

	it("does not resurrect terminal attempts or create completion evidence", async () => {
		const f = await fixture();
		await client.generationAttempt.update({
			where: { id: f.attemptId },
			data: { status: "SUCCEEDED", nextReconcileAt: null },
		});
		expect(await f.wake()).toBe("terminal");
		expect(await f.notices()).toEqual([]);
		expect(await f.read()).toMatchObject({ status: "SUCCEEDED", nextReconcileAt: null });
	});

	it.each([{ engine: "video-workflow-v1" }, { provider: "replicate" }])(
		"rejects foreign owners %j without a notification",
		async (options) => {
			const f = await fixture(options);
			expect(await f.wake()).toBe("invalid");
			expect(await f.notices()).toEqual([]);
		},
	);

	it("a claim crash still recovers after the ordinary lease expires", async () => {
		const f = await fixture();
		expect(await f.wake()).toBe("ready");
		await claim(f, false);
		expect((await f.notices())[0]?.status).toBe("PROCESSED");
		await client.generationAttempt.update({
			where: { id: f.attemptId },
			data: { reconcileLeasedUntil: new Date(0) },
		});
		await claim(f, false);
		expect(await f.wake()).toBe("recorded");
	});
});
