import { createHash } from "node:crypto";

import { MEDIA_VERIFICATION_POLICY_VERSION } from "@repo/ai/media/moderation/types";
import { isApprovedImageResult, type ImageResultReceipt } from "@repo/config/image-result";
import type { PrismaClient } from "@repo/database/generated-client";
import { persistApprovedImageResult } from "@repo/database/media-approved-image-result";
import { readProviderCandidateBytes } from "@repo/storage/lib/provider-original-bytes";

import { providerCdnAllowlist } from "../provider-output-policy";

/** Called after publication, or on an explicit edit action. Never writes R2 or
 * submits moderation again. Archival/settlement retain their existing durable intents. */
export async function importImageResult(receipt: ImageResultReceipt, database: PrismaClient) {
	if (!isApprovedImageResult(receipt)) return false;
	const existing = await database.mediaAsset.findUnique({ where: { id: receipt.assetId } });
	if (existing?.status === "READY")
		return (
			existing.deletedAt === null &&
			existing.ownerId === receipt.context.ownerId &&
			existing.verificationProviderTaskId === receipt.submission.moderationTaskId
		);
	if (
		existing &&
		(existing.status !== "VERIFYING" || existing.deletedAt || existing.verificationGeneration > 1)
	)
		return false;
	const bytes = await readProviderCandidateBytes({
		url: receipt.completion.outputUrl,
		mimeType: receipt.mimeType,
		allowedHosts: providerCdnAllowlist(process.env),
		...(receipt.context.guest ? { watermark: true } : {}),
	});
	return persistApprovedImageResult(
		{
			receipt,
			bytes: bytes.length,
			checksum: createHash("sha256").update(bytes).digest("hex"),
			policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
		},
		database,
	);
}
