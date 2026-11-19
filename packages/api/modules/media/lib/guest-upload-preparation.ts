import type { GenerationJourneyRefs } from "@repo/config/generation-journey";
import { loadGuestUploadCompletion, recordGrowthEvent } from "@repo/database";
import { db } from "@repo/database/client";
import { logger } from "@repo/logs";
import { headObject } from "@repo/storage";
import { persistGenerationJourneyConfirmation } from "@repo/utils/lib/generation-journey-server";
import type { RequestDefer } from "@repo/utils/request-lifecycle";

import { completeOwnedUploadSession } from "../procedures/complete-upload-session";
import { resolveGuestPublicOrigin } from "./draft-security";
import {
	assertGuestCapabilityVersion,
	hashGuestAbuseBinding,
	hashGuestSecret,
	loadGuestCapability,
	requireGuestAbuseHmac,
} from "./guest-capability";

export interface GuestUploadPreparationInput {
	sessionId: string;
	completionToken: string;
	capabilityVersion: string;
	sha256: string;
}

/** Reuses the upload's immutable identity. SEALED never asserts a review verdict. */
export async function prepareGuestUpload(
	input: GuestUploadPreparationInput,
	headers: Headers,
	loaded: Awaited<ReturnType<typeof loadGuestCapability>>,
): Promise<{ status: "SEALED"; assetId: string } | { status: "PENDING"; retryAfterMs: number }> {
	const publicOrigin = resolveGuestPublicOrigin(headers.get("origin"), {
		saasOrigin: process.env.NEXT_PUBLIC_SAAS_URL,
	});
	if (!loaded.config.enabled || !loaded.config.promotionPeriod) {
		throw new Error("GUEST_CAPABILITY_DISABLED");
	}
	const { secretKey, keyVersion } = requireGuestAbuseHmac(loaded.config);
	assertGuestCapabilityVersion(input.capabilityVersion, loaded.snapshot.version);
	const identity = {
		sessionId: input.sessionId,
		completionTokenHash: hashGuestSecret(input.completionToken),
		capabilityVersion: loaded.snapshot.version,
		originHash: hashGuestAbuseBinding(secretKey, keyVersion, "guest-origin", publicOrigin),
		expectedSha256: input.sha256,
	};
	const completion = await loadGuestUploadCompletion(identity, db);
	const sealed = { status: "SEALED" as const, assetId: completion.assetId };
	assertGuestCapabilityVersion(completion.capabilityVersion, loaded.snapshot.version);
	if (completion.status === "COMPLETED") return sealed;

	if (completion.status === "PENDING") {
		try {
			const metadata = await headObject({ bucket: "media", key: completion.stagingObjectKey });
			if (
				metadata.contentLength !== completion.expectedBytes ||
				metadata.contentType !== completion.contentType
			) {
				throw new Error("GUEST_UPLOAD_METADATA_MISMATCH");
			}
		} catch (error) {
			// Another request can finish and remove staging between the identity read and HEAD.
			// Only the same authorized completed session proves that sealing already succeeded.
			const current = await loadGuestUploadCompletion(identity, db);
			if (current.status === "COMPLETED") return sealed;
			throw error;
		}
	}
	try {
		await completeOwnedUploadSession(
			{ sessionId: input.sessionId, expectedSha256: completion.expectedSha256 },
			completion.ownerId,
		);
	} catch (error) {
		if (error instanceof Error && error.message === "Upload session finalization is in progress") {
			return { status: "PENDING", retryAfterMs: 500 };
		}
		// The next poll re-reads the authorized session and its finalization lease.
		const pending = guestUploadPendingAfterStartTimeout(error, "seal");
		if (pending) return pending;
		throw error;
	}
	return sealed;
}

export async function recordGuestUploadSealed(
	assetId: string,
	context: { headers: Headers; defer?: RequestDefer },
	refs?: GenerationJourneyRefs,
): Promise<void> {
	const confirmation = persistGenerationJourneyConfirmation(
		{ headers: context.headers, stage: "upload_sealed", entityKey: assetId, refs },
		{ save: recordGrowthEvent },
	);
	if (context.defer) {
		try {
			context.defer(confirmation);
			return;
		} catch {
			// Drain on this request if deferred work cannot be registered.
		}
	}
	await confirmation;
}

export function guestUploadPendingAfterStartTimeout(error: unknown, stage: "seal" | "claim") {
	// Prisma also uses P2028 after writes. The exact start-timeout message
	// establishes that the transaction callback was skipped.
	if (
		!(error instanceof Error) ||
		!("code" in error) ||
		error.code !== "P2028" ||
		error.message !== "Transaction API error: Unable to start a transaction in the given time."
	)
		return;
	logger.warn("media.guest_upload.transaction_start_timeout", { stage, code: "P2028" });
	return { status: "PENDING" as const, retryAfterMs: 500 };
}
