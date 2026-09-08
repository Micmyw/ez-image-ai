import { MEDIA_VERIFICATION_POLICY_VERSION, MEDIA_VERIFICATION_RULE_VERSION } from "@repo/ai";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/media-assets", () => ({
	getOwnedMediaAsset: vi.fn(),
	getOwnedMediaAssetReadState: vi.fn(),
	getOwnedMediaUploadSession: vi.fn(),
}));

import { getOwnedMediaAssetReadState } from "@repo/database/media-assets";

import { requireReadyOwnedMediaAsset } from "./asset-authorization";

describe("requireReadyOwnedMediaAsset", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	it("fails closed when the current moderation boundary does not authorize the asset", async () => {
		vi.stubEnv("MEDIA_SAFETY_ADAPTER", "sightengine");
		vi.mocked(getOwnedMediaAssetReadState).mockResolvedValue({
			asset: {
				id: "asset-1",
				ownerType: "USER",
				status: "READY",
				deletedAt: null,
			},
			readable: false,
		} as never);

		await expect(requireReadyOwnedMediaAsset("asset-1", "user-1")).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
		});
		expect(getOwnedMediaAssetReadState).toHaveBeenCalledWith(
			expect.objectContaining({
				assetId: "asset-1",
				ownerId: "user-1",
				verification: expect.objectContaining({
					provider: "sightengine",
					ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
					policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				}),
			}),
		);
	});
});
