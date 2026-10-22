import { verifyRequest } from "@repo/jobs/orchestration/auth";
import { CAPACITY_WAIT_MS } from "@repo/jobs/orchestration/capacity";
import { describe, expect, it, vi } from "vitest";

import { createExecutorInvoker } from "./invoke";

const secret = "test-only-32-character-shared-secret";
const task = { taskId: "media-verify-upload", payload: { assetId: "asset" } };
const context = { attempt: 1, maxAttempts: 8, runId: "run" };

describe("executor capacity protocol", () => {
	it("retains only the precise receipt-bound 503 pre-claim retry protocol", async () => {
		const transfer = {
			taskId: "media-finalize-generation",
			payload: { jobId: "job", version: 0 },
			outboxReceipt: { eventId: "event", workerId: "worker", leaseToken: "token" },
		};
		const retry = {
			status: "retry",
			reason: "OUTPUT_TRANSFER_CLAIM_CONFLICT",
			phase: "BEFORE_TRANSFER_LEASE",
		};
		for (const [request, response, status, expected] of [
			[transfer, retry, 503, retry],
			[transfer, retry, 502, { status: "failed" }],
			[transfer, { ...retry, phase: "AFTER_TRANSFER_LEASE" }, 503, { status: "failed" }],
			[transfer, { ...retry, reason: "P2034" }, 503, { status: "failed" }],
			[transfer, { ...retry, privateUrl: "secret" }, 503, { status: "failed" }],
			[{ ...transfer, outboxReceipt: undefined }, retry, 503, { status: "failed" }],
			[task, retry, 503, { status: "failed" }],
		] as const) {
			const invoke = createExecutorInvoker(secret, () => ({
				fetch: async () => Response.json(response, { status }),
			}));
			expect(await invoke(request, context)).toEqual(expected);
		}
	});
	it("converts the database remainder in the Workflow clock before checkpointing it", async () => {
		const now = 1_800_000_000_000;
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			const invoke = createExecutorInvoker(secret, () => ({
				fetch: async () =>
					Response.json({ status: "ok", preparedEvent: null, eventRetryAfterMs: 811 }),
			}));
			expect(
				await invoke({ taskId: "media-prepare-event", payload: { eventId: "event" } }, context),
			).toEqual({ status: "ok", preparedEvent: null, eventRetryAt: now + 811 });
		} finally {
			clock.mockRestore();
		}
	});
	it("parses only the closed settlement rollback response on the matching receipt-bound task", async () => {
		const settlement = {
			taskId: "media-settle-generation",
			payload: { jobId: "job", version: 0 },
			outboxReceipt: { eventId: "event", workerId: "worker", leaseToken: "token" },
		};
		const retry = {
			status: "retry",
			reason: "SETTLEMENT_TRANSACTION_CONFLICT",
			phase: "TRANSACTION_ROLLED_BACK",
		};
		for (const [request, response, status, expected] of [
			[settlement, retry, 503, retry],
			[settlement, retry, 502, { status: "failed" }],
			[settlement, { ...retry, phase: "BEFORE_TRANSFER_LEASE" }, 503, { status: "failed" }],
			[settlement, { ...retry, reason: "P2034" }, 503, { status: "failed" }],
			[settlement, { ...retry, retryAfterMs: 1 }, 503, { status: "failed" }],
			[{ ...settlement, taskId: "media-finalize-generation" }, retry, 503, { status: "failed" }],
			[{ ...settlement, outboxReceipt: undefined }, retry, 503, { status: "failed" }],
		] as const) {
			const invoke = createExecutorInvoker(secret, () => ({
				fetch: async () => Response.json(response, { status }),
			}));
			expect(await invoke(request, context)).toEqual(expected);
		}
	});
	it.each([-1, 1.5, "811", null, Number.MAX_SAFE_INTEGER])(
		"rejects an invalid or overflowing prepare remainder %s",
		async (eventRetryAfterMs) => {
			const invoke = createExecutorInvoker(secret, () => ({
				fetch: async () => Response.json({ status: "ok", preparedEvent: null, eventRetryAfterMs }),
			}));
			await expect(
				invoke({ taskId: "media-prepare-event", payload: { eventId: "event" } }, context),
			).rejects.toThrow();
		},
	);
	it("reroutes an explicit streaming exclusion with the exact request, receipt and attempt", async () => {
		const transfer = {
			taskId: "media-finalize-generation",
			payload: { jobId: "job", version: 0, deferOutputReview: true },
			outboxReceipt: { eventId: "event", workerId: "worker", leaseToken: "token" },
		};
		const bodies: string[] = [];
		const service = {
			fetch: vi.fn(async (request: Request) => {
				bodies.push(await request.text());
				return Response.json({ status: "reroute", executor: "heavy" }, { status: 409 });
			}),
		};
		const heavy = {
			fetch: vi.fn(async (request: Request) => {
				const body = await request.text();
				bodies.push(body);
				expect(
					await verifyRequest(secret, "POST", "/internal/execute", body, request.headers),
				).toBe(true);
				return Response.json({
					status: "ok",
					deliveryState: "completed",
					continuation: { eventIds: [] },
				});
			}),
		};
		await expect(
			createExecutorInvoker(
				secret,
				() => service,
				() => heavy,
			)(transfer, context),
		).resolves.toMatchObject({ status: "ok", deliveryState: "completed" });
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).toBe(bodies[0]);
		expect(JSON.parse(bodies[1]!)).toMatchObject({ request: transfer, context });
		expect(service.fetch).toHaveBeenCalledOnce();
		expect(heavy.fetch).toHaveBeenCalledOnce();
	});
	it.each([
		new Response("network failure", { status: 502 }),
		new Response("conflict", { status: 409 }),
		Response.json({ status: "reroute", executor: "control" }, { status: 409 }),
	])(
		"does not reinterpret transport errors as permission to switch execution",
		async (response) => {
			const heavy = { fetch: vi.fn() };
			const invoke = createExecutorInvoker(
				secret,
				() => ({ fetch: async () => response }),
				() => heavy,
			);
			await expect(
				invoke(
					{ taskId: "media-finalize-generation", payload: { jobId: "job", version: 0 } },
					context,
				),
			).resolves.toEqual({ status: "failed" });
			expect(heavy.fetch).not.toHaveBeenCalled();
		},
	);
	it("never reroutes first submissions or lost responses and never loops a heavy rejection", async () => {
		const heavy = {
			fetch: vi.fn(async () =>
				Response.json({ status: "reroute", executor: "heavy" }, { status: 409 }),
			),
		};
		const service = {
			fetch: vi.fn(async () =>
				Response.json({ status: "reroute", executor: "heavy" }, { status: 409 }),
			),
		};
		const invoke = createExecutorInvoker(
			secret,
			() => service,
			() => heavy,
		);
		await expect(invoke(task, context)).resolves.toEqual({ status: "failed" });
		expect(heavy.fetch).not.toHaveBeenCalled();
		service.fetch.mockRejectedValueOnce(new Error("response lost"));
		await expect(
			invoke(
				{ taskId: "media-finalize-generation", payload: { jobId: "job", version: 0 } },
				context,
			),
		).rejects.toThrow("response lost");
		expect(heavy.fetch).not.toHaveBeenCalled();
		await expect(
			invoke(
				{ taskId: "media-finalize-generation", payload: { jobId: "job", version: 0 } },
				context,
			),
		).resolves.toEqual({ status: "failed" });
		expect(heavy.fetch).toHaveBeenCalledOnce();
	});
	it("opts in via the signed body and includes the capacity window in its I/O deadline", async () => {
		const timeout = vi.spyOn(AbortSignal, "timeout");
		const fetcher = vi.fn(async (request: Request) => {
			const body = await request.text();
			expect(JSON.parse(body)).toEqual({
				request: task,
				context,
				waitForCapacityMs: CAPACITY_WAIT_MS,
				supportsImmediatePolling: true,
				supportsDatabaseConflictRetry: true,
			});
			expect(await verifyRequest(secret, "POST", "/internal/execute", body, request.headers)).toBe(
				true,
			);
			return Response.json({ status: "ok", poll: { done: true, waitSeconds: 0 } });
		});
		try {
			await expect(
				createExecutorInvoker(secret, () => ({ fetch: fetcher }))(task, context),
			).resolves.toMatchObject({ status: "ok" });
			expect(timeout).toHaveBeenCalledWith(130_000 + CAPACITY_WAIT_MS);
		} finally {
			timeout.mockRestore();
		}
	});
	it.each([
		[
			Response.json({ status: "busy", capacityWaited: true }, { status: 429 }),
			{ status: "busy", capacityWaited: true },
		],
		[
			Response.json({ status: "busy", capacityWaited: "true" }, { status: 429 }),
			{ status: "busy" },
		],
		[new Response("Busy", { status: 429 }), { status: "busy" }],
	])("preserves the explicit capacity-wait receipt only", async (response, expected) => {
		const invoke = createExecutorInvoker(secret, () => ({
			fetch: vi.fn().mockResolvedValue(response),
		}));
		expect(await invoke(task, context)).toEqual(expected);
	});
});
