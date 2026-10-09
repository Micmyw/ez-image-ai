import { describe, expect, it } from "vitest";

import { createVideoEffectTemplateSnapshot } from "./video-effects.server";
import {
	createVideoAudioSafetyPolicy,
	readVideoAudioSafetyPolicy,
	videoOutputConstraints,
	videoOutputSpecificationFailure,
	videoResolutionPixelContract,
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
		"validates ten-second %s against its frozen duration, pixels and silence",
		(effectId) => {
			const template = createVideoEffectTemplateSnapshot({
				effectId,
				presetKey: "standard",
				duration: 10,
				inputs: { leftAssetId: "one", rightAssetId: "one" },
			});
			const snapshot = {
				...template.video,
				requestKind: "template-video",
				videoEffectTemplate: template,
			};
			const constraints = videoOutputConstraints(snapshot);
			const output = {
				durationMillis: 10000,
				width: 720,
				height: 1280,
				audioTracks: 0,
				videoTracks: 1 as const,
			};
			expect(videoOutputSpecificationFailure(output, constraints)).toBeNull();
			expect(
				videoOutputSpecificationFailure({ ...output, durationMillis: 5000 }, constraints),
			).toBeNull();
			expect(
				videoOutputSpecificationFailure(
					{ ...output, audioTracks: 1, audioTrackIds: [2] },
					constraints,
				),
			).toBeNull();
			expect(
				videoOutputSpecificationFailure({ ...output, width: 360, height: 640 }, constraints),
			).toBeNull();
			for (const change of [
				{ duration: 5 },
				{ videoEffectTemplate: { ...template, schemaVersion: 1 } },
				{ videoEffectTemplate: { ...template, templateVersion: "unknown" } },
			])
				expect(() => videoOutputConstraints({ ...snapshot, ...change })).toThrow(
					"VIDEO_TEMPLATE_OUTPUT_CONSTRAINTS_INVALID",
				);
		},
	);
	it("allows both Kling Pro square outputs while the official prose and schema remain contradictory", () => {
		const square = { ...expected, aspectRatio: "1:1" };
		// The prose table says 1440x1440; OpenAPI says 1080x1080. This freezes the
		// historic target is advisory without claiming supplier verification or choosing a source.
		expect(videoResolutionPixelContract(square)).toBe("DOCUMENTED");
		expect(
			videoOutputSpecificationFailure({ ...metadata, width: 1080, height: 1080 }, square),
		).toBeNull();
		expect(
			videoOutputSpecificationFailure({ ...metadata, width: 1440, height: 1440 }, square),
		).toBeNull();
	});
	it("supports only the frozen reference template with its matching Seedance 2 silent portrait output", () => {
		// Synthetic identity only; this is not real motion, moderation or rights evidence.
		const template = createVideoEffectTemplateSnapshot(
			{
				effectId: "rumpelstiltskin-solo",
				presetKey: "standard",
				inputs: { leftAssetId: "subject", rightAssetId: "subject" },
			},
			{
				RUMPELSTILTSKIN_APPROVED_MOTION_REFERENCE: JSON.stringify({
					assetId: "fixture-motion",
					ownerId: "fixture-owner",
					objectKey: "private/fixture.mp4",
					sha256: "a".repeat(64),
					etag: "fixture-etag",
					storageVersionId: null,
					bytes: 1024,
					mimeType: "video/mp4",
					durationSeconds: 5,
					width: 720,
					height: 1280,
					fps: 30,
					audioTrackCount: 0,
					version: "fixture-motion-v1",
					review: {
						decision: "ALLOW",
						policyVersion: "seeapi-video-policy-2026-10-04.1",
						decisionHash: "b".repeat(64),
						verificationGeneration: 0,
						validUntil: "2100-01-01T00:00:00Z",
					},
					rights: { approvalId: "fixture-rights", validUntil: "2100-01-01T00:00:00Z" },
				}),
			},
		);
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
		expect(constraints).toMatchObject({
			productKey: "video-seedance-2",
			durationSeconds: 5,
			sound: false,
			resolution: "720p",
			aspectRatio: "9:16",
			exactPixels: { width: 720, height: 1280 },
		});
		expect(videoOutputSpecificationFailure(silentPortrait, constraints)).toBeNull();
		expect(
			videoOutputSpecificationFailure(
				{ ...silentPortrait, audioTracks: 1, audioTrackIds: [2] },
				constraints,
			),
		).toBeNull();
		expect(
			videoOutputSpecificationFailure({ ...silentPortrait, width: 360, height: 640 }, constraints),
		).toBeNull();
		for (const change of [
			{ productKey: "video-seedance-1-5-pro" },
			{ sound: true },
			{ duration: 10 },
			{ videoEffectTemplate: { ...template, schemaVersion: 1 } },
			{ videoEffectTemplate: { ...template, schemaVersion: 3 } },
			{ videoEffectTemplate: { ...template, effectId: "raindance-solo" } },
			{ videoEffectTemplate: { ...template, executionKind: "scene-video" } },
			{ videoEffectTemplate: { ...template, templateVersion: "unknown" } },
			{
				videoEffectTemplate: {
					...template,
					video: { ...template.video, productKey: "video-seedance-1-5-pro" },
				},
			},
			{ videoEffectTemplate: { ...template, video: { ...template.video, sound: true } } },
			{ videoEffectTemplate: { ...template, output: { ...template.output, sound: true } } },
		])
			expect(() => videoOutputConstraints({ ...snapshot, ...change })).toThrow(
				"VIDEO_TEMPLATE_OUTPUT_CONSTRAINTS_INVALID",
			);
	});
	it.each(["hotel-lobby-duo", "raindance-solo", "raindance-duo"] as const)(
		"preserves frozen %s targets while allowing usable output deviations",
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
			).toBeNull();
			expect(
				videoOutputSpecificationFailure(
					{ ...silentPortrait, width: 1080, height: 1920 },
					constraints,
				),
			).toBeNull();
			expect(
				videoOutputSpecificationFailure(
					{ ...silentPortrait, audioTracks: 1, audioTrackIds: [2] },
					constraints,
				),
			).toBeNull();
			for (const change of [
				{ videoEffectTemplate: undefined },
				{ videoEffectTemplate: { ...template, effectId: undefined } },
				{ videoEffectTemplate: { ...template, effectId: "unapproved-template" } },
				{ duration: 10 },
				{ sound: true },
				{ productKey: "video-seedance-2" },
				{ videoEffectTemplate: { ...template, schemaVersion: 2 } },
				{
					videoEffectTemplate: {
						...template,
						video: { ...template.video, productKey: "video-seedance-2" },
					},
				},
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
		expect(
			videoOutputSpecificationFailure({ ...metadata, durationMillis: 5000 }, expected),
		).toBeNull();
		expect(
			videoOutputSpecificationFailure({ ...metadata, width: 1280, height: 720 }, expected),
		).toBeNull();
		expect(
			videoOutputSpecificationFailure(
				{ ...metadata, width: 1080, height: 1920 },
				{ ...expected, productKey: "video-seedance-2" },
			),
		).toBeNull();
		expect(videoOutputSpecificationFailure(metadata, { ...expected, sound: false })).toBeNull();
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
