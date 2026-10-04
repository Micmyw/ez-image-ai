import { describe, expect, it } from "vitest";

import {
	configuredVideoTextSafetyProfile,
	createVideoTextSafetyProfile,
	isApprovedVideoTextDecision,
	readVideoTextSafetyProfile,
	videoTextSafetyProfilesMatch,
} from "./video-text-safety";

const profile = createVideoTextSafetyProfile();
const allowed = {
	decision: "ALLOW",
	reasonCode: "WAFFO_PROMPT_ALLOWED",
	ruleVersion: profile.ruleVersion,
	evidence: {
		requestId: "request-1",
		models: ["waffo-prompt-sift"],
		operations: 1,
		waffo: {
			requestId: "request-1",
			action: "allow",
			semanticStatus: "scored",
			matchedCategories: [],
		},
	},
};
describe("immutable video Waffo text policy", () => {
	it("selects only explicit Waffo and never defaults historical jobs to the current provider", () => {
		expect(configuredVideoTextSafetyProfile({ VIDEO_V1_TEXT_SAFETY_ADAPTER: "waffo" })).toEqual(
			profile,
		);
		for (const provider of [undefined, "sightengine", "test"])
			expect(() =>
				configuredVideoTextSafetyProfile({ VIDEO_V1_TEXT_SAFETY_ADAPTER: provider }),
			).toThrow("VIDEO_TEXT_MODERATION_NOT_CONFIGURED");
		expect(() => readVideoTextSafetyProfile({ prompt: "old job" })).toThrow(
			"VIDEO_TEXT_SAFETY_PROFILE_INVALID",
		);
		expect(readVideoTextSafetyProfile({ textSafetyProfile: profile })).toEqual(profile);
	});
	it("rejects policy drift and unexpected request properties", () => {
		expect(videoTextSafetyProfilesMatch(profile, profile)).toBe(true);
		for (const value of [
			null,
			{ ...profile, ruleVersion: "old" },
			{ ...profile, semantic: "shadow" },
			{ ...profile, bypass: true },
		])
			expect(videoTextSafetyProfilesMatch(value, profile)).toBe(false);
	});
	it("requires explicit scored Waffo approval from one request", () => {
		expect(isApprovedVideoTextDecision(allowed, profile)).toBe(true);
		for (const value of [
			{ ...allowed, decision: "BYPASS" },
			{ ...allowed, reasonCode: "SAFE" },
			{ ...allowed, ruleVersion: "old" },
			{ ...allowed, evidence: undefined },
			{ ...allowed, evidence: { ...allowed.evidence, requestId: "other-request" } },
			{
				...allowed,
				evidence: {
					...allowed.evidence,
					waffo: { ...allowed.evidence.waffo, semanticStatus: "shadow_scored" },
				},
			},
			{
				...allowed,
				evidence: {
					...allowed.evidence,
					waffo: { ...allowed.evidence.waffo, matchedCategories: ["adult_nsfw"] },
				},
			},
		])
			expect(isApprovedVideoTextDecision(value, profile)).toBe(false);
	});
});
