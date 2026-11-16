import { createHmac, timingSafeEqual } from "node:crypto";

import { MEDIA_VERIFICATION_RULE_VERSION, MEDIA_VERIFICATION_POLICY_VERSION } from "@repo/ai";
import { isApprovedImageResult, type ImageResultReceipt } from "@repo/config/image-result";
import { db } from "@repo/database/client";
import { getImageResultAccess } from "@repo/database/media-image-result-access";
import { readImageResult } from "@repo/jobs/realtime/image-result";
import { importImageResult } from "@repo/jobs/realtime/import-image-result";

export function isCurrentImageResult(
	receipt: ImageResultReceipt,
	input: {
		ownerId: string;
		status: string;
		attemptId?: string;
		providerTaskId?: string | null;
		uncertainSubmission?: boolean;
		attemptStatus?: string;
		assetStatus?: string | null;
		deletedAt?: Date | null;
		deleteAfter?: Date | null;
		verificationGeneration?: number | null;
		promptRejected?: boolean;
	},
	now = Date.now(),
) {
	return (
		isApprovedImageResult(receipt, now) &&
		receipt.submission.ruleVersion === MEDIA_VERIFICATION_RULE_VERSION &&
		receipt.policyVersion === MEDIA_VERIFICATION_POLICY_VERSION &&
		receipt.context.ownerId === input.ownerId &&
		receipt.context.attemptId === input.attemptId &&
		receipt.completion.providerTaskId === input.providerTaskId &&
		!input.uncertainSubmission &&
		["PROVIDER_PENDING", "PROVIDER_RUNNING", "FINALIZING", "SUCCEEDED"].includes(input.status) &&
		!input.promptRejected &&
		!["SUBMISSION_UNCERTAIN", "NEEDS_RECONCILIATION", "FAILED"].includes(
			input.attemptStatus ?? "",
		) &&
		!input.deletedAt &&
		(!input.deleteAfter || input.deleteAfter.getTime() > now) &&
		!["DELETED", "QUARANTINED", "VERIFICATION_FAILED"].includes(input.assetStatus ?? "") &&
		(input.verificationGeneration ?? 0) <= 1
	);
}

export async function getAuthorizedImageResult(jobId: string, ownerId: string, assetId?: string) {
	const receipt = await readImageResult(jobId).catch(() => null);
	if (!receipt || (assetId && receipt.assetId !== assetId)) return null;
	return authorizeImageResult(receipt, ownerId);
}

export async function authorizeImageResult(receipt: ImageResultReceipt, ownerId: string) {
	const access = await getImageResultAccess(receipt.context.jobId, receipt.assetId, db, ownerId);
	return access &&
		isCurrentImageResult(receipt, access) &&
		(access.ownerId === ownerId || (receipt.context.guest && access.grantedUserId === ownerId)) &&
		(!receipt.context.guest ||
			(access.guestExpiresAt && access.guestExpiresAt.getTime() > Date.now()))
		? receipt
		: null;
}

/** Explicit edit action can materialize its approved input without waiting for
 * the background worker, R2 archival, credit settlement, or another SeeAPI call. */
export async function materializeImageResultForEdit(
	jobId: string,
	ownerId: string,
	assetId: string,
) {
	const receipt = await getAuthorizedImageResult(jobId, ownerId, assetId);
	return receipt ? importImageResult(receipt, db) : false;
}

function signature(value: string) {
	const secret = process.env.WORKFLOWS_DISPATCH_SECRET ?? "";
	if (secret.length < 32) throw new Error("IMAGE_RESULT_ACCESS_UNAVAILABLE");
	return createHmac("sha256", secret).update(`image-result-read:v1:${value}`).digest();
}

export function signImageResultReadUrl(
	receipt: ImageResultReceipt,
	disposition: "inline" | "attachment" = "inline",
	requesterId = receipt.context.ownerId,
) {
	const expires = Math.min(
		Date.now() + 300_000,
		receipt.context.expiresAt,
		(receipt.approvedAt ?? 0) + 86_400_000,
	);
	if (!isApprovedImageResult(receipt) || expires <= Date.now())
		throw new Error("IMAGE_RESULT_EXPIRED");
	const payload = Buffer.from(
		JSON.stringify({
			jobId: receipt.context.jobId,
			assetId: receipt.assetId,
			ownerId: requesterId,
			expires,
			disposition,
		}),
	).toString("base64url");
	const url = new URL("/api/media/original", process.env.NEXT_PUBLIC_SAAS_URL);
	url.searchParams.set("result", payload);
	url.searchParams.set("signature", signature(payload).toString("base64url"));
	return {
		assetId: receipt.assetId,
		url: url.toString(),
		expiresAt: new Date(expires).toISOString(),
		expiresIn: Math.max(1, Math.floor((expires - Date.now()) / 1_000)),
	};
}

export function verifyImageResultReadUrl(url: URL) {
	try {
		const value = url.searchParams.get("result") ?? "";
		const supplied = url.searchParams.get("signature") ?? "";
		if (!value || value.length > 2048 || !/^[\w-]{43}$/.test(supplied)) return null;
		if (!timingSafeEqual(Buffer.from(supplied, "base64url"), signature(value))) return null;
		const grant = JSON.parse(Buffer.from(value, "base64url").toString()) as {
			jobId: string;
			assetId: string;
			ownerId: string;
			expires: number;
			disposition: "inline" | "attachment";
		};
		return Number.isSafeInteger(grant.expires) &&
			grant.expires > Date.now() &&
			grant.expires <= Date.now() + 300_000 &&
			[grant.jobId, grant.assetId, grant.ownerId].every(
				(id) => typeof id === "string" && /^[\w-]{1,128}$/.test(id),
			) &&
			["inline", "attachment"].includes(grant.disposition)
			? grant
			: null;
	} catch {
		return null;
	}
}

export function imageResultDto(receipt: ImageResultReceipt) {
	return {
		id: receipt.assetId,
		kind: "OUTPUT",
		mimeType: receipt.mimeType,
		byteSize: receipt.preparedIdentity?.bytes.toString() ?? "0",
		width: null,
		height: null,
		durationMillis: null,
		createdAt: new Date(receipt.approvedAt!).toISOString(),
		contentVersion: `review:${receipt.submission.moderationTaskId}`,
		visibleUntil: new Date(receipt.context.expiresAt).toISOString(),
		preview: signImageResultReadUrl(receipt),
	};
}
