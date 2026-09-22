import { createHash } from "node:crypto";

import { assertDetectedMediaType } from "./media-signatures";

const PART_BYTES = 5 * 1024 * 1024;
const SINGLE_PUT_MAX_BYTES = 10 * 1024 * 1024;
type Parts = Array<{ partNumber: number; etag: string }>;

export interface ImmutableReferenceTarget {
	put(body: Buffer, sha256: string): Promise<void>;
	createMultipart(): Promise<string>;
	uploadPart(uploadId: string, partNumber: number, body: Buffer): Promise<string>;
	complete(uploadId: string, parts: Parts): Promise<void>;
	abort(uploadId: string): Promise<void>;
}

/** Validate and hash once; buffer small images, stream larger ones in bounded parts. */
export async function writeImmutableReference(
	input: {
		body: ReadableStream<Uint8Array>;
		contentLength: number;
		contentType: "image/jpeg" | "image/png" | "image/webp";
	},
	target: ImmutableReferenceTarget,
): Promise<{ bytes: number; sha256: string }> {
	if (
		!Number.isSafeInteger(input.contentLength) ||
		input.contentLength <= 0 ||
		input.contentLength > 20 * 1024 * 1024
	)
		throw new Error("INPUT_TOO_LARGE");
	const reader = input.body.getReader();
	const hash = createHash("sha256");
	const multipart = input.contentLength > SINGLE_PUT_MAX_BYTES;
	let buffer = Buffer.allocUnsafe(multipart ? PART_BYTES : input.contentLength);
	let used = 0;
	let bytes = 0;
	let validated = false;
	let uploadId: string | undefined;
	const parts: Parts = [];
	const validate = () => {
		if (!validated) {
			assertDetectedMediaType(buffer.subarray(0, Math.min(used, 64)), input.contentType);
			validated = true;
		}
	};
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > input.contentLength) throw new Error("INPUT_TOO_LARGE");
			hash.update(value);
			let offset = 0;
			while (offset < value.byteLength) {
				const length = Math.min(buffer.length - used, value.byteLength - offset);
				buffer.set(value.subarray(offset, offset + length), used);
				used += length;
				offset += length;
				if (used >= 64) validate();
				if (multipart && used === PART_BYTES) {
					validate();
					uploadId ??= await target.createMultipart();
					const partNumber = parts.length + 1;
					parts.push({ partNumber, etag: await target.uploadPart(uploadId, partNumber, buffer) });
					buffer = Buffer.allocUnsafe(PART_BYTES);
					used = 0;
				}
			}
		}
		if (bytes !== input.contentLength) throw new Error("TEMPORARY_REFERENCE_INVALID");
		validate();
		const sha256 = hash.digest("hex");
		if (uploadId) {
			if (used) {
				const partNumber = parts.length + 1;
				parts.push({
					partNumber,
					etag: await target.uploadPart(uploadId, partNumber, buffer.subarray(0, used)),
				});
			}
			await target.complete(uploadId, parts);
		} else {
			await target.put(buffer.subarray(0, used), sha256);
		}
		return { bytes, sha256 };
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		if (uploadId) await target.abort(uploadId).catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
}
