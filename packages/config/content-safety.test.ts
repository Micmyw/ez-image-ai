import { describe, expect, it } from "vitest";

import {
	isPermittedModerationEvidence,
	isDelegatedImageInputEvidence,
	SEEAPI_INPUT_DELEGATION_REASON,
	isRetryableModerationError,
	MODERATION_BYPASS_REASON,
	moderationServiceErrorCode,
} from "./content-safety";

describe("moderation evidence permission", () => {
	it("permits only new account input delegation without treating it as approval", () => {
		const evidence = {
			status: "BYPASSED",
			reasonCode: SEEAPI_INPUT_DELEGATION_REASON,
			provider: "seeapi",
			providerTaskId: "task_1",
			evidenceKind: "INPUT",
		};
		const asset = {
			kind: "INPUT",
			mimeType: "image/jpeg",
			ownerType: "USER",
			retentionClass: "ACCOUNT",
			verificationEngine: "legacy",
		};
		expect(isDelegatedImageInputEvidence(evidence, asset)).toBe(true);
		expect(isPermittedModerationEvidence(evidence)).toBe(false);
		for (const change of [
			{ kind: "OUTPUT" },
			{ mimeType: "video/mp4" },
			{ retentionClass: "GUEST" },
			{ verificationEngine: "video-workflow-v1" },
			{ ownerType: "ORGANIZATION" },
		])
			expect(isDelegatedImageInputEvidence(evidence, { ...asset, ...change })).toBe(false);
		for (const change of [
			{ status: "APPROVED" },
			{ status: "REJECTED" },
			{ status: "ERROR" },
			{ reasonCode: MODERATION_BYPASS_REASON },
			{ provider: "test" },
			{ providerTaskId: null },
		])
			expect(isDelegatedImageInputEvidence({ ...evidence, ...change }, asset)).toBe(false);
	});
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
