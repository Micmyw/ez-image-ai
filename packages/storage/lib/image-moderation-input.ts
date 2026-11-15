import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { imageSize } from "image-size";

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
import { moderationImageHeader } from "./moderation-image-header";
import { readProviderCandidateBytes } from "./provider-original-bytes";
import { openInspectedRemoteMedia, type OpenedRemoteMedia } from "./stream-copy";

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
	expectedGifFrameCount?: number;
	/** Only supplied for an archive receipt matching the already established source identity. */
	archiveKey?: string;
	/** Already policy-inspected source, owned by this same continuous delivery request. */
	source?: OpenedRemoteMedia;
}) {
	if (input.archiveKey && input.checksum) {
		try {
			const archived = await readArchivedMediaStream({ bucket: "media", key: input.archiveKey });
			if (archived.contentType !== input.mimeType) {
				await archived.body.cancel();
				throw new ImageProcessingError("IMAGE_MODERATION_SOURCE_INVALID");
			}
			return await prepareImageStreamModeration(
				archived,
				input.checksum,
				undefined,
				undefined,
				input.expectedGifFrameCount,
			);
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
			undefined,
			undefined,
			input.expectedGifFrameCount,
		);
	}
	const opened =
		input.source ??
		(await openInspectedRemoteMedia(input.url, {
			allowedHosts: input.allowedHosts,
			expectedKind: "image",
			maxRedirects: config.media.remoteMaxRedirects,
			connectTimeoutMs: config.media.remoteConnectTimeoutMs,
			firstByteTimeoutMs: config.media.remoteFirstByteTimeoutMs,
			totalTimeoutMs: config.media.remoteTotalTimeoutMs,
		}));
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
			undefined,
			undefined,
			input.expectedGifFrameCount,
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
	expectedGifFrameCount?: number,
) {
	const processor = getImageProcessor();
	if (!processor.moderationJpeg)
		throw new ImageProcessingError("IMAGE_MODERATION_PROCESSOR_UNAVAILABLE");
	let source: ReadableStream<Uint8Array> | undefined;
	let output: ReadableStream<Uint8Array> | undefined;
	let preparationSource: ReadableStream<Uint8Array> | undefined;
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
		preparationSource = source;
		let preparationLength = stored.contentLength ?? undefined;
		let targetSide = 1568;
		if (stored.contentType === "image/svg+xml" || stored.contentType === "image/gif") {
			// Identity-check the full original before rendering a static SVG or one
			// sampled animation contact sheet. Never pass active XML to the detector.
			const bytes = new Uint8Array(await new Response(source).arrayBuffer());
			const { gifReviewPng, svgReviewPng } =
				await import("../image-processing/generated-image-review");
			const png =
				stored.contentType === "image/gif"
					? gifReviewPng(bytes, expectedGifFrameCount)
					: await svgReviewPng(bytes);
			preparationSource = new Blob([png as Uint8Array<ArrayBuffer>]).stream();
			preparationLength = png.byteLength;
		} else {
			const header = await moderationImageHeader(source);
			preparationSource = header.source;
			targetSide = header.side;
		}
		const sourceUrl =
			processor.key === "cloudflare-images" &&
			stored.contentType !== "image/svg+xml" &&
			stored.contentType !== "image/gif" &&
			(stored.contentLength ?? 0) > CLOUDFLARE_IMAGES_MAX_INPUT_BYTES &&
			objectKey
				? await createSignedReadUrl({ bucket: "media", key: objectKey, expiresIn: 300 })
				: undefined;
		output = await processor.moderationJpeg(preparationSource, {
			contentLength: preparationLength,
			sourceUrl,
			targetSide,
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
		// The JPEG is already in memory. Inspect its actual header locally instead
		// of uploading it to Images again just to read its dimensions.
		let dimensions;
		try {
			dimensions = imageSize(bytes);
		} catch {
			throw new ImageProcessingError("IMAGE_MODERATION_PREPARATION_FAILED");
		}
		if (
			dimensions.type !== "jpg" ||
			dimensions.width !== targetSide ||
			dimensions.height !== targetSide
		)
			throw new ImageProcessingError("IMAGE_MODERATION_PREPARATION_FAILED");
		return {
			assetUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
			checksum,
			bytes: sourceBytes,
		};
	} finally {
		if (output && !output.locked) await output.cancel().catch(() => undefined);
		if (preparationSource && !preparationSource.locked)
			await preparationSource.cancel().catch(() => undefined);
		if (source && !source.locked) await source.cancel().catch(() => undefined);
		if (!stored.body.locked) await stored.body.cancel().catch(() => undefined);
	}
}
