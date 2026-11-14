import { createHash } from "node:crypto";

import { config } from "../config";
import { getImageProcessor } from "../image-processing/context";
import type { ImageContentType } from "../image-processing/types";
import { openInspectedRemoteMedia } from "./stream-copy";

/** No clean guest original is written to storage. The deterministic derivative is the asset. */
export async function readProviderCandidateBytes(input: {
	url: string;
	mimeType: string;
	allowedHosts: string[];
	watermark?: boolean;
}) {
	const source = await openInspectedRemoteMedia(input.url, {
		allowedHosts: input.allowedHosts,
		expectedKind: "image",
		maxRedirects: config.media.remoteMaxRedirects,
		connectTimeoutMs: config.media.remoteConnectTimeoutMs,
		firstByteTimeoutMs: config.media.remoteFirstByteTimeoutMs,
		totalTimeoutMs: 60_000,
	});
	try {
		if (source.contentType !== input.mimeType) throw new Error("ORIGINAL_IDENTITY_CHANGED");
		const chunks: Uint8Array[] = [];
		let size = 0;
		for await (const value of source.stream) {
			const chunk = Buffer.from(value);
			size += chunk.length;
			if (size > 25 * 1024 * 1024) throw new Error("ORIGINAL_SIZE_EXCEEDED");
			chunks.push(chunk);
		}
		if (!size) throw new Error("ORIGINAL_IDENTITY_INVALID");
		const declared = source.headers["content-length"];
		if (declared !== undefined && Number(declared) !== size)
			throw new Error("ORIGINAL_IDENTITY_CHANGED");
		const blob = new Blob(chunks as Uint8Array<ArrayBuffer>[]);
		if (!input.watermark) return new Uint8Array(await blob.arrayBuffer());
		if (!["image/png", "image/jpeg", "image/webp"].includes(input.mimeType))
			throw new Error("ORIGINAL_WATERMARK_FORMAT_INVALID");
		const processor = getImageProcessor();
		const dimensions = await processor.inspect(blob.stream(), input.mimeType as ImageContentType, {
			contentLength: size,
		});
		const output = await processor.watermark(blob.stream(), {
			...dimensions,
			contentType: input.mimeType as ImageContentType,
			contentLength: size,
		});
		let outputBytes = 0;
		return new Uint8Array(
			await new Response(
				output.pipeThrough(
					new TransformStream<Uint8Array, Uint8Array>({
						transform(chunk, controller) {
							outputBytes += chunk.length;
							if (outputBytes > 25 * 1024 * 1024) throw new Error("ORIGINAL_SIZE_EXCEEDED");
							controller.enqueue(chunk);
						},
					}),
				),
			).arrayBuffer(),
		);
	} finally {
		source.stream.destroy();
	}
}

/** No bytes become visible before matching the detector's complete source identity. */
export async function readProviderOriginalBytes(input: {
	url: string;
	checksum: string;
	bytes: number;
	mimeType: string;
	allowedHosts: string[];
	watermark?: boolean;
}) {
	if (
		!Number.isSafeInteger(input.bytes) ||
		input.bytes < 1 ||
		input.bytes > 25 * 1024 * 1024 ||
		!/^[a-f0-9]{64}$/i.test(input.checksum)
	)
		throw new Error("ORIGINAL_IDENTITY_INVALID");
	if (input.watermark) {
		const bytes = await readProviderCandidateBytes(input);
		if (
			bytes.length !== input.bytes ||
			createHash("sha256").update(bytes).digest("hex") !== input.checksum
		)
			throw new Error("ORIGINAL_IDENTITY_CHANGED");
		return bytes;
	}
	const source = await openInspectedRemoteMedia(input.url, {
		allowedHosts: input.allowedHosts,
		expectedKind: "image",
		maxRedirects: config.media.remoteMaxRedirects,
		connectTimeoutMs: config.media.remoteConnectTimeoutMs,
		firstByteTimeoutMs: config.media.remoteFirstByteTimeoutMs,
		totalTimeoutMs: 60_000,
	});
	try {
		if (source.contentType !== input.mimeType) throw new Error("ORIGINAL_IDENTITY_CHANGED");
		const body = new Uint8Array(input.bytes);
		const hash = createHash("sha256");
		let offset = 0;
		for await (const value of source.stream) {
			const chunk = Buffer.from(value);
			if (offset + chunk.length > input.bytes) throw new Error("ORIGINAL_IDENTITY_CHANGED");
			body.set(chunk, offset);
			offset += chunk.length;
			hash.update(chunk);
		}
		if (offset !== input.bytes || hash.digest("hex") !== input.checksum)
			throw new Error("ORIGINAL_IDENTITY_CHANGED");
		return body;
	} finally {
		source.stream.destroy();
	}
}
