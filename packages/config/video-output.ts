/** Immutable request-derived output requirements. Legacy snapshots remain five-second/silent. */
export const VIDEO_AUDIO_POLICY_VERSION = "video-spoken-content-2026-10-04.1";
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
	if (typeof snapshot.productKey !== "string")
		return {
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
		productKey: snapshot.productKey,
		durationSeconds: Number(snapshot.duration),
		sound: snapshot.sound,
		resolution: snapshot.resolution,
		aspectRatio: snapshot.aspectRatio,
	};
}

export function videoResolutionPixelContract(
	expected: VideoOutputConstraints,
): "DOCUMENTED" | "NOT_VERIFIED" {
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
	if (videoResolutionPixelContract(expected) === "DOCUMENTED") {
		const pixels = { "720p": 720, "1080p": 1080, "4k": 2160 }[expected.resolution]!;
		const width = expected.aspectRatio === "16:9" ? (pixels * 16) / 9 : pixels;
		const height = expected.aspectRatio === "9:16" ? (pixels * 16) / 9 : pixels;
		if (output.width !== width || output.height !== height) return "VIDEO_RESOLUTION_MISMATCH";
	}
	if (!["source", "adaptive"].includes(expected.aspectRatio)) {
		const ratio = /^(\d+):(\d+)$/.exec(expected.aspectRatio);
		if (!ratio || !Number(ratio[1]) || !Number(ratio[2])) return "VIDEO_ASPECT_RATIO_INVALID";
		const target = Number(ratio[1]) / Number(ratio[2]);
		if (Math.abs(output.width / output.height - target) / target > 0.025)
			return "VIDEO_ASPECT_RATIO_MISMATCH";
	}
	return null;
}
