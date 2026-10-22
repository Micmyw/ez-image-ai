import { kieCompletionCallbackUrl } from "@repo/jobs/orchestration/kie-callback-auth";
import { logger } from "@repo/logs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createKieCallbackHandler } from "./kie-callback";

const defaults = vi.hoisted(() => ({
	wakeAttempt: vi.fn(),
	wakeJob: vi.fn(),
	dispatchJob: vi.fn(),
}));
vi.mock("@repo/database", () => ({ wakeKieGenerationAttemptWithOwner: defaults.wakeAttempt }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/jobs/orchestration/client", () => ({
	wakeJob: defaults.wakeJob,
	dispatchJob: defaults.dispatchJob,
}));

const secret = "s".repeat(32);
const phaseOwner = { workflowId: `job-${"a".repeat(64)}`, phaseKey: "attempt-phase", epoch: 3 };
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
	beforeEach(() => {
		vi.clearAllMocks();
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});
	it("uses the direct read-only wake path by default", async () => {
		vi.stubEnv("WORKFLOWS_DISPATCH_SECRET", secret);
		defaults.wakeAttempt.mockResolvedValue("ready");
		defaults.wakeJob.mockResolvedValue(undefined);
		const f = fixture();
		expect((await createKieCallbackHandler()(f.request())).status).toBe(202);
		expect(defaults.wakeAttempt).toHaveBeenCalledWith(
			{ attemptId: "attempt-1", providerTaskId: "remote-1" },
			{},
			expect.objectContaining({ onTiming: expect.any(Function) }),
		);
		expect(defaults.wakeJob).toHaveBeenCalledExactlyOnceWith(
			"media-poll-generation",
			{ attemptId: "attempt-1" },
			{ idempotencyKey: "generation-callback:attempt-1", timeoutMs: 3000 },
		);
		expect(defaults.dispatchJob).not.toHaveBeenCalled();
	});
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
	it.each(["recorded", "invalid", "terminal"] as const)(
		"handles %s without dispatching",
		async (outcome) => {
			const f = fixture();
			f.wake.mockResolvedValue(outcome);
			expect((await f.handler(f.request())).status).toBe(outcome === "invalid" ? 400 : 202);
			expect(f.dispatch).not.toHaveBeenCalled();
		},
	);
	it("retries the same read-only wake after its first transport failure", async () => {
		const f = fixture();
		f.dispatch.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(undefined);
		expect((await f.handler(f.request())).status).toBe(503);
		expect((await f.handler(f.request())).status).toBe(202);
		expect(f.dispatch).toHaveBeenCalledTimes(2);
		expect(f.dispatch.mock.calls[0]).toEqual(f.dispatch.mock.calls[1]);
	});
	it("acknowledges a consumed duplicate without waking another query", async () => {
		const f = fixture();
		f.wake.mockResolvedValueOnce("ready").mockResolvedValueOnce("recorded");
		expect((await f.handler(f.request())).status).toBe(202);
		expect((await f.handler(f.request())).status).toBe(202);
		expect(f.dispatch).toHaveBeenCalledTimes(1);
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
	it("signals the persisted attempt owner without trusting callback owner fields", async () => {
		const f = fixture();
		f.wake.mockResolvedValue({ status: "ready", phaseOwner });
		expect(
			(
				await f.handler(
					f.request({ data: { taskId: "remote-1" }, phaseOwner: { workflowId: "forged" } }),
				)
			).status,
		).toBe(202);
		expect(f.dispatch).toHaveBeenCalledExactlyOnceWith(
			"media-poll-generation",
			{ attemptId: "attempt-1" },
			{ idempotencyKey: "generation-callback:attempt-1", timeoutMs: 3000, phaseOwner },
		);
		expect(f.wake.mock.invocationCallOrder[0]).toBeLessThan(
			f.dispatch.mock.invocationCallOrder[0]!,
		);
	});
	it("preserves durable recovery without another execution chain when signaling fails", async () => {
		const f = fixture();
		f.wake.mockResolvedValue({ status: "ready", phaseOwner });
		f.dispatch.mockRejectedValue(new Error("phase signal failed"));
		expect((await f.handler(f.request())).status).toBe(503);
		expect(f.dispatch).toHaveBeenCalledOnce();
		expect(f.dispatch.mock.calls[0]![2]).toMatchObject({ phaseOwner });
	});
	it("does not signal a consumed notice even with an owner", async () => {
		const f = fixture();
		f.wake.mockResolvedValue({ status: "recorded", phaseOwner });
		expect((await f.handler(f.request())).status).toBe(202);
		expect(f.dispatch).not.toHaveBeenCalled();
	});
});
