import { describe, expect, it } from "vitest";

import { createVideoOutputReport, videoOutputSpecificationFailure } from "./video-output";
import { readVideoOutputReport } from "./video-output-report";

const requested = {
	productKey: "video-kling-3",
	durationSeconds: 10,
	sound: false,
	resolution: "1080p",
	aspectRatio: "9:16",
};
const actual = {
	durationMillis: 5000,
	width: 1280,
	height: 720,
	audioTracks: 1,
	audioTrackIds: [2],
	videoTracks: 1 as const,
};

describe("video quality does not decide delivery eligibility", () => {
	it("allows usable metadata with unexpected audio, duration, resolution and ratio", () => {
		expect(videoOutputSpecificationFailure(actual, requested)).toBeNull();
		expect(createVideoOutputReport(actual, requested)).toEqual({
			schemaVersion: 1,
			actual: { durationMillis: 5000, width: 1280, height: 720, audioTracks: 1 },
			requested: { durationSeconds: 10, sound: false, resolution: "1080p", aspectRatio: "9:16" },
			warnings: [
				"DURATION_MISMATCH",
				"UNEXPECTED_AUDIO",
				"RESOLUTION_MISMATCH",
				"ASPECT_RATIO_MISMATCH",
			],
		});
	});
	it("reports missing requested audio and preserves the original requested settings", () => {
		const report = createVideoOutputReport(
			{ ...actual, audioTracks: 0, audioTrackIds: [] },
			{ ...requested, sound: true },
		);
		expect(report.warnings).toContain("MISSING_AUDIO");
		expect(report.requested.sound).toBe(true);
	});
	it("does not invent a pixel matrix for a resolution label without pixel evidence", () => {
		const report = createVideoOutputReport(actual, {
			...requested,
			productKey: "video-seedance-2",
		});
		expect(report.actual).toMatchObject({ width: 1280, height: 720 });
		expect(report.warnings).not.toContain("RESOLUTION_MISMATCH");
	});
	it("does not expose private stage data or an invalid report on the public boundary", () => {
		const report = createVideoOutputReport(actual, requested);
		const outputSpec = {
			report,
			...actual,
			assetId: "sealed-asset",
			checksum: "a".repeat(64),
			etag: "sealed-etag",
		};
		expect(readVideoOutputReport({ outputSpec, providerUrl: "private" })).toEqual(report);
		for (const stageData of [
			null,
			{},
			{ outputSpec: { ...outputSpec, assetId: undefined } },
			{ outputSpec: { ...outputSpec, width: 1920 } },
			{ outputSpec: { ...outputSpec, report: { ...report, providerUrl: "private" } } },
			{ outputSpec: { ...outputSpec, report: { ...report, warnings: ["RAW_PROVIDER_ERROR"] } } },
		])
			expect(readVideoOutputReport(stageData)).toBeUndefined();
	});
	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		"still rejects invalid duration %s",
		(durationMillis) => {
			expect(
				videoOutputSpecificationFailure({ ...actual, durationMillis }, requested),
			).not.toBeNull();
		},
	);
	it("still rejects broken audio identity and impossible dimensions", () => {
		expect(videoOutputSpecificationFailure({ ...actual, audioTrackIds: [] }, requested)).toBe(
			"VIDEO_AUDIO_TRACK_IDENTITY_MISSING",
		);
		expect(videoOutputSpecificationFailure({ ...actual, width: 0 }, requested)).toBe(
			"VIDEO_DIMENSIONS_INVALID",
		);
	});
});
