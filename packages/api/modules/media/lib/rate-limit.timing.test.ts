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
	it.each([true, false])(
		"retains the limiter result and logs no user identity: %s",
		async (allowed) => {
			mocks.query.mockResolvedValue([{ allowed }]);
			const result = enforceMediaRateLimit("private-test-user", "media:generation");
			if (allowed) await expect(result).resolves.toBeUndefined();
			else await expect(result).rejects.toThrow("RATE_LIMITED");
			expect(mocks.query).toHaveBeenCalledOnce();
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
