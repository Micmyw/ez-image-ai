import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import type { MediaContentType } from "../types";
import { assertDetectedMediaType, IMAGE_MAX_BYTES, MediaValidationError } from "./media-signatures";

// Capture native fetch before application wrappers; the target is a server-only
// signed storage URL, never a provider-controlled destination.
const storageFetch = globalThis.fetch.bind(globalThis);
const WRITE_CHUNK_BYTES = 64 * 1024;
export const MAX_STREAMING_GENERATION_IMAGE_BYTES = IMAGE_MAX_BYTES;

export function canStreamImmutableGenerationImage(input: {
	contentType: string;
	contentLength: string | number | undefined;
}): boolean {
	if (!["image/jpeg", "image/png", "image/webp"].includes(input.contentType)) return false;
	if (typeof input.contentLength === "string" && !/^\d+$/.test(input.contentLength)) return false;
	const bytes = Number(input.contentLength);
	return Number.isSafeInteger(bytes) && bytes > 0 && bytes <= MAX_STREAMING_GENERATION_IMAGE_BYTES;
}

/** A single conditional write with no complete-image buffer. Keep the final byte
 * until EOF and validation, so a truncated/oversized stream cannot commit a
 * valid-length prefix which a later recovery would mistake for the full object.
 */
export async function writeValidatedPrivateImageStream(input: {
	url: string;
	source: Readable;
	contentLength: number;
	contentType: MediaContentType;
	timeoutMs: number;
}): Promise<{ bytes: number; sha256: string; etag: string | null; versionId: string | null }> {
	const length = input.contentLength;
	if (!canStreamImmutableGenerationImage(input))
		throw new MediaValidationError(
			"OUTPUT_MEDIA_SIZE_EXCEEDED",
			"Streaming image length is invalid",
		);
	const fixed = (
		globalThis as typeof globalThis & {
			FixedLengthStream?: new (length: number) => {
				readable: ReadableStream<Uint8Array>;
				writable: WritableStream<Uint8Array>;
			};
		}
	).FixedLengthStream;
	const body = fixed ? new fixed(length) : new TransformStream<Uint8Array, Uint8Array>();
	const writer = body.writable.getWriter();
	const controller = new AbortController();
	let firstFailure: unknown;
	let failed = false;
	const stop = (error: unknown) => {
		if (!failed) {
			failed = true;
			firstFailure = error;
		}
		controller.abort(error);
		input.source.destroy();
		void body.readable.cancel(error).catch(() => undefined);
		void writer.abort(error).catch(() => undefined);
	};
	const timer = setTimeout(() => stop(new Error("Private object stream timeout")), input.timeoutMs);
	const hash = createHash("sha256");
	const header = Buffer.allocUnsafe(64);
	let headerBytes = 0;
	let bytes = 0;
	let tail: Buffer | undefined;
	let validated = false;
	const pump = async () => {
		try {
			for await (const value of input.source) {
				const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
				bytes += chunk.byteLength;
				if (bytes > length)
					throw new MediaValidationError(
						"OUTPUT_MEDIA_SIZE_EXCEEDED",
						"Remote media exceeds its declared length",
					);
				hash.update(chunk);
				if (headerBytes < header.length)
					headerBytes += chunk.copy(header, headerBytes, 0, header.length - headerBytes);
				if (!validated && headerBytes >= 16) {
					assertDetectedMediaType(header.subarray(0, headerBytes), input.contentType);
					validated = true;
				}
				const writableBytes = bytes === length && chunk.length ? chunk.length - 1 : chunk.length;
				if (writableBytes < chunk.length) tail = Buffer.from(chunk.subarray(writableBytes));
				for (let offset = 0; offset < writableBytes; offset += WRITE_CHUNK_BYTES)
					await writer.write(
						chunk.subarray(offset, Math.min(offset + WRITE_CHUNK_BYTES, writableBytes)),
					);
			}
			if (bytes !== length || !tail)
				throw new MediaValidationError(
					"OUTPUT_MEDIA_SIZE_EXCEEDED",
					"Remote media does not match its declared length",
				);
			if (!validated) assertDetectedMediaType(header.subarray(0, headerBytes), input.contentType);
			const sha256 = hash.digest("hex");
			await writer.write(tail);
			await writer.close();
			return { bytes, sha256 };
		} catch (error) {
			stop(error);
			throw error;
		}
	};
	try {
		const upload = storageFetch(input.url, {
			method: "PUT",
			redirect: "manual",
			headers: {
				"Content-Type": input.contentType,
				"Content-Length": String(length),
				"If-None-Match": "*",
			},
			body: body.readable,
			signal: controller.signal,
			duplex: "half",
		} as RequestInit & { duplex: "half" })
			.then(async (response) => {
				await response.body?.cancel();
				if (!response.ok)
					throw Object.assign(new Error("Private object conditional write failed"), {
						$metadata: { httpStatusCode: response.status },
					});
				return {
					etag: response.headers.get("etag"),
					versionId: response.headers.get("x-amz-version-id"),
				};
			})
			.catch((error: unknown) => {
				stop(error);
				throw error;
			});
		const transfer = pump();
		const [uploaded, transferred] = await Promise.allSettled([upload, transfer]);
		// A conditional conflict remains distinguishable even though cancelling its
		// source also rejects the pump. All other source validation failures survive.
		if (uploaded.status === "rejected" && isConditionalConflict(uploaded.reason))
			throw uploaded.reason;
		if (failed) throw firstFailure;
		if (transferred.status === "rejected") throw transferred.reason;
		if (uploaded.status === "rejected") throw uploaded.reason;
		return { ...transferred.value, ...uploaded.value };
	} finally {
		clearTimeout(timer);
		input.source.destroy();
		writer.releaseLock();
	}
}

function isConditionalConflict(error: unknown): boolean {
	const status = (error as { $metadata?: { httpStatusCode?: unknown } } | undefined)?.$metadata
		?.httpStatusCode;
	return status === 409 || status === 412;
}
