import { createHash, randomUUID } from "node:crypto";

import { promptSchema } from "@repo/ai";
import { createGenerationDraftTransaction } from "@repo/database";
import { db } from "@repo/database/client";
import { createAssetObjectKey, deleteObject, putPrivateMediaObject } from "@repo/storage";
import { z } from "zod";

import { publicProcedure } from "../../../orpc/procedures";
import { draftClientIdentity } from "../lib/draft-client-identity";
import {
	assertMarketingOrigin,
	createDraftClaimToken,
	hashDraftClaimToken,
} from "../lib/draft-security";

const draftUploadSchema = z
	.object({
		contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
		base64: z.string().min(1).max(35_000_000),
	})
	.strict();

export const marketingGenerationDraftInputSchema = z
	.object({
		productKey: z.enum(["image-fast", "image-quality"]),
		input: z
			.object({
				kind: z.literal("image-to-image"),
				prompt: promptSchema,
			})
			.strict(),
		upload: draftUploadSchema,
	})
	.strict();

export const createGenerationDraft = publicProcedure
	.route({ method: "POST", path: "/media/drafts", tags: ["Media"] })
	.input(marketingGenerationDraftInputSchema)
	.handler(async ({ context, input }) => {
		const marketingOrigin = process.env.NEXT_PUBLIC_MARKETING_URL;
		if (!marketingOrigin) throw new Error("FORBIDDEN_ORIGIN");
		assertMarketingOrigin(context.headers.get("origin"), marketingOrigin);
		const subjectHash = clientIpHash(context.headers, process.env);
		await enforceDraftRateLimit(subjectHash, "marketing-draft");

		const token = createDraftClaimToken();
		const assetId = `asset_${randomUUID().replaceAll("-", "")}`;
		const objectKey = createAssetObjectKey(
			`draft_${randomUUID().replaceAll("-", "")}`,
			assetId,
			input.upload.contentType,
		);
		const uploaded = await putPrivateMediaObject({
			bucket: "media",
			key: objectKey,
			contentType: input.upload.contentType,
			body: Buffer.from(input.upload.base64, "base64"),
		});
		const expiresAt = new Date(Date.now() + 60 * 60_000);
		const uploadedAt = new Date();
		let draft;
		try {
			draft = await createGenerationDraftTransaction(
				{
					claimTokenHash: hashDraftClaimToken(token),
					productKey: input.productKey,
					input: input.input,
					expiresAt,
					abuseLimits: {
						subjectHash,
						maximumActiveDrafts: configuredPositiveInteger(
							process.env.MEDIA_MAX_ACTIVE_ANONYMOUS_DRAFTS,
							3,
						),
						maximumActiveBytes: BigInt(
							configuredPositiveInteger(
								process.env.MEDIA_MAX_ANONYMOUS_DRAFT_BYTES,
								25 * 1024 * 1024,
							),
						),
						maximumGlobalDraftsPerMinute: configuredPositiveInteger(
							process.env.MEDIA_MAX_GLOBAL_ANONYMOUS_DRAFTS_PER_MINUTE,
							100,
						),
					},
					asset: {
						id: assetId,
						objectKey,
						mimeType: input.upload.contentType,
						byteSize: BigInt(uploaded.bytes),
						checksum: uploaded.sha256,
						finalizedAt: uploadedAt,
					},
				},
				db,
			);
		} catch (error) {
			await deleteObject({ bucket: "media", key: objectKey }).catch(() => undefined);
			throw error;
		}
		context.responseHeaders?.set("Cache-Control", "no-store");
		return {
			draftId: draft.id,
			expiresAt: draft.expiresAt.toISOString(),
			continueUrl: "/draft/continue",
			claimToken: token,
		};
	});

function clientIpHash(headers: Headers, environment: NodeJS.ProcessEnv): string {
	const secret = process.env.BETTER_AUTH_SECRET;
	if (!secret) throw new Error("DRAFT_CONFIGURATION_ERROR");
	const ip = draftClientIdentity(headers, environment);
	return createHash("sha256").update(`${secret}:marketing-draft:${ip}`).digest("hex");
}

function configuredPositiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function enforceDraftRateLimit(subjectHash: string, action: string): Promise<void> {
	const now = new Date();
	const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
	const [result] = await db.$queryRaw<Array<{ allowed: boolean }>>`
		INSERT INTO "rate_limit_bucket" ("id", "action", "subjectHash", "windowStart", "windowEnd", "count", "updatedAt")
		VALUES (gen_random_uuid()::text, ${action}, ${subjectHash}, ${windowStart}, ${new Date(windowStart.getTime() + 60_000)}, 1, now())
		ON CONFLICT ("action", "subjectHash", "windowStart") DO UPDATE
		SET "count" = "rate_limit_bucket"."count" + 1, "updatedAt" = now()
		RETURNING ("count" <= 5) AS "allowed"`;
	if (!result?.allowed) throw new Error("RATE_LIMITED");
}
