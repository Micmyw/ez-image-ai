import { signRequest } from "@repo/jobs/orchestration/auth";
import { imagePhaseEventType } from "@repo/jobs/orchestration/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handlePhaseWake } from "./wake";

const secret = "test-only-32-character-shared-secret";
const owner = { workflowId: "actual-workflow", phaseKey: "phase-uuid", epoch: 2 };
beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function diagnostic() {
	expect(console.warn).toHaveBeenCalledTimes(1);
	const [message] = vi.mocked(console.warn).mock.calls[0]!;
	expect(typeof message).toBe("string");
	return JSON.parse(message) as Record<string, unknown>;
}
async function signed(changes: Record<string, unknown> = {}) {
	const body = JSON.stringify({
		taskId: "media-verify-upload",
		payload: { assetId: "asset" },
		idempotencyKey: "review-callback",
		phaseOwner: owner,
		...changes,
	});
	return new Request("https://jobs/internal/phase-wake", {
		method: "POST",
		body,
		headers: await signRequest(secret, "POST", "/internal/phase-wake", body),
	});
}
function binding() {
	const sendEvent = vi.fn(async (event: { type: string; payload: unknown }) => {
		// Match the real cloud binding, which is stricter than local workerd.
		if (event.type.length > 100 || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(event.type))
			throw new Error("(workflow.invalid_event_type) Provided event type is invalid");
	});
	return {
		sendEvent,
		createBatch: vi.fn(),
		get: vi.fn(async () => ({
			sendEvent,
			status: async () => ({ status: "waiting" }),
			restart: async () => {},
		})),
	};
}
describe("authenticated single-owner phase signals", () => {
	it("signals the exact persisted owner and returns its full receipt without creating a Workflow", async () => {
		const workflows = binding();
		const response = await handlePhaseWake(await signed(), secret, workflows);
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({
			accepted: true,
			wake: true,
			id: owner.workflowId,
			phaseOwner: owner,
		});
		expect(workflows.get).toHaveBeenCalledExactlyOnceWith(owner.workflowId);
		expect(workflows.sendEvent).toHaveBeenCalledExactlyOnceWith({
			type: imagePhaseEventType(owner),
			payload: { phaseKey: owner.phaseKey, epoch: owner.epoch },
		});
		expect(workflows.createBatch).not.toHaveBeenCalled();
		expect(console.warn).not.toHaveBeenCalled();
	});
	it("does not create a fallback execution after an unknown or missing signal response", async () => {
		const workflows = binding();
		workflows.sendEvent.mockRejectedValueOnce(new Error("response lost"));
		expect((await handlePhaseWake(await signed(), secret, workflows)).status).toBe(503);
		expect(workflows.createBatch).not.toHaveBeenCalled();
		expect(diagnostic()).toMatchObject({
			event: "generation_phase_wake_failed",
			stage: "send",
			reason: "EVENT_SEND_FAILED",
			errorName: "Error",
			workflowId: owner.workflowId,
			phaseKey: owner.phaseKey,
			epoch: owner.epoch,
			taskId: "media-verify-upload",
			assetId: "asset",
			eventTypeLength: imagePhaseEventType(owner).length,
			durationMs: expect.any(Number),
		});
	});
	it("identifies missing secrets and bindings without logging request data", async () => {
		expect((await handlePhaseWake(await signed(), "", binding())).status).toBe(503);
		expect(diagnostic()).toEqual({
			event: "generation_phase_wake_failed",
			stage: "configuration",
			reason: "SECRET_UNAVAILABLE",
			durationMs: expect.any(Number),
		});
		vi.mocked(console.warn).mockClear();
		expect((await handlePhaseWake(await signed(), secret, undefined)).status).toBe(503);
		expect(diagnostic()).toMatchObject({ stage: "binding", reason: "BINDING_UNAVAILABLE" });
	});
	it("distinguishes instance lookup from a missing sendEvent method without restarting", async () => {
		const workflows = binding();
		workflows.get.mockRejectedValueOnce(new TypeError("private instance detail"));
		expect((await handlePhaseWake(await signed(), secret, workflows)).status).toBe(503);
		expect(diagnostic()).toMatchObject({
			stage: "get",
			reason: "INSTANCE_LOOKUP_FAILED",
			errorName: "TypeError",
		});
		expect(workflows.sendEvent).not.toHaveBeenCalled();
		vi.mocked(console.warn).mockClear();
		const restart = vi.fn();
		expect(
			(
				await handlePhaseWake(await signed(), secret, {
					...workflows,
					get: async () => ({ status: async () => ({ status: "waiting" }), restart }),
				})
			).status,
		).toBe(503);
		expect(diagnostic()).toMatchObject({ stage: "binding", reason: "SEND_EVENT_UNAVAILABLE" });
		expect(restart).not.toHaveBeenCalled();
		expect(workflows.createBatch).not.toHaveBeenCalled();
	});
	it.each(["TypeError", "DataCloneError", "TimeoutError", "private-secret-error-name"])(
		"allows only the observed error category for %s without echoing sensitive details",
		async (name) => {
			const workflows = binding();
			const error = new Error("https://private.example/image?signature=secret raw-body-secret");
			error.name = name;
			workflows.sendEvent.mockRejectedValueOnce(error);
			expect(
				(
					await handlePhaseWake(
						await signed({
							taskId: "media-poll-generation",
							payload: { attemptId: "attempt-1" },
							idempotencyKey: "private-idempotency-secret",
						}),
						secret,
						workflows,
					)
				).status,
			).toBe(503);
			const record = diagnostic();
			expect(record).toMatchObject({
				stage: "send",
				reason: "EVENT_SEND_FAILED",
				errorName: name.startsWith("private-") ? "Unknown" : name,
				attemptId: "attempt-1",
			});
			expect(record.durationMs).toBeGreaterThanOrEqual(0);
			expect(JSON.stringify(record)).not.toMatch(/private|secret|signature|raw-body/);
			expect(record).not.toHaveProperty("assetId");
			expect(workflows.sendEvent).toHaveBeenCalledTimes(1);
			expect(workflows.createBatch).not.toHaveBeenCalled();
		},
	);
	it("does not log unsigned bodies or identifiers containing URLs", async () => {
		const workflows = binding();
		const unauthorized = new Request("https://jobs/internal/phase-wake", {
			method: "POST",
			body: "private unsigned body",
		});
		expect((await handlePhaseWake(unauthorized, secret, workflows)).status).toBe(401);
		expect(console.warn).not.toHaveBeenCalled();
		workflows.sendEvent.mockRejectedValueOnce("private thrown secret");
		expect(
			(
				await handlePhaseWake(
					await signed({ payload: { assetId: "https://private.example/image?signature=secret" } }),
					secret,
					workflows,
				)
			).status,
		).toBe(503);
		const record = diagnostic();
		expect(record).toMatchObject({ errorName: "Unknown", stage: "send" });
		expect(record).not.toHaveProperty("assetId");
		expect(JSON.stringify(record)).not.toMatch(/private|secret|signature/);
	});
	it.each([
		["instance.not_found", "INSTANCE_NOT_FOUND"],
		["(instance.not_found) Instance does not exist: private-instance", "INSTANCE_NOT_FOUND"],
		["Engine was never started", "ENGINE_NOT_STARTED"],
		["private-url-token-instance.not_found", "UNKNOWN"],
		["private-url-token-workflow.invalid_event_type", "UNKNOWN"],
	])("retains a safe binding error code for %s", async (message, errorCode) => {
		const workflows = binding();
		const failure = new Error(message);
		failure.name = "WorkflowError";
		workflows.get.mockRejectedValueOnce(failure);
		expect((await handlePhaseWake(await signed(), secret, workflows)).status).toBe(503);
		const record = diagnostic();
		expect(record).toMatchObject({
			stage: "get",
			errorName: "WorkflowError",
			errorCode,
		});
		expect(JSON.stringify(record)).not.toContain("private");
		expect(workflows.sendEvent).not.toHaveBeenCalled();
		expect(workflows.createBatch).not.toHaveBeenCalled();
	});
	it("keeps diagnostic failures from replacing the original unavailable response", async () => {
		const workflows = binding();
		workflows.sendEvent.mockRejectedValueOnce(new Error("response lost"));
		vi.mocked(console.warn).mockImplementationOnce(() => {
			throw new Error("diagnostic sink failed");
		});
		const response = await handlePhaseWake(await signed(), secret, workflows);
		expect(response.status).toBe(503);
		expect(await response.text()).toBe("Phase signal unavailable");
		expect(workflows.sendEvent).toHaveBeenCalledTimes(1);
		expect(workflows.createBatch).not.toHaveBeenCalled();
	});
	it("classifies the observed cloud event rejection without logging its raw message", async () => {
		const workflows = binding();
		workflows.sendEvent.mockRejectedValueOnce(
			new Error("(workflow.invalid_event_type) Provided event type is invalid: private-detail"),
		);
		expect((await handlePhaseWake(await signed(), secret, workflows)).status).toBe(503);
		const record = diagnostic();
		expect(record).toMatchObject({ stage: "send", errorCode: "INVALID_EVENT_TYPE" });
		expect(JSON.stringify(record)).not.toContain("private-detail");
		expect(workflows.sendEvent).toHaveBeenCalledTimes(1);
		expect(workflows.createBatch).not.toHaveBeenCalled();
	});
	it("permits duplicate hints but never treats their payload as a moderation verdict", async () => {
		const workflows = binding();
		await handlePhaseWake(await signed(), secret, workflows);
		await handlePhaseWake(await signed(), secret, workflows);
		expect(workflows.sendEvent).toHaveBeenCalledTimes(2);
		expect(workflows.createBatch).not.toHaveBeenCalled();
	});
	it.each([
		{ phaseOwner: { ...owner, epoch: 0 } },
		{ phaseOwner: { ...owner, phaseKey: "a".repeat(128) } },
		{ phaseOwner: { ...owner, approved: true } },
		{ taskId: "media-finalize-generation", payload: { jobId: "job", version: 0 } },
		{ payload: { assetId: "asset", allowQuarantinedReverification: true } },
		{ url: "https://untrusted" },
	])("rejects malformed owners and privileged wake bodies", async (changes) => {
		const workflows = binding();
		expect((await handlePhaseWake(await signed(changes), secret, workflows)).status).toBe(400);
		expect(workflows.get).not.toHaveBeenCalled();
	});
});
