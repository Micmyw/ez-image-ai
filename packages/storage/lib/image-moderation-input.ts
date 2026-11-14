import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { config } from "../config";
import { CLOUDFLARE_IMAGES_MAX_INPUT_BYTES } from "../image-processing/cloudflare-images";
import { getImageProcessor } from "../image-processing/context";
import { ImageProcessingError } from "../image-processing/types";
import {
	createSignedReadUrl,
	readPrivateMediaStream,
	readArchivedMediaStream,
} from "../provider/s3";
import { detectMediaType } from "./media-signatures";
import { readProviderCandidateBytes } from "./provider-original-bytes";
import { openInspectedRemoteMedia } from "./stream-copy";

export interface ImageModerationSource {
	objectKey: string;
	checksum: string;
	storageEtag: string | null;
}

export async function prepareProviderImageModeration(input: {
	url: string;
	mimeType: string;
	checksum?: string | null;
	allowedHosts: string[];
	watermark?: boolean;
	/** Only supplied for an archive receipt matching the already established source identity. */
	archiveKey?: string;
}) {
	if (input.archiveKey && input.checksum) {
		try {
			const archived = await readArchivedMediaStream({ bucket: "media", key: input.archiveKey });
			if (archived.contentType !== input.mimeType) {
				await archived.body.cancel();
				throw new ImageProcessingError("IMAGE_MODERATION_SOURCE_INVALID");
			}
			return await prepareImageStreamModeration(archived, input.checksum);
		} catch {
			/* Retry the same hash-bound provider image if the physical archive is unavailable. */
		}
	}
	if (input.watermark) {
		const bytes = await readProviderCandidateBytes(input);
		return prepareImageStreamModeration(
			{
				body: new Blob([bytes]).stream(),
				contentLength: bytes.length,
				contentType: input.mimeType,
				etag: null,
			},
			input.checksum,
		);
	}
	const opened = await openInspectedRemoteMedia(input.url, {
		allowedHosts: input.allowedHosts,
		expectedKind: "image",
		maxRedirects: config.media.remoteMaxRedirects,
		connectTimeoutMs: config.media.remoteConnectTimeoutMs,
		firstByteTimeoutMs: config.media.remoteFirstByteTimeoutMs,
		totalTimeoutMs: config.media.remoteTotalTimeoutMs,
	});
	try {
		if (opened.contentType !== input.mimeType)
			throw new ImageProcessingError("IMAGE_MODERATION_SOURCE_INVALID");
		const length = Number(opened.headers["content-length"]);
		return await prepareImageStreamModeration(
			{
				body: Readable.toWeb(opened.stream) as unknown as ReadableStream<Uint8Array>,
				contentLength: Number.isSafeInteger(length) && length > 0 ? length : null,
				contentType: opened.contentType,
				etag: null,
			},
			input.checksum,
		);
	} finally {
		opened.stream.destroy();
	}
}

/** Prepare before the may-have-submitted fence; retrieval always uses its existing task ID. */
export async function preparePrivateImageModeration(input: ImageModerationSource): Promise<string> {
	if (!/^[a-f0-9]{64}$/i.test(input.checksum))
		throw new ImageProcessingError("IMAGE_MODERATION_SOURCE_INVALID");
	const stored = await readPrivateMediaStream({
		bucket: "media",
		key: input.objectKey,
		...(input.storageEtag ? { ifMatch: input.storageEtag } : {}),
	});
	const result = await prepareImageStreamModeration(
		stored,
		input.checksum,
		input.storageEtag,
		input.objectKey,
	);
	return result.assetUrl;
}

async function prepareImageStreamModeration(
	stored: {
		body: ReadableStream<Uint8Array>;
		contentLength: number | null;
		contentType: string | null;
		etag: string | null;
	},
	expectedChecksum?: string | null,
	expectedEtag?: string | null,
	objectKey?: string,
) {
	const processor = getImageProcessor();
	if (!processor.moderationJpeg)
		throw new ImageProcessingError("IMAGE_MODERATION_PROCESSOR_UNAVAILABLE");
	let source: ReadableStream<Uint8Array> | undefined;
	let output: ReadableStream<Uint8Array> | undefined;
	try {
		if (
			(stored.contentLength ?? 0) > 25 * 1024 * 1024 ||
			!["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"].includes(
				stored.contentType ?? "",
			) ||
			(expectedEtag && stored.etag !== expectedEtag)
		)
			throw new ImageProcessingError("IMAGE_MODERATION_SOURCE_INVALID");
		const sourceHash = createHash("sha256");
		let sourceBytes = 0;
		let sourceVerified = false;
		let checksum = "";
		source = stored.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					sourceBytes += chunk.byteLength;
					if (sourceBytes > (stored.contentLength ?? 25 * 1024 * 1024))
						throw new ImageProcessingError("IMAGE_MODERATION_SOURCE_INVALID");
					sourceHash.update(chunk);
					controller.enqueue(chunk);
				},
				flush() {
					checksum = sourceHash.digest("hex");
					if (
						!sourceBytes ||
						(stored.contentLength !== null && sourceBytes !== stored.contentLength) ||
						(expectedChecksum && checksum !== expectedChecksum.toLowerCase())
					)
						throw new ImageProcessingError("IMAGE_MODERATION_SOURCE_INVALID");
					sourceVerified = true;
				},
			}),
		);
		let preparationSource = source;
		let preparationLength = stored.contentLength ?? undefined;
		if (stored.contentType === "image/svg+xml" || stored.contentType === "image/gif") {
			// The original is fully identity-checked before rendering. Never review only
			// the first frame of an animation, or pass active XML to an image service.
			const bytes = new Uint8Array(await new Response(source).arrayBuffer());
			const { gifReviewPng, svgReviewPng } =
				await import("../image-processing/generated-image-review");
			const png =
				stored.contentType === "image/gif" ? gifReviewPng(bytes) : await svgReviewPng(bytes);
			preparationSource = new Blob([png as Uint8Array<ArrayBuffer>]).stream();
			preparationLength = png.byteLength;
		}
		const sourceUrl =
			processor.key === "cloudflare-images" &&
			preparationSource === source &&
			(stored.contentLength ?? 0) > CLOUDFLARE_IMAGES_MAX_INPUT_BYTES &&
			objectKey
				? await createSignedReadUrl({ bucket: "media", key: objectKey, expiresIn: 300 })
				: undefined;
		output = await processor.moderationJpeg(preparationSource, {
			contentLength: preparationLength,
			sourceUrl,
		});
		let outputBytes = 0;
		const bounded = output.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					outputBytes += chunk.byteLength;
					if (outputBytes > 8 * 1024 * 1024)
						throw new ImageProcessingError("IMAGE_MODERATION_PREPARATION_FAILED");
					controller.enqueue(chunk);
				},
			}),
		);
		const bytes = Buffer.from(await new Response(bounded).arrayBuffer());
		if (!sourceVerified || !bytes.length || detectMediaType(bytes) !== "image/jpeg")
			throw new ImageProcessingError("IMAGE_MODERATION_PREPARATION_FAILED");
		// Verify the actual output, including a remote transform that could be unavailable.
		const dimensions = await processor.inspect(new Blob([bytes]).stream(), "image/jpeg", {
			contentLength: bytes.length,
		});
		if (dimensions.width !== 1568 || dimensions.height !== 1568)
			throw new ImageProcessingError("IMAGE_MODERATION_PREPARATION_FAILED");
		return {
			assetUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
			checksum,
			bytes: sourceBytes,
		};
	} finally {
		if (output && !output.locked) await output.cancel().catch(() => undefined);
		if (source && !source.locked) await source.cancel().catch(() => undefined);
		if (!stored.body.locked) await stored.body.cancel().catch(() => undefined);
	}
}
