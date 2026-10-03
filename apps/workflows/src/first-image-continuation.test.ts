import { describe, expect, it, vi } from "vitest";

import { runTask, type DurableSteps, type InvokeTask } from "./orchestrator";

function steps() {
	const saved = new Map<string, unknown>();
	return {
		do: async (name, _options, operation) => {
			if (!saved.has(name)) saved.set(name, await operation());
			return saved.get(name) as never;
		},
		sleep: vi.fn(async () => undefined),
	} satisfies DurableSteps;
}

describe("normal first-image continuation", () => {
	it("follows only committed event identities with global scanning disabled", async () => {
		const calls: string[] = [];
		const invoke: InvokeTask = async (request) => {
			calls.push(request.taskId);
			if (request.taskId === "media-deliver-outbox") throw new Error("SCANNER_DISABLED");
			if (request.taskId === "media-verify-upload")
				return {
					status: "ok",
					poll: { done: true, waitSeconds: 0, continuation: { eventIds: ["committed-dispatch"] } },
				};
			expect(request).toEqual({
				taskId: "media-deliver-events",
				payload: { eventIds: ["committed-dispatch"] },
			});
			return { status: "ok" };
		};
		await runTask(
			{ taskId: "media-verify-upload", payload: { assetId: "input" } },
			"flow",
			steps(),
			invoke,
		);
		expect(calls).toEqual(["media-verify-upload", "media-deliver-events"]);
	});
	it("continues the original accepted attempt in the same durable flow before targeting output preparation", async () => {
		const calls: string[] = [];
		let polls = 0;
		const invoke: InvokeTask = async (request) => {
			calls.push(request.taskId);
			if (request.taskId === "media-dispatch-image-kie-google_nano-banana")
				return { status: "ok", continuation: { eventIds: [], pollAttemptId: "original-attempt" } };
			if (request.taskId === "media-poll-generation") {
				expect(request.payload).toEqual({ attemptId: "original-attempt" });
				return {
					status: "ok",
					poll:
						++polls === 1
							? { done: false, waitSeconds: 5, continuation: { eventIds: [] } }
							: { done: true, waitSeconds: 0, continuation: { eventIds: ["finalize-event"] } },
				};
			}
			expect(request.taskId).toBe("media-deliver-events");
			return { status: "ok" };
		};
		const step = steps();
		await runTask(
			{
				taskId: "media-dispatch-image-kie-google_nano-banana",
				payload: { jobId: "job", version: 0 },
			},
			"flow",
			step,
			invoke,
		);
		expect(calls).toEqual([
			"media-dispatch-image-kie-google_nano-banana",
			"media-poll-generation",
			"media-poll-generation",
			"media-deliver-events",
		]);
		expect(step.sleep).toHaveBeenCalledTimes(1);
	});
	it("replays durable acceptance after a failed handoff without resubmitting generation", async () => {
		const submit = vi.fn();
		const delivery = vi.fn(() => {
			throw new Error("ACCEPTED_RESPONSE_LOST");
		});
		const invoke: InvokeTask = async (request) => {
			if (request.taskId === "media-dispatch-image-kie-google_nano-banana") {
				submit();
				return { status: "ok", continuation: { eventIds: [], pollAttemptId: "original" } };
			}
			if (request.taskId === "media-poll-generation")
				return {
					status: "ok",
					poll: { done: true, waitSeconds: 0, continuation: { eventIds: ["committed-output"] } },
				};
			expect(request).toEqual({
				taskId: "media-deliver-events",
				payload: { eventIds: ["committed-output"] },
			});
			delivery();
			return { status: "ok" };
		};
		const step = steps();
		const request = {
			taskId: "media-dispatch-image-kie-google_nano-banana",
			payload: { jobId: "job", version: 0 },
		};
		await runTask(request, "flow", step, invoke);
		const deliveryAttempts = delivery.mock.calls.length;
		expect(deliveryAttempts).toBeGreaterThan(0);
		await runTask(request, "flow", step, invoke);
		expect(submit).toHaveBeenCalledTimes(1);
		expect(delivery).toHaveBeenCalledTimes(deliveryAttempts);
	});
	it("does not turn an empty current continuation into a legacy global scan", async () => {
		const invoke = vi.fn<InvokeTask>(async () => ({
			status: "ok",
			continuation: { eventIds: [] },
		}));
		await runTask(
			{ taskId: "media-finalize-generation", payload: { jobId: "job", version: 0 } },
			"empty",
			steps(),
			invoke,
		);
		expect(invoke).toHaveBeenCalledTimes(1);
	});
});
