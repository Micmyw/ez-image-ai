import { describe, expect, it, vi } from "vitest";

import { moderateQuoteInput, TEXT_MODERATION_RULE_VERSION } from "./text-moderation";

const quote = {
	ownerType: "USER" as const,
	ownerId: "retry-owner",
	submittedByUserId: "retry-owner",
	productKey: "image-fast",
	catalogVersion: "v1",
	pricingVersion: "v1",
	credits: 4n,
	inputSnapshot: { prompt: "A quiet mountain landscape" },
	expiresAt: new Date(Date.now() + 300_000),
};
const verdict = (decision: "ALLOW" | "ERROR" | "REJECT" | "REVIEW", reasonCode: string) => ({
	decision,
	reasonCode,
	ruleVersion: TEXT_MODERATION_RULE_VERSION,
});
function dependencies(
	scan: ReturnType<typeof vi.fn<(...args: any[]) => Promise<ReturnType<typeof verdict>>>>,
) {
	return {
		provider: "waffo" as const,
		moderateText: scan,
		persistApproved: vi.fn((evidence) => evidence),
		recordDenied: vi.fn(),
		retryWait: vi.fn(async () => {}),
	};
}

describe("bounded moderation outage handling", () => {
	it("permits a prompt after four technical failures with explicit bypass provenance", async () => {
		const deps = dependencies(
			vi.fn().mockResolvedValue(verdict("ERROR", "MODERATION_UNAVAILABLE")),
		);
		const result = await moderateQuoteInput(quote, deps);
		expect(deps.moderateText).toHaveBeenCalledTimes(4);
		expect(deps.retryWait).toHaveBeenCalledTimes(3);
		expect(result).toMatchObject({
			decision: "BYPASS",
			reasonCode: "MODERATION_TECHNICAL_FAILURE_BYPASS",
			retry: { failures: 4, lastErrorCode: "MODERATION_UNAVAILABLE" },
		});
		expect(deps.recordDenied).not.toHaveBeenCalled();
	});
	it("stops on successful recovery and preserves the preceding failures", async () => {
		const deps = dependencies(
			vi
				.fn()
				.mockResolvedValueOnce(verdict("ERROR", "MODERATION_UNAVAILABLE"))
				.mockResolvedValue(verdict("ALLOW", "NO_POLICY_MATCH")),
		);
		expect(await moderateQuoteInput(quote, deps)).toMatchObject({
			decision: "ALLOW",
			retry: { failures: 1 },
		});
		expect(deps.moderateText).toHaveBeenCalledTimes(2);
	});
	it.each(["REJECT", "REVIEW"] as const)(
		"does not turn %s after a technical error into a bypass",
		async (decision) => {
			const deps = dependencies(
				vi
					.fn()
					.mockResolvedValueOnce(verdict("ERROR", "MODERATION_UNAVAILABLE"))
					.mockResolvedValue(verdict(decision, "CONTENT_RESTRICTED")),
			);
			await expect(moderateQuoteInput(quote, deps)).rejects.toThrow();
			expect(deps.moderateText).toHaveBeenCalledTimes(2);
			expect(deps.persistApproved).not.toHaveBeenCalled();
		},
	);
	it("does not bypass invalid input or invalid detector configuration", async () => {
		for (const code of ["MODERATION_INVALID_INPUT", "MODERATION_CONFIGURATION_ERROR"]) {
			const deps = dependencies(vi.fn().mockResolvedValue(verdict("ERROR", code)));
			await expect(moderateQuoteInput(quote, deps)).rejects.toThrow();
			expect(deps.moderateText).toHaveBeenCalledOnce();
			expect(deps.persistApproved).not.toHaveBeenCalled();
			expect(deps.recordDenied).toHaveBeenCalledWith(
				expect.objectContaining({
					retry: expect.objectContaining({ failures: 1, lastErrorCode: code }),
				}),
			);
		}
	});
});
