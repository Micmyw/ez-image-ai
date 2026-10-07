import { VIDEO_MODEL_CATALOG_VERSION } from "@repo/config/video-models";
import { VIDEO_SUPPLIER_PRICE_VERSION } from "@repo/config/video-pricing.server";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database/media-assets", () => ({
	createMediaUploadSessionTransaction: vi.fn(async () => undefined),
}));
vi.mock("@repo/database/video-v1", () => ({
	createVideoJobRecord: vi.fn(),
	findExistingVideoAdmission: vi.fn(),
	getVideoJobRecord: vi.fn(),
	listVideoJobRecords: vi.fn(),
}));
vi.mock("@repo/database/video-v1-fulfillment", () => ({ authorizeVideoPlayback: vi.fn() }));
vi.mock("@repo/database/video-v1-uploads", () => ({
	getVideoUploadSession: vi.fn(),
	recordVideoInputIdentity: vi.fn(),
	releaseNormalizedSourceStorage: vi.fn(),
}));
vi.mock("@repo/jobs/video-v1/workflow-binding", () => ({
	getVideoWorkflowBinding: () => undefined,
	getVideoWorkflowReadinessBindings: () => ({
		workflow: true,
		r2: true,
		hyperdrive: true,
		uploadCors: true,
	}),
}));
vi.mock("@repo/storage", () => ({
	createFinalAssetObjectKey: () => "users/owner/final/reference.png",
	createStagingObjectKey: () => "users/owner/staging/reference.png",
	createSignedUpload: vi.fn(async () => "https://upload.example.test/private"),
	deleteObject: vi.fn(),
	inspectPrivateImage: vi.fn(),
	normalizeVideoReferenceToPng: vi.fn(),
}));
vi.mock("../media/procedures/complete-upload-session", () => ({
	completeOwnedUploadSession: vi.fn(),
}));
vi.mock("../media/lib/plan-entitlement", () => ({
	loadUserPlanEntitlement: vi.fn(async () => ({ maximumInputBytes: 8_000_000 })),
}));
vi.mock("../media/lib/rate-limit", () => ({ enforceMediaRateLimit: vi.fn() }));
vi.mock("../media/lib/storage-limits", () => ({
	mediaUploadLimits: () => ({ maximumActiveSessions: 5, maximumReservedBytes: 100_000_000n }),
}));

import { createMediaUploadSessionTransaction } from "@repo/database/media-assets";
import { createVideoJobRecord } from "@repo/database/video-v1";
import { createSignedUpload } from "@repo/storage";

import { enforceMediaRateLimit } from "../media/lib/rate-limit";
import { createVideoUpload } from "./uploads";

// Real model access, readiness and pricing; all database/storage boundaries are local mocks.
const environment = {
	VIDEO_V1_ENABLED: "true",
	MEDIA_GENERATION_ENABLED: "true",
	VIDEO_V1_ACCESS: "authenticated",
	KIE_API_KEY: "fixture-only",
	KIE_WEBHOOK_SECRET: "fixture-only",
	NEXT_PUBLIC_SAAS_URL: "https://video.example.test",
	VIDEO_V1_CALLBACK_BASE_URL: "https://video.example.test",
	VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
	VIDEO_V1_TEXT_SAFETY_ADAPTER: "waffo",
	VIDEO_V1_IMAGE_SAFETY_ADAPTER: "seeapi",
	VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
	VIDEO_COST_VISUAL_POLICY_VERSION: createVideoVisualSafetyProfile("seeapi", 5).policyVersion,
	VIDEO_COST_TEXT_RULE_VERSION: createVideoTextSafetyProfile().ruleVersion,
	SEEAPI_API_KEY: "fixture-only",
	SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({
		whkey_test: "whsec_local_test_signing_secret_20261004",
	}),
	VIDEO_SEEAPI_CALLBACK_SECRET: "local-video-seeapi-callback-secret-20261004",
	WAFFO_MERCHANT_ID: "fixture-only",
	WAFFO_PRIVATE_KEY: "fixture-only",
	VIDEO_V1_PROVIDER_CONCURRENCY: "5",
	VIDEO_V1_OUTPUT_ALLOWED_HOSTS: "cdn.example.test",
	VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
	VIDEO_PRICE_BASIS: "HYPOTHETICAL_TEST_ONLY_COSTS",
	VIDEO_PRICE_VALID_UNTIL: "none",
	VIDEO_COST_MODERATION_BASE_MICROS: "10000",
	VIDEO_COST_MODERATION_PER_SECOND_MICROS: "5000",
	VIDEO_COST_RUNTIME_MICROS: "5000",
	VIDEO_COST_STORAGE_MICROS: "5000",
	VIDEO_COST_PAYMENT_FIXED_MICROS: "2000",
	VIDEO_COST_PAYMENT_FEE_BPS: "500",
	VIDEO_COST_NONBILLABLE_FAILURE_BPS: "1000",
};
const input = { contentType: "image/png", byteSize: 100 };
beforeEach(() => {
	vi.clearAllMocks();
	for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());

describe("video upload model admission", () => {
	it.each([undefined, "", "[]", "not-json"])(
		"admits a priced official image upload regardless of stale model scope %s",
		async (scope) => {
			vi.stubEnv("VIDEO_MODEL_ALLOWED_OPTIONS", scope);
			await expect(createVideoUpload({ id: "owner" }, input)).resolves.toMatchObject({
				method: "PUT",
				uploadUrl: "https://upload.example.test/private",
			});
			expect(enforceMediaRateLimit).toHaveBeenCalledWith("owner", "video-v1:upload");
			expect(createMediaUploadSessionTransaction).toHaveBeenCalledWith(
				expect.objectContaining({
					ownerId: "owner",
					verificationEngine: "video-workflow-v1",
					expectedBytes: 100n,
					reservedBytes: 100n,
				}),
				expect.anything(),
			);
			expect(createVideoJobRecord).not.toHaveBeenCalled();
		},
	);
	it.each([undefined, "old-contract"])(
		"rejects an unconfirmed model contract %s",
		async (version) => {
			vi.stubEnv("VIDEO_MODEL_CONTRACT_VERSION", version);
			await expect(createVideoUpload({ id: "owner" }, input)).rejects.toThrow(
				"VIDEO_MODEL_CONTRACT_NOT_CONFIRMED",
			);
			expect(createMediaUploadSessionTransaction).not.toHaveBeenCalled();
			expect(createSignedUpload).not.toHaveBeenCalled();
		},
	);
	it.each([
		["VIDEO_V1_ENABLED", "false", "VIDEO_ACCESS_DENIED"],
		["SEEAPI_WEBHOOK_SIGNING_KEYS", "", "VIDEO_SEEAPI_CALLBACK_NOT_CONFIGURED"],
		["WAFFO_PRIVATE_KEY", "", "VIDEO_MODERATION_NOT_CONFIGURED"],
		["VIDEO_PRICE_VALID_UNTIL", "2000-01-01T00:00:00.000Z", "VIDEO_PRICE_EXPIRED"],
		["VIDEO_PRICE_ACCEPTED_VERSION", "old-price", "VIDEO_PRICE_NOT_APPROVED"],
	])("retains the %s admission check before storage reservation", async (key, value, error) => {
		vi.stubEnv(key, value);
		await expect(createVideoUpload({ id: "owner" }, input)).rejects.toThrow(error);
		expect(createMediaUploadSessionTransaction).not.toHaveBeenCalled();
	});
	it("admits a registered user in authenticated mode", async () => {
		await expect(createVideoUpload({ id: "registered-user" }, input)).resolves.toMatchObject({
			method: "PUT",
		});
		expect(createMediaUploadSessionTransaction).toHaveBeenCalledWith(
			expect.objectContaining({
				ownerId: "registered-user",
				verificationEngine: "video-workflow-v1",
			}),
			expect.anything(),
		);
	});
	it("rejects an anonymous session before reserving upload storage in authenticated mode", async () => {
		vi.stubEnv("VIDEO_V1_ACCESS", "authenticated");
		const anonymous = { id: "guest-session", isAnonymous: true };
		await expect(createVideoUpload(anonymous, input)).rejects.toThrow("VIDEO_ACCESS_DENIED");
		expect(createMediaUploadSessionTransaction).not.toHaveBeenCalled();
		expect(createSignedUpload).not.toHaveBeenCalled();
	});
	it("admits an image upload with explicitly unbounded approved pricing", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-12T00:00:00.000Z"));
		try {
			await expect(createVideoUpload({ id: "registered-user" }, input)).resolves.toMatchObject({
				method: "PUT",
			});
		} finally {
			vi.useRealTimers();
		}
	});
});
