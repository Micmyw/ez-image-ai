import { describe, expect, it } from "vitest";

import { isPermittedModerationEvidence, MODERATION_BYPASS_REASON } from "./content-safety";

describe("moderation evidence permission", () => {
	it("allows explicit approval and rejects technical-failure bypass history", () => {
		expect(isPermittedModerationEvidence({ status: "APPROVED" })).toBe(true);
		for (const status of ["BYPASSED", "PENDING", "REJECTED", "ERROR", "REVIEW"])
			expect(isPermittedModerationEvidence({ status, reasonCode: MODERATION_BYPASS_REASON })).toBe(
				false,
			);
		expect(isPermittedModerationEvidence(null)).toBe(false);
	});
});
