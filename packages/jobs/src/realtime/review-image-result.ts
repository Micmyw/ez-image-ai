import { createHash } from "node:crypto";

import { createConfiguredImageSafetyAdapter } from "@repo/ai/media/moderation/configured";
import {
	MEDIA_VERIFICATION_RULE_VERSION,
	MEDIA_VERIFICATION_POLICY_VERSION,
	type MediaSafetyAdapter,
} from "@repo/ai/media/moderation/types";
import {
	isApprovedImageResult,
	isInvalidImageResultMedia,
	isTerminalImageResult,
	type ImageResultContext,
	type ImageResultReceipt,
} from "@repo/config/image-result";
import { prepareProviderImageModeration } from "@repo/storage/lib/image-moderation-input";

import { providerCdnAllowlist } from "../provider-output-policy";
import { imageResultAssetId, writeImageResult } from "./image-result";

type Options = {
	environment?: NodeJS.ProcessEnv;
	safety?: MediaSafetyAdapter;
	prepare?: typeof prepareProviderImageModeration;
	write?: typeof writeImageResult;
	wait?: (ms: number) => Promise<void>;
	now?: () => number;
	forceThumbnail?: boolean;
	priorReview?: ImageResultReceipt["priorReview"];
};

export function resultMimeType(
	context: ImageResultContext,
	url: string,
): ImageResultReceipt["mimeType"] {
	const suffix = /\.(png|jpe?g|webp|gif|svg)$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
	const format = suffix === "jpg" ? "jpeg" : (suffix ?? context.format);
	return format === "svg" ? "image/svg+xml" : (`image/${format}` as ImageResultReceipt["mimeType"]);
}

/** First external operation for ordinary rasters is SeeAPI POST. No DB, hub read,
 * source GET/HEAD, byte digest or R2 operation is allowed before that submission. */
export async function submitImageResult(
	context: ImageResultContext,
	completion: ImageResultReceipt["completion"],
	options: Options = {},
): Promise<ImageResultReceipt> {
	const environment = options.environment ?? process.env;
	const now = options.now ?? Date.now;
	if (
		context.expiresAt <= now() ||
		context.providerModelId !== completion.providerModelId ||
		!providerCdnAllowlist(environment).includes(new URL(completion.outputUrl).hostname)
	)
		throw new Error("IMAGE_RESULT_CONTEXT_INVALID");
	const safety = options.safety ?? createConfiguredImageSafetyAdapter(environment);
	if (!safety.submitImage) throw new Error("IMAGE_REVIEW_UNAVAILABLE");
	const assetId = imageResultAssetId(context.jobId, context.attemptId);
	const mimeType = resultMimeType(context, completion.outputUrl);
	const prepared =
		!options.forceThumbnail && ["image/png", "image/jpeg"].includes(mimeType)
			? undefined
			: await (options.prepare ?? prepareProviderImageModeration)({
					url: completion.outputUrl,
					mimeType,
					allowedHosts: providerCdnAllowlist(environment),
					...(context.frameCount ? { expectedGifFrameCount: context.frameCount } : {}),
				});
	// SeeAPI owns the idempotency fence. Identical callback retries send the same body/key.
	// This is explicitly a request key, NOT an image checksum.
	const reviewInput = prepared ? ("thumbnail" as const) : ("provider-url" as const);
	const key = `output-url-${createHash("sha256")
		.update(
			JSON.stringify([assetId, completion.outputUrl, MEDIA_VERIFICATION_RULE_VERSION, reviewInput]),
		)
		.digest("hex")}`;
	const submission = await safety.submitImage({
		assetUrl: prepared?.assetUrl ?? completion.outputUrl,
		ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
		idempotencyKey: key,
	});
	if (submission.idempotency.key !== key || !submission.idempotency.providerSupported)
		throw new Error("IMAGE_REVIEW_IDEMPOTENCY_INVALID");
	const receipt: ImageResultReceipt = {
		context,
		completion,
		assetId,
		mimeType,
		submission,
		reviewInput,
		policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
		...(options.priorReview ? { priorReview: options.priorReview } : {}),
		nextQueryAt: now() + Math.max(2_000, submission.retryAfterMs ?? 0),
		...(prepared
			? { preparedIdentity: { checksum: prepared.checksum, bytes: prepared.bytes } }
			: {}),
		...(submission.completedDecision ? { decision: submission.completedDecision } : {}),
	};
	if (receipt.decision?.decision === "ALLOW") receipt.approvedAt = now();
	return (options.write ?? writeImageResult)(receipt);
}

/** Query-only recovery is shared by the short request and the durable image Workflow. */
export async function pollImageResult(
	receipt: ImageResultReceipt,
	options: Options & { maximumQueries?: number } = {},
): Promise<ImageResultReceipt> {
	const now = options.now ?? Date.now;
	const safety =
		options.safety ?? createConfiguredImageSafetyAdapter(options.environment ?? process.env);
	if (!safety.retrieveImage) throw new Error("IMAGE_REVIEW_UNAVAILABLE");
	const wait =
		options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	if (receipt.policyVersion !== MEDIA_VERIFICATION_POLICY_VERSION)
		throw new Error("IMAGE_REVIEW_POLICY_CHANGED");
	const deadline = now() + 15_000;
	const convert = (invalid: ImageResultReceipt) =>
		submitImageResult(invalid.context, invalid.completion, {
			...options,
			forceThumbnail: true,
			priorReview: {
				moderationTaskId: invalid.submission.moderationTaskId,
				idempotencyKey: invalid.submission.idempotency.key,
				decision: invalid.decision!,
			},
		});
	for (let query = 0; query < (options.maximumQueries ?? 15); query++) {
		if (isInvalidImageResultMedia(receipt)) {
			// Only an authenticated, terminal invalid-media result permits conversion.
			// Never retry content rejection or an uncertain/failed network submission.
			receipt = await convert(receipt);
		}
		if (isTerminalImageResult(receipt)) break;
		if (receipt.context.expiresAt <= now()) break;
		const delay = Math.max(0, receipt.nextQueryAt - now());
		if (now() + delay > deadline) break;
		if (delay) await wait(delay);
		if (receipt.context.expiresAt <= now()) break;
		const decision = await safety.retrieveImage({
			moderationTaskId: receipt.submission.moderationTaskId,
			ruleVersion: receipt.submission.ruleVersion,
			assetUrl: "",
		});
		receipt = {
			...receipt,
			decision,
			nextQueryAt: now() + Math.max(1_000, decision.retryAfterMs ?? 0),
		};
		if (decision.decision === "ALLOW") receipt.approvedAt = now();
		// Complete, authenticated ALLOW is the only publishing authority.
		if (decision.decision === "ALLOW" && !isApprovedImageResult(receipt, now()))
			throw new Error("IMAGE_REVIEW_INVALID_APPROVAL");
		receipt = await (options.write ?? writeImageResult)(receipt);
	}
	return isInvalidImageResultMedia(receipt) ? convert(receipt) : receipt;
}
