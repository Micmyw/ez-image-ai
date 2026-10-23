import { describe, expect, it } from "vitest";

import { imagePhaseEventType } from "./contracts";

const owner = {
	workflowId: "job-workflow",
	phaseKey: "00000000-0000-4000-8000-000000000001",
	epoch: 1,
};

describe("Cloudflare image phase event contract", () => {
	it("uses the cloud event alphabet for UUID phase identities", () => {
		// The cloud binding rejects colons with workflow.invalid_event_type;
		// local workerd currently accepts them. Keep this independent of its mock.
		expect(imagePhaseEventType(owner)).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/);
		expect(imagePhaseEventType(owner).length).toBeLessThanOrEqual(100);
	});

	it("retains distinct phase and epoch identities without truncation", () => {
		const types = [
			owner,
			{ ...owner, epoch: 2 },
			{ ...owner, phaseKey: `${owner.phaseKey}_other` },
		].map(imagePhaseEventType);
		expect(new Set(types).size).toBe(3);
	});

	it("accepts the cloud length boundary and rejects overflow rather than colliding", () => {
		expect(imagePhaseEventType({ ...owner, phaseKey: "a".repeat(86) })).toHaveLength(100);
		expect(() => imagePhaseEventType({ ...owner, phaseKey: "a".repeat(87) })).toThrow(
			"INVALID_IMAGE_PHASE_EVENT_TYPE",
		);
		expect(
			imagePhaseEventType({ ...owner, phaseKey: "a".repeat(71), epoch: Number.MAX_SAFE_INTEGER }),
		).toHaveLength(100);
		expect(() =>
			imagePhaseEventType({ ...owner, phaseKey: "a".repeat(72), epoch: Number.MAX_SAFE_INTEGER }),
		).toThrow("INVALID_IMAGE_PHASE_EVENT_TYPE");
	});
});
