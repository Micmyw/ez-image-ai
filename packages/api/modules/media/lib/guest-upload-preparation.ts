import { loadGuestUploadCompletion, recordGrowthEvent } from "@repo/database";
import { db } from "@repo/database/client";
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
	journey?: { actionRef?: string; draftRef?: string };
}

/** Reuses the upload's immutable identity. SEALED never asserts a review verdict. */
export async function prepareGuestUpload(
	input: GuestUploadPreparationInput,
	headers: Headers,
	loaded: Awaited<ReturnType<typeof loadGuestCapability>>,
	defer?: RequestDefer,
): Promise<{ status: "SEALED" } | { status: "PENDING"; retryAfterMs: number }> {
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
	const sealed = async () => {
		const confirmation = persistGenerationJourneyConfirmation(
			{ headers, stage: "upload_sealed", entityKey: completion.assetId, refs: input.journey },
			{ save: recordGrowthEvent },
		);
		if (defer) {
			try {
				defer(confirmation);
			} catch {
				await confirmation;
			}
		} else await confirmation;
		return { status: "SEALED" as const };
	};
	assertGuestCapabilityVersion(completion.capabilityVersion, loaded.snapshot.version);
	if (completion.status === "COMPLETED") return sealed();

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
			if (current.status === "COMPLETED") return sealed();
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
		throw error;
	}
	return sealed();
}
