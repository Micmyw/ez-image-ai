import { randomBytes } from "node:crypto";

import { promptSchema } from "@repo/ai";
import {
	EZPIC_PRODUCT_KEYS,
	imageAspectRatioSchema,
	imageBackgroundSchema,
	imageOutputFormatSchema,
	imageSkuKeySchema,
	imageGifFrameCountSchema,
	imageGifFrameDurationMsSchema,
	parseImageSelection,
} from "@repo/config";
import { isGuestTrialModel } from "@repo/config/guest-trial";
import { finalizeGuestDraftFromReadyUploadTransaction } from "@repo/database";
import { db } from "@repo/database/client";
import { z } from "zod";

import { publicProcedure } from "../../../orpc/procedures";
import { currentMediaAssetVerificationBoundary } from "../lib/asset-authorization";
import { createDraftClaimToken, hashDraftClaimToken } from "../lib/draft-security";
import {
	assertGuestCapabilityVersion,
	assertGuestProductAvailable,
	hashGuestSecret,
	loadGuestCapability,
} from "../lib/guest-capability";
import { prepareGuestUpload } from "../lib/guest-upload-preparation";

export const completeGuestDraftUpload = publicProcedure
	.route({
		method: "POST",
		path: "/media/guest-drafts/upload-completions",
		tags: ["Media"],
		summary: "Complete and moderate a private guest draft upload",
		description: "Returns a one-use claim only after the immutable input asset is READY.",
	})
	.input(
		z
			.object({
				sessionId: z.string().min(1).max(128),
				completionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
				capabilityVersion: z.string().min(1).max(128),
				productKey: z.string().min(1).max(64),
				skuKey: imageSkuKeySchema,
				sha256: z.string().regex(/^[a-f0-9]{64}$/),
				prompt: promptSchema,
				aspectRatio: imageAspectRatioSchema.default("auto"),
				outputFormat: imageOutputFormatSchema.optional(),
				background: imageBackgroundSchema.optional(),
				frameCount: imageGifFrameCountSchema.optional(),
				frameDurationMs: imageGifFrameDurationMsSchema.optional(),
			})
			.strict(),
	)
	.output(
		z.discriminatedUnion("status", [
			z
				.object({
					status: z.literal("PENDING"),
					retryAfterMs: z.number().int().min(100).max(5_000),
				})
				.strict(),
			z
				.object({
					status: z.literal("FAILED"),
					code: z.enum([
						"GUEST_UPLOAD_CONTENT_REJECTED",
						"GUEST_UPLOAD_REVIEW_REQUIRED",
						"GUEST_UPLOAD_SAFETY_UNAVAILABLE",
					]),
				})
				.strict(),
			z
				.object({
					status: z.literal("READY"),
					claimToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
					continueUrl: z.literal("/draft/continue"),
					productKey: z.enum(EZPIC_PRODUCT_KEYS),
					skuKey: imageSkuKeySchema,
					accessHint: z.enum(["guest-trial", "paid-account"]),
				})
				.strict(),
		]),
	)
	.handler(async ({ context, input }) => {
		context.responseHeaders?.set("Cache-Control", "no-store");
		const loaded = await loadGuestCapability();
		if (!loaded.config.enabled || !loaded.config.promotionPeriod) {
			throw new Error("GUEST_CAPABILITY_DISABLED");
		}
		assertGuestCapabilityVersion(input.capabilityVersion, loaded.snapshot.version);
		const product = assertGuestProductAvailable(loaded.snapshot, input.productKey);
		const selection = parseImageSelection(product.key, input);
		const sku = selection
			? product.skuMatrix.cells.find((cell) => cell.skuKey === selection.skuKey)
			: undefined;
		if (
			!selection ||
			!sku ||
			!sku.aspectRatios.includes(selection.aspectRatio) ||
			!runtimeControlAvailable(sku.controls, "outputFormat", selection.outputFormat) ||
			!runtimeControlAvailable(sku.controls, "background", selection.background)
		) {
			throw new Error("GUEST_PRODUCT_UNAVAILABLE");
		}
		const completionTokenHash = hashGuestSecret(input.completionToken);
		const preparation = await prepareGuestUpload(input, context.headers, loaded, context.defer);
		if (preparation.status === "PENDING") return preparation;

		const claimToken = createDraftClaimToken();
		try {
			await finalizeGuestDraftFromReadyUploadTransaction(
				{
					sessionId: input.sessionId,
					completionTokenHash,
					consumedTokenHash: hashGuestSecret(
						`consumed:${input.sessionId}:${randomBytes(32).toString("base64url")}`,
					),
					claimTokenHash: hashDraftClaimToken(claimToken),
					capabilityVersion: loaded.snapshot.version,
					promotionPeriod: loaded.config.promotionPeriod,
					maximumOutstandingBootstraps: loaded.config.limits.maximumOutstandingBootstraps,
					productKey: product.key,
					skuKey: selection.skuKey,
					prompt: input.prompt,
					aspectRatio: selection.aspectRatio,
					...(selection.outputFormat === undefined ? {} : { outputFormat: selection.outputFormat }),
					...(selection.background === undefined ? {} : { background: selection.background }),
					...(selection.frameCount === undefined ? {} : { frameCount: selection.frameCount }),
					...(selection.frameDurationMs === undefined
						? {}
						: { frameDurationMs: selection.frameDurationMs }),
					expiresAt: new Date(Date.now() + loaded.config.bootstrapTtlMs),
					verification: currentMediaAssetVerificationBoundary(),
				},
				db,
			);
		} catch (error) {
			if (
				error instanceof Error &&
				[
					"GUEST_UPLOAD_CONTENT_REJECTED",
					"GUEST_UPLOAD_REVIEW_REQUIRED",
					"GUEST_UPLOAD_SAFETY_UNAVAILABLE",
				].includes(error.message)
			) {
				return {
					status: "FAILED" as const,
					code: error.message as
						| "GUEST_UPLOAD_CONTENT_REJECTED"
						| "GUEST_UPLOAD_REVIEW_REQUIRED"
						| "GUEST_UPLOAD_SAFETY_UNAVAILABLE",
				};
			}
			if (error instanceof Error && error.message === "GUEST_UPLOAD_NOT_READY") {
				return { status: "PENDING" as const, retryAfterMs: 500 };
			}
			if (error instanceof Error && error.message === "GUEST_OUTSTANDING_BOOTSTRAP_CAP_EXCEEDED") {
				throw new Error("GUEST_CAPACITY_UNAVAILABLE");
			}
			throw error;
		}
		return {
			status: "READY" as const,
			claimToken,
			continueUrl: "/draft/continue" as const,
			productKey: product.key,
			skuKey: selection.skuKey,
			accessHint: isGuestTrialModel(product.key, selection.skuKey)
				? ("guest-trial" as const)
				: ("paid-account" as const),
		};
	});

function runtimeControlAvailable(
	controls: ReadonlyArray<{ key: string; options: ReadonlyArray<{ key: string }> }>,
	key: "outputFormat" | "background",
	value: string | undefined,
): boolean {
	return (
		value === undefined ||
		Boolean(
			controls
				.find((control) => control.key === key)
				?.options.some((option) => option.key === value),
		)
	);
}
