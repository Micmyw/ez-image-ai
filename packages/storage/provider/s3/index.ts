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
	S3Client,
	UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl as getS3SignedUrl } from "@aws-sdk/s3-request-presigner";
import { logger } from "@repo/logs";

import { config } from "../../config";
import { detectMediaType, getMediaByteLimit } from "../../lib/media-signatures";
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
	},
): Promise<void> {
	if (input.parts.length === 0) throw new Error("Multipart upload has no parts");
	await getS3Client().send(
		new CompleteMultipartUploadCommand({
			...mediaLocation(input),
			UploadId: input.uploadId,
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
}): Promise<{ bytes: number; sha256: string; etag: string | null; versionId: string | null }> {
	if (input.staging.key === input.final.key) throw new Error("Staging and final keys must differ");
	const existing = await inspectStoredMediaObject(
		input.final,
		input.contentType,
		input.contentLength,
	).catch(() => null);
	if (existing) return existing;

	const source = await getS3Client().send(new GetObjectCommand(mediaLocation(input.staging)));
	if (
		!source.Body ||
		typeof (source.Body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== "function"
	) {
		throw new Error("Staging object body was empty");
	}
	if (source.ContentLength !== input.contentLength || source.ContentType !== input.contentType) {
		throw new Error("Staging object metadata does not match the upload session");
	}
	const { uploadId } = await createMultipartUpload({
		bucket: input.final.bucket,
		key: input.final.key,
		contentType: input.contentType,
	});
	const copied = await copyRemoteStreamToMultipart(source.Body as Readable, {
		maxBytes: input.contentLength,
		partSize: config.media.multipartPartSize,
		validateHeader(header) {
			if (detectMediaType(header) !== input.contentType) {
				throw new Error("Staging object signature does not match the upload session");
			}
		},
		uploadPart: ({ partNumber, body }) =>
			uploadMultipartPart({ ...input.final, uploadId, partNumber, body }),
		complete: (parts) => completeMultipartUpload({ ...input.final, uploadId, parts }),
		abort: () => abortMultipartUpload({ ...input.final, uploadId }),
	});
	if (copied.bytes !== input.contentLength)
		throw new Error("Staging object size does not match the upload session");
	return inspectStoredMediaObject(
		input.final,
		input.contentType,
		input.contentLength,
		copied.sha256,
	);
}

async function inspectStoredMediaObject(
	location: MediaObjectLocation,
	contentType: MediaContentType,
	contentLength: number,
	expectedSha256?: string,
): Promise<{ bytes: number; sha256: string; etag: string | null; versionId: string | null }> {
	const result = await getS3Client().send(new GetObjectCommand(mediaLocation(location)));
	if (
		!result.Body ||
		typeof (result.Body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== "function"
	) {
		throw new Error("Stored object body was empty");
	}
	if (result.ContentLength !== contentLength || result.ContentType !== contentType) {
		throw new Error("Stored object metadata does not match the upload session");
	}
	const hash = createHash("sha256");
	const headerChunks: Buffer[] = [];
	let headerBytes = 0;
	let bytes = 0;
	for await (const value of result.Body as AsyncIterable<Uint8Array>) {
		const chunk = Buffer.from(value);
		bytes += chunk.byteLength;
		if (bytes > contentLength) throw new Error("Stored object exceeds the upload session size");
		hash.update(chunk);
		if (headerBytes < 64) {
			const slice = chunk.subarray(0, 64 - headerBytes);
			headerChunks.push(slice);
			headerBytes += slice.byteLength;
		}
	}
	if (bytes !== contentLength || detectMediaType(Buffer.concat(headerChunks)) !== contentType) {
		throw new Error("Stored object does not match the upload session");
	}
	const sha256 = hash.digest("hex");
	if (expectedSha256 && sha256 !== expectedSha256)
		throw new Error("Final object checksum mismatch");
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
		throw new Error("Media byte limit exceeded");
	}
	if (detectMediaType(input.body.subarray(0, 64)) !== input.contentType) {
		throw new Error("Media signature does not match the expected content type");
	}
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

export interface StreamRemoteObjectInput extends MediaObjectLocation {
	sourceUrl: string;
	allowedHosts: readonly string[];
	expectedContentType: MediaContentType;
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
				getMediaByteLimit(input.expectedContentType),
			),
			partSize: config.media.multipartPartSize,
			validateHeader(header) {
				if (detectMediaType(header) !== input.expectedContentType) {
					throw new Error("Remote media signature does not match the expected content type");
				}
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
