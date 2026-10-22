import { createHash } from "node:crypto";

import {
	createVideoOutputReport,
	readVideoAudioSafetyPolicy,
	VIDEO_OUTPUT_MAX_BYTES,
	videoOutputConstraints,
	videoOutputSpecificationFailure,
	type VideoOutputConstraints,
} from "@repo/config/video-output";
import { readVideoOutputReport } from "@repo/config/video-output-report";
import {
	abortIncompleteMultipartUploads,
	abortMultipartUpload,
	completeMultipartUpload,
	copyRemoteStreamToMultipart,
	createMultipartUpload,
	headObject,
	readPrivateMediaStream,
	requestRemoteMediaStream,
	uploadMultipartPart,
	VideoMp4Inspector,
	VideoSpecificationError,
	type VideoMp4Metadata,
	type RemoteMediaRequestOptions,
} from "@repo/storage";

export type VideoStoredObject = VideoMp4Metadata & {
	bytes: number;
	checksum: string;
	etag: string;
	inspectionVersion?: "video-mp4-stream-v1";
};
const INSPECTION_VERSION = "video-mp4-stream-v1";
export const VIDEO_MAX_BYTES = VIDEO_OUTPUT_MAX_BYTES;
const VIDEO_SPOKEN_REVIEW_MAX_BYTES = 25_000_000;
function assertAudioReviewSize(
	metadata: VideoMp4Metadata,
	bytes: number,
	constraints: VideoOutputConstraints,
) {
	if (
		readVideoAudioSafetyPolicy(constraints).mode === "required" &&
		metadata.audioTracks > 0 &&
		bytes > VIDEO_SPOKEN_REVIEW_MAX_BYTES
	)
		throw new VideoSpecificationError("VIDEO_AUDIO_MEDIA_TOO_LARGE");
}

type PersistedVideoObject = {
	id: string;
	objectKey: string;
	checksum: string | null;
	storageEtag: string | null;
	byteSize: bigint;
	finalizedAt: Date | null;
	verificationEngine: string;
	kind: string;
	mimeType: string;
	width: number | null;
	height: number | null;
	durationMillis: bigint | null;
};
const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
function sameJson(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
	if (Array.isArray(left) !== Array.isArray(right)) return false;
	const a = left as Record<string, unknown>;
	const b = right as Record<string, unknown>;
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((key) => sameJson(a[key], b[key]));
}

/** Reuse only the server's lease-committed complete-stream inspection. */
function persistedInspection(
	asset: PersistedVideoObject,
	outputSpec: unknown,
	constraints: VideoOutputConstraints,
): VideoStoredObject | null {
	const spec = record(outputSpec);
	const receipt = record(spec.storageInspection);
	const metadata = record(receipt.metadata);
	const bytes = Number(asset.byteSize);
	if (
		receipt.schemaVersion !== 1 ||
		receipt.verifier !== INSPECTION_VERSION ||
		asset.verificationEngine !== "video-workflow-v1" ||
		asset.kind !== "OUTPUT" ||
		asset.mimeType !== "video/mp4" ||
		!asset.finalizedAt ||
		receipt.checkedAt !== asset.finalizedAt.toISOString() ||
		!asset.checksum ||
		!/^[a-f0-9]{64}$/.test(asset.checksum) ||
		!asset.storageEtag ||
		!Number.isSafeInteger(bytes) ||
		bytes < 1 ||
		bytes > VIDEO_MAX_BYTES ||
		receipt.assetId !== asset.id ||
		receipt.objectKey !== asset.objectKey ||
		receipt.checksum !== asset.checksum ||
		receipt.etag !== asset.storageEtag ||
		receipt.bytes !== bytes ||
		spec.assetId !== asset.id ||
		spec.checksum !== asset.checksum ||
		spec.etag !== asset.storageEtag ||
		!sameJson(receipt.constraints, constraints) ||
		metadata.width !== asset.width ||
		metadata.height !== asset.height ||
		asset.durationMillis === null ||
		metadata.durationMillis !== Number(asset.durationMillis) ||
		metadata.videoTracks !== 1 ||
		metadata.audioTracks !== spec.audioTracks ||
		!Array.isArray(metadata.audioTrackIds) ||
		!sameJson(metadata.audioTrackIds, spec.audioTrackIds)
	)
		return null;
	const output = metadata as VideoMp4Metadata;
	try {
		if (videoOutputSpecificationFailure(output, constraints)) return null;
		assertAudioReviewSize(output, bytes, constraints);
		const report = readVideoOutputReport({ outputSpec });
		if (!report || !sameJson(report, createVideoOutputReport(output, constraints))) return null;
	} catch {
		return null;
	}
	return {
		...output,
		bytes,
		checksum: asset.checksum,
		etag: asset.storageEtag,
		inspectionVersion: INSPECTION_VERSION,
	};
}

/**
 * A conditional byte read proves the inspected immutable object is still
 * readable. Missing/legacy/mismatched evidence keeps the original full check;
 * recovery adoption always calls inspectVideoObject directly.
 */
export async function inspectPersistedVideoObject(
	asset: PersistedVideoObject,
	outputSpec: unknown,
	constraints: VideoOutputConstraints,
): Promise<VideoStoredObject | null> {
	const fullInspection = () =>
		inspectVideoObject(
			asset.objectKey,
			asset.checksum && asset.storageEtag
				? { checksum: asset.checksum, etag: asset.storageEtag, bytes: Number(asset.byteSize) }
				: undefined,
			constraints,
		);
	const inspected = persistedInspection(asset, outputSpec, constraints);
	if (!inspected) return fullInspection();
	let response;
	try {
		response = await readPrivateMediaStream({
			bucket: "media",
			key: asset.objectKey,
			ifMatch: inspected.etag,
			range: { start: 0, end: 0 },
		});
	} catch (error) {
		const details = error as { name?: string; $metadata?: { httpStatusCode?: number } };
		if (
			["NotFound", "NoSuchKey", "PreconditionFailed"].includes(details.name ?? "") ||
			[404, 412].includes(details.$metadata?.httpStatusCode ?? 0)
		)
			return fullInspection();
		throw error;
	}
	if (
		response.etag !== inspected.etag ||
		response.contentType !== "video/mp4" ||
		response.contentLength !== 1
	) {
		await response.body.cancel();
		return fullInspection();
	}
	const reader = response.body.getReader();
	let readable = false;
	try {
		const first = await reader.read();
		readable = !first.done && first.value.byteLength === 1 && (await reader.read()).done === true;
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	return readable ? inspected : fullInspection();
}

/** Conditions bind the bytes read to the same private, immutable object. */
export async function inspectVideoObject(
	key: string,
	expected?: { checksum: string; etag: string; bytes: number },
	constraints: VideoOutputConstraints = videoOutputConstraints(null),
): Promise<VideoStoredObject | null> {
	let metadata;
	try {
		metadata = await headObject({ bucket: "media", key });
	} catch (error) {
		const details = error as { name?: string; $metadata?: { httpStatusCode?: number } };
		if (
			details.name === "NotFound" ||
			details.name === "NoSuchKey" ||
			details.$metadata?.httpStatusCode === 404
		)
			return null;
		throw error;
	}
	if (
		!metadata.etag ||
		metadata.contentType !== "video/mp4" ||
		metadata.contentLength < 1 ||
		metadata.contentLength > VIDEO_MAX_BYTES
	)
		throw new VideoSpecificationError("VIDEO_STORED_IDENTITY_INVALID");
	if (expected && (expected.etag !== metadata.etag || expected.bytes !== metadata.contentLength))
		throw new VideoSpecificationError("VIDEO_STORED_IDENTITY_CHANGED");
	const response = await readPrivateMediaStream({ bucket: "media", key, ifMatch: metadata.etag });
	const reader = response.body.getReader();
	const inspector = new VideoMp4Inspector(undefined, constraints);
	const hash = createHash("sha256");
	let bytes = 0;
	try {
		while (true) {
			const item = await reader.read();
			if (item.done) break;
			bytes += item.value.byteLength;
			inspector.write(item.value);
			hash.update(item.value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	if (bytes !== metadata.contentLength)
		throw new VideoSpecificationError("VIDEO_STORED_SIZE_MISMATCH");
	const checksum = hash.digest("hex");
	if (expected && checksum !== expected.checksum)
		throw new VideoSpecificationError("VIDEO_STORED_IDENTITY_CHANGED");
	const result = inspector.finish();
	assertAudioReviewSize(result, bytes, constraints);
	const failure = videoOutputSpecificationFailure(result, constraints);
	if (failure) throw new VideoSpecificationError(failure);
	return { ...result, bytes, checksum, etag: metadata.etag, inspectionVersion: INSPECTION_VERSION };
}

export async function transferVideoOutput(input: {
	key: string;
	url: string;
	maxBytes: number;
	requestOptions: RemoteMediaRequestOptions;
	constraints?: VideoOutputConstraints;
	/** Only the lease which atomically created this random object identity may set this. */
	freshTransfer?: boolean;
}): Promise<VideoStoredObject> {
	if (
		!input.requestOptions.allowedHosts.length ||
		input.requestOptions.allowedHosts.some((host) => host.includes("*"))
	)
		throw new VideoSpecificationError("VIDEO_EXACT_OUTPUT_HOSTS_REQUIRED");
	if (!input.freshTransfer)
		await abortIncompleteMultipartUploads({ bucket: "media", key: input.key });
	const response = await requestRemoteMediaStream(input.url, input.requestOptions);
	const constraints = input.constraints ?? videoOutputConstraints(null);
	const inspector = new VideoMp4Inspector(Math.min(input.maxBytes, VIDEO_MAX_BYTES), constraints);
	const length = Number(response.headers["content-length"]);
	if (Number.isFinite(length) && length > input.maxBytes) {
		response.stream.destroy();
		throw new VideoSpecificationError("OUTPUT_MEDIA_SIZE_EXCEEDED");
	}
	const location = { bucket: "media" as const, key: input.key };
	let uploadId: string;
	try {
		uploadId = (await createMultipartUpload({ ...location, contentType: "video/mp4" })).uploadId;
	} catch (error) {
		response.stream.destroy();
		throw error;
	}
	let sourceBytes = 0;
	try {
		const copied = await copyRemoteStreamToMultipart(response.stream, {
			maxBytes: Math.min(input.maxBytes, VIDEO_MAX_BYTES),
			partSize: 5 * 1024 * 1024,
			inspectChunk: (chunk) => {
				inspector.write(chunk);
				sourceBytes += chunk.byteLength;
			},
			uploadPart: ({ partNumber, body, signal }) =>
				uploadMultipartPart({ ...location, uploadId, partNumber, body, signal }),
			complete: async (parts) => {
				assertAudioReviewSize(inspector.finish(), sourceBytes, constraints);
				const failure = videoOutputSpecificationFailure(inspector.finish(), constraints);
				if (failure) throw new VideoSpecificationError(failure);
				await completeMultipartUpload({ ...location, uploadId, parts, ifNoneMatch: "*" });
			},
			abort: () => abortMultipartUpload({ ...location, uploadId }),
		});
		const head = await headObject(location);
		if (!head.etag || head.contentLength !== copied.bytes)
			throw new Error("VIDEO_STORED_HEAD_MISMATCH");
		return {
			...inspector.finish(),
			bytes: copied.bytes,
			checksum: copied.sha256,
			etag: head.etag,
			inspectionVersion: INSPECTION_VERSION,
		};
	} finally {
		response.stream.destroy();
	}
}
