import { createHash } from "node:crypto";

import { CLOUDFLARE_IMAGES_MAX_INPUT_BYTES } from "../image-processing/cloudflare-images";
import { getImageProcessor } from "../image-processing/context";
import { ImageProcessingError } from "../image-processing/types";
import { createSignedReadUrl, readPrivateMediaStream } from "../provider/s3";
import { detectMediaType } from "./media-signatures";

export interface ImageModerationSource {
	objectKey: string;
	checksum: string;
	storageEtag: string | null;
}

/** Prepare before the may-have-submitted fence; retrieval always uses its existing task ID. */
export async function preparePrivateImageModeration(input: ImageModerationSource): Promise<string> {
	if (!/^[a-f0-9]{64}$/i.test(input.checksum))
		throw new ImageProcessingError("IMAGE_MODERATION_SOURCE_INVALID");
	const processor = getImageProcessor();
	if (!processor.moderationJpeg)
		throw new ImageProcessingError("IMAGE_MODERATION_PROCESSOR_UNAVAILABLE");
	const stored = await readPrivateMediaStream({
		bucket: "media",
		key: input.objectKey,
		...(input.storageEtag ? { ifMatch: input.storageEtag } : {}),
	});
	let source: ReadableStream<Uint8Array> | undefined;
	let output: ReadableStream<Uint8Array> | undefined;
	try {
		if (
			stored.contentLength > 25 * 1024 * 1024 ||
			!["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"].includes(
				stored.contentType ?? "",
			) ||
			(input.storageEtag && stored.etag !== input.storageEtag)
		)
			throw new ImageProcessingError("IMAGE_MODERATION_SOURCE_INVALID");
		const sourceHash = createHash("sha256");
		let sourceBytes = 0;
		let sourceVerified = false;
		source = stored.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					sourceBytes += chunk.byteLength;
					if (sourceBytes > stored.contentLength)
						throw new ImageProcessingError("IMAGE_MODERATION_SOURCE_INVALID");
					sourceHash.update(chunk);
					controller.enqueue(chunk);
				},
				flush() {
					if (
						sourceBytes !== stored.contentLength ||
						sourceHash.digest("hex") !== input.checksum.toLowerCase()
					)
						throw new ImageProcessingError("IMAGE_MODERATION_SOURCE_INVALID");
					sourceVerified = true;
				},
			}),
		);
		let preparationSource = source;
		let preparationLength = stored.contentLength;
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
			stored.contentLength > CLOUDFLARE_IMAGES_MAX_INPUT_BYTES
				? await createSignedReadUrl({ bucket: "media", key: input.objectKey, expiresIn: 300 })
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
		return `data:image/jpeg;base64,${bytes.toString("base64")}`;
	} finally {
		if (output && !output.locked) await output.cancel().catch(() => undefined);
		if (source && !source.locked) await source.cancel().catch(() => undefined);
		if (!stored.body.locked) await stored.body.cancel().catch(() => undefined);
	}
}
