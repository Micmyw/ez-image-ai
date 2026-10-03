import { kieCompletionCallbackUrl } from "@repo/jobs/orchestration/kie-callback-auth";
import { logger } from "@repo/logs";
import { describe, expect, it, vi } from "vitest";

import { createKieCallbackHandler } from "./kie-callback";

const secret = "s".repeat(32);
function fixture() {
	const wake = vi
		.fn<NonNullable<Parameters<typeof createKieCallbackHandler>[0]>["wake"]>()
		.mockResolvedValue("ready");
	const dispatch = vi.fn().mockResolvedValue(undefined);
	const handler = createKieCallbackHandler({ secret: () => secret, wake, dispatch });
	const url = kieCompletionCallbackUrl("attempt-1", {
		NEXT_PUBLIC_SAAS_URL: "https://example.test",
		WORKFLOWS_DISPATCH_SECRET: secret,
	})!;
	const request = (
		body: unknown = { data: { taskId: "remote-1", state: "success", resultJson: "untrusted" } },
	) => new Request(url, { method: "POST", body: JSON.stringify(body) });
	return { handler, wake, dispatch, url, request };
}
describe("Kie completion wake-up", () => {
	it("logs callback phases without callback credentials or provider payloads", async () => {
		const logs = vi.spyOn(logger, "info").mockImplementation(() => undefined);
		try {
			const f = fixture();
			expect((await f.handler(f.request())).status).toBe(202);
			const records = logs.mock.calls
				.filter(([name]) => name === "media.flow.timing")
				.map(([, fields]) => fields as Record<string, unknown>);
			expect(records.map((record) => record.stage)).toEqual([
				"callback.auth",
				"callback.body",
				"callback.database",
				"callback.wake",
				"callback.total",
			]);
			expect(JSON.stringify(records)).not.toMatch(/remote-1|untrusted|https:|signature|token/);
			expect(records[records.length - 1]).toMatchObject({
				attemptId: "attempt-1",
				connectionWaitMs: null,
				sqlExecutionMs: null,
			});
		} finally {
			logs.mockRestore();
		}
	});
	it("ignores callback results and wakes the existing leased retrieval using one stable key", async () => {
		const f = fixture();
		for (let i = 0; i < 2; i++) expect((await f.handler(f.request())).status).toBe(202);
		expect(f.wake).toHaveBeenCalledWith(
			{ attemptId: "attempt-1", providerTaskId: "remote-1" },
			expect.objectContaining({ mark: expect.any(Function) }),
		);
		expect(f.dispatch).toHaveBeenCalledWith(
			"media-poll-generation",
			{ attemptId: "attempt-1" },
			{
				idempotencyKey: "generation-callback:attempt-1",
				timeoutMs: 3000,
			},
		);
		expect(f.dispatch.mock.calls[0]).toEqual(f.dispatch.mock.calls[1]);
	});
	it("rejects forged callbacks before touching the database", async () => {
		const f = fixture();
		expect(
			(
				await f.handler(
					new Request(f.url.replace("attempt-1", "attempt-2"), { method: "POST", body: "{}" }),
				)
			).status,
		).toBe(401);
		expect(f.wake).not.toHaveBeenCalled();
	});
	it.each(["pending", "invalid", "terminal"] as const)(
		"handles %s without dispatching",
		async (outcome) => {
			const f = fixture();
			f.wake.mockResolvedValue(outcome);
			expect((await f.handler(f.request())).status).toBe(
				outcome === "pending" ? 503 : outcome === "invalid" ? 400 : 202,
			);
			expect(f.dispatch).not.toHaveBeenCalled();
		},
	);
	it("allows retry after uncertain dispatch while retaining normal polling recovery", async () => {
		const f = fixture();
		f.dispatch.mockRejectedValue(new Error("timeout"));
		expect((await f.handler(f.request())).status).toBe(503);
	});
	it("rejects oversized and malformed payloads without database access", async () => {
		const f = fixture();
		expect((await f.handler(f.request({ data: {} }))).status).toBe(400);
		expect(
			(await f.handler(f.request({ data: { taskId: "remote-1" }, padding: "x".repeat(65536) })))
				.status,
		).toBe(400);
		expect(f.wake).not.toHaveBeenCalled();
	});
});
