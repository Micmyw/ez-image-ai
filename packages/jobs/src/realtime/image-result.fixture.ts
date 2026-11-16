import {
	MEDIA_VERIFICATION_RULE_VERSION,
	MEDIA_VERIFICATION_POLICY_VERSION,
} from "@repo/ai/media/moderation/types";
import type { ImageResultReceipt } from "@repo/config/image-result";

import { imageResultAssetId } from "./image-result";

export function imageResultFixture(now = Date.now()): ImageResultReceipt {
	return {
		context: {
			version: 1,
			jobId: "job-1",
			ownerId: "user-1",
			attemptId: "attempt-1",
			providerModelId: "nano-banana-2-lite",
			format: "png",
			guest: false,
			expiresAt: now + 3_600_000,
		},
		completion: {
			version: 1,
			source: "kie-image-success-callback",
			authentication: "kie-hmac-sha256",
			providerTaskId: "remote-1",
			providerModelId: "nano-banana-2-lite",
			outputUrl: "https://tempfile.aiquickdraw.com/result.png",
			receivedAt: new Date(now).toISOString(),
		},
		assetId: imageResultAssetId("job-1", "attempt-1"),
		mimeType: "image/png",
		reviewInput: "provider-url",
		policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
		submission: {
			moderationTaskId: "review-1",
			status: "RUNNING",
			ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			idempotency: { key: "output-key", providerSupported: true, replayed: false },
		},
		decision: {
			decision: "ALLOW",
			reasonCode: "NO_POLICY_MATCH",
			ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			evidence: {
				requestId: "review-1",
				models: ["nsfw-filter-2"],
				operations: 1,
				scores: {},
				seeapi: { taskId: "review-1", flagged: false, nsfw: [], specialCare: [] },
			},
		},
		approvedAt: now,
		nextQueryAt: now,
	};
}
