import { describe, expect, it } from "vitest";

import {
	isPermittedModerationEvidence,
	isRetryableModerationError,
	MODERATION_BYPASS_REASON,
	moderationServiceErrorCode,
} from "./content-safety";

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

describe("moderation service errors", () => {
	it("preserves invalid media separately from retryable service timeouts", () => {
		expect(moderationServiceErrorCode(new Error("MODERATION_MEDIA_INVALID"))).toBe(
			"MODERATION_MEDIA_INVALID",
		);
		expect(isRetryableModerationError("MODERATION_MEDIA_INVALID")).toBe(false);
		expect(moderationServiceErrorCode(new Error("MODERATION_TIMEOUT"))).toBe("MODERATION_TIMEOUT");
		expect(isRetryableModerationError("MODERATION_TIMEOUT")).toBe(true);
		expect(
			isPermittedModerationEvidence({ status: "ERROR", reasonCode: "MODERATION_MEDIA_INVALID" }),
		).toBe(false);
	});
});
