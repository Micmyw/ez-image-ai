import { createHash } from "node:crypto";
import * as https from "node:https";
import type { Readable } from "node:stream";

import type { MediaContentType } from "../types";
import {
	assertDetectedMediaType,
	assertMediaKind,
	MediaValidationError,
	type MediaKind,
} from "./media-signatures";
import type { RemoteUrlPolicyOptions, ValidatedRemoteUrl } from "./remote-url-policy";
import { assertAllowedRemoteUrl, RemoteMediaPolicyError } from "./remote-url-policy";

export interface MultipartStreamTarget {
	maxBytes: number;
	partSize: number;
	uploadPart(input: { partNumber: number; body: Buffer }): Promise<string>;
	complete(parts: Array<{ partNumber: number; etag: string }>): Promise<void>;
	abort(): Promise<void>;
	validateHeader?(header: Buffer): void;
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
	const headerChunks: Buffer[] = [];
	let headerBytes = 0;
	let isHeaderValidated = false;
	let pendingChunks: Buffer[] = [];
	let pendingIndex = 0;
	let pendingBytes = 0;
	let bytes = 0;
	try {
		for await (const value of source) {
			const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
			bytes += chunk.byteLength;
			if (bytes > target.maxBytes) {
				throw new MediaValidationError(
					"OUTPUT_MEDIA_SIZE_EXCEEDED",
					"Remote media byte limit exceeded",
				);
			}
			hash.update(chunk);
			if (headerBytes < 64) {
				const slice = chunk.subarray(0, 64 - headerBytes);
				headerChunks.push(slice);
				headerBytes += slice.byteLength;
			}
			pendingChunks.push(chunk);
			pendingBytes += chunk.byteLength;
			if (!isHeaderValidated && pendingBytes >= Math.min(target.partSize, 16)) {
				target.validateHeader?.(Buffer.concat(headerChunks));
				isHeaderValidated = true;
			}
			while (pendingBytes >= target.partSize) {
				const taken = takePendingBytes(pendingChunks, pendingIndex, pendingBytes, target.partSize);
				pendingChunks = taken.chunks;
				pendingIndex = taken.index;
				pendingBytes = taken.bytes;
				const partNumber = parts.length + 1;
				parts.push({
					partNumber,
					etag: await target.uploadPart({ partNumber, body: taken.body }),
				});
			}
		}
		if (bytes === 0) {
			throw new MediaValidationError(
				"OUTPUT_MEDIA_SIZE_EXCEEDED",
				"Remote media response was empty",
			);
		}
		if (!isHeaderValidated) target.validateHeader?.(Buffer.concat(headerChunks));
		if (pendingBytes > 0) {
			const taken = takePendingBytes(pendingChunks, pendingIndex, pendingBytes, pendingBytes);
			const partNumber = parts.length + 1;
			parts.push({
				partNumber,
				etag: await target.uploadPart({ partNumber, body: taken.body }),
			});
		}
		await target.complete(parts);
		return { bytes, sha256: hash.digest("hex"), header: Buffer.concat(headerChunks) };
	} catch (error) {
		try {
			await target.abort();
		} catch {
			/* preserve the transfer failure */
		}
		throw error;
	}
}

function takePendingBytes(
	chunks: Buffer[],
	startIndex: number,
	totalBytes: number,
	takeBytes: number,
): { body: Buffer; chunks: Buffer[]; index: number; bytes: number } {
	const partChunks: Buffer[] = [];
	let index = startIndex;
	let remaining = takeBytes;
	while (remaining > 0) {
		const chunk = chunks[index];
		if (!chunk) throw new Error("Multipart stream queue was shorter than expected");
		if (chunk.byteLength <= remaining) {
			partChunks.push(chunk);
			remaining -= chunk.byteLength;
			index += 1;
		} else {
			partChunks.push(chunk.subarray(0, remaining));
			chunks[index] = chunk.subarray(remaining);
			remaining = 0;
		}
	}
	if (index >= 1_024 && index * 2 >= chunks.length) {
		chunks = chunks.slice(index);
		index = 0;
	}
	return {
		body: partChunks.length === 1 ? partChunks[0]! : Buffer.concat(partChunks, takeBytes),
		chunks,
		index,
		bytes: totalBytes - takeBytes,
	};
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
 * claims a transfer lease; the later full transfer validates the same type
 * again to close the probe/transfer race.
 */
export async function inspectRemoteMedia(
	initialUrl: string,
	options: RemoteMediaRequestOptions & { expectedKind: MediaKind },
): Promise<{ contentType: MediaContentType }> {
	const response = await requestRemoteMediaStream(initialUrl, options);
	try {
		return { contentType: await detectMediaTypeFromStream(response.stream, options.expectedKind) };
	} finally {
		response.stream.destroy();
	}
}

export async function requestRemoteMediaStream(
	initialUrl: string,
	options: RemoteMediaRequestOptions,
): Promise<RemoteStreamResponse & { url: URL }> {
	let current: string | URL = initialUrl;
	for (let redirect = 0; redirect <= options.maxRedirects; redirect += 1) {
		const validated = await assertAllowedRemoteUrl(current, options);
		const response = await (options.request ?? requestPinnedHttps)(validated, options);
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

async function detectMediaTypeFromStream(
	stream: Readable,
	expectedKind: MediaKind,
): Promise<MediaContentType> {
	const headerChunks: Buffer[] = [];
	let headerBytes = 0;
	for await (const value of stream) {
		const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
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

function requestPinnedHttps(
	validated: ValidatedRemoteUrl,
	options?: RemoteMediaRequestOptions,
): Promise<RemoteStreamResponse> {
	return new Promise((resolve, reject) => {
		const controller = new AbortController();
		const totalTimer = setTimeout(() => controller.abort(), options?.totalTimeoutMs ?? 600_000);
		const request = https.request(
			validated.url,
			{
				method: "GET",
				lookup: validated.lookup,
				signal: controller.signal,
				timeout: options?.connectTimeoutMs ?? 5_000,
				headers: { Accept: "image/*,video/*" },
			},
			(response) => {
				const firstByteTimer = setTimeout(
					() => response.destroy(new Error("Remote media first-byte timeout")),
					options?.firstByteTimeoutMs ?? 10_000,
				);
				response.once("data", () => clearTimeout(firstByteTimer));
				response.once("end", () => {
					clearTimeout(firstByteTimer);
					clearTimeout(totalTimer);
				});
				response.once("close", () => clearTimeout(totalTimer));
				const headers: Record<string, string | undefined> = {};
				for (const [name, value] of Object.entries(response.headers)) {
					headers[name] = Array.isArray(value) ? value[0] : value;
				}
				resolve({ status: response.statusCode ?? 0, headers, stream: response });
			},
		);
		request.once("timeout", () => request.destroy(new Error("Remote media connection timeout")));
		request.once("error", (error) => {
			clearTimeout(totalTimer);
			reject(error);
		});
		request.end();
	});
}
