import { beforeEach, describe, expect, it, vi } from "vitest";

const record = vi.hoisted(() => vi.fn());
vi.mock("@repo/database", () => ({ recordCheckoutDiagnostic: record }));
vi.mock("@repo/logs", () => ({ logger: { error: vi.fn() } }));
import { observeCheckoutOperation } from "./checkout-diagnostics";

beforeEach(() => {
	record.mockReset();
	record.mockResolvedValue(undefined);
});
describe("checkout observation failure isolation", () => {
	it("does not label an unresolved recovery as a recovered checkout", async () => {
		const result = await observeCheckoutOperation(
			{ intentId: "order", actorUserId: "user", operation: "recovery" },
			async () => ({ kind: "REVIEW" }),
			(value) => (value.kind === "RECOVERED" ? "succeeded" : "unconfirmed"),
		);
		expect(result).toEqual({ kind: "REVIEW" });
		expect(record.mock.calls[1][0].diagnostic.phase).toBe("unconfirmed");
	});
	it("preserves a successful payment result when all diagnostic writes fail", async () => {
		record.mockRejectedValue(new Error("database unavailable"));
		const capture = vi.fn().mockResolvedValue({ accepted: true });
		await expect(
			observeCheckoutOperation(
				{ intentId: "order", actorUserId: "user", operation: "capture" },
				capture,
			),
		).resolves.toEqual({ accepted: true });
		expect(capture).toHaveBeenCalledTimes(1);
	});
	it("does not retry or replace an uncertain payment error", async () => {
		const error = new Error("uncertain financial outcome");
		const capture = vi.fn().mockRejectedValue(error);
		await expect(
			observeCheckoutOperation(
				{ intentId: "order", actorUserId: "user", operation: "capture" },
				capture,
			),
		).rejects.toBe(error);
		expect(capture).toHaveBeenCalledTimes(1);
		const start = record.mock.calls[0][0];
		const end = record.mock.calls[1][0];
		expect(start.diagnostic.phase).toBe("started");
		expect(end.diagnostic).toMatchObject({
			phase: "failed",
			attemptId: start.diagnostic.attemptId,
			error: { kind: "unknown" },
		});
		expect(JSON.stringify(end)).not.toContain(error.message);
	});
});
