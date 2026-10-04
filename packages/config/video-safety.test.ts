import { describe, expect, it } from "vitest";

import {
	configuredVideoVisualSafetyProfile,
	createVideoVisualSafetyProfile,
	readVideoVisualSafetyProfile,
} from "./video-safety";

describe("immutable video visual safety profiles", () => {
	it.each([2, 5, 8, 10, 15, 30])("freezes all settings for %i requested seconds", (duration) => {
		const visualSafetyProfile = createVideoVisualSafetyProfile("seeapi", duration);
		expect(readVideoVisualSafetyProfile({ duration, visualSafetyProfile })).toEqual(
			visualSafetyProfile,
		);
		expect(visualSafetyProfile.sampling).toMatchObject({
			numFrames: Math.max(8, duration + 2),
			thresholdOffset: 0,
			strictSpecialCare: true,
			returnFrames: "none",
		});
	});
	it("uses the historical Sightengine policy only for absent job profiles", () => {
		expect(readVideoVisualSafetyProfile({ duration: 5 })).toEqual(
			createVideoVisualSafetyProfile("sightengine", 5),
		);
		for (const visualSafetyProfile of [null, {}, "seeapi"])
			expect(() => readVideoVisualSafetyProfile({ duration: 5, visualSafetyProfile })).toThrow(
				"VIDEO_SAFETY_PROFILE_INVALID",
			);
	});
	it("rejects changed thresholds, coverage, rules, frame count and unknown fields", () => {
		const profile = createVideoVisualSafetyProfile("seeapi", 10);
		for (const visualSafetyProfile of [
			{ ...profile, policyVersion: "future" },
			{ ...profile, ruleVersion: "future" },
			{ ...profile, sampling: { ...profile.sampling, thresholdOffset: 0.02 } },
			{ ...profile, sampling: { ...profile.sampling, strictSpecialCare: false } },
			{ ...profile, sampling: { ...profile.sampling, maxFrameGapMillis: 2000 } },
			{ ...profile, sampling: { ...profile.sampling, numFrames: 8 } },
			{ ...profile, unexpected: true },
		])
			expect(() => readVideoVisualSafetyProfile({ duration: 10, visualSafetyProfile })).toThrow(
				"VIDEO_SAFETY_PROFILE_INVALID",
			);
	});
	it("requires explicit real provider selection for new admissions", () => {
		for (const value of [undefined, "test", "mock", "sightengine", ""])
			expect(() =>
				configuredVideoVisualSafetyProfile({ VIDEO_V1_VIDEO_SAFETY_ADAPTER: value }, 5),
			).toThrow("VIDEO_MODERATION_NOT_CONFIGURED");
		expect(
			configuredVideoVisualSafetyProfile({ VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi" }, 5).provider,
		).toBe("seeapi");
	});
	it.each([0, 1, 2.5, 31, NaN, Infinity])("rejects invalid requested duration %s", (duration) => {
		expect(() => createVideoVisualSafetyProfile("seeapi", duration)).toThrow(
			"VIDEO_SAFETY_PROFILE_INVALID",
		);
	});
});
