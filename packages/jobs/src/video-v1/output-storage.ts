import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import {
	readVideoAudioSafetyPolicy,
	VIDEO_OUTPUT_MAX_BYTES,
	videoOutputConstraints,
	videoOutputSpecificationFailure,
	type VideoOutputConstraints,
} from "@repo/config/video-output";
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
};
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
	return { ...result, bytes, checksum, etag: metadata.etag };
}

export async function transferVideoOutput(input: {
	key: string;
	url: string;
	maxBytes: number;
	requestOptions: RemoteMediaRequestOptions;
	constraints?: VideoOutputConstraints;
}): Promise<VideoStoredObject> {
	if (
		!input.requestOptions.allowedHosts.length ||
		input.requestOptions.allowedHosts.some((host) => host.includes("*"))
	)
		throw new VideoSpecificationError("VIDEO_EXACT_OUTPUT_HOSTS_REQUIRED");
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
	const source = Readable.from(
		(async function* () {
			for await (const chunk of response.stream) {
				inspector.write(chunk);
				sourceBytes += chunk.byteLength;
				yield chunk;
			}
		})(),
	);
	try {
		const copied = await copyRemoteStreamToMultipart(source, {
			maxBytes: Math.min(input.maxBytes, VIDEO_MAX_BYTES),
			partSize: 5 * 1024 * 1024,
			uploadPart: ({ partNumber, body }) =>
				uploadMultipartPart({ ...location, uploadId, partNumber, body }),
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
		return { ...inspector.finish(), bytes: copied.bytes, checksum: copied.sha256, etag: head.etag };
	} finally {
		response.stream.destroy();
	}
}
