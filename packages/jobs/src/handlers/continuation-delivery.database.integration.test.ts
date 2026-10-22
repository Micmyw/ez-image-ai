import { PrismaPg } from "@prisma/adapter-pg";
import {
	claimOutboxBatch,
	completeOutboxEvent,
	deferOutboxEvent,
	prepareWorkflowOutboxEvent,
	beginWorkflowOutboxExecution,
	completeWorkflowOutboxExecution,
	failWorkflowOutboxExecution,
	deferWorkflowOutboxExecution,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { OutputTransferClaimConflictError, SettlementTransactionConflictError } from "../contracts";
import { executeTargetedEvent, prepareTargetedEvent } from "./targeted-event-delivery";

let database: PrismaClient;
beforeAll(() => {
	const url = new URL(process.env.TEST_DATABASE_URL ?? "");
	const explicitImageTarget =
		process.env.MEDIA_IMAGE_TEST_DATABASE_URL === url.href &&
		url.port !== "5432" &&
		Boolean(url.port);
	if (
		url.hostname !== "127.0.0.1" ||
		(url.port !== "55432" && !explicitImageTarget) ||
		!url.pathname.includes("test")
	)
		throw new Error("USE_DISPOSABLE_DATABASE");
	database = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.href }) });
});
afterAll(async () => database?.$disconnect());

it("retains the committed execution fence when begin's response is lost without a second marker write", async () => {
	const now = new Date("2000-01-01T00:00:00Z");
	const event = await database.outboxEvent.create({
		data: {
			eventType: "GENERATION_SETTLE",
			aggregateType: "GENERATION_JOB",
			aggregateId: "job",
			dedupeKey: `lost-begin:${crypto.randomUUID()}`,
			payload: { jobId: "job", version: 0 },
			availableAt: now,
		},
	});
	try {
		const prepared = await prepareWorkflowOutboxEvent(
			{ eventId: event.id, workerId: "lost-begin", now },
			database,
		);
		const task = {
			taskId: "media-settle-generation",
			payload: { jobId: "job", version: 0 },
			outboxReceipt: {
				eventId: event.id,
				workerId: "lost-begin",
				leaseToken: prepared!.leaseToken,
			},
		};
		const normalBegin = (input: Parameters<typeof beginWorkflowOutboxExecution>[0]) =>
			beginWorkflowOutboxExecution({ ...input, now }, database);
		const deps = {
			begin: vi.fn(normalBegin).mockImplementationOnce(async (input) => {
				await normalBegin(input);
				throw new Error("BEGIN_RESPONSE_LOST");
			}),
			complete: vi.fn(async () => true),
			defer: vi.fn(async () => true),
			fail: vi.fn(async () => {
				throw new Error("MARKER_UNAVAILABLE");
			}),
			execute: vi.fn(async () => ({ continuation: { eventIds: [] } })),
			recover: vi.fn(async () => ({})),
		};
		await expect(executeTargetedEvent(task, deps)).rejects.toThrow("BEGIN_RESPONSE_LOST");
		const held = await database.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
		expect(held.lastError).toMatch(/^EXECUTION_IN_PROGRESS:/);
		await expect(executeTargetedEvent(task, deps)).rejects.toThrow("OUTBOX_RECOVERY_REQUIRED");
		expect(deps.execute).not.toHaveBeenCalled();
		expect(deps.fail).not.toHaveBeenCalled();
		expect(await database.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toEqual(held);
	} finally {
		await database.outboxEvent.delete({ where: { id: event.id } });
	}
});

it.each([
	[
		"media-finalize-generation",
		"GENERATION_FINALIZE",
		new OutputTransferClaimConflictError({ code: "40001" }),
	],
	[
		"media-settle-generation",
		"GENERATION_SETTLE",
		new SettlementTransactionConflictError({ code: "55P03" }),
	],
] as const)(
	"releases only a confirmed %s rollback guard and completes the same receipt",
	async (taskId, eventType, conflict) => {
		const now = new Date("2000-01-01T00:00:00Z");
		const event = await database.outboxEvent.create({
			data: {
				eventType,
				aggregateType: "GENERATION_JOB",
				aggregateId: "job",
				dedupeKey: `confirmed-rollback:${crypto.randomUUID()}`,
				payload: { jobId: "job", version: 0 },
				availableAt: now,
			},
		});
		try {
			const prepared = await prepareWorkflowOutboxEvent(
				{ eventId: event.id, workerId: "safe-rollback", now },
				database,
			);
			const task = {
				taskId,
				payload: { jobId: "job", version: 0 },
				outboxReceipt: {
					eventId: event.id,
					workerId: "safe-rollback",
					leaseToken: prepared!.leaseToken,
				},
			};
			const deps = {
				begin: (input: Parameters<typeof beginWorkflowOutboxExecution>[0]) =>
					beginWorkflowOutboxExecution({ ...input, now }, database),
				complete: (input: Parameters<typeof completeWorkflowOutboxExecution>[0]) =>
					completeWorkflowOutboxExecution({ ...input, now }, database),
				defer: (input: Parameters<typeof deferWorkflowOutboxExecution>[0]) =>
					deferWorkflowOutboxExecution({ ...input, now }, database),
				fail: vi.fn((input: Parameters<typeof failWorkflowOutboxExecution>[0]) =>
					failWorkflowOutboxExecution({ ...input, now }, database),
				),
				execute: vi
					.fn()
					.mockRejectedValueOnce(conflict)
					.mockResolvedValue({ continuation: { eventIds: [] } }),
				recover: vi.fn(async () => ({})),
			};
			await expect(executeTargetedEvent(task, deps)).rejects.toBe(conflict);
			expect(
				await database.outboxEvent.findUniqueOrThrow({ where: { id: event.id } }),
			).toMatchObject({
				lastError: null,
				leaseToken: task.outboxReceipt.leaseToken,
				status: "LEASED",
				attempts: 1,
			});
			expect(await executeTargetedEvent(task, deps)).toMatchObject({ deliveryState: "completed" });
			expect(deps.execute).toHaveBeenCalledTimes(2);
			expect(deps.fail).not.toHaveBeenCalled();
			expect(
				await database.outboxEvent.findUniqueOrThrow({ where: { id: event.id } }),
			).toMatchObject({ lastError: null, leaseToken: null, status: "PROCESSED", attempts: 1 });
		} finally {
			await database.outboxEvent.delete({ where: { id: event.id } });
		}
	},
);

it.each([false, true])(
	"blocks an older caller after unknown failure even if the failure marker write fails: %s",
	async (markerWriteFails) => {
		let now = new Date("2000-01-01T00:00:00Z");
		const event = await database.outboxEvent.create({
			data: {
				eventType: "GENERATION_DISPATCH",
				aggregateType: "GENERATION_JOB",
				aggregateId: "job",
				dedupeKey: `old-caller-failure:${crypto.randomUUID()}`,
				payload: { jobId: "job", version: 0 },
				availableAt: now,
			},
		});
		const execute = vi
			.fn()
			.mockRejectedValueOnce(new Error("UNKNOWN_EXECUTION_OUTCOME"))
			.mockResolvedValue({ continuation: { eventIds: [] } });
		const deps = {
			begin: (input: Parameters<typeof beginWorkflowOutboxExecution>[0]) =>
				beginWorkflowOutboxExecution({ ...input, now }, database),
			complete: (input: Parameters<typeof completeWorkflowOutboxExecution>[0]) =>
				completeWorkflowOutboxExecution({ ...input, now }, database),
			fail: async (input: Parameters<typeof failWorkflowOutboxExecution>[0]) => {
				if (markerWriteFails) throw new Error("FAILURE_MARKER_UNAVAILABLE");
				return failWorkflowOutboxExecution({ ...input, now }, database);
			},
			defer: (input: Parameters<typeof deferWorkflowOutboxExecution>[0]) =>
				deferWorkflowOutboxExecution({ ...input, now }, database),
			execute,
			recover: vi.fn(async () => ({ continuation: { eventIds: [] } })),
		};
		const prepare = (workerId: string) =>
			prepareTargetedEvent(
				{ eventId: event.id, workerId },
				{
					prepare: (input) => prepareWorkflowOutboxEvent({ ...input, now }, database),
					resolve: async () => ({
						taskId: "media-dispatch-image-kie-nano-banana-2",
						provider: "kie",
						providerModelId: "nano-banana-2",
					}),
					complete: deps.complete,
				},
			);
		try {
			const task = await prepare("old-workflow");
			await expect(executeTargetedEvent(task!, deps)).rejects.toThrow("UNKNOWN_EXECUTION_OUTCOME");
			const held = await database.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
			expect(held.lastError).toEqual(
				markerWriteFails ? expect.stringMatching(/^EXECUTION_IN_PROGRESS:/) : "RECOVERY_REQUIRED",
			);
			await expect(executeTargetedEvent(task!, deps)).rejects.toThrow("OUTBOX_RECOVERY_REQUIRED");
			expect(execute).toHaveBeenCalledOnce();
			// A same-owner reprepare that now resolves to a no-op cannot erase an
			// active or unknown execution guard through its marker-less ACK path.
			expect(
				await prepareTargetedEvent(
					{ eventId: event.id, workerId: "old-workflow" },
					{
						prepare: (input) => prepareWorkflowOutboxEvent({ ...input, now }, database),
						resolve: async () => null,
						complete: deps.complete,
					},
				),
			).toBeNull();
			expect(await database.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toEqual(
				held,
			);
			expect(await prepare("other-workflow")).toBeNull();
			now = new Date(held.leasedUntil!.getTime() + 1);
			const replacement = await prepare("recovery-workflow");
			expect(replacement!.outboxReceipt!.leaseToken).not.toBe(task!.outboxReceipt!.leaseToken);
			expect(
				(await database.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).lastError,
			).toBeNull();
			expect(await executeTargetedEvent(replacement!, deps)).toMatchObject({
				deliveryState: "completed",
			});
			expect(execute).toHaveBeenCalledTimes(2);
		} finally {
			await database.outboxEvent.delete({ where: { id: event.id } });
		}
	},
);

it("cannot mark a committed ACK as failed when its response is lost", async () => {
	const now = new Date("2000-01-01T00:00:00Z");
	const event = await database.outboxEvent.create({
		data: {
			eventType: "GENERATION_SETTLE",
			aggregateType: "GENERATION_JOB",
			aggregateId: "job",
			dedupeKey: `lost-ack-failure:${crypto.randomUUID()}`,
			payload: { jobId: "job", version: 0 },
			availableAt: now,
		},
	});
	const execute = vi.fn(async () => ({ continuation: { eventIds: [] } }));
	const fail = vi.fn((input: Parameters<typeof failWorkflowOutboxExecution>[0]) =>
		failWorkflowOutboxExecution({ ...input, now }, database),
	);
	const recover = vi.fn(async () => ({ continuation: { eventIds: [] } }));
	try {
		const task = await prepareTargetedEvent(
			{ eventId: event.id, workerId: "lost-ack" },
			{
				prepare: (input) => prepareWorkflowOutboxEvent({ ...input, now }, database),
				resolve: async () => null,
				complete: (input) => completeWorkflowOutboxExecution({ ...input, now }, database),
			},
		);
		const deps = {
			begin: (input: Parameters<typeof beginWorkflowOutboxExecution>[0]) =>
				beginWorkflowOutboxExecution({ ...input, now }, database),
			complete: async (input: Parameters<typeof completeWorkflowOutboxExecution>[0]) => {
				await completeWorkflowOutboxExecution({ ...input, now }, database);
				throw new Error("ACK_RESPONSE_LOST");
			},
			fail,
			defer: (input: Parameters<typeof deferWorkflowOutboxExecution>[0]) =>
				deferWorkflowOutboxExecution({ ...input, now }, database),
			execute,
			recover,
		};
		await expect(executeTargetedEvent(task!, deps)).rejects.toThrow("ACK_RESPONSE_LOST");
		await expect(fail.mock.results[0]!.value).resolves.toBe(false);
		expect(await database.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject(
			{ status: "PROCESSED", lastError: null, leaseToken: null },
		);
		expect(await executeTargetedEvent(task!, deps)).toMatchObject({ deliveryState: "completed" });
		expect(execute).toHaveBeenCalledOnce();
		expect(recover).toHaveBeenCalledOnce();
	} finally {
		await database.outboxEvent.delete({ where: { id: event.id } });
	}
});

it.each([
	"JOB_CREATED",
	"GENERATION_DISPATCH",
	"GENERATION_FINALIZE",
	"GENERATION_FINALIZE_RETRY",
	"GENERATION_SETTLE",
	"MEDIA_ASSET_VERIFY",
	"MEDIA_ASSET_MODERATION_REQUESTED",
])(
	"shares the %s claim and lease across direct delivery, scan, lost response and old payload recovery",
	async (eventType) => {
		const now = new Date("1890-01-01T00:00:00Z");
		const event = await database.outboxEvent.create({
			data: {
				eventType,
				aggregateType: eventType.startsWith("MEDIA") ? "MEDIA_ASSET" : "GENERATION_JOB",
				aggregateId: crypto.randomUUID(),
				dedupeKey: `direct:${crypto.randomUUID()}`,
				payload: {},
				availableAt: now,
			},
		});
		const claim = { limit: 1, leaseSeconds: 10, now };
		try {
			const [direct, scan] = await Promise.all([
				claimOutboxBatch({ ...claim, workerId: "direct", eventIds: [event.id] }, database),
				claimOutboxBatch({ ...claim, workerId: "scan" }, database),
			]);
			expect(direct.length + scan.length).toBe(1);
			const first = [...direct, ...scan][0]!;
			expect(first.id).toBe(event.id);
			const workerId = direct.length ? "direct" : "scan";
			// Acceptance response loss must retain the delivery number, with no ACK.
			expect(
				await deferOutboxEvent(
					{
						id: event.id,
						workerId,
						leaseToken: first.leaseToken,
						retryAt: new Date(now.getTime() + 1000),
						now,
					},
					database,
				),
			).toEqual({ applied: true });
			expect(
				await claimOutboxBatch({ ...claim, workerId: "early", eventIds: [event.id] }, database),
			).toEqual([]);
			const [retry] = await claimOutboxBatch(
				{ ...claim, now: new Date(now.getTime() + 1001), workerId: "retry", eventIds: [event.id] },
				database,
			);
			expect(retry!.attempts).toBe(first.attempts);
			expect(
				(await completeOutboxEvent(event.id, workerId, first.leaseToken, database)).count,
			).toBe(0);
			// Process death before ACK: only expired lease can be reclaimed by scanning.
			const [recovered] = await claimOutboxBatch(
				{ ...claim, now: new Date(now.getTime() + 11002), workerId: "recovery" },
				database,
			);
			expect(recovered!.id).toBe(event.id);
			expect(
				(await completeOutboxEvent(event.id, "retry", retry!.leaseToken, database)).count,
			).toBe(0);
			expect(
				(await completeOutboxEvent(event.id, "recovery", recovered!.leaseToken, database)).count,
			).toBe(1);
		} finally {
			await database.outboxEvent.delete({ where: { id: event.id } });
		}
	},
);

it("rejects unrelated maintenance and contradictory payload identities in targeted claims", async () => {
	const now = new Date("1890-01-01T00:00:00Z");
	const rows = await Promise.all(
		["MEDIA_OBJECT_DELETE", "GENERATION_FINALIZE"].map((eventType) =>
			database.outboxEvent.create({
				data: {
					eventType,
					aggregateType: "GENERATION_JOB",
					aggregateId: "original",
					dedupeKey: crypto.randomUUID(),
					payload: { jobId: "another-job" },
					availableAt: now,
				},
			}),
		),
	);
	try {
		expect(
			await claimOutboxBatch(
				{ workerId: "target", eventIds: rows.map((e) => e.id), now, limit: 10, leaseSeconds: 10 },
				database,
			),
		).toEqual([]);
	} finally {
		await database.outboxEvent.deleteMany({ where: { id: { in: rows.map((e) => e.id) } } });
	}
});

it("replays an ACKed acceptance from PostgreSQL without invoking the paid handler after response loss", async () => {
	const event = await database.outboxEvent.create({
		data: {
			eventType: "GENERATION_DISPATCH",
			aggregateType: "GENERATION_JOB",
			aggregateId: "job",
			dedupeKey: `inline-response-loss:${crypto.randomUUID()}`,
			payload: { jobId: "job", version: 0 },
			// Receipt semantics are independent of host/database clock skew.
			availableAt: new Date(0),
		},
	});
	const paidHandler = vi.fn(async () => ({
		continuation: { eventIds: [], pollAttemptId: "accepted-attempt" },
	}));
	const recover = vi.fn(async () => ({
		continuation: { eventIds: [], pollAttemptId: "accepted-attempt" },
	}));
	try {
		const task = await prepareTargetedEvent(
			{ eventId: event.id, workerId: "inline-response-loss" },
			{
				prepare: (input) => prepareWorkflowOutboxEvent(input, database),
				resolve: async () => ({
					taskId: "media-dispatch-image-kie-nano-banana-2",
					provider: "kie",
					providerModelId: "nano-banana-2",
				}),
				complete: (input) => completeWorkflowOutboxExecution(input, database),
			},
		);
		expect(task).not.toBeNull();
		const deps = {
			begin: (input: Parameters<typeof beginWorkflowOutboxExecution>[0]) =>
				beginWorkflowOutboxExecution(input, database),
			complete: (input: Parameters<typeof completeWorkflowOutboxExecution>[0]) =>
				completeWorkflowOutboxExecution(input, database),
			fail: (input: Parameters<typeof failWorkflowOutboxExecution>[0]) =>
				failWorkflowOutboxExecution(input, database),
			defer: (input: Parameters<typeof deferWorkflowOutboxExecution>[0]) =>
				deferWorkflowOutboxExecution(input, database),
			execute: paidHandler,
			recover,
		};
		await executeTargetedEvent(task!, deps); // The caller loses this response after durable ACK.
		expect(await database.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject(
			{ status: "PROCESSED" },
		);
		expect(await executeTargetedEvent(task!, deps)).toMatchObject({
			deliveryState: "completed",
			continuation: { pollAttemptId: "accepted-attempt" },
		});
		expect(paidHandler).toHaveBeenCalledOnce();
		expect(recover).toHaveBeenCalledOnce();
	} finally {
		await database.outboxEvent.delete({ where: { id: event.id } });
	}
});

it("retains the same leased event through PENDING moderation and ACKs only its terminal tick", async () => {
	const event = await database.outboxEvent.create({
		data: {
			eventType: "MEDIA_ASSET_VERIFY",
			aggregateType: "MEDIA_ASSET",
			aggregateId: "asset",
			dedupeKey: `inline-review:${crypto.randomUUID()}`,
			payload: { assetId: "asset" },
			availableAt: new Date(0),
		},
	});
	try {
		const task = await prepareTargetedEvent(
			{ eventId: event.id, workerId: "inline-review" },
			{
				prepare: (input) => prepareWorkflowOutboxEvent(input, database),
				resolve: async () => null,
				complete: (input) => completeWorkflowOutboxExecution(input, database),
			},
		);
		const execute = vi
			.fn()
			.mockResolvedValueOnce({ done: false, waitSeconds: 3, continuation: { eventIds: [] } })
			.mockResolvedValueOnce({ done: true, waitSeconds: 0, continuation: { eventIds: [] } });
		expect(task).not.toBeNull();
		const deps = {
			begin: (input: Parameters<typeof beginWorkflowOutboxExecution>[0]) =>
				beginWorkflowOutboxExecution(input, database),
			complete: (input: Parameters<typeof completeWorkflowOutboxExecution>[0]) =>
				completeWorkflowOutboxExecution(input, database),
			fail: (input: Parameters<typeof failWorkflowOutboxExecution>[0]) =>
				failWorkflowOutboxExecution(input, database),
			defer: (input: Parameters<typeof deferWorkflowOutboxExecution>[0]) =>
				deferWorkflowOutboxExecution(input, database),
			execute,
			recover: vi.fn(),
		};
		expect(await executeTargetedEvent(task!, deps)).toMatchObject({ deliveryState: "pending" });
		expect(await database.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject(
			{
				status: "LEASED",
				attempts: 1,
				leaseToken: task!.outboxReceipt!.leaseToken,
				processedAt: null,
			},
		);
		expect(await executeTargetedEvent(task!, deps)).toMatchObject({ deliveryState: "completed" });
		expect(await database.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject(
			{ status: "PROCESSED", attempts: 1 },
		);
		expect(deps.recover).not.toHaveBeenCalled();
	} finally {
		await database.outboxEvent.delete({ where: { id: event.id } });
	}
});
