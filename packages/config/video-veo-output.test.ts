import { describe, expect, it } from "vitest";

import {
	videoOutputConstraints,
	videoOutputSpecificationFailure,
	videoResolutionPixelContract,
} from "./video-output";

// Application delivery floor, not a claim of supplier-confirmed exact pixels.
const base = {
	productKey: "video-veo-3-1",
	veoTier: "lite",
	modelContractVersion: "video-models-2026-10-08.1",
	duration: 8,
	sound: true,
	resolution: "1080p",
	aspectRatio: "16:9",
	audioSafetyPolicy: { schemaVersion: 1, mode: "not_requested" },
};
describe("frozen Veo application delivery floor", () => {
	it.each([
		["720p", 720],
		["1080p", 1080],
		["4k", 2160],
	] as const)(
		"preserves the %s target without rejecting downgraded output including Auto",
		(resolution, minimumShortEdge) => {
			for (const veoTier of ["lite", "fast", "quality"])
				for (const aspectRatio of ["16:9", "9:16", "source"]) {
					const constraints = videoOutputConstraints({
						...base,
						veoTier,
						aspectRatio,
						resolution,
						resolutionPolicy: { schemaVersion: 1, kind: "minimum-short-edge", minimumShortEdge },
					});
					expect(constraints.minimumShortEdge).toBe(minimumShortEdge);
					expect(videoResolutionPixelContract(constraints)).toBe("APP_MINIMUM");
					const output = {
						durationMillis: 8000,
						width: (minimumShortEdge * 16) / 9,
						height: Number(minimumShortEdge),
						audioTracks: 0,
						videoTracks: 1 as const,
					};
					if (aspectRatio === "9:16") [output.width, output.height] = [output.height, output.width];
					expect(videoOutputSpecificationFailure(output, constraints)).toBeNull();
					expect(
						videoOutputSpecificationFailure(
							{ ...output, width: output.width / 2, height: output.height / 2 },
							constraints,
						),
					).toBeNull();
				}
		},
	);
	it.each([
		undefined,
		{ schemaVersion: 2, kind: "minimum-short-edge", minimumShortEdge: 1080 },
		{ schemaVersion: 1, kind: "minimum-short-edge", minimumShortEdge: 720 },
		{ schemaVersion: 1, kind: "exact", minimumShortEdge: 1080 },
	])(
		"fails closed when the explicit tier has a missing or mismatched frozen floor %j",
		(resolutionPolicy) => {
			expect(() => videoOutputConstraints({ ...base, resolutionPolicy })).toThrow(
				"VIDEO_RESOLUTION_POLICY_INVALID",
			);
		},
	);
	it.each(["video-veo-3-1", "video-veo-3-1-fast"])(
		"does not retrofit the delivery floor onto historical %s",
		(productKey) => {
			const { veoTier: _tier, ...legacy } = { ...base, productKey };
			const constraints = videoOutputConstraints(legacy);
			expect(constraints).not.toHaveProperty("minimumShortEdge");
			expect(videoResolutionPixelContract(constraints)).toBe("NOT_VERIFIED");
		},
	);
});
