import { randomBytes } from "node:crypto";

import { promptSchema } from "@repo/ai";
import {
	finalizeGuestDraftFromReadyUploadTransaction,
	loadGuestUploadCompletion,
} from "@repo/database";
import { db } from "@repo/database/client";
import { headObject } from "@repo/storage";
import { z } from "zod";

import { publicProcedure } from "../../../orpc/procedures";
import { currentMediaAssetVerificationBoundary } from "../lib/asset-authorization";
import {
	createDraftClaimToken,
	hashDraftClaimToken,
	resolveGuestPublicOrigin,
} from "../lib/draft-security";
import {
	assertGuestCapabilityVersion,
	assertGuestProductAvailable,
	hashGuestAbuseBinding,
	hashGuestSecret,
	loadGuestCapability,
	requireGuestAbuseHmac,
} from "../lib/guest-capability";
import { completeOwnedUploadSession } from "./complete-upload-session";

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
				sha256: z.string().regex(/^[a-f0-9]{64}$/),
				prompt: promptSchema,
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
					status: z.literal("READY"),
					claimToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
					continueUrl: z.literal("/draft/continue"),
					productKey: z.enum(["image-fast", "image-quality"]),
					accessHint: z.enum(["guest-trial", "paid-account"]),
				})
				.strict(),
		]),
	)
	.handler(async ({ context, input }) => {
		const publicOrigin = resolveGuestPublicOrigin(context.headers.get("origin"), {
			saasOrigin: process.env.NEXT_PUBLIC_SAAS_URL,
			marketingOrigin: process.env.NEXT_PUBLIC_MARKETING_URL,
		});
		const loaded = await loadGuestCapability();
		if (!loaded.config.enabled || !loaded.config.promotionPeriod) {
			throw new Error("GUEST_CAPABILITY_DISABLED");
		}
		const { secretKey: abuseSecret, keyVersion: abuseKeyVersion } = requireGuestAbuseHmac(
			loaded.config,
		);
		assertGuestCapabilityVersion(input.capabilityVersion, loaded.snapshot.version);
		const product = assertGuestProductAvailable(loaded.snapshot, input.productKey);
		const completionTokenHash = hashGuestSecret(input.completionToken);
		const completion = await loadGuestUploadCompletion(
			{
				sessionId: input.sessionId,
				completionTokenHash,
				capabilityVersion: loaded.snapshot.version,
				originHash: hashGuestAbuseBinding(
					abuseSecret,
					abuseKeyVersion,
					"guest-origin",
					publicOrigin,
				),
				expectedSha256: input.sha256,
			},
			db,
		);
		assertGuestCapabilityVersion(completion.capabilityVersion, loaded.snapshot.version);

		if (completion.status !== "COMPLETED") {
			const metadata = await headObject({ bucket: "media", key: completion.stagingObjectKey });
			if (
				metadata.contentLength !== completion.expectedBytes ||
				metadata.contentType !== completion.contentType
			) {
				throw new Error("GUEST_UPLOAD_METADATA_MISMATCH");
			}
			await completeOwnedUploadSession(
				{
					sessionId: input.sessionId,
					expectedSha256: completion.expectedSha256,
				},
				completion.ownerId,
			);
		}

		const claimToken = createDraftClaimToken();
		context.responseHeaders?.set("Cache-Control", "no-store");
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
					prompt: input.prompt,
					expiresAt: new Date(Date.now() + loaded.config.bootstrapTtlMs),
					verification: currentMediaAssetVerificationBoundary(),
				},
				db,
			);
		} catch (error) {
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
			accessHint: product.accessHint,
		};
	});
