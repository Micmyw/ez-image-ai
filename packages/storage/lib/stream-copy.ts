import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { requestRemoteHttps } from "#remote-media-node-transport";

import type { MediaContentType } from "../types";
import {
	assertDetectedMediaType,
	assertMediaKind,
	MediaValidationError,
	type MediaKind,
} from "./media-signatures";
import { currentRemoteMediaTransport } from "./remote-media-runtime";
import type { RemoteUrlPolicyOptions, ValidatedRemoteUrl } from "./remote-url-policy";
import { assertAllowedRemoteUrl, RemoteMediaPolicyError } from "./remote-url-policy";

export interface MultipartStreamTarget {
	maxBytes: number;
	partSize: number;
	uploadPart(input: { partNumber: number; body: Buffer; signal?: AbortSignal }): Promise<string>;
	complete(parts: Array<{ partNumber: number; etag: string }>): Promise<void>;
	abort(): Promise<void>;
	validateHeader?(header: Buffer): void;
	/** Incremental validation of every source byte before it can be uploaded. */
	inspectChunk?(chunk: Buffer): void;
}

export interface MultipartStreamResult {
	bytes: number;
	sha256: string;
	header: Buffer;
}

export async function copyRemoteStreamToMultipart(
	source: Readable,
	target: MultipartStreamTarget,
): Promise<MultipartStreamResult> {
	if (!Number.isSafeInteger(target.maxBytes) || target.maxBytes <= 0)
		throw new Error("Byte limit is invalid");
	if (!Number.isSafeInteger(target.partSize) || target.partSize <= 0)
		throw new Error("Part size is invalid");
	const hash = createHash("sha256");
	const parts: Array<{ partNumber: number; etag: string }> = [];
	const header = Buffer.allocUnsafe(64);
	let headerBytes = 0;
	let isHeaderValidated = false;
	// One uploading part and one assembly buffer. The source transport owns its
	// high-water mark/current chunk; never retain a list of previously read chunks.
	const partCapacity = Math.min(target.partSize, target.maxBytes);
	let pending = Buffer.allocUnsafe(partCapacity);
	let pendingBytes = 0;
	let bytes = 0;
	let inFlight: Promise<void> | undefined;
	let uploadFailed = false;
	let uploadError: unknown;
	const uploadController = new AbortController();
	const waitForUpload = async () => {
		await inFlight;
		if (uploadFailed) throw uploadError;
	};
	const upload = async (body: Buffer) => {
		await waitForUpload();
		const partNumber = parts.length + 1;
		// Install the rejection handler before pulling more bytes. In particular,
		// a failed upload must wake an iterator stalled on the supplier response.
		inFlight = Promise.resolve()
			.then(() => target.uploadPart({ partNumber, body, signal: uploadController.signal }))
			.then(
				(etag) => {
					parts.push({ partNumber, etag });
				},
				(error: unknown) => {
					uploadFailed = true;
					uploadError = error;
					source.destroy();
				},
			);
	};
	try {
		for await (const value of source) {
			if (uploadFailed) throw uploadError;
			const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
			bytes += chunk.byteLength;
			if (bytes > target.maxBytes) {
				throw new MediaValidationError(
					"OUTPUT_MEDIA_SIZE_EXCEEDED",
					"Remote media byte limit exceeded",
				);
			}
			hash.update(chunk);
			target.inspectChunk?.(chunk);
			if (headerBytes < 64) {
				headerBytes += chunk.copy(header, headerBytes, 0, 64 - headerBytes);
			}
			if (!isHeaderValidated && headerBytes >= Math.min(target.partSize, 16)) {
				target.validateHeader?.(header.subarray(0, headerBytes));
				isHeaderValidated = true;
			}
			for (let offset = 0; offset < chunk.byteLength;) {
				const length = Math.min(chunk.byteLength - offset, partCapacity - pendingBytes);
				chunk.copy(pending, pendingBytes, offset, offset + length);
				pendingBytes += length;
				offset += length;
				if (pendingBytes === target.partSize) {
					await upload(pending);
					pending = Buffer.allocUnsafe(partCapacity);
					pendingBytes = 0;
				}
			}
		}
		if (bytes === 0) {
			throw new MediaValidationError(
				"OUTPUT_MEDIA_SIZE_EXCEEDED",
				"Remote media response was empty",
			);
		}
		if (!isHeaderValidated) target.validateHeader?.(header.subarray(0, headerBytes));
		if (pendingBytes > 0) {
			await upload(pending.subarray(0, pendingBytes));
		}
		await waitForUpload();
		await target.complete(parts);
		return { bytes, sha256: hash.digest("hex"), header: header.subarray(0, headerBytes) };
	} catch (error) {
		const failure = uploadFailed ? uploadError : error;
		uploadController.abort();
		source.destroy();
		// A part must not finish after the upload has been aborted and leave new
		// remote state behind. Adapters which support cancellation stop promptly;
		// older adapters are still drained before multipart cleanup.
		await inFlight;
		try {
			await target.abort();
		} catch {
			/* preserve the transfer failure */
		}
		throw failure;
	} finally {
		source.destroy();
	}
}

export async function copyRemoteRequestToMultipart(
	openStream: () => Promise<Readable>,
	target: MultipartStreamTarget,
): Promise<MultipartStreamResult> {
	let source: Readable;
	try {
		source = await openStream();
	} catch (error) {
		try {
			await target.abort();
		} catch {
			// Preserve the remote request or transfer failure.
		}
		throw error;
	}
	return copyRemoteStreamToMultipart(source, target);
}

export interface RemoteStreamResponse {
	status: number;
	headers: Record<string, string | undefined>;
	stream: Readable;
}

export interface OpenedRemoteMedia extends RemoteStreamResponse {
	url: URL;
	contentType: MediaContentType;
}

export interface RemoteMediaRequestOptions extends RemoteUrlPolicyOptions {
	maxRedirects: number;
	connectTimeoutMs?: number;
	firstByteTimeoutMs?: number;
	totalTimeoutMs?: number;
	request?: (input: ValidatedRemoteUrl) => Promise<RemoteStreamResponse>;
}

/**
 * Reads only the initial bounded prefix of a provider object. This gives the
 * finalizer a detected media type for the immutable object key before it
 * claims a transfer lease. Kept for callers that only need a probe; transfer
 * callers use openInspectedRemoteMedia to retain the same authorized download.
 */
export async function inspectRemoteMedia(
	initialUrl: string,
	options: RemoteMediaRequestOptions & { expectedKind: MediaKind },
): Promise<{ contentType: MediaContentType }> {
	const response = await openInspectedRemoteMedia(initialUrl, options);
	try {
		return { contentType: response.contentType };
	} finally {
		response.stream.destroy();
	}
}

/**
 * Detect a bounded prefix without reopening the supplier URL. Every byte read
 * for detection is replayed, and the caller owns destroying the returned stream.
 * The original transport retains its DNS, redirect and timeout policy.
 */
export async function openInspectedRemoteMedia(
	initialUrl: string,
	options: RemoteMediaRequestOptions & { expectedKind: MediaKind },
): Promise<OpenedRemoteMedia> {
	const response = await requestRemoteMediaStream(initialUrl, options);
	const iterator = response.stream[Symbol.asyncIterator]();
	const prefetched: Buffer[] = [];
	try {
		const contentType = await detectMediaTypeFromIterator(
			iterator,
			options.expectedKind,
			prefetched,
		);
		return {
			...response,
			contentType,
			stream: replayInspectedStream(response.stream, iterator, prefetched),
		};
	} catch (error) {
		response.stream.destroy();
		await iterator.return?.().catch(() => undefined);
		throw error;
	}
}

export async function requestRemoteMediaStream(
	initialUrl: string,
	options: RemoteMediaRequestOptions,
): Promise<RemoteStreamResponse & { url: URL }> {
	let current: string | URL = initialUrl;
	for (let redirect = 0; redirect <= options.maxRedirects; redirect += 1) {
		const validated = await assertAllowedRemoteUrl(current, options);
		const request = options.request ?? currentRemoteMediaTransport()?.request ?? requestRemoteHttps;
		const response = await request(validated, options);
		if (response.status >= 300 && response.status < 400) {
			response.stream.destroy();
			const location = response.headers.location;
			if (!location || redirect === options.maxRedirects) {
				throw new RemoteMediaPolicyError(
					"OUTPUT_REMOTE_REDIRECT_POLICY_REJECTED",
					location ? "Remote redirect limit exceeded" : "Remote redirect omitted Location",
				);
			}
			try {
				current = new URL(location, validated.url);
			} catch {
				throw new RemoteMediaPolicyError(
					"OUTPUT_REMOTE_REDIRECT_POLICY_REJECTED",
					"Remote redirect Location is invalid",
				);
			}
			continue;
		}
		if (response.status < 200 || response.status >= 300) {
			response.stream.destroy();
			throw new Error(`Remote media request failed with status ${response.status}`);
		}
		return { ...response, url: validated.url };
	}
	throw new RemoteMediaPolicyError(
		"OUTPUT_REMOTE_REDIRECT_POLICY_REJECTED",
		"Remote redirect limit exceeded",
	);
}

async function detectMediaTypeFromIterator(
	iterator: AsyncIterator<unknown>,
	expectedKind: MediaKind,
	prefetched: Buffer[],
): Promise<MediaContentType> {
	const headerChunks: Buffer[] = [];
	let headerBytes = 0;
	for (;;) {
		const { value, done } = await iterator.next();
		if (done) break;
		const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
		if (!chunk.byteLength) continue;
		prefetched.push(chunk);
		if (headerBytes < 64) {
			const slice = chunk.subarray(0, 64 - headerBytes);
			headerChunks.push(slice);
			headerBytes += slice.byteLength;
		}
		try {
			const contentType = assertDetectedMediaType(Buffer.concat(headerChunks));
			assertMediaKind(contentType, expectedKind);
			return contentType;
		} catch (error) {
			if (
				headerBytes >= 64 ||
				!(error instanceof MediaValidationError) ||
				error.code !== "OUTPUT_MEDIA_TYPE_UNSUPPORTED"
			)
				throw error;
		}
	}
	const contentType = assertDetectedMediaType(Buffer.concat(headerChunks));
	assertMediaKind(contentType, expectedKind);
	return contentType;
}

function replayInspectedStream(
	source: Readable,
	iterator: AsyncIterator<unknown>,
	prefetched: Buffer[],
): Readable {
	let reading = false;
	return new Readable({
		objectMode: false,
		read() {
			if (reading) return;
			reading = true;
			const next = async () => {
				const prefix = prefetched.shift();
				return prefix ? { done: false, value: prefix } : iterator.next();
			};
			void next().then(
				({ done, value }) => {
					reading = false;
					if (!this.destroyed) this.push(done ? null : value);
				},
				(error: Error) => {
					reading = false;
					this.destroy(error);
				},
			);
		},
		destroy(error, callback) {
			// Cancel upstream before waiting for a pending iterator.next(). A close
			// listener alone would deadlock when the supplier stalls mid-download.
			source.destroy(error ?? undefined);
			prefetched.length = 0;
			Promise.resolve(iterator.return?.()).then(
				() => callback(error),
				() => callback(error),
			);
		},
	});
}
