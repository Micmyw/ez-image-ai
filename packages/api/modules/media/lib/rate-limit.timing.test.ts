import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), info: vi.fn() }));
vi.mock("@repo/database/client", () => ({ db: { $queryRaw: mocks.query } }));
vi.mock("@repo/logs", () => ({
	getLogContext: () => ({ requestId: "limit-request" }),
	logger: { info: mocks.info },
}));
import { enforceMediaRateLimit } from "./rate-limit";

beforeEach(() => vi.clearAllMocks());
describe("admission rate limit timing", () => {
	it.each([
		["media:quote", true],
		["media:quote", false],
		["media:generation", true],
		["media:generation", false],
	] as const)(
		"retains the %s limiter result and logs no user identity: %s",
		async (action, allowed) => {
			mocks.query.mockResolvedValue([{ allowed }]);
			const result = enforceMediaRateLimit("private-test-user", action);
			if (allowed) await expect(result).resolves.toBeUndefined();
			else await expect(result).rejects.toThrow("RATE_LIMITED");
			expect(mocks.query).toHaveBeenCalledOnce();
			expect(mocks.query.mock.calls[0]).toContain(action);
			expect(mocks.info).toHaveBeenCalledWith(
				"media.flow.timing",
				expect.objectContaining({
					requestId: "limit-request",
					stage: "admission.rateLimit",
					outcome: allowed ? "ok" : "error",
				}),
			);
			expect(JSON.stringify(mocks.info.mock.calls)).not.toContain("private-test-user");
		},
	);
});
