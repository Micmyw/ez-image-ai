import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CreateMultipartUploadCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	HeadBucketCommand,
	PutObjectCommand,
	ListMultipartUploadsCommand,
	S3Client,
	UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl as getS3SignedUrl } from "@aws-sdk/s3-request-presigner";
import { logger } from "@repo/logs";

import { config, MAX_AVATAR_UPLOAD_BYTES } from "../../config";
import { getImageProcessor } from "../../image-processing/context";
import type { ImageContentType } from "../../image-processing/types";
import {
	GUEST_WATERMARK_VERSION,
	createWatermarkStagedGuestImage,
} from "../../lib/image-watermark";
import { writeImmutableReference } from "../../lib/immutable-reference";
import {
	canStreamImmutableGenerationImage,
	writeValidatedPrivateImageStream,
} from "../../lib/streaming-private-image";
export { canStreamImmutableGenerationImage } from "../../lib/streaming-private-image";
import {
	assertDetectedMediaType,
	assertMediaKind,
	getMediaByteLimit,
	getMediaKindByteLimit,
	MediaValidationError,
	type MediaKind,
} from "../../lib/media-signatures";
import type { OpenedRemoteMedia, RemoteMediaRequestOptions } from "../../lib/stream-copy";
import {
	copyRemoteRequestToMultipart,
	copyRemoteStreamToMultipart,
	requestRemoteMediaStream,
} from "../../lib/stream-copy";
import type {
	GetSignedUploadUrlHandler,
	GetSignedUrlHander,
	MediaContentType,
	MediaObjectLocation,
	MediaObjectMetadata,
	MultipartUploadInput,
	SignedReadInput,
	SignedUploadInput,
} from "../../types";

let s3Client: S3Client | null = null;
let streamingS3Client: S3Client | null = null;

function getS3Client(streaming = false): S3Client {
	const existing = streaming ? streamingS3Client : s3Client;
	if (existing) return existing;
	const endpoint = process.env.S3_ENDPOINT;
	const accessKeyId = process.env.S3_ACCESS_KEY_ID;
	const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
	if (!endpoint) throw new Error("Missing env variable S3_ENDPOINT");
	if (!accessKeyId) throw new Error("Missing env variable S3_ACCESS_KEY_ID");
	if (!secretAccessKey) throw new Error("Missing env variable S3_SECRET_ACCESS_KEY");
	const client = new S3Client({
		region: process.env.S3_REGION || "auto",
		endpoint,
		forcePathStyle: true,
		credentials: { accessKeyId, secretAccessKey },
		// Presigning a stream must not freeze an optional checksum for an empty
		// command body. HTTPS protects transport; we hash every source byte and
		// persist that identity only after the conditional PUT completes.
		...(streaming ? { requestChecksumCalculation: "WHEN_REQUIRED" as const } : {}),
	});
	if (streaming) streamingS3Client = client;
	else s3Client = client;
	return client;
}

function bucketName(bucket: keyof typeof config.bucketNames): string {
	const value = config.bucketNames[bucket];
	if (!value) throw new Error("Invalid bucket");
	return value;
}

function mediaLocation(location: MediaObjectLocation): { Bucket: string; Key: string } {
	if (location.bucket !== "media" || !location.key.startsWith("users/")) {
		throw new Error("Invalid private media object location");
	}
	return { Bucket: bucketName("media"), Key: location.key };
}

export async function createSignedUpload(input: SignedUploadInput): Promise<string> {
	return getS3SignedUrl(
		getS3Client(),
		new PutObjectCommand({
			...mediaLocation(input),
			ContentType: input.contentType,
			ContentLength: input.contentLength,
		}),
		{ expiresIn: input.expiresIn ?? config.media.signedUploadExpiresSeconds },
	);
}

export async function createMultipartUpload(
	input: MultipartUploadInput,
): Promise<{ uploadId: string }> {
	const result = await getS3Client().send(
		new CreateMultipartUploadCommand({
			...mediaLocation(input),
			ContentType: input.contentType,
			...(input.metadata ? { Metadata: input.metadata } : {}),
		}),
	);
	if (!result.UploadId) throw new Error("Storage did not return a multipart upload ID");
	return { uploadId: result.UploadId };
}

export async function signMultipartPart(
	input: MediaObjectLocation & {
		uploadId: string;
		partNumber: number;
		contentLength: number;
		expiresIn?: number;
	},
): Promise<string> {
	assertPartNumber(input.partNumber);
	if (!Number.isSafeInteger(input.contentLength) || input.contentLength <= 0) {
		throw new Error("Invalid multipart part length");
	}
	return getS3SignedUrl(
		getS3Client(),
		new UploadPartCommand({
			...mediaLocation(input),
			UploadId: input.uploadId,
			PartNumber: input.partNumber,
			ContentLength: input.contentLength,
		}),
		{ expiresIn: input.expiresIn ?? config.media.signedUploadExpiresSeconds },
	);
}

export async function uploadMultipartPart(
	input: MediaObjectLocation & {
		uploadId: string;
		partNumber: number;
		body: Buffer;
		signal?: AbortSignal;
	},
): Promise<string> {
	assertPartNumber(input.partNumber);
	const result = await getS3Client().send(
		new UploadPartCommand({
			...mediaLocation(input),
			UploadId: input.uploadId,
			PartNumber: input.partNumber,
			Body: input.body,
			ContentLength: input.body.byteLength,
		}),
		input.signal ? { abortSignal: input.signal } : undefined,
	);
	if (!result.ETag) throw new Error("Storage did not return a multipart part ETag");
	return result.ETag;
}

export async function completeMultipartUpload(
	input: MediaObjectLocation & {
		uploadId: string;
		parts: Array<{ partNumber: number; etag: string }>;
		ifNoneMatch?: "*";
	},
): Promise<void> {
	if (input.parts.length === 0) throw new Error("Multipart upload has no parts");
	await getS3Client().send(
		new CompleteMultipartUploadCommand({
			...mediaLocation(input),
			UploadId: input.uploadId,
			...(input.ifNoneMatch ? { IfNoneMatch: input.ifNoneMatch } : {}),
			MultipartUpload: {
				Parts: input.parts.map(({ partNumber, etag }) => ({ PartNumber: partNumber, ETag: etag })),
			},
		}),
	);
}

export async function abortMultipartUpload(
	input: MediaObjectLocation & { uploadId: string },
): Promise<void> {
	await getS3Client().send(
		new AbortMultipartUploadCommand({
			...mediaLocation(input),
			UploadId: input.uploadId,
		}),
	);
}

/**
 * Lists incomplete multipart uploads for one exact private object key. S3 only
 * offers prefix filtering, so callers must never act on a result without the
 * exact-key check below.
 */
export async function listMultipartUploads(input: MediaObjectLocation): Promise<string[]> {
	const location = mediaLocation(input);
	const client = getS3Client();
	const uploadIds: string[] = [];
	let keyMarker: string | undefined;
	let uploadIdMarker: string | undefined;
	for (;;) {
		const result = await client.send(
			new ListMultipartUploadsCommand({
				...location,
				Prefix: input.key,
				...(keyMarker ? { KeyMarker: keyMarker } : {}),
				...(uploadIdMarker ? { UploadIdMarker: uploadIdMarker } : {}),
			}),
		);
		for (const upload of result.Uploads ?? []) {
			if (upload.Key === input.key && upload.UploadId) uploadIds.push(upload.UploadId);
		}
		if (!result.IsTruncated) break;
		if (!result.NextKeyMarker) {
			throw new Error("Storage multipart listing omitted a continuation key");
		}
		keyMarker = result.NextKeyMarker;
		uploadIdMarker = result.NextUploadIdMarker;
	}
	return [...new Set(uploadIds)];
}

/**
 * Clears every known incomplete multipart upload for an exact final key. This
 * is safe for stale crash recovery only after the caller owns the session
 * finalization lease; it must not be used against an active finalizer.
 */
export async function abortIncompleteMultipartUploads(input: MediaObjectLocation): Promise<number> {
	const uploadIds = await listMultipartUploads(input);
	let aborted = 0;
	for (const uploadId of uploadIds) {
		try {
			await abortMultipartUpload({ ...input, uploadId });
			aborted += 1;
		} catch (error) {
			if (!isNoSuchUpload(error)) throw error;
		}
	}
	return aborted;
}

export async function headObject(input: MediaObjectLocation): Promise<MediaObjectMetadata> {
	const result = await getS3Client().send(new HeadObjectCommand(mediaLocation(input)));
	return {
		contentLength: result.ContentLength ?? 0,
		contentType: result.ContentType ?? null,
		etag: result.ETag ?? null,
		metadata: result.Metadata ?? {},
	};
}

/** Server-authorized private object read. Never buffers a video or follows a remote URL. */
export async function readPrivateMediaStream(
	input: MediaObjectLocation & { range?: { start: number; end: number }; ifMatch?: string },
): Promise<{
	body: ReadableStream<Uint8Array>;
	contentLength: number;
	contentType: string | null;
	etag: string | null;
}> {
	if (
		input.range &&
		(!Number.isSafeInteger(input.range.start) ||
			!Number.isSafeInteger(input.range.end) ||
			input.range.start < 0 ||
			input.range.end < input.range.start)
	) {
		throw new Error("INVALID_MEDIA_RANGE");
	}
	const result = await getS3Client().send(
		new GetObjectCommand({
			...mediaLocation(input),
			...(input.ifMatch ? { IfMatch: input.ifMatch } : {}),
			...(input.range ? { Range: `bytes=${input.range.start}-${input.range.end}` } : {}),
		}),
	);
	if (!result.Body || !Number.isSafeInteger(result.ContentLength) || result.ContentLength! <= 0) {
		throw new Error("PRIVATE_MEDIA_BODY_MISSING");
	}
	return {
		body: result.Body.transformToWebStream() as ReadableStream<Uint8Array>,
		contentLength: result.ContentLength!,
		contentType: result.ContentType ?? null,
		etag: result.ETag ?? null,
	};
}

const MAX_PRIVATE_REFERENCE_BYTES = 10_000_000;

function imageByteStream(body: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(body);
			controller.close();
		},
	});
}

/** One bounded read supplies identity, metadata and decoding with the exact same bytes. */
async function readPrivateReferenceImage(
	input: MediaObjectLocation & {
		contentType: ImageContentType;
		contentLength?: number;
		ifMatch?: string;
		maximumBytes: number;
	},
) {
	if (
		!Number.isSafeInteger(input.maximumBytes) ||
		input.maximumBytes < 1 ||
		input.maximumBytes > MAX_PRIVATE_REFERENCE_BYTES ||
		(input.contentLength !== undefined &&
			(!Number.isSafeInteger(input.contentLength) ||
				input.contentLength < 1 ||
				input.contentLength > input.maximumBytes))
	)
		throw new Error("INPUT_TOO_LARGE");
	const stored = await getS3Client().send(
		new GetObjectCommand({
			...mediaLocation(input),
			...(input.ifMatch ? { IfMatch: input.ifMatch } : {}),
		}),
	);
	if (!stored.Body) throw new Error("PRIVATE_MEDIA_BODY_MISSING");
	const source = stored.Body.transformToWebStream() as ReadableStream<Uint8Array>;
	const reader = source.getReader();
	try {
		if (
			!stored.ETag ||
			(input.ifMatch && stored.ETag !== input.ifMatch) ||
			stored.ContentType !== input.contentType ||
			!Number.isSafeInteger(stored.ContentLength) ||
			!stored.ContentLength ||
			stored.ContentLength < 1 ||
			(input.contentLength !== undefined && stored.ContentLength !== input.contentLength)
		)
			throw new Error("VIDEO_INPUT_IDENTITY_MISMATCH");
		if (stored.ContentLength > input.maximumBytes) throw new Error("INPUT_TOO_LARGE");
		// Allocate once; never collect an unbounded stream or double-buffer its chunks.
		const body = Buffer.alloc(stored.ContentLength);
		let bytes = 0;
		for (;;) {
			const item = await reader.read();
			if (item.done) break;
			bytes += item.value.byteLength;
			if (bytes > body.length) throw new Error("VIDEO_INPUT_IDENTITY_MISMATCH");
			body.set(item.value, bytes - item.value.byteLength);
		}
		if (bytes !== body.length) throw new Error("VIDEO_INPUT_IDENTITY_MISMATCH");
		assertDetectedMediaType(body.subarray(0, 64), input.contentType);
		return { body, bytes, etag: stored.ETag, versionId: stored.VersionId ?? null };
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

async function inspectReferenceBytes(
	body: Uint8Array,
	contentType: ImageContentType,
	validateDecoded = true,
) {
	const processor = getImageProcessor();
	if (!processor.validateDecoded) throw new Error("VIDEO_INPUT_DECODER_UNAVAILABLE");
	const dimensions = await processor.inspect(imageByteStream(body), contentType, {
		contentLength: body.byteLength,
	});
	if (validateDecoded)
		await processor.validateDecoded(imageByteStream(body), contentType, {
			contentLength: body.byteLength,
		});
	return dimensions;
}

export async function inspectPrivateImage(
	input: MediaObjectLocation & {
		contentType: "image/jpeg" | "image/png" | "image/webp";
		contentLength: number;
		ifMatch?: string;
	},
): Promise<{ width: number; height: number }> {
	const { body } = await readPrivateReferenceImage({
		...input,
		maximumBytes: MAX_PRIVATE_REFERENCE_BYTES,
	});
	return inspectReferenceBytes(body, input.contentType);
}

/** Only small reference images use this bounded buffer; generated video stays streamed. */
export async function normalizeVideoReferenceToPng(input: {
	source: MediaObjectLocation;
	final: MediaObjectLocation;
	sourceBytes: number;
	sourceEtag: string;
	maximumBytes: number;
	/** Template uploads canonicalize every supported format; legacy WebP callers keep their default. */
	sourceContentType?: "image/jpeg" | "image/png" | "image/webp";
	/** Ordinary WebP uploads preserve the existing no-geometry-change contract. */
	preserveDimensions?: boolean;
}): Promise<{
	bytes: number;
	sha256: string;
	etag: string | null;
	versionId: string | null;
	width: number;
	height: number;
}> {
	if (
		!Number.isSafeInteger(input.maximumBytes) ||
		input.maximumBytes < 1 ||
		input.maximumBytes > MAX_PRIVATE_REFERENCE_BYTES ||
		!Number.isSafeInteger(input.sourceBytes) ||
		input.sourceBytes < 1 ||
		input.sourceBytes > input.maximumBytes
	)
		throw new Error("INPUT_TOO_LARGE");
	const inspectWinner = async () => {
		const { body, ...identity } = await readPrivateReferenceImage({
			...input.final,
			contentType: "image/png",
			maximumBytes: input.maximumBytes,
		});
		return {
			...identity,
			sha256: createHash("sha256").update(body).digest("hex"),
			...(await inspectReferenceBytes(body, "image/png")),
		};
	};
	const assertDimensions = (
		source: { width: number; height: number },
		final: { width: number; height: number },
	) => {
		if (
			input.preserveDimensions &&
			(source.width !== final.width || source.height !== final.height)
		)
			throw new Error("VIDEO_INPUT_DIMENSIONS_CHANGED");
	};
	// The conditional write arbitrates ownership. Looking for a final object first
	// adds a storage round trip to every new upload, where it can only return 404.
	const original = await readPrivateReferenceImage({
		...input.source,
		contentType: input.sourceContentType ?? "image/webp",
		contentLength: input.sourceBytes,
		ifMatch: input.sourceEtag,
		maximumBytes: input.maximumBytes,
	}).catch((error: unknown) => {
		// Templates may reclaim their source after committing the canonical identity.
		// Ordinary video still needs the source to enforce its geometry contract.
		if (input.preserveDimensions || !isExplicitObjectNotFound(error)) throw error;
		return null;
	});
	if (!original) return inspectWinner();
	const sourceBody = original.body;
	const processor = getImageProcessor();
	if (!processor.normalizePng) throw new Error("VIDEO_WEBP_NORMALIZATION_UNAVAILABLE");
	// Normalization consumes and fully decodes this same bounded source. A separate
	// decode/transcode before it provides no additional evidence.
	const sourceDimensions = await inspectReferenceBytes(
		sourceBody,
		input.sourceContentType ?? "image/webp",
		false,
	);
	const image = await processor.normalizePng(imageByteStream(sourceBody), {
		contentLength: input.sourceBytes,
	});
	const reader = image.getReader();
	// A fixed cap prevents a tiny-chunk stream from retaining an unbounded list or
	// requiring a second complete output allocation when concatenating chunks.
	const normalized = Buffer.alloc(input.maximumBytes);
	let bytes = 0;
	try {
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			bytes += result.value.byteLength;
			if (bytes > input.maximumBytes) throw new Error("VIDEO_NORMALIZED_INPUT_TOO_LARGE");
			normalized.set(result.value, bytes - result.value.byteLength);
		}
		const body = normalized.subarray(0, bytes);
		assertDetectedMediaType(body.subarray(0, 64), "image/png");
		const sha256 = createHash("sha256").update(body).digest("hex");
		const dimensions = await inspectReferenceBytes(body, "image/png");
		assertDimensions(sourceDimensions, dimensions);
		try {
			const stored = await getS3Client().send(
				new PutObjectCommand({
					...mediaLocation(input.final),
					Body: body,
					ContentLength: bytes,
					ContentType: "image/png",
					IfNoneMatch: "*",
				}),
			);
			return {
				bytes,
				sha256,
				etag: stored.ETag ?? null,
				versionId: stored.VersionId ?? null,
				...dimensions,
			};
		} catch (error) {
			if (!isConditionalWriteConflict(error)) throw error;
			const winner = await inspectWinner();
			assertDimensions(sourceDimensions, winner);
			return winner;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

export async function promoteStagedObject(input: {
	staging: MediaObjectLocation;
	final: MediaObjectLocation;
	contentType: MediaContentType;
	contentLength: number;
	expectedSha256?: string;
	/**
	 * Allows a recovery caller that owns a deterministic final key to commit the
	 * already-immutable final object's observed identity, even when a mutable
	 * remote source produced different bytes during a later retry.
	 */
	acceptExistingFinalIdentity?: boolean;
	/** Bounded fast path for small, server-owned generated images. */
	preferSinglePut?: boolean;
	promotion?: {
		uploadId?: string;
		onMultipartUploadCreated?: (input: { uploadId: string }) => Promise<void>;
	};
}): Promise<{ bytes: number; sha256: string; etag: string | null; versionId: string | null }> {
	if (input.staging.key === input.final.key) throw new Error("Staging and final keys must differ");
	const existing = await inspectExistingFinalObject(input);
	if (existing) return existing;

	const source = await getS3Client().send(new GetObjectCommand(mediaLocation(input.staging)));
	if (
		!source.Body ||
		typeof (source.Body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== "function"
	) {
		throw new MediaValidationError("OUTPUT_MEDIA_SIZE_EXCEEDED", "Staging object body was empty");
	}
	if (source.ContentLength !== input.contentLength) {
		throw new MediaValidationError(
			"OUTPUT_MEDIA_SIZE_EXCEEDED",
			"Staging object size does not match the expected provider output",
		);
	}
	if (source.ContentType !== input.contentType) {
		throw new MediaValidationError(
			"OUTPUT_MEDIA_TYPE_MISMATCH",
			"Staging object metadata does not match the expected provider output",
		);
	}
	if (
		input.preferSinglePut &&
		!input.promotion?.uploadId &&
		input.contentLength <= 2 * 1024 * 1024 &&
		(input.contentType === "image/jpeg" ||
			input.contentType === "image/png" ||
			input.contentType === "image/webp")
	) {
		let identity: { etag: string | null; versionId: string | null } = {
			etag: null,
			versionId: null,
		};
		const unexpectedMultipart = async (): Promise<never> => {
			throw new Error("SMALL_PROMOTION_MULTIPART_UNEXPECTED");
		};
		try {
			const copied = await writeImmutableReference(
				{
					body: Readable.toWeb(
						Readable.from(source.Body as AsyncIterable<Uint8Array>),
					) as unknown as ReadableStream<Uint8Array>,
					contentLength: input.contentLength,
					contentType: input.contentType,
				},
				{
					async put(body, sha256) {
						if (input.expectedSha256 && sha256 !== input.expectedSha256)
							throw new Error("UPLOAD_CHECKSUM_MISMATCH");
						const written = await getS3Client().send(
							new PutObjectCommand({
								...mediaLocation(input.final),
								Body: body,
								ContentType: input.contentType,
								ContentLength: body.length,
								IfNoneMatch: "*",
							}),
						);
						identity = { etag: written.ETag ?? null, versionId: written.VersionId ?? null };
					},
					createMultipart: unexpectedMultipart,
					uploadPart: unexpectedMultipart,
					complete: unexpectedMultipart,
					abort: unexpectedMultipart,
				},
			);
			return { ...copied, ...identity };
		} catch (error) {
			if (!isConditionalWriteConflict(error)) throw error;
			return inspectStoredMediaObject(
				input.final,
				input.contentType,
				input.acceptExistingFinalIdentity ? undefined : input.contentLength,
				input.expectedSha256,
			);
		}
	}
	let uploadId = input.promotion?.uploadId;
	if (!uploadId) {
		const created = await createMultipartUpload({
			bucket: input.final.bucket,
			key: input.final.key,
			contentType: input.contentType,
		});
		uploadId = created.uploadId;
		if (input.promotion?.onMultipartUploadCreated) {
			try {
				await input.promotion.onMultipartUploadCreated({ uploadId });
			} catch (error) {
				try {
					await abortMultipartUpload({ ...input.final, uploadId });
				} catch {
					// Preserve the durable-state persistence error.
				}
				throw error;
			}
		}
	}
	let copied: { bytes: number; sha256: string };
	try {
		copied = await copyRemoteStreamToMultipart(source.Body as Readable, {
			maxBytes: input.contentLength,
			partSize: config.media.multipartPartSize,
			validateHeader(header) {
				assertDetectedMediaType(header, input.contentType);
			},
			uploadPart: ({ partNumber, body, signal }) =>
				uploadMultipartPart({ ...input.final, uploadId, partNumber, body, signal }),
			complete: (parts) =>
				completeMultipartUpload({ ...input.final, uploadId, parts, ifNoneMatch: "*" }),
			abort: () => abortMultipartUpload({ ...input.final, uploadId }),
		});
	} catch (error) {
		if (!isConditionalWriteConflict(error)) throw error;
		return inspectStoredMediaObject(
			input.final,
			input.contentType,
			input.acceptExistingFinalIdentity ? undefined : input.contentLength,
			input.expectedSha256,
		);
	}
	if (copied.bytes !== input.contentLength)
		throw new MediaValidationError(
			"OUTPUT_MEDIA_SIZE_EXCEEDED",
			"Staging object size does not match the expected provider output",
		);
	return inspectStoredMediaObject(
		input.final,
		input.contentType,
		input.contentLength,
		input.expectedSha256 ?? copied.sha256,
	);
}

async function inspectExistingFinalObject(input: {
	final: MediaObjectLocation;
	contentType: MediaContentType;
	contentLength: number;
	expectedSha256?: string;
	acceptExistingFinalIdentity?: boolean;
}): Promise<{
	bytes: number;
	sha256: string;
	etag: string | null;
	versionId: string | null;
} | null> {
	try {
		return await inspectStoredMediaObject(
			input.final,
			input.contentType,
			input.acceptExistingFinalIdentity ? undefined : input.contentLength,
			input.expectedSha256,
		);
	} catch (error) {
		if (isExplicitObjectNotFound(error)) return null;
		throw error;
	}
}

export async function inspectPrivateMediaObject(
	input: MediaObjectLocation & { contentType: MediaContentType; contentLength: number },
): Promise<{ bytes: number; sha256: string; etag: string | null; versionId: string | null }> {
	return inspectStoredMediaObject(input, input.contentType, input.contentLength);
}

function isExplicitObjectNotFound(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const details = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
	return details.name === "NoSuchKey" || details.$metadata?.httpStatusCode === 404;
}

function isNoSuchUpload(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const details = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
	return details.name === "NoSuchUpload" || details.$metadata?.httpStatusCode === 404;
}

function isConditionalWriteConflict(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const details = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
	return (
		details.name === "PreconditionFailed" ||
		details.name === "ConditionalRequestConflict" ||
		details.$metadata?.httpStatusCode === 409 ||
		details.$metadata?.httpStatusCode === 412
	);
}

function isUncertainGenerationImageWrite(error: unknown): boolean {
	if (error instanceof MediaValidationError) return false;
	const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata
		?.httpStatusCode;
	return typeof status !== "number" || status === 408 || status >= 500;
}

async function inspectStoredMediaObject(
	location: MediaObjectLocation,
	contentType: MediaContentType,
	contentLength: number | undefined,
	expectedSha256?: string,
): Promise<{ bytes: number; sha256: string; etag: string | null; versionId: string | null }> {
	const result = await getS3Client().send(new GetObjectCommand(mediaLocation(location)));
	const body = result.Body;
	try {
		if (!body || typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== "function") {
			throw new MediaValidationError("OUTPUT_MEDIA_SIZE_EXCEEDED", "Stored object body was empty");
		}
		const storedContentLength = result.ContentLength;
		if (
			!Number.isSafeInteger(storedContentLength) ||
			!storedContentLength ||
			storedContentLength > getMediaByteLimit(contentType) ||
			(contentLength !== undefined && storedContentLength !== contentLength)
		) {
			throw new MediaValidationError(
				"OUTPUT_MEDIA_SIZE_EXCEEDED",
				"Stored object size does not match the expected provider output",
			);
		}
		if (result.ContentType !== contentType) {
			throw new MediaValidationError(
				"OUTPUT_MEDIA_TYPE_MISMATCH",
				"Stored object MIME metadata does not match the expected provider output",
			);
		}
		const hash = createHash("sha256");
		const headerChunks: Buffer[] = [];
		let headerBytes = 0;
		let bytes = 0;
		for await (const value of body as AsyncIterable<Uint8Array>) {
			const chunk = Buffer.from(value);
			bytes += chunk.byteLength;
			if (bytes > storedContentLength)
				throw new MediaValidationError(
					"OUTPUT_MEDIA_SIZE_EXCEEDED",
					"Stored object exceeds the expected provider output size",
				);
			hash.update(chunk);
			if (headerBytes < 64) {
				const slice = chunk.subarray(0, 64 - headerBytes);
				headerChunks.push(slice);
				headerBytes += slice.byteLength;
			}
		}
		if (bytes !== storedContentLength) {
			throw new MediaValidationError(
				"OUTPUT_MEDIA_SIZE_EXCEEDED",
				"Stored object does not match the expected provider output size",
			);
		}
		assertDetectedMediaType(Buffer.concat(headerChunks), contentType);
		const sha256 = hash.digest("hex");
		if (expectedSha256 && sha256 !== expectedSha256)
			throw new MediaValidationError(
				"OUTPUT_MEDIA_TYPE_MISMATCH",
				"Final object checksum does not match the expected provider output",
			);
		return { bytes, sha256, etag: result.ETag ?? null, versionId: result.VersionId ?? null };
	} finally {
		// Metadata rejection happens before iteration can release the SDK response.
		// Both Node and Workers own this body; never replace the validation/read error
		// with a cleanup failure or consume the response a second time.
		const response = body as
			| {
					destroy?: () => void;
					destroyed?: boolean;
					cancel?: () => Promise<void>;
					locked?: boolean;
			  }
			| undefined;
		try {
			if (typeof response?.destroy === "function") {
				if (!response.destroyed) response.destroy();
			} else if (typeof response?.cancel === "function" && !response.locked) {
				await response.cancel();
			}
		} catch {
			// Preserve the authoritative inspection result.
		}
	}
}

export async function checkStorageMetadataAccess(): Promise<void> {
	await getS3Client().send(new HeadBucketCommand({ Bucket: bucketName("media") }));
}

export async function putPrivateMediaObject(
	input: MediaObjectLocation & {
		contentType: MediaContentType;
		body: Buffer;
	},
): Promise<{ bytes: number; sha256: string }> {
	if (input.body.byteLength > getMediaByteLimit(input.contentType)) {
		throw new MediaValidationError("OUTPUT_MEDIA_SIZE_EXCEEDED", "Media byte limit exceeded");
	}
	assertDetectedMediaType(input.body.subarray(0, 64), input.contentType);
	const sha256 = createHash("sha256").update(input.body).digest("hex");
	await getS3Client().send(
		new PutObjectCommand({
			...mediaLocation(input),
			ContentType: input.contentType,
			ContentLength: input.body.byteLength,
			Body: input.body,
			Metadata: { sha256 },
		}),
	);
	return { bytes: input.body.byteLength, sha256 };
}

/** One conditional private object for ordinary images. Remote URL images stream
 * up to the existing image byte limit; inline buffers retain the 10 MiB limit.
 * Unknown-length files retain the multipart path.
 * The caller owns the deterministic key and fences quota/DB commit with its lease.
 */
export async function tryWriteImmutableGenerationImage(
	input: MediaObjectLocation & {
		contentType: MediaContentType;
		body?: Buffer;
		sourceUrl?: string;
		allowedHosts?: readonly string[];
		/** Caller-owned inspected stream; a null fast-path result leaves it reusable. */
		openedSource?: OpenedRemoteMedia;
		/** A concurrent URL-only executor must never enter the buffered fallback. */
		streamingOnly?: boolean;
		/** True only when the committed transfer claim created a previously absent
		 * asset under its job/binding locks. Missing/false keeps recovery GET-first. */
		freshClaim?: boolean;
		reserve(bytes: number): Promise<void>;
	},
	options: StreamRemoteObjectOptions = {},
): Promise<{
	bytes: number;
	sha256: string;
	etag: string | null;
	versionId: string | null;
} | null> {
	if (
		input.contentType !== "image/jpeg" &&
		input.contentType !== "image/png" &&
		input.contentType !== "image/webp"
	)
		return null;
	if (input.streamingOnly && input.body) return null;
	if (input.freshClaim !== true) {
		const existing = await inspectExistingFinalObject({
			final: input,
			contentType: input.contentType,
			contentLength: 0,
			acceptExistingFinalIdentity: true,
		});
		if (existing) {
			await input.reserve(existing.bytes);
			return existing;
		}
	}
	const maximum = Math.min(10 * 1024 * 1024, getMediaByteLimit(input.contentType));
	let stream: Readable;
	let length: number;
	if (input.body) {
		length = input.body.byteLength;
		if (length > maximum) return null;
		stream = Readable.from([input.body]);
	} else {
		if (!input.openedSource && (!input.sourceUrl || !input.allowedHosts))
			throw new Error("GENERATION_OUTPUT_SOURCE_REQUIRED");
		const response =
			input.openedSource ??
			(await requestRemoteMediaStream(input.sourceUrl!, {
				allowedHosts: input.allowedHosts!,
				maxRedirects: config.media.remoteMaxRedirects,
				connectTimeoutMs: config.media.remoteConnectTimeoutMs,
				firstByteTimeoutMs: config.media.remoteFirstByteTimeoutMs,
				totalTimeoutMs: config.media.remoteTotalTimeoutMs,
				...options,
			}));
		stream = response.stream;
		length = Number(response.headers["content-length"]);
		if (
			!canStreamImmutableGenerationImage({
				contentType: input.contentType,
				contentLength: response.headers["content-length"],
			})
		) {
			if (!input.openedSource) stream.destroy();
			return null;
		}
	}
	let identity: { etag: string | null; versionId: string | null } = { etag: null, versionId: null };
	let writeAttempted = false;
	const unexpectedMultipart = async (): Promise<never> => {
		throw new Error("BOUNDED_OUTPUT_MULTIPART_UNEXPECTED");
	};
	try {
		if (!input.body) {
			await input.reserve(length);
			const url = await getS3SignedUrl(
				getS3Client(true),
				new PutObjectCommand({
					...mediaLocation(input),
					ContentLength: length,
					ContentType: input.contentType,
					IfNoneMatch: "*",
				}),
				{
					expiresIn:
						Math.ceil((options.totalTimeoutMs ?? config.media.remoteTotalTimeoutMs) / 1000) + 60,
					signableHeaders: new Set(["content-length", "content-type", "if-none-match"]),
				},
			);
			writeAttempted = true;
			return await writeValidatedPrivateImageStream({
				url,
				source: stream,
				contentLength: length,
				contentType: input.contentType,
				timeoutMs: options.totalTimeoutMs ?? config.media.remoteTotalTimeoutMs,
			});
		}
		const written = await writeImmutableReference(
			{
				body: Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
				contentLength: length,
				contentType: input.contentType,
			},
			{
				async put(body, sha256) {
					await input.reserve(body.length);
					writeAttempted = true;
					const result = await getS3Client().send(
						new PutObjectCommand({
							...mediaLocation(input),
							Body: body,
							ContentLength: body.length,
							ContentType: input.contentType,
							Metadata: { sha256 },
							IfNoneMatch: "*",
						}),
					);
					identity = { etag: result.ETag ?? null, versionId: result.VersionId ?? null };
				},
				createMultipart: unexpectedMultipart,
				uploadPart: unexpectedMultipart,
				complete: unexpectedMultipart,
				abort: unexpectedMultipart,
			},
		);
		return { ...written, ...identity };
	} catch (error) {
		if (
			!isConditionalWriteConflict(error) &&
			!(input.freshClaim === true && writeAttempted && isUncertainGenerationImageWrite(error))
		)
			throw error;
		// A fresh claim does not prove that storage has no orphan or racing winner.
		// After a conflict/uncertain PUT, consume and hash that whole immutable
		// object. Never trust response headers as content or reopen the supplier.
		const winner = await inspectExistingFinalObject({
			final: input,
			contentType: input.contentType,
			contentLength: 0,
			acceptExistingFinalIdentity: true,
		});
		if (!winner) throw error;
		await input.reserve(winner.bytes);
		return winner;
	} finally {
		stream.destroy();
	}
}

/** Template scenes are decoded and normalized before their only private immutable write.
 * The caller must first persist the scene asset and reserve its maximum capacity.
 * Recovery reuses the exact canonical winner even if the remote URL later changes.
 */
export async function storeImmutableVideoTemplateScene(
	input: MediaObjectLocation & {
		sourceUrl: string;
		allowedHosts: readonly string[];
		maximumBytes: number;
	},
): Promise<{
	bytes: number;
	sha256: string;
	etag: string | null;
	versionId: string | null;
	width: number;
	height: number;
}> {
	if (
		!Number.isSafeInteger(input.maximumBytes) ||
		input.maximumBytes < 1 ||
		input.maximumBytes > 10_000_000
	)
		throw new Error("VIDEO_TEMPLATE_SCENE_BYTE_LIMIT_INVALID");
	const inspectWinner = async () => {
		const { body, ...identity } = await readPrivateReferenceImage({
			...input,
			contentType: "image/png",
			maximumBytes: input.maximumBytes,
		});
		const dimensions = await inspectReferenceBytes(body, "image/png");
		if (Math.abs(dimensions.width / dimensions.height - 9 / 16) > 0.015)
			throw new Error("VIDEO_TEMPLATE_SCENE_ASPECT_RATIO_INVALID");
		return { ...identity, sha256: createHash("sha256").update(body).digest("hex"), ...dimensions };
	};
	try {
		return await inspectWinner();
	} catch (error) {
		if (!isExplicitObjectNotFound(error)) throw error;
	}
	const processor = getImageProcessor();
	if (!processor.normalizePng || !processor.validateDecoded)
		throw new Error("VIDEO_TEMPLATE_SCENE_DECODER_UNAVAILABLE");
	const response = await requestRemoteMediaStream(input.sourceUrl, {
		allowedHosts: input.allowedHosts,
		maxRedirects: config.media.remoteMaxRedirects,
		connectTimeoutMs: config.media.remoteConnectTimeoutMs,
		firstByteTimeoutMs: config.media.remoteFirstByteTimeoutMs,
		totalTimeoutMs: config.media.remoteTotalTimeoutMs,
	});
	const bounded = async (source: AsyncIterable<Uint8Array>) => {
		const body = Buffer.alloc(input.maximumBytes);
		let bytes = 0;
		for await (const chunk of source) {
			bytes += chunk.byteLength;
			if (bytes > input.maximumBytes) throw new Error("VIDEO_TEMPLATE_SCENE_TOO_LARGE");
			body.set(chunk, bytes - chunk.byteLength);
		}
		if (!bytes) throw new Error("VIDEO_TEMPLATE_SCENE_EMPTY");
		return body.subarray(0, bytes);
	};
	try {
		const body = await bounded(response.stream);
		const contentType = response.headers["content-type"]?.split(";")[0]?.trim();
		if (contentType !== "image/jpeg" && contentType !== "image/png" && contentType !== "image/webp")
			throw new Error("VIDEO_TEMPLATE_SCENE_FORMAT_INVALID");
		assertDetectedMediaType(body.subarray(0, 64), contentType);
		await inspectReferenceBytes(body, contentType, false);
		const normalized = await processor.normalizePng(imageByteStream(body), {
			contentLength: body.length,
		});
		const reader = normalized.getReader();
		const normalizedBytes = Buffer.alloc(input.maximumBytes);
		let bytes = 0;
		try {
			for (;;) {
				const result = await reader.read();
				if (result.done) break;
				bytes += result.value.byteLength;
				if (bytes > input.maximumBytes) throw new Error("VIDEO_TEMPLATE_SCENE_TOO_LARGE");
				normalizedBytes.set(result.value, bytes - result.value.byteLength);
			}
		} finally {
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
		const canonical = normalizedBytes.subarray(0, bytes);
		assertDetectedMediaType(canonical.subarray(0, 64), "image/png");
		const dimensions = await inspectReferenceBytes(canonical, "image/png");
		if (Math.abs(dimensions.width / dimensions.height - 9 / 16) > 0.015)
			throw new Error("VIDEO_TEMPLATE_SCENE_ASPECT_RATIO_INVALID");
		const sha256 = createHash("sha256").update(canonical).digest("hex");
		try {
			const stored = await getS3Client().send(
				new PutObjectCommand({
					...mediaLocation(input),
					Body: canonical,
					ContentLength: bytes,
					ContentType: "image/png",
					Metadata: { sha256 },
					IfNoneMatch: "*",
				}),
			);
			return {
				bytes,
				sha256,
				etag: stored.ETag ?? null,
				versionId: stored.VersionId ?? null,
				...dimensions,
			};
		} catch (error) {
			if (!isConditionalWriteConflict(error)) throw error;
			return inspectWinner();
		}
	} finally {
		response.stream.destroy();
	}
}

/** The key is generated by the server; clients never receive write access to it. */
export async function putTemporaryReferenceObject(
	input: MediaObjectLocation & {
		contentType: "image/jpeg" | "image/png" | "image/webp";
		contentLength: number;
		body: ReadableStream<Uint8Array>;
	},
): Promise<{ bytes: number; sha256: string }> {
	return writeImmutableReference(input, {
		put: async (body, sha256) => {
			await getS3Client().send(
				new PutObjectCommand({
					...mediaLocation(input),
					ContentType: input.contentType,
					ContentLength: body.byteLength,
					Body: body,
					Metadata: { sha256 },
					IfNoneMatch: "*",
				}),
			);
		},
		createMultipart: async () => (await createMultipartUpload(input)).uploadId,
		uploadPart: (uploadId, partNumber, body) =>
			uploadMultipartPart({ ...input, uploadId, partNumber, body }),
		complete: (uploadId, parts) =>
			completeMultipartUpload({ ...input, uploadId, parts, ifNoneMatch: "*" }),
		abort: (uploadId) => abortMultipartUpload({ ...input, uploadId }),
	});
}

export async function readMediaHeader(input: MediaObjectLocation): Promise<Buffer> {
	const result = await getS3Client().send(
		new GetObjectCommand({
			...mediaLocation(input),
			Range: "bytes=0-63",
		}),
	);
	if (!result.Body) throw new Error("Storage object body was empty");
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const value of result.Body as AsyncIterable<Uint8Array>) {
		const chunk = Buffer.from(value);
		chunks.push(chunk.subarray(0, Math.max(0, 64 - bytes)));
		bytes += chunk.byteLength;
		if (bytes >= 64) break;
	}
	return Buffer.concat(chunks);
}

export async function createSignedReadUrl(input: SignedReadInput): Promise<string> {
	return getS3SignedUrl(
		getS3Client(),
		new GetObjectCommand({
			...mediaLocation(input),
			ResponseContentDisposition: input.responseContentDisposition ?? "inline",
		}),
		{ expiresIn: input.expiresIn ?? config.media.signedReadExpiresSeconds },
	);
}

export async function deleteObject(input: MediaObjectLocation): Promise<void> {
	await getS3Client().send(new DeleteObjectCommand(mediaLocation(input)));
}

export const watermarkStagedGuestImage = createWatermarkStagedGuestImage({
	inspectImage: inspectStagedGuestImage,
	transformAndStore: transformAndStoreGuestImage,
	deleteObject,
});

async function inspectStagedGuestImage(
	location: MediaObjectLocation,
	contentType: Extract<MediaContentType, `image/${string}`>,
): Promise<{ width: number; height: number }> {
	const result = await getS3Client().send(new GetObjectCommand(mediaLocation(location)));
	if (!result.Body || result.ContentType !== contentType) {
		throw new MediaValidationError(
			"OUTPUT_MEDIA_TYPE_MISMATCH",
			"Guest staging image metadata is invalid",
		);
	}
	const source = result.Body.transformToWebStream();
	try {
		return await getImageProcessor().inspect(source, contentType, {
			contentLength: result.ContentLength,
		});
	} finally {
		if (!source.locked) await source.cancel().catch(() => undefined);
	}
}

async function transformAndStoreGuestImage(input: {
	staging: MediaObjectLocation;
	final: MediaObjectLocation;
	contentType: Extract<MediaContentType, `image/${string}`>;
	deleteAfter: Date;
	width: number;
	height: number;
}): Promise<{ bytes: number; sha256: string; etag?: string; versionId?: string }> {
	const sourceObject = await getS3Client().send(new GetObjectCommand(mediaLocation(input.staging)));
	if (
		!sourceObject.Body ||
		sourceObject.ContentType !== input.contentType ||
		!Number.isSafeInteger(sourceObject.ContentLength) ||
		!sourceObject.ContentLength ||
		sourceObject.ContentLength > getMediaByteLimit(input.contentType)
	) {
		throw new MediaValidationError(
			"OUTPUT_MEDIA_SIZE_EXCEEDED",
			"Guest staging image identity is invalid",
		);
	}
	let conditionalConflict = false;
	const source = sourceObject.Body.transformToWebStream();
	let transformed: Readable | undefined;
	let copied;
	try {
		const output = await getImageProcessor().watermark(source, {
			width: input.width,
			height: input.height,
			contentType: input.contentType,
			contentLength: sourceObject.ContentLength,
		});
		// DOM and workerd declarations differ, but both supply the standard Web stream contract.
		transformed = Readable.fromWeb(
			output as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
		);
		const { uploadId } = await createMultipartUpload({
			...input.final,
			contentType: input.contentType,
			metadata: {
				watermark: GUEST_WATERMARK_VERSION,
				"delete-after": input.deleteAfter.toISOString(),
			},
		});
		copied = await copyRemoteStreamToMultipart(transformed, {
			maxBytes: getMediaByteLimit(input.contentType),
			partSize: config.media.multipartPartSize,
			validateHeader(header) {
				assertDetectedMediaType(header, input.contentType);
			},
			uploadPart: ({ partNumber, body, signal }) =>
				uploadMultipartPart({ ...input.final, uploadId, partNumber, body, signal }),
			complete: async (parts) => {
				try {
					await completeMultipartUpload({ ...input.final, uploadId, parts, ifNoneMatch: "*" });
				} catch (error) {
					if (!isConditionalWriteConflict(error)) throw error;
					conditionalConflict = true;
					try {
						await abortMultipartUpload({ ...input.final, uploadId });
					} catch (abortError) {
						if (!isNoSuchUpload(abortError)) throw abortError;
					}
				}
			},
			abort: () => abortMultipartUpload({ ...input.final, uploadId }),
		});
	} finally {
		transformed?.destroy();
		if (!source.locked) await source.cancel().catch(() => undefined);
	}
	const stored = await inspectStoredMediaObject(
		input.final,
		input.contentType,
		copied.bytes,
		copied.sha256,
	);
	if (conditionalConflict && stored.sha256 !== copied.sha256) {
		throw new MediaValidationError(
			"OUTPUT_MEDIA_TYPE_MISMATCH",
			"Existing guest watermarked object identity differs",
		);
	}
	return {
		bytes: stored.bytes,
		sha256: stored.sha256,
		...(stored.etag ? { etag: stored.etag } : {}),
		...(stored.versionId ? { versionId: stored.versionId } : {}),
	};
}

export interface StreamRemoteObjectInput extends MediaObjectLocation {
	sourceUrl: string;
	allowedHosts: readonly string[];
	expectedContentType: MediaContentType;
	expectedMediaKind?: MediaKind;
	maxBytes?: number;
	/** A previously inspected, caller-owned download; no second supplier request. */
	openedSource?: OpenedRemoteMedia;
}

export interface StreamRemoteObjectOptions extends Pick<
	RemoteMediaRequestOptions,
	"resolve" | "request" | "totalTimeoutMs"
> {}

export async function streamRemoteObjectToStorage(
	input: StreamRemoteObjectInput,
	options: StreamRemoteObjectOptions = {},
): Promise<{ bytes: number; sha256: string }> {
	const { uploadId } = await createMultipartUpload({
		bucket: input.bucket,
		key: input.key,
		contentType: input.expectedContentType,
	});
	const result = await copyRemoteRequestToMultipart(
		async () => {
			const response =
				input.openedSource ??
				(await requestRemoteMediaStream(input.sourceUrl, {
					allowedHosts: input.allowedHosts,
					maxRedirects: config.media.remoteMaxRedirects,
					connectTimeoutMs: config.media.remoteConnectTimeoutMs,
					firstByteTimeoutMs: config.media.remoteFirstByteTimeoutMs,
					totalTimeoutMs: config.media.remoteTotalTimeoutMs,
					...options,
				}));
			return response.stream;
		},
		{
			maxBytes: Math.min(
				input.maxBytes ?? Number.MAX_SAFE_INTEGER,
				input.expectedMediaKind
					? getMediaKindByteLimit(input.expectedMediaKind)
					: getMediaByteLimit(input.expectedContentType),
			),
			partSize: config.media.multipartPartSize,
			validateHeader(header) {
				const contentType = assertDetectedMediaType(header, input.expectedContentType);
				if (input.expectedMediaKind) assertMediaKind(contentType, input.expectedMediaKind);
			},
			uploadPart: ({ partNumber, body, signal }) =>
				uploadMultipartPart({ ...input, uploadId, partNumber, body, signal }),
			complete: (parts) => completeMultipartUpload({ ...input, uploadId, parts }),
			abort: () => abortMultipartUpload({ ...input, uploadId }),
		},
	);
	return { bytes: result.bytes, sha256: result.sha256 };
}

function assertPartNumber(partNumber: number): void {
	if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
		throw new Error("Invalid multipart part number");
	}
}

// Avatar compatibility. New media flows use the private object APIs above.
export const getSignedUploadUrl: GetSignedUploadUrlHandler = async (
	path,
	{ bucket, contentType, contentLength },
) => {
	if (
		!Number.isSafeInteger(contentLength) ||
		contentLength <= 0 ||
		contentLength > MAX_AVATAR_UPLOAD_BYTES ||
		!(["image/png", "image/jpeg"] as const).some((type) => type === contentType)
	) {
		throw new Error("Invalid avatar upload declaration");
	}
	try {
		return await getS3SignedUrl(
			getS3Client(),
			new PutObjectCommand({
				Bucket: bucketName(bucket),
				Key: path,
				ContentType: contentType,
				ContentLength: contentLength,
			}),
			{ expiresIn: 60, signableHeaders: new Set(["content-type", "content-length"]) },
		);
	} catch (error) {
		logger.error(error);
		throw new Error("Could not get signed upload url");
	}
};

export const getSignedUrl: GetSignedUrlHander = async (path, { bucket, expiresIn }) => {
	try {
		return await getS3SignedUrl(
			getS3Client(),
			new GetObjectCommand({ Bucket: bucketName(bucket), Key: path }),
			{ expiresIn },
		);
	} catch (error) {
		logger.error(error);
		throw new Error("Could not get signed url");
	}
};
