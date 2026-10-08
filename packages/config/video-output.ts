import { RUMPELSTILTSKIN_TEMPLATE_VERSION } from "./rumpelstiltskin-reference.server";
import {
	HOTEL_LOBBY_EFFECT_ID,
	RAINDANCE_SOLO_EFFECT_ID,
	RAINDANCE_DUO_EFFECT_ID,
	RUMPELSTILTSKIN_SOLO_EFFECT_ID,
	HOTEL_LOBBY_LONG_TEMPLATE_VERSION,
	RAINDANCE_LONG_TEMPLATE_VERSION,
} from "./video-effects";
import { VIDEO_VEO_TIER_CONTRACT_VERSION, videoVeoTierSchema } from "./video-models";

/** Immutable request-derived output requirements. Legacy snapshots remain five-second/silent. */
export const VIDEO_AUDIO_POLICY_VERSION = "video-spoken-content-2026-10-04.1";
export const VIDEO_OUTPUT_MAX_BYTES = 100 * 1024 * 1024;
/** Frozen application minimum, not a supplier-confirmed exact pixel matrix. */
export type VideoResolutionPolicy = {
	schemaVersion: 1;
	kind: "minimum-short-edge";
	minimumShortEdge: number;
};

/** New quote policy; the consumer below validates its frozen version independently. */
export function createVideoResolutionPolicy(request: {
	productKey?: string;
	veoTier?: string;
	resolution?: string;
}): VideoResolutionPolicy | undefined {
	if (request.productKey !== "video-veo-3-1" || request.veoTier === undefined) return undefined;
	const minimumShortEdge = { "720p": 720, "1080p": 1080, "4k": 2160 }[request.resolution ?? ""];
	if (!videoVeoTierSchema.safeParse(request.veoTier).success || !minimumShortEdge)
		throw new Error("VIDEO_RESOLUTION_POLICY_INVALID");
	return { schemaVersion: 1, kind: "minimum-short-edge", minimumShortEdge };
}

function readMinimumShortEdge(snapshot: Record<string, unknown>): number | undefined {
	if (snapshot.veoTier === undefined && snapshot.resolutionPolicy === undefined) return undefined;
	const floor = { "720p": 720, "1080p": 1080, "4k": 2160 }[String(snapshot.resolution)];
	const policy = snapshot.resolutionPolicy;
	if (
		snapshot.productKey !== "video-veo-3-1" ||
		snapshot.modelContractVersion !== VIDEO_VEO_TIER_CONTRACT_VERSION ||
		!videoVeoTierSchema.safeParse(snapshot.veoTier).success ||
		!floor ||
		!policy ||
		typeof policy !== "object" ||
		Array.isArray(policy)
	)
		throw new Error("VIDEO_RESOLUTION_POLICY_INVALID");
	const value = policy as Record<string, unknown>;
	if (
		value.schemaVersion !== 1 ||
		value.kind !== "minimum-short-edge" ||
		value.minimumShortEdge !== floor ||
		Object.keys(value).some((key) => !["schemaVersion", "kind", "minimumShortEdge"].includes(key))
	)
		throw new Error("VIDEO_RESOLUTION_POLICY_INVALID");
	return floor;
}
export type VideoAudioSafetyPolicy = {
	schemaVersion: 1;
	mode: "not_requested" | "required";
};

export function createVideoAudioSafetyPolicy(): VideoAudioSafetyPolicy {
	return { schemaVersion: 1, mode: "not_requested" };
}

/** Missing historical policy retains its original requirement; never downgrade stored jobs. */
export function readVideoAudioSafetyPolicy(snapshot: unknown): VideoAudioSafetyPolicy {
	if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
		throw new Error("VIDEO_AUDIO_SAFETY_POLICY_INVALID");
	const policy = (snapshot as Record<string, unknown>).audioSafetyPolicy;
	if (policy === undefined) return { schemaVersion: 1, mode: "required" };
	if (!policy || typeof policy !== "object" || Array.isArray(policy))
		throw new Error("VIDEO_AUDIO_SAFETY_POLICY_INVALID");
	const value = policy as Record<string, unknown>;
	if (
		value.schemaVersion !== 1 ||
		(value.mode !== "not_requested" && value.mode !== "required") ||
		Object.keys(value).some((key) => key !== "schemaVersion" && key !== "mode")
	)
		throw new Error("VIDEO_AUDIO_SAFETY_POLICY_INVALID");
	return { schemaVersion: 1, mode: value.mode };
}
export type VideoOutputConstraints = {
	/** Frozen template requirement, not a claim that the supplier was quality-tested. */
	exactPixels?: { width: number; height: number };
	minimumShortEdge?: number;
	/** Missing historical constraints retain the spoken-review size limit. */
	audioSafetyPolicy?: VideoAudioSafetyPolicy;
	productKey?: string;
	durationSeconds: number;
	sound: boolean;
	resolution: string;
	aspectRatio: string;
};
export type VideoOutputMetadata = {
	durationMillis: number;
	width: number;
	height: number;
	audioTracks: number;
	audioTrackIds?: number[];
	videoTracks: 1;
};
export function videoOutputConstraints(value: unknown): VideoOutputConstraints {
	const snapshot =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	const minimumShortEdge = readMinimumShortEdge(snapshot);
	if (snapshot.requestKind === "template-video" || snapshot.videoEffectTemplate !== undefined) {
		const template = snapshot.videoEffectTemplate;
		if (!template || typeof template !== "object" || Array.isArray(template))
			throw new Error("VIDEO_TEMPLATE_OUTPUT_CONSTRAINTS_INVALID");
		const config = template as Record<string, unknown>;
		const rawOutput = config.output;
		if (!rawOutput || typeof rawOutput !== "object" || Array.isArray(rawOutput))
			throw new Error("VIDEO_TEMPLATE_OUTPUT_CONSTRAINTS_INVALID");
		const output = rawOutput as Record<string, unknown>;
		const rawVideo = config.video;
		if (!rawVideo || typeof rawVideo !== "object" || Array.isArray(rawVideo))
			throw new Error("VIDEO_TEMPLATE_OUTPUT_CONSTRAINTS_INVALID");
		const video = rawVideo as Record<string, unknown>;
		const legacyTemplate =
			config.schemaVersion === 1 &&
			typeof config.effectId === "string" &&
			[HOTEL_LOBBY_EFFECT_ID, RAINDANCE_SOLO_EFFECT_ID, RAINDANCE_DUO_EFFECT_ID].includes(
				config.effectId,
			);
		const referenceTemplate =
			config.schemaVersion === 2 &&
			config.effectId === RUMPELSTILTSKIN_SOLO_EFFECT_ID &&
			config.templateVersion === RUMPELSTILTSKIN_TEMPLATE_VERSION &&
			config.executionKind === "seedance-reference";
		const longTemplate =
			config.schemaVersion === 3 &&
			((config.effectId === HOTEL_LOBBY_EFFECT_ID &&
				config.templateVersion === HOTEL_LOBBY_LONG_TEMPLATE_VERSION) ||
				([RAINDANCE_SOLO_EFFECT_ID, RAINDANCE_DUO_EFFECT_ID].includes(String(config.effectId)) &&
					config.templateVersion === RAINDANCE_LONG_TEMPLATE_VERSION));
		const productKey = referenceTemplate ? "video-seedance-2" : "video-seedance-1-5-pro";
		if (
			(!legacyTemplate && !referenceTemplate && !longTemplate) ||
			typeof config.templateVersion !== "string" ||
			output.durationSeconds !== (longTemplate ? 10 : 5) ||
			output.resolution !== "720p" ||
			output.aspectRatio !== "9:16" ||
			output.sound !== false ||
			output.width !== 720 ||
			output.height !== 1280 ||
			snapshot.duration !== output.durationSeconds ||
			snapshot.resolution !== output.resolution ||
			snapshot.aspectRatio !== output.aspectRatio ||
			snapshot.sound !== output.sound ||
			snapshot.productKey !== productKey ||
			video.productKey !== productKey ||
			video.mode !== "image-to-video" ||
			video.duration !== output.durationSeconds ||
			video.resolution !== output.resolution ||
			video.aspectRatio !== output.aspectRatio ||
			video.sound !== output.sound
		)
			throw new Error("VIDEO_TEMPLATE_OUTPUT_CONSTRAINTS_INVALID");
		return {
			audioSafetyPolicy: readVideoAudioSafetyPolicy(snapshot),
			productKey,
			durationSeconds: longTemplate ? 10 : 5,
			sound: output.sound,
			resolution: output.resolution,
			aspectRatio: output.aspectRatio,
			exactPixels: { width: output.width, height: output.height },
		};
	}
	if (typeof snapshot.productKey !== "string")
		return {
			audioSafetyPolicy: readVideoAudioSafetyPolicy(snapshot),
			durationSeconds: 5,
			sound: false,
			resolution: "default",
			aspectRatio: typeof snapshot.aspectRatio === "string" ? snapshot.aspectRatio : "source",
		};
	if (
		!Number.isInteger(snapshot.duration) ||
		Number(snapshot.duration) < 2 ||
		Number(snapshot.duration) > 30 ||
		typeof snapshot.sound !== "boolean" ||
		typeof snapshot.resolution !== "string" ||
		typeof snapshot.aspectRatio !== "string"
	)
		throw new Error("VIDEO_OUTPUT_CONSTRAINTS_INVALID");
	return {
		audioSafetyPolicy: readVideoAudioSafetyPolicy(snapshot),
		productKey: snapshot.productKey,
		durationSeconds: Number(snapshot.duration),
		sound: snapshot.sound,
		resolution: snapshot.resolution,
		aspectRatio: snapshot.aspectRatio,
		...(minimumShortEdge === undefined ? {} : { minimumShortEdge }),
	};
}

export function videoResolutionPixelContract(
	expected: VideoOutputConstraints,
): "DOCUMENTED" | "APP_MINIMUM" | "NOT_VERIFIED" {
	if (expected.minimumShortEdge !== undefined) return "APP_MINIMUM";
	return expected.productKey === "video-kling-3" &&
		["720p", "1080p", "4k"].includes(expected.resolution) &&
		["16:9", "9:16", "1:1"].includes(expected.aspectRatio)
		? "DOCUMENTED"
		: "NOT_VERIFIED";
}

/** Return a stable failure code without leaking the request or private metadata. */
export function videoOutputSpecificationFailure(
	output: VideoOutputMetadata,
	expected: VideoOutputConstraints,
): string | null {
	if (
		!Number.isFinite(output.durationMillis) ||
		Math.abs(output.durationMillis - expected.durationSeconds * 1000) > 250
	)
		return "VIDEO_DURATION_MISMATCH";
	if (
		!Number.isInteger(output.audioTracks) ||
		output.audioTracks < 0 ||
		output.audioTracks > 1 ||
		output.videoTracks !== 1
	)
		return "VIDEO_TRACK_NOT_SUPPORTED";
	if (!expected.sound && output.audioTracks !== 0) return "VIDEO_AUDIO_TRACK_NOT_ALLOWED";
	if (
		output.audioTracks &&
		(!output.audioTrackIds ||
			output.audioTrackIds.length !== output.audioTracks ||
			!output.audioTrackIds.every((id) => Number.isInteger(id) && id > 0 && id <= 0xffff_ffff) ||
			new Set(output.audioTrackIds).size !== output.audioTracks)
	)
		return "VIDEO_AUDIO_TRACK_IDENTITY_MISSING";
	if (
		![output.width, output.height].every(
			(dimension) => Number.isInteger(dimension) && dimension > 0 && dimension <= 8192,
		)
	)
		return "VIDEO_DIMENSIONS_INVALID";
	if (
		expected.minimumShortEdge !== undefined &&
		Math.min(output.width, output.height) < expected.minimumShortEdge
	)
		return "VIDEO_RESOLUTION_MISMATCH";
	if (videoResolutionPixelContract(expected) === "DOCUMENTED") {
		const pixels = { "720p": 720, "1080p": 1080, "4k": 2160 }[expected.resolution]!;
		const width = expected.aspectRatio === "16:9" ? (pixels * 16) / 9 : pixels;
		const height = expected.aspectRatio === "9:16" ? (pixels * 16) / 9 : pixels;
		if (output.width !== width || output.height !== height) return "VIDEO_RESOLUTION_MISMATCH";
	}
	if (
		expected.exactPixels &&
		(output.width !== expected.exactPixels.width || output.height !== expected.exactPixels.height)
	)
		return "VIDEO_RESOLUTION_MISMATCH";
	if (!["source", "adaptive"].includes(expected.aspectRatio)) {
		const ratio = /^(\d+):(\d+)$/.exec(expected.aspectRatio);
		if (!ratio || !Number(ratio[1]) || !Number(ratio[2])) return "VIDEO_ASPECT_RATIO_INVALID";
		const target = Number(ratio[1]) / Number(ratio[2]);
		if (Math.abs(output.width / output.height - target) / target > 0.025)
			return "VIDEO_ASPECT_RATIO_MISMATCH";
	}
	return null;
}
