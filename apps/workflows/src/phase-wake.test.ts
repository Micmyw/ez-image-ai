import { signRequest } from "@repo/jobs/orchestration/auth";
import { imagePhaseEventType } from "@repo/jobs/orchestration/contracts";
import { describe, expect, it, vi } from "vitest";

import { handlePhaseWake } from "./wake";

const secret = "test-only-32-character-shared-secret";
const owner = { workflowId: "actual-workflow", phaseKey: "phase-uuid", epoch: 2 };
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
	const sendEvent = vi.fn(async () => {});
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
	});
	it("does not create a fallback execution after an unknown or missing signal response", async () => {
		const workflows = binding();
		workflows.sendEvent.mockRejectedValueOnce(new Error("response lost"));
		expect((await handlePhaseWake(await signed(), secret, workflows)).status).toBe(503);
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
