import { describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => vi.fn());
vi.mock("@repo/logs", () => ({ logger: { info: log } }));
import { createFlowTiming } from "./flow-timing";

describe("flow timing", () => {
	it("measures success and failure without logging values or error payloads", async () => {
		let now = 10;
		const timing = createFlowTiming({ requestId: "request-1" }, () => now);
		await expect(
			timing.measure("status.query", async () => {
				now += 25;
				return { prompt: "secret prompt", url: "https://private.test/token" };
			}),
		).resolves.toHaveProperty("prompt");
		timing.bind({ jobId: "job-1", assetId: "asset-1" });
		await expect(
			timing.measure("status.sign", async () => {
				now += 5;
				throw new Error("private token");
			}),
		).rejects.toThrow("private token");
		expect(log).toHaveBeenCalledWith(
			"media.flow.timing",
			expect.objectContaining({
				requestId: "request-1",
				stage: "status.query",
				stageMs: 25,
				outcome: "ok",
			}),
		);
		expect(log).toHaveBeenLastCalledWith(
			"media.flow.timing",
			expect.objectContaining({
				jobId: "job-1",
				assetId: "asset-1",
				stageMs: 5,
				elapsedMs: 30,
				outcome: "error",
				connectionWaitMs: null,
				sqlExecutionMs: null,
			}),
		);
		expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|private|https/);
	});
	it("accepts only correlation identifiers even if a caller supplies extra data", () => {
		const timing = createFlowTiming({ requestId: "r", prompt: "secret" } as never);
		timing.bind({ jobId: "j", token: "secret" } as never);
		timing.mark("status.authorization", 0, { assetId: "a", url: "private" } as never);
		expect(JSON.stringify(log.mock.lastCall)).not.toMatch(/secret|private|prompt|token/);
	});
	it("keeps a successful operation successful even if the logging sink fails", async () => {
		log.mockImplementationOnce(() => {
			throw new Error("sink unavailable");
		});
		await expect(
			createFlowTiming().measure("admission.committed", async () => "committed"),
		).resolves.toBe("committed");
	});
});
