import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient, type Prisma } from "../../generated/client";
import {
	claimOutboxBatch,
	prepareWorkflowOutboxEvent,
	prepareWorkflowOutboxDelivery,
	beginWorkflowOutboxExecution,
	completeWorkflowOutboxExecution,
	failWorkflowOutboxExecution,
	deferWorkflowOutboxExecution,
	completeOutboxEvent,
	deferOutboxEvent,
	releaseOutboxEvent,
} from "./outbox";
import { isDatabaseSerializationConflict, type OutboxClaimInput } from "./types";

describe("durable Outbox completion receipts in PostgreSQL", () => {
	let client: PrismaClient;
	const ownedIds: string[] = [];
	const ownedAssets: string[] = [];
	const initialTime = new Date("1900-01-01T00:00:00.000Z");

	beforeAll(() => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString) throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
		const parsed = new URL(connectionString);
		if (
			connectionString === process.env.DATABASE_URL ||
			!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
			!/(^|[_-])(test|testing)([_-]|$)/.test(parsed.pathname.slice(1).toLowerCase())
		) {
			throw new Error("UNSAFE_TEST_DATABASE: use a separate local test database");
		}
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString, max: 60, connectionTimeoutMillis: 5_000 }),
		});
	});

	afterEach(async () => {
		vi.useRealTimers();
		if (ownedIds.length)
			await client.outboxEvent.deleteMany({ where: { id: { in: ownedIds.splice(0) } } });
		if (ownedAssets.length)
			await client.mediaAsset.deleteMany({ where: { id: { in: ownedAssets.splice(0) } } });
	});
	afterAll(async () => client?.$disconnect());

	async function createEvent() {
		const dedupeKey = `test-workflow-receipt:${crypto.randomUUID()}`;
		const event = await client.outboxEvent.create({
			data: {
				eventType: "PAYMENT_EVENT_RECEIVED",
				aggregateType: "PAYMENT_EVENT",
				aggregateId: dedupeKey,
				dedupeKey,
				payload: { paymentEventId: dedupeKey },
				availableAt: initialTime,
			},
		});
		ownedIds.push(event.id);
		return event;
	}

	async function claim(id: string, now: Date, workerId = "receipt-worker") {
		const claims = await claimOutboxBatch({ workerId, limit: 100, leaseSeconds: 60, now }, client);
		const event = claims.find((entry) => entry.id === id);
		expect(event).toBeDefined();
		return event!;
	}

	async function createGenerationEvents(count: number) {
		const ids = Array.from({ length: count }, () => crypto.randomUUID());
		ownedIds.push(...ids);
		await client.outboxEvent.createMany({
			data: ids.map((id) => ({
				id,
				eventType: "GENERATION_DISPATCH",
				aggregateType: "GENERATION_JOB",
				aggregateId: id,
				dedupeKey: `test-targeted-claim:${id}`,
				payload: { jobId: id },
				availableAt: initialTime,
			})),
		});
		return ids;
	}

	function claimBarrier(count: number) {
		let arrived = 0;
		let timedOut = false;
		let release!: () => void;
		const ready = new Promise<void>((resolve) => {
			release = resolve;
		});
		const deadline = setTimeout(() => {
			timedOut = true;
			release();
		}, 5_000);
		return {
			async enter() {
				arrived += 1;
				if (arrived === count) release();
				await ready;
			},
			close() {
				clearTimeout(deadline);
				release();
			},
			get arrived() {
				return arrived;
			},
			get timedOut() {
				return timedOut;
			},
		};
	}

	async function concurrentClaims(inputs: OutboxClaimInput[]) {
		const before = claimBarrier(inputs.length);
		const after = claimBarrier(inputs.length);
		let statements = 0;
		let statementConflicts = 0;
		let commitConflicts = 0;
		let transactions = 0;
		const observed = client.$extends({
			query: {
				async $queryRaw({ args, query }) {
					const firstRound = statements++ < inputs.length;
					if (firstRound) await before.enter();
					try {
						return await query(args);
					} catch (error) {
						if (isDatabaseSerializationConflict(error)) statementConflicts += 1;
						throw error;
					} finally {
						// An explicit transaction remains open here; an atomic statement has
						// already committed. Both exercise the real production claim SQL.
						if (firstRound) await after.enter();
					}
				},
			},
		}) as unknown as PrismaClient;
		const transaction = observed.$transaction.bind(observed);
		const transactionSpy = vi.spyOn(observed, "$transaction").mockImplementation((async (
			operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
			options: Parameters<typeof transaction>[1],
		) => {
			transactions += 1;
			let operationCompleted = false;
			try {
				return await transaction(async (tx) => {
					const value = await operation(tx);
					operationCompleted = true;
					return value;
				}, options);
			} catch (error) {
				if (operationCompleted && isDatabaseSerializationConflict(error)) commitConflicts += 1;
				throw error;
			}
		}) as typeof observed.$transaction);
		const startedAt = performance.now();
		try {
			const results = await Promise.allSettled(
				inputs.map((input) => claimOutboxBatch(input, observed)),
			);
			const rejected = results.filter((result) => result.status === "rejected");
			console.info(
				"outbox.claim.cohort",
				JSON.stringify({
					count: inputs.length,
					distinctEvents: new Set(inputs.flatMap((input) => input.eventIds ?? [])).size,
					before: before.arrived,
					after: after.arrived,
					transactions,
					statements,
					statementConflicts,
					commitConflicts,
					fulfilled: results.length - rejected.length,
					rejected: rejected.length,
					elapsedMs: performance.now() - startedAt,
				}),
			);
			expect(before.arrived).toBe(inputs.length);
			expect(after.arrived).toBe(inputs.length);
			expect(before.timedOut || after.timedOut).toBe(false);
			expect(rejected).toEqual([]);
			expect(statementConflicts + commitConflicts).toBe(0);
			return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
		} finally {
			before.close();
			after.close();
			transactionSpy.mockRestore();
		}
	}

	it("claims 50 independent events at one barrier without serialization conflicts", async () => {
		const ids = await createGenerationEvents(50);
		const claims = await concurrentClaims(
			ids.map((id, index) => ({
				eventIds: [id],
				workerId: `independent-${index}`,
				limit: 1,
				leaseSeconds: 90,
				now: initialTime,
			})),
		);
		expect(claims.map((row) => row.id).sort()).toEqual([...ids].sort());
		expect(new Set(claims.map((row) => row.leaseToken)).size).toBe(50);
		expect(claims.every((row) => row.attempts === 1)).toBe(true);
		expect(
			await client.outboxEvent.count({ where: { id: { in: ids }, status: "LEASED", attempts: 1 } }),
		).toBe(50);
	});

	it("grants one live token when 50 workers claim the same event at one barrier", async () => {
		const [id] = await createGenerationEvents(1);
		const claims = await concurrentClaims(
			Array.from({ length: 50 }, (_, index) => ({
				eventIds: [id!],
				workerId: `contender-${index}`,
				limit: 1,
				leaseSeconds: 90,
				now: initialTime,
			})),
		);
		expect(claims).toHaveLength(1);
		expect(await client.outboxEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
			status: "LEASED",
			attempts: 1,
			leaseToken: claims[0]!.leaseToken,
		});
	});

	it("honors exact due and lease boundaries, including same-worker replay and unknown holds", async () => {
		const due = new Date(initialTime.getTime() + 811);
		const event = await createOutputEvent("INPUT", due);
		const owner = { eventId: event.id, workerId: "boundary-owner" };
		expect(
			await prepareWorkflowOutboxDelivery({ ...owner, now: new Date(due.getTime() - 1) }, client),
		).toEqual({ event: null, retryAfterMs: 1 });
		expect(await client.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
			status: "PENDING",
			attempts: 0,
			leaseToken: null,
		});
		const prepared = await prepareWorkflowOutboxDelivery({ ...owner, now: due }, client);
		const lease = prepared.event!;
		expect(lease).toMatchObject({ id: event.id, attempts: 1 });
		expect(lease.leasedUntil).toEqual(new Date(due.getTime() + 90_000));
		await client.outboxEvent.update({
			where: { id: event.id },
			data: { lastError: "RECOVERY_REQUIRED" },
		});
		const live = new Date(lease.leasedUntil.getTime() - 1);
		expect(await prepareWorkflowOutboxDelivery({ ...owner, now: live }, client)).toMatchObject({
			event: {
				id: event.id,
				leaseToken: lease.leaseToken,
				attempts: 1,
				leasedUntil: lease.leasedUntil,
			},
		});
		expect(
			await prepareWorkflowOutboxDelivery({ ...owner, workerId: "other", now: live }, client),
		).toEqual({ event: null, retryAfterMs: 1 });
		expect(
			await beginWorkflowOutboxExecution(
				{ ...owner, leaseToken: lease.leaseToken, timeoutSeconds: 60, now: live },
				client,
			),
		).toMatchObject({ state: "recovery-required" });
		expect(await client.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
			leaseToken: lease.leaseToken,
			attempts: 1,
			lastError: "RECOVERY_REQUIRED",
			leasedUntil: lease.leasedUntil,
		});
		const reclaimed = await prepareWorkflowOutboxDelivery(
			{ ...owner, now: lease.leasedUntil },
			client,
		);
		expect(reclaimed.event).toMatchObject({ id: event.id, attempts: 2 });
		expect(reclaimed.event!.leaseToken).not.toBe(lease.leaseToken);
		expect(
			(await client.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).lastError,
		).toBeNull();
		expect(
			await completeWorkflowOutboxExecution(
				{ ...owner, leaseToken: lease.leaseToken, now: lease.leasedUntil },
				client,
			),
		).toBe(false);
	});

	it("keeps explicit event provenance and legacy empty payload compatibility", async () => {
		const [valid, legacy, mismatch] = await createGenerationEvents(3);
		await client.outboxEvent.update({ where: { id: legacy }, data: { payload: {} } });
		await client.outboxEvent.update({
			where: { id: mismatch },
			data: { payload: { jobId: valid } },
		});
		const payment = await createEvent();
		const input = await createOutputEvent("INPUT");
		const rows = await claimOutboxBatch(
			{
				eventIds: [valid!, legacy!, mismatch!, payment.id, input.id, "missing"],
				workerId: "provenance",
				limit: 100,
				leaseSeconds: 90,
				now: initialTime,
			},
			client,
		);
		expect(rows.map((row) => row.id).sort()).toEqual([valid, legacy, input.id].sort());
		expect(
			await client.outboxEvent.count({
				where: {
					id: { in: [mismatch!, payment.id] },
					status: "PENDING",
					attempts: 0,
					leaseToken: null,
				},
			}),
		).toBe(2);
	});

	it.each(["targeted", "scan", "legacy-output"] as const)(
		"respects a caller-owned transaction and rolls back its %s claim",
		async (selector) => {
			const event = await createOutputEvent();
			const rollback = new Error("TEST_CALLER_ROLLBACK");
			await expect(
				client.$transaction(
					async (tx) => {
						const rows = await claimOutboxBatch(
							{
								workerId: "caller-owned",
								limit: 100,
								leaseSeconds: 90,
								now: initialTime,
								...(selector === "targeted" ? { eventIds: [event.id] } : {}),
								...(selector === "legacy-output" ? { outputReviewEventId: event.id } : {}),
							},
							tx,
						);
						expect(rows.filter((row) => row.id === event.id)).toHaveLength(1);
						throw rollback;
					},
					{ isolationLevel: "Serializable" },
				),
			).rejects.toBe(rollback);
			expect(await client.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject(
				{
					status: "PENDING",
					attempts: 0,
					leaseToken: null,
					leaseOwner: null,
					leasedUntil: null,
				},
			);
		},
	);

	it.each(["targeted", "scan", "legacy-output"] as const)(
		"shares row locks with the other delivery path while %s owns an uncommitted claim",
		async (winner) => {
			const event = await createOutputEvent();
			let release!: () => void;
			let announce!: () => void;
			let timedOut = false;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const ready = new Promise<void>((resolve) => {
				announce = resolve;
			});
			const deadline = setTimeout(() => {
				timedOut = true;
				announce();
				release();
			}, 5_000);
			const common = { limit: 100, leaseSeconds: 90, now: initialTime };
			const holding = client.$transaction(
				async (tx) => {
					const rows = await claimOutboxBatch(
						{
							...common,
							workerId: winner,
							...(winner === "targeted" ? { eventIds: [event.id] } : {}),
							...(winner === "legacy-output" ? { outputReviewEventId: event.id } : {}),
						},
						tx,
					);
					announce();
					await held;
					return rows;
				},
				{ isolationLevel: "Serializable" },
			);
			void holding.catch(announce);
			try {
				await ready;
				expect(timedOut).toBe(false);
				const loser = await claimOutboxBatch(
					{
						...common,
						workerId: "contender",
						...(winner === "targeted" ? {} : { eventIds: [event.id] }),
					},
					client,
				);
				expect(loser.filter((row) => row.id === event.id)).toEqual([]);
				expect(timedOut).toBe(false);
				release();
				expect((await holding).filter((row) => row.id === event.id)).toHaveLength(1);
				expect(
					await client.outboxEvent.findUniqueOrThrow({ where: { id: event.id } }),
				).toMatchObject({
					status: "LEASED",
					attempts: 1,
					leaseOwner: winner,
				});
			} finally {
				clearTimeout(deadline);
				release();
				await Promise.allSettled([holding]);
			}
		},
	);

	it("persists an unknown failure only under its live fence without changing the lease or ACK", async () => {
		const event = await createEvent();
		const owned = await claim(event.id, initialTime);
		const receipt = { eventId: event.id, workerId: "receipt-worker", leaseToken: owned.leaseToken };
		const begun = await beginWorkflowOutboxExecution(
			{ ...receipt, timeoutSeconds: 120, now: initialTime },
			client,
		);
		const executionReceipt = { ...receipt, executionMarker: begun.event!.lastError! };
		const before = await client.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
		expect(
			await failWorkflowOutboxExecution({ ...executionReceipt, now: initialTime }, client),
		).toBe(true);
		expect(await client.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toEqual({
			...before,
			lastError: "RECOVERY_REQUIRED",
		});
		for (const allowQueryRecovery of [false, true]) {
			expect(
				await beginWorkflowOutboxExecution(
					{ ...receipt, timeoutSeconds: 900, now: initialTime, allowQueryRecovery },
					client,
				),
			).toMatchObject({ state: "recovery-required" });
		}
		expect(
			(await client.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).leasedUntil,
		).toEqual(before.leasedUntil);
		await client.outboxEvent.update({
			where: { id: event.id },
			data: { lastError: executionReceipt.executionMarker },
		});
		for (const rejected of [
			{ ...executionReceipt, workerId: "other", now: initialTime },
			{ ...executionReceipt, leaseToken: "other", now: initialTime },
			{ ...executionReceipt, now: new Date(initialTime.getTime() + 150_000) },
		])
			expect(await failWorkflowOutboxExecution(rejected, client)).toBe(false);
		expect(
			(await client.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).lastError,
		).toBe(executionReceipt.executionMarker);
		expect(
			await completeWorkflowOutboxExecution({ ...executionReceipt, now: initialTime }, client),
		).toBe(true);
		expect(
			await failWorkflowOutboxExecution({ ...executionReceipt, now: initialTime }, client),
		).toBe(false);
	});
	it("allows only confirmed query recovery for a marked live moderation receipt", async () => {
		const event = await createOutputEvent();
		const owner = { eventId: event.id, workerId: "review-recovery", now: initialTime };
		const prepared = await prepareWorkflowOutboxEvent(owner, client);
		const receipt = { ...owner, leaseToken: prepared!.leaseToken, timeoutSeconds: 120 };
		const begun = await beginWorkflowOutboxExecution(receipt, client);
		expect(
			await failWorkflowOutboxExecution(
				{ ...receipt, executionMarker: begun.event!.lastError! },
				client,
			),
		).toBe(true);
		expect(await beginWorkflowOutboxExecution(receipt, client)).toMatchObject({
			state: "recovery-required",
		});
		const query = await beginWorkflowOutboxExecution(
			{ ...receipt, allowQueryRecovery: true },
			client,
		);
		expect(query).toMatchObject({
			state: "active",
			event: { lastError: expect.stringMatching(/^RECOVERY_QUERY_IN_PROGRESS:/) },
		});
		const queryReceipt = { ...receipt, executionMarker: query.event!.lastError! };
		expect(await completeWorkflowOutboxExecution(receipt, client)).toBe(false);
		// Even read-only recovery cannot enter another in-flight query.
		expect(
			await beginWorkflowOutboxExecution({ ...receipt, allowQueryRecovery: true }, client),
		).toMatchObject({ state: "recovery-required" });
		expect(await deferWorkflowOutboxExecution(queryReceipt, client)).toBe(true);
		expect(
			(await client.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).lastError,
		).toBe("RECOVERY_REQUIRED");
		expect(await beginWorkflowOutboxExecution(receipt, client)).toMatchObject({
			state: "recovery-required",
		});
		const resumed = await beginWorkflowOutboxExecution(
			{ ...receipt, allowQueryRecovery: true },
			client,
		);
		expect(resumed.state).toBe("active");
		expect(
			await completeWorkflowOutboxExecution(
				{ ...receipt, executionMarker: resumed.event!.lastError! },
				client,
			),
		).toBe(true);
	});

	it("fences concurrent begins and late safe-clear/failure/ACK writes by execution generation", async () => {
		const event = await createOutputEvent();
		const owner = { eventId: event.id, workerId: "generation-fence", now: initialTime };
		const prepared = await prepareWorkflowOutboxEvent(owner, client);
		const receipt = { ...owner, leaseToken: prepared!.leaseToken, timeoutSeconds: 120 };
		const results = await Promise.all([
			beginWorkflowOutboxExecution(receipt, client),
			beginWorkflowOutboxExecution({ ...receipt, allowQueryRecovery: true }, client),
		]);
		expect(results.map((result) => result.state).sort()).toEqual(["active", "recovery-required"]);
		const first = results.find((result) => result.state === "active")!;
		const firstReceipt = { ...receipt, executionMarker: first.event!.lastError! };
		expect(await deferWorkflowOutboxExecution(firstReceipt, client)).toBe(true);
		const second = await beginWorkflowOutboxExecution(receipt, client);
		const secondReceipt = { ...receipt, executionMarker: second.event!.lastError! };
		expect(second.state).toBe("active");
		expect(secondReceipt.executionMarker).not.toBe(firstReceipt.executionMarker);
		expect(await failWorkflowOutboxExecution(firstReceipt, client)).toBe(false);
		expect(await deferWorkflowOutboxExecution(firstReceipt, client)).toBe(false);
		expect(await completeWorkflowOutboxExecution(firstReceipt, client)).toBe(false);
		expect(await completeWorkflowOutboxExecution(receipt, client)).toBe(false);
		expect(
			(await client.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).lastError,
		).toBe(secondReceipt.executionMarker);
		expect(await completeWorkflowOutboxExecution(secondReceipt, client)).toBe(true);
	});

	async function createOutputEvent(
		kind: "INPUT" | "OUTPUT" = "OUTPUT",
		availableAt: Date | null = initialTime,
	) {
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId: "outbox-target-test",
				kind,
				status: "VERIFYING",
				objectKey: `test/${crypto.randomUUID()}`,
				mimeType: "image/png",
				byteSize: 16n,
			},
		});
		ownedAssets.push(asset.id);
		const event = await client.outboxEvent.create({
			data: {
				eventType: "MEDIA_ASSET_VERIFY",
				aggregateType: "MEDIA_ASSET",
				aggregateId: asset.id,
				dedupeKey: `test-output-poll:${asset.id}`,
				payload: { assetId: asset.id },
				...(availableAt ? { availableAt } : {}),
			},
		});
		ownedIds.push(event.id);
		return event;
	}

	it.each([-86_400_000, 86_400_000])(
		"creates an immediately due event with database-default availableAt despite host skew %i ms",
		async (skew) => {
			const [{ now }] = await client.$queryRaw<
				Array<{ now: Date }>
			>`SELECT clock_timestamp() AS "now"`;
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date(now!.getTime() + skew));
			const event = await createOutputEvent("INPUT", null);
			const [stored] = await client.$queryRaw<Array<{ availableAt: Date; databaseNow: Date }>>`
				SELECT "availableAt", clock_timestamp() AS "databaseNow" FROM "outbox_event" WHERE "id" = ${event.id}`;
			expect(Math.abs(stored!.availableAt.getTime() - stored!.databaseNow.getTime())).toBeLessThan(
				5_000,
			);
			expect(
				await prepareWorkflowOutboxDelivery(
					{ eventId: event.id, workerId: "immediate-default" },
					client,
				),
			).toMatchObject({ event: { id: event.id, attempts: 1 } });
		},
	);

	it.each([-86_400_000, 86_400_000])(
		"claims, fences and ACKs immediate events using the database clock with runtime skew %i ms",
		async (skew) => {
			const event = await createOutputEvent();
			const [{ now }] = await client.$queryRaw<
				Array<{ now: Date }>
			>`SELECT clock_timestamp() AS "now"`;
			await client.outboxEvent.update({ where: { id: event.id }, data: { availableAt: now } });
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date(now!.getTime() + skew));
			const prepared = await prepareWorkflowOutboxDelivery(
				{ eventId: event.id, workerId: "skewed-workflow" },
				client,
			);
			expect(prepared.event).toMatchObject({ id: event.id, attempts: 1 });
			expect(prepared.retryAfterMs).toBeUndefined();
			expect(prepared.event!.leasedUntil.getTime() - now!.getTime()).toBeGreaterThanOrEqual(90_000);
			expect(prepared.event!.leasedUntil.getTime() - now!.getTime()).toBeLessThan(95_000);
			const receipt = {
				eventId: event.id,
				workerId: "skewed-workflow",
				leaseToken: prepared.event!.leaseToken,
			};
			const begun = await beginWorkflowOutboxExecution({ ...receipt, timeoutSeconds: 120 }, client);
			expect(begun).toMatchObject({ state: "active" });
			const contended = await prepareWorkflowOutboxDelivery(
				{ eventId: event.id, workerId: "contender" },
				client,
			);
			expect(contended.event).toBeNull();
			expect(contended.retryAfterMs).toBeGreaterThan(140_000);
			expect(contended.retryAfterMs).toBeLessThanOrEqual(150_000);
			expect(
				await completeWorkflowOutboxExecution(
					{ ...receipt, executionMarker: begun.event!.lastError! },
					client,
				),
			).toBe(true);
			expect(
				await prepareWorkflowOutboxDelivery({ eventId: event.id, workerId: "contender" }, client),
			).toEqual({ event: null });
		},
	);
	it("retains a genuine future due time without claiming or ACKing it", async () => {
		const event = await createOutputEvent();
		const due = new Date(initialTime.getTime() + 811);
		await client.outboxEvent.update({ where: { id: event.id }, data: { availableAt: due } });
		const input = { eventId: event.id, workerId: "waiting-workflow", now: initialTime };
		expect(await prepareWorkflowOutboxDelivery(input, client)).toEqual({
			event: null,
			retryAfterMs: 811,
		});
		expect(await client.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
			status: "PENDING",
			attempts: 0,
			leaseToken: null,
		});
		const prepared = await prepareWorkflowOutboxDelivery({ ...input, now: due }, client);
		expect(prepared.event).toMatchObject({ id: event.id, attempts: 1 });
		expect(prepared.retryAfterMs).toBeUndefined();
	});
	it("uses the later actual due or lease expiry while retaining the same event identity", async () => {
		const event = await createOutputEvent();
		const owner = { eventId: event.id, workerId: "owner", now: initialTime };
		const prepared = await prepareWorkflowOutboxDelivery(owner, client);
		expect(prepared.event).not.toBeNull();
		await client.outboxEvent.update({
			where: { id: event.id },
			data: { availableAt: new Date(initialTime.getTime() + 120_000) },
		});
		expect(
			await prepareWorkflowOutboxDelivery({ ...owner, workerId: "contender" }, client),
		).toEqual({ event: null, retryAfterMs: 120_000 });
		expect(await client.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
			status: "LEASED",
			attempts: 1,
			leaseToken: prepared.event!.leaseToken,
		});
	});
	it("resumes its own live receipt when due without waiting for its lease to expire", async () => {
		const event = await createOutputEvent();
		const input = { eventId: event.id, workerId: "owner", now: initialTime };
		const prepared = await prepareWorkflowOutboxDelivery(input, client);
		const due = new Date(initialTime.getTime() + 30_000);
		await client.outboxEvent.update({ where: { id: event.id }, data: { availableAt: due } });
		expect(await prepareWorkflowOutboxDelivery(input, client)).toEqual({
			event: null,
			retryAfterMs: 30_000,
		});
		expect(await prepareWorkflowOutboxDelivery({ ...input, workerId: "other" }, client)).toEqual({
			event: null,
			retryAfterMs: 90_000,
		});
		expect(await prepareWorkflowOutboxDelivery({ ...input, now: due }, client)).toMatchObject({
			event: { id: event.id, leaseToken: prepared.event!.leaseToken, attempts: 1 },
		});
	});

	it("resumes a lost prepare response without replacing its token or incrementing the attempt", async () => {
		const event = await createOutputEvent();
		const input = { eventId: event.id, workerId: "inline-workflow", now: initialTime };
		const first = await prepareWorkflowOutboxEvent(input, client);
		expect(first).toMatchObject({ id: event.id, attempts: 1 });
		const replay = await prepareWorkflowOutboxEvent(
			{ ...input, now: new Date(initialTime.getTime() + 1000) },
			client,
		);
		expect(replay).toMatchObject({ id: event.id, attempts: 1, leaseToken: first!.leaseToken });
		expect(
			await prepareWorkflowOutboxEvent({ ...input, workerId: "other-workflow" }, client),
		).toBeNull();
	});
	it("keeps a 900 second finalization fenced past the initial prepare lease and recovers its ACK", async () => {
		const event = await createOutputEvent();
		const first = await prepareWorkflowOutboxEvent(
			{ eventId: event.id, workerId: "inline-workflow", now: initialTime },
			client,
		);
		const receipt = {
			eventId: event.id,
			workerId: "inline-workflow",
			leaseToken: first!.leaseToken,
		};
		const begun = await beginWorkflowOutboxExecution(
			{ ...receipt, timeoutSeconds: 900, now: initialTime },
			client,
		);
		expect(begun).toMatchObject({ state: "active" });
		const late = new Date(initialTime.getTime() + 899_000);
		expect(
			await prepareWorkflowOutboxEvent(
				{ eventId: event.id, workerId: "scanner", now: late },
				client,
			),
		).toBeNull();
		expect(
			await completeWorkflowOutboxExecution(
				{ ...receipt, now: late, executionMarker: begun.event!.lastError! },
				client,
			),
		).toBe(true);
		expect(
			await beginWorkflowOutboxExecution({ ...receipt, timeoutSeconds: 900, now: late }, client),
		).toMatchObject({ state: "completed", event: { status: "PROCESSED" } });
		expect(await client.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
			attempts: 1,
			status: "PROCESSED",
		});
	});
	it("fences an expired or reclaimed receipt and lets only one concurrent completion ACK", async () => {
		const event = await createOutputEvent();
		const input = { eventId: event.id, workerId: "inline-workflow", now: initialTime };
		const first = await prepareWorkflowOutboxEvent(input, client);
		const receipt = { eventId: event.id, workerId: input.workerId, leaseToken: first!.leaseToken };
		const expired = new Date(initialTime.getTime() + 90_001);
		expect(
			await beginWorkflowOutboxExecution({ ...receipt, timeoutSeconds: 120, now: expired }, client),
		).toEqual({ state: "lost", event: null });
		expect(await completeWorkflowOutboxExecution({ ...receipt, now: expired }, client)).toBe(false);
		const replacement = await prepareWorkflowOutboxEvent({ ...input, now: expired }, client);
		expect(replacement).toMatchObject({ attempts: 2 });
		expect(replacement!.leaseToken).not.toBe(first!.leaseToken);
		expect(
			await beginWorkflowOutboxExecution({ ...receipt, timeoutSeconds: 120, now: expired }, client),
		).toEqual({ state: "lost", event: null });
		const results = await Promise.all(
			[1, 2].map(() =>
				completeWorkflowOutboxExecution(
					{ ...receipt, leaseToken: replacement!.leaseToken, now: expired },
					client,
				),
			),
		);
		expect(results.filter(Boolean)).toHaveLength(1);
	});
	it("shares claim ownership with the scheduled scanner under concurrent delivery", async () => {
		const event = await createOutputEvent();
		const [inline, scanned] = await Promise.all([
			prepareWorkflowOutboxEvent(
				{ eventId: event.id, workerId: "inline", now: initialTime },
				client,
			),
			claimOutboxBatch(
				{ workerId: "scanner", limit: 100, leaseSeconds: 90, now: initialTime },
				client,
			),
		]);
		expect(
			[...(inline ? [inline] : []), ...scanned].filter((row) => row.id === event.id),
		).toHaveLength(1);
	});

	it("targets only the committed output event and leaves input/other events to normal delivery", async () => {
		const output = await createOutputEvent();
		const input = await createOutputEvent("INPUT");
		const other = await createEvent();
		const target = (id: string) =>
			claimOutboxBatch(
				{
					workerId: "target",
					limit: 1,
					leaseSeconds: 60,
					now: initialTime,
					outputReviewEventId: id,
				},
				client,
			);
		for (const id of [input.id, other.id, "missing"]) expect(await target(id)).toEqual([]);
		expect(await target(output.id)).toMatchObject([{ id: output.id, attempts: 1 }]);
		expect(await target(output.id)).toEqual([]);
		expect(await client.outboxEvent.findUniqueOrThrow({ where: { id: input.id } })).toMatchObject({
			status: "PENDING",
			attempts: 0,
		});
	});
	it("claims old output events without new trace fields but rejects mismatched payload identity", async () => {
		const old = await createOutputEvent();
		await client.outboxEvent.update({ where: { id: old.id }, data: { payload: {} } });
		expect(
			await claimOutboxBatch(
				{
					workerId: "old-format",
					limit: 1,
					leaseSeconds: 60,
					now: initialTime,
					outputReviewEventId: old.id,
				},
				client,
			),
		).toMatchObject([{ id: old.id }]);
		const mismatched = await createOutputEvent();
		await client.outboxEvent.update({
			where: { id: mismatched.id },
			data: { payload: { assetId: old.aggregateId } },
		});
		expect(
			await claimOutboxBatch(
				{
					workerId: "mismatched",
					limit: 1,
					leaseSeconds: 60,
					now: initialTime,
					outputReviewEventId: mismatched.id,
				},
				client,
			),
		).toEqual([]);
	});

	it("has one winner between targeted wake and scheduled scan, and fences an expired winner", async () => {
		const event = await createOutputEvent();
		const claims = await Promise.all([
			claimOutboxBatch(
				{
					workerId: "target",
					limit: 1,
					leaseSeconds: 60,
					now: initialTime,
					outputReviewEventId: event.id,
				},
				client,
			),
			claimOutboxBatch(
				{ workerId: "scan", limit: 100, leaseSeconds: 60, now: initialTime },
				client,
			),
		]);
		const winners = claims.flat().filter((row) => row.id === event.id);
		expect(winners).toHaveLength(1);
		const oldOwner = claims[0]!.some((row) => row.id === event.id) ? "target" : "scan";
		const reclaimed = await claimOutboxBatch(
			{
				workerId: "recovery",
				limit: 1,
				leaseSeconds: 60,
				now: new Date(initialTime.getTime() + 60001),
				outputReviewEventId: event.id,
			},
			client,
		);
		expect(reclaimed).toHaveLength(1);
		expect(reclaimed[0]!.leaseToken).not.toBe(winners[0]!.leaseToken);
		expect(await completeOutboxEvent(event.id, oldOwner, winners[0]!.leaseToken, client)).toEqual({
			count: 0,
		});
		expect(
			await completeOutboxEvent(event.id, "recovery", reclaimed[0]!.leaseToken, client),
		).toEqual({ count: 1 });
	});

	it("preserves one delivery attempt through more pending checks than the failure budget", async () => {
		const created = await createEvent();
		let now = initialTime;
		for (let check = 0; check < 15; check += 1) {
			const claimed = await claim(created.id, now);
			expect(claimed.attempts).toBe(1);
			const retryAt = new Date(now.getTime() + 30_000);
			expect(
				await deferOutboxEvent(
					{
						id: created.id,
						workerId: "receipt-worker",
						leaseToken: claimed.leaseToken,
						now,
						retryAt,
					},
					client,
				),
			).toEqual({ applied: true });
			expect(
				await client.outboxEvent.findUniqueOrThrow({ where: { id: created.id } }),
			).toMatchObject({
				status: "PENDING",
				attempts: 0,
				leaseOwner: null,
				leaseToken: null,
				leasedUntil: null,
				processedAt: null,
				availableAt: retryAt,
			});
			const early = await claimOutboxBatch(
				{
					workerId: "receipt-worker",
					limit: 100,
					leaseSeconds: 60,
					now: new Date(retryAt.getTime() - 1),
				},
				client,
			);
			expect(early.some((entry) => entry.id === created.id)).toBe(false);
			now = retryAt;
		}
		const completed = await claim(created.id, now);
		expect(completed.attempts).toBe(1);
		expect(
			await completeOutboxEvent(created.id, "receipt-worker", completed.leaseToken, client),
		).toEqual({ count: 1 });
		expect(await client.outboxEvent.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject(
			{ status: "PROCESSED", attempts: 1 },
		);
	});

	it("advances the delivery only on failure and decrements at most once under concurrent defer", async () => {
		const created = await createEvent();
		const first = await claim(created.id, initialTime);
		const retryAt = new Date(initialTime.getTime() + 30_000);
		expect(
			await releaseOutboxEvent(
				{
					id: created.id,
					workerId: "receipt-worker",
					leaseToken: first.leaseToken,
					error: "WORKFLOWS_EXECUTION_FAILED",
					maxAttempts: 12,
					retryAt,
				},
				client,
			),
		).toEqual({ applied: true, deadLettered: false });
		const second = await claim(created.id, retryAt);
		expect(second.attempts).toBe(2);
		const deferredAt = new Date(retryAt.getTime() + 30_000);
		const results = await Promise.all(
			[1, 2].map(() =>
				deferOutboxEvent(
					{
						id: created.id,
						workerId: "receipt-worker",
						leaseToken: second.leaseToken,
						now: retryAt,
						retryAt: deferredAt,
					},
					client,
				),
			),
		);
		expect(results.filter((result) => result.applied)).toHaveLength(1);
		expect(await client.outboxEvent.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject(
			{ status: "PENDING", attempts: 1 },
		);
		const third = await claim(created.id, deferredAt);
		expect(third.attempts).toBe(2);
		await client.outboxEvent.update({ where: { id: created.id }, data: { attempts: 12 } });
		expect(
			await releaseOutboxEvent(
				{
					id: created.id,
					workerId: "receipt-worker",
					leaseToken: third.leaseToken,
					error: "WORKFLOWS_EXECUTION_FAILED",
					maxAttempts: 12,
					retryAt: deferredAt,
				},
				client,
			),
		).toEqual({ applied: true, deadLettered: true });
	});

	it("does not decrement an expired or reclaimed lease, including a reused worker ID", async () => {
		const created = await createEvent();
		const first = await claim(created.id, initialTime);
		const expiredAt = new Date(initialTime.getTime() + 60_001);
		expect(
			await deferOutboxEvent(
				{
					id: created.id,
					workerId: "receipt-worker",
					leaseToken: first.leaseToken,
					now: expiredAt,
					retryAt: expiredAt,
				},
				client,
			),
		).toEqual({ applied: false });
		const second = await claim(created.id, expiredAt);
		expect(second.leaseToken).not.toBe(first.leaseToken);
		expect(
			await deferOutboxEvent(
				{
					id: created.id,
					workerId: "receipt-worker",
					leaseToken: first.leaseToken,
					now: expiredAt,
					retryAt: expiredAt,
				},
				client,
			),
		).toEqual({ applied: false });
		expect(await client.outboxEvent.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject(
			{ status: "LEASED", attempts: 2, leaseToken: second.leaseToken },
		);
	});
});
