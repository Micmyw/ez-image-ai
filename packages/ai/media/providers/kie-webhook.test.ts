import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyKieWebhook } from "./kie-webhook";

describe("shared Kie task/time signature", () => {
	const secret = "test-provider-webhook-key";
	const now = 1794816000;
	function input(offset = 0) {
		const timestamp = String(now + offset);
		return {
			taskId: "task-1",
			timestamp,
			secret,
			nowSeconds: now,
			signature: createHmac("sha256", secret).update(`task-1.${timestamp}`).digest("base64"),
		};
	}
	it.each([0, -300, 30])("accepts a fresh authentic signature (offset %s)", async (offset) => {
		expect(await verifyKieWebhook(input(offset))).toBe(true);
	});
	it.each([-301, 31])(
		"rejects stale or future signed notifications (offset %s)",
		async (offset) => {
			expect(await verifyKieWebhook(input(offset))).toBe(false);
		},
	);
	it("rejects a changed task or key", async () => {
		expect(await verifyKieWebhook({ ...input(), taskId: "other-task" })).toBe(false);
		expect(await verifyKieWebhook({ ...input(), secret: "different-key" })).toBe(false);
	});
});
