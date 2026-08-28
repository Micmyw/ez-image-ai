import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

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
import sharp from "sharp";

import { config } from "../../config";
import {
	GUEST_WATERMARK_VERSION,
	createWatermarkStagedGuestImage,
} from "../../lib/image-watermark";
import {
	assertDetectedMediaType,
	assertMediaKind,
	getMediaByteLimit,
	getMediaKindByteLimit,
	MediaValidationError,
	type MediaKind,
} from "../../lib/media-signatures";
import type { RemoteMediaRequestOptions } from "../../lib/stream-copy";
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

function getS3Client(): S3Client {
	if (s3Client) return s3Client;
	const endpoint = process.env.S3_ENDPOINT;
	const accessKeyId = process.env.S3_ACCESS_KEY_ID;
	const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
	if (!endpoint) throw new Error("Missing env variable S3_ENDPOINT");
	if (!accessKeyId) throw new Error("Missing env variable S3_ACCESS_KEY_ID");
	if (!secretAccessKey) throw new Error("Missing env variable S3_SECRET_ACCESS_KEY");
	s3Client = new S3Client({
		region: process.env.S3_REGION || "auto",
		endpoint,
		forcePathStyle: true,
		credentials: { accessKeyId, secretAccessKey },
	});
	return s3Client;
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
	input: MediaObjectLocation & { uploadId: string; partNumber: number; body: Buffer },
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
			uploadPart: ({ partNumber, body }) =>
				uploadMultipartPart({ ...input.final, uploadId, partNumber, body }),
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

async function inspectStoredMediaObject(
	location: MediaObjectLocation,
	contentType: MediaContentType,
	contentLength: number | undefined,
	expectedSha256?: string,
): Promise<{ bytes: number; sha256: string; etag: string | null; versionId: string | null }> {
	const result = await getS3Client().send(new GetObjectCommand(mediaLocation(location)));
	if (
		!result.Body ||
		typeof (result.Body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== "function"
	) {
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
	for await (const value of result.Body as AsyncIterable<Uint8Array>) {
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
	const source = result.Body as Readable;
	const inspector = sharp({ sequentialRead: true, failOn: "error" });
	source.pipe(inspector);
	try {
		const metadata = await inspector.metadata();
		if (!metadata.width || !metadata.height) {
			throw new MediaValidationError(
				"OUTPUT_MEDIA_TYPE_MISMATCH",
				"Guest staging image dimensions are unavailable",
			);
		}
		return { width: metadata.width, height: metadata.height };
	} finally {
		source.destroy();
	}
}

async function transformAndStoreGuestImage(input: {
	staging: MediaObjectLocation;
	final: MediaObjectLocation;
	contentType: Extract<MediaContentType, `image/${string}`>;
	deleteAfter: Date;
	createTransform(): import("sharp").Sharp;
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
	const { uploadId } = await createMultipartUpload({
		...input.final,
		contentType: input.contentType,
		metadata: {
			watermark: GUEST_WATERMARK_VERSION,
			"delete-after": input.deleteAfter.toISOString(),
		},
	});
	let conditionalConflict = false;
	const source = sourceObject.Body as Readable;
	const transform = input.createTransform();
	source.once("error", (error) => transform.destroy(error));
	const transformed = source.pipe(transform);
	let copied;
	try {
		copied = await copyRemoteStreamToMultipart(transformed, {
			maxBytes: getMediaByteLimit(input.contentType),
			partSize: config.media.multipartPartSize,
			validateHeader(header) {
				assertDetectedMediaType(header, input.contentType);
			},
			uploadPart: ({ partNumber, body }) =>
				uploadMultipartPart({ ...input.final, uploadId, partNumber, body }),
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
		source.destroy();
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
}

export interface StreamRemoteObjectOptions extends Pick<
	RemoteMediaRequestOptions,
	"resolve" | "request"
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
			const response = await requestRemoteMediaStream(input.sourceUrl, {
				allowedHosts: input.allowedHosts,
				maxRedirects: config.media.remoteMaxRedirects,
				connectTimeoutMs: config.media.remoteConnectTimeoutMs,
				firstByteTimeoutMs: config.media.remoteFirstByteTimeoutMs,
				totalTimeoutMs: config.media.remoteTotalTimeoutMs,
				...options,
			});
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
			uploadPart: ({ partNumber, body }) =>
				uploadMultipartPart({ ...input, uploadId, partNumber, body }),
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
	{ bucket, contentType = "image/jpeg", contentLength },
) => {
	try {
		return await getS3SignedUrl(
			getS3Client(),
			new PutObjectCommand({
				Bucket: bucketName(bucket),
				Key: path,
				ContentType: contentType,
				ContentLength: contentLength,
			}),
			{ expiresIn: 60 },
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
