import { describe, expect, it } from "vitest";

import { createVideoEffectTemplateSnapshot } from "./video-effects.server";
import {
	createVideoAudioSafetyPolicy,
	readVideoAudioSafetyPolicy,
	videoOutputConstraints,
	videoOutputSpecificationFailure,
} from "./video-output";

const metadata = {
	durationMillis: 10_000,
	width: 1920,
	height: 1080,
	audioTracks: 1,
	audioTrackIds: [2],
	videoTracks: 1 as const,
};
const expected = {
	productKey: "video-kling-3",
	durationSeconds: 10,
	sound: true,
	resolution: "1080p",
	aspectRatio: "16:9",
};
describe("immutable video output contract", () => {
	it.each(["hotel-lobby-duo", "raindance-solo", "raindance-duo"] as const)(
		"requires actual silent 720 by 1280 output for the frozen %s template",
		(effectId) => {
			const template = createVideoEffectTemplateSnapshot({
				effectId,
				presetKey: "standard",
				inputs: {
					leftAssetId: "left",
					rightAssetId: effectId === "raindance-solo" ? "left" : "right",
				},
			});
			const snapshot = {
				...template.video,
				requestKind: "template-video",
				videoEffectTemplate: template,
				audioSafetyPolicy: createVideoAudioSafetyPolicy(),
			};
			const constraints = videoOutputConstraints(snapshot);
			const silentPortrait = {
				durationMillis: 5000,
				width: 720,
				height: 1280,
				audioTracks: 0,
				videoTracks: 1 as const,
			};
			expect(videoOutputSpecificationFailure(silentPortrait, constraints)).toBeNull();
			// Correct aspect ratio alone must not certify the advertised resolution.
			expect(
				videoOutputSpecificationFailure(
					{ ...silentPortrait, width: 360, height: 640 },
					constraints,
				),
			).toBe("VIDEO_RESOLUTION_MISMATCH");
			expect(
				videoOutputSpecificationFailure(
					{ ...silentPortrait, width: 1080, height: 1920 },
					constraints,
				),
			).toBe("VIDEO_RESOLUTION_MISMATCH");
			expect(
				videoOutputSpecificationFailure(
					{ ...silentPortrait, audioTracks: 1, audioTrackIds: [2] },
					constraints,
				),
			).toBe("VIDEO_AUDIO_TRACK_NOT_ALLOWED");
			for (const change of [
				{ videoEffectTemplate: undefined },
				{ videoEffectTemplate: { ...template, effectId: undefined } },
				{ videoEffectTemplate: { ...template, effectId: "unapproved-template" } },
				{ duration: 10 },
				{ sound: true },
				{ videoEffectTemplate: { ...template, output: { ...template.output, width: 360 } } },
			])
				expect(() => videoOutputConstraints({ ...snapshot, ...change })).toThrow(
					"VIDEO_TEMPLATE_OUTPUT_CONSTRAINTS_INVALID",
				);
		},
	);
	it("keeps audio review scope explicit without downgrading historical snapshots", () => {
		expect(createVideoAudioSafetyPolicy()).toEqual({ schemaVersion: 1, mode: "not_requested" });
		expect(readVideoAudioSafetyPolicy({})).toEqual({ schemaVersion: 1, mode: "required" });
		expect(
			readVideoAudioSafetyPolicy({ audioSafetyPolicy: createVideoAudioSafetyPolicy() }),
		).toEqual(createVideoAudioSafetyPolicy());
		for (const audioSafetyPolicy of [
			null,
			false,
			{ mode: "not_requested" },
			{ schemaVersion: 1, mode: "allow" },
			{ schemaVersion: 1, mode: "not_requested", approved: true },
		])
			expect(() => readVideoAudioSafetyPolicy({ audioSafetyPolicy })).toThrow(
				"VIDEO_AUDIO_SAFETY_POLICY_INVALID",
			);
	});
	it("keeps legacy snapshots fixed at five seconds and silent", () => {
		expect(videoOutputConstraints({ duration: 30, sound: true })).toMatchObject({
			durationSeconds: 5,
			sound: false,
		});
		expect(
			videoOutputConstraints({
				productKey: "video-kling-3",
				duration: 10,
				sound: true,
				resolution: "1080p",
				aspectRatio: "16:9",
			}),
		).toEqual({ ...expected, audioSafetyPolicy: { schemaVersion: 1, mode: "required" } });
	});
	it.each(["not_requested", "required"] as const)(
		"carries the frozen %s audio policy into storage and recovery constraints",
		(mode) => {
			const audioSafetyPolicy = { schemaVersion: 1 as const, mode };
			for (const request of [
				{ duration: 5, sound: false },
				{
					productKey: "video-kling-3",
					duration: 10,
					sound: true,
					resolution: "1080p",
					aspectRatio: "16:9",
				},
			]) {
				expect(videoOutputConstraints({ ...request, audioSafetyPolicy }).audioSafetyPolicy).toEqual(
					audioSafetyPolicy,
				);
			}
		},
	);
	it("rejects malformed frozen audio policy instead of silently removing the historical limit", () => {
		expect(() =>
			videoOutputConstraints({
				duration: 5,
				audioSafetyPolicy: { schemaVersion: 1, mode: "allow" },
			}),
		).toThrow("VIDEO_AUDIO_SAFETY_POLICY_INVALID");
	});
	it("checks duration, resolution, aspect ratio and actual audio track identity independently", () => {
		expect(videoOutputSpecificationFailure(metadata, expected)).toBeNull();
		expect(videoOutputSpecificationFailure({ ...metadata, durationMillis: 5000 }, expected)).toBe(
			"VIDEO_DURATION_MISMATCH",
		);
		expect(
			videoOutputSpecificationFailure({ ...metadata, width: 1280, height: 720 }, expected),
		).toBe("VIDEO_RESOLUTION_MISMATCH");
		expect(
			videoOutputSpecificationFailure(
				{ ...metadata, width: 1080, height: 1920 },
				{ ...expected, productKey: "video-seedance-2" },
			),
		).toBe("VIDEO_ASPECT_RATIO_MISMATCH");
		expect(videoOutputSpecificationFailure(metadata, { ...expected, sound: false })).toBe(
			"VIDEO_AUDIO_TRACK_NOT_ALLOWED",
		);
		expect(
			videoOutputSpecificationFailure({ ...metadata, audioTracks: 0, audioTrackIds: [] }, expected),
		).toBeNull();
		expect(
			videoOutputSpecificationFailure(
				{ ...metadata, audioTracks: 2, audioTrackIds: [2, 3] },
				expected,
			),
		).toBe("VIDEO_TRACK_NOT_SUPPORTED");
	});
	it("does not invent pixels for an unverified resolution label", () => {
		expect(
			videoOutputSpecificationFailure(metadata, {
				...expected,
				productKey: "video-minimax-h3",
				resolution: "2k",
			}),
		).toBeNull();
		expect(
			videoOutputSpecificationFailure(metadata, {
				...expected,
				resolution: "default",
				aspectRatio: "source",
			}),
		).toBeNull();
	});
});
