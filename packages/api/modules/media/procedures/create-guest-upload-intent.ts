import { randomBytes, randomUUID } from "node:crypto";

import { createGuestMediaUploadIntentTransaction } from "@repo/database";
import { db } from "@repo/database/client";
import {
	createFinalAssetObjectKey,
	createSignedUpload,
	createStagingObjectKey,
} from "@repo/storage";
import { z } from "zod";

import { publicProcedure } from "../../../orpc/procedures";
import { trustedGuestClientIdentity } from "../lib/draft-client-identity";
import { assertMarketingOrigin } from "../lib/draft-security";
import {
	assertGuestCapabilityVersion,
	hashGuestAbuseBinding,
	hashGuestSecret,
	loadGuestCapability,
} from "../lib/guest-capability";
import {
	cloudflareTurnstileVerifier,
	databaseTurnstileTokenConsumer,
	verifyGuestTurnstileToken,
} from "../lib/turnstile";

const imageContentTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp"]);

export const createGuestDraftUploadIntent = publicProcedure
	.route({
		method: "POST",
		path: "/media/guest-drafts/upload-intents",
		tags: ["Media"],
		summary: "Create a private signed guest draft upload",
		description: "Allocates one bounded private staging upload after guest abuse checks.",
	})
	.input(
		z
			.object({
				capabilityVersion: z.string().min(1).max(128),
				contentType: imageContentTypeSchema,
				bytes: z
					.number()
					.int()
					.positive()
					.max(10 * 1024 * 1024),
				sha256: z.string().regex(/^[a-f0-9]{64}$/),
				turnstileToken: z.string().min(1).max(2_048),
			})
			.strict(),
	)
	.output(
		z
			.object({
				sessionId: z.string().min(1),
				assetId: z.string().min(1),
				uploadUrl: z.string().url(),
				completionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
				expiresAt: z.string().datetime(),
			})
			.strict(),
	)
	.handler(async ({ context, input }) => {
		const marketingOrigin = process.env.NEXT_PUBLIC_MARKETING_URL;
		const abuseSecret = process.env.GUEST_ABUSE_HMAC_SECRET;
		const abuseKeyVersion = process.env.GUEST_ABUSE_HMAC_VERSION;
		if (!marketingOrigin || !abuseSecret || !abuseKeyVersion) {
			throw new Error("GUEST_CONFIGURATION_ERROR");
		}
		assertMarketingOrigin(context.headers.get("origin"), marketingOrigin);
		const identity = trustedGuestClientIdentity(context.headers, process.env);
		if (!identity) throw new Error("GUEST_TRUSTED_CLIENT_REQUIRED");
		const loaded = await loadGuestCapability();
		if (!loaded.config.enabled || !loaded.config.promotionPeriod) {
			throw new Error("GUEST_CAPABILITY_DISABLED");
		}
		assertGuestCapabilityVersion(input.capabilityVersion, loaded.snapshot.version);
		if (
			input.bytes > loaded.config.maximumBytes ||
			!loaded.config.mimeTypes.includes(input.contentType)
		) {
			throw new Error("GUEST_UPLOAD_UNSUPPORTED");
		}

		const hostname = new URL(marketingOrigin).hostname;
		const now = new Date();
		const verify = loaded.config.turnstile.required
			? cloudflareTurnstileVerifier(requiredTurnstileSecret(loaded.config.turnstile.secretKey))
			: async () => ({
					success: true,
					hostname,
					action: "guest_upload",
					challengeTimestamp: now.toISOString(),
				});
		await verifyGuestTurnstileToken(
			{
				token: input.turnstileToken,
				action: "guest_upload",
				hostname,
				clientIp: identity.ip,
				now,
			},
			{ verify, consumeTokenHash: databaseTurnstileTokenConsumer },
		);

		const assetId = `asset_${randomUUID().replaceAll("-", "")}`;
		const sessionId = randomUUID();
		const ownerId = `guest_${randomUUID().replaceAll("-", "")}`;
		const completionToken = randomBytes(32).toString("base64url");
		const expiresAt = new Date(now.getTime() + 10 * 60_000);
		const deleteAfter = new Date(now.getTime() + loaded.config.retentionMs);
		const objectKey = createFinalAssetObjectKey(ownerId, assetId, randomUUID(), input.contentType);
		const stagingObjectKey = createStagingObjectKey(
			ownerId,
			sessionId,
			randomUUID(),
			input.contentType,
		);
		await createGuestMediaUploadIntentTransaction(
			{
				assetId,
				sessionId,
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				objectKey,
				stagingObjectKey,
				mimeType: input.contentType,
				expectedBytes: BigInt(input.bytes),
				completionTokenHash: hashGuestSecret(completionToken),
				expiresAt,
				multipartUploadId: null,
				limits: { maximumActiveSessions: 1, maximumReservedBytes: BigInt(10 * 1024 * 1024) },
				capabilityVersion: loaded.snapshot.version,
				promotionPeriod: loaded.config.promotionPeriod,
				originHash: hashGuestAbuseBinding(
					abuseSecret,
					abuseKeyVersion,
					"guest-origin",
					marketingOrigin,
				),
				expectedSha256: input.sha256,
				deleteAfter,
				ipHash: hashGuestAbuseBinding(abuseSecret, abuseKeyVersion, "guest-ip", identity.ip),
				subnetHash: hashGuestAbuseBinding(
					abuseSecret,
					abuseKeyVersion,
					"guest-subnet",
					identity.subnet,
				),
				abuseLimits: loaded.config.limits,
				abuseEvidenceTtlMs: loaded.config.abuseEvidenceTtlMs,
			},
			db,
		);
		const uploadUrl = await createSignedUpload({
			bucket: "media",
			key: stagingObjectKey,
			contentType: input.contentType,
			contentLength: input.bytes,
		});
		context.responseHeaders?.set("Cache-Control", "no-store");
		return { sessionId, assetId, uploadUrl, completionToken, expiresAt: expiresAt.toISOString() };
	});

function requiredTurnstileSecret(value: string | null): string {
	if (!value) throw new Error("GUEST_CONFIGURATION_ERROR");
	return value;
}
