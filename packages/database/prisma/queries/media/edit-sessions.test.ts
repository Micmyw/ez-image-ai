import { describe, expect, it, vi } from "vitest";

import { findEligibleImageEditParentForOwner } from "./edit-sessions";

describe("image edit source formats", () => {
	it.each(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"])(
		"only reuses supported raster outputs (%s)",
		async (mimeType) => {
			const client = {
				generationJob: {
					findFirst: vi.fn(async () => ({
						editSessionId: "session_1",
						productKey: "image-gpt-image-2-6-flare",
						inputSnapshot: { kind: "image-to-image", prompt: "edit the landscape" },
						assets: [
							{
								asset: {
									ownerType: "USER",
									ownerId: "owner_1",
									status: "READY",
									deletedAt: null,
									mimeType,
									moderationResults: [{ status: "APPROVED" }],
								},
							},
						],
					})),
				},
			};
			const result = await findEligibleImageEditParentForOwner(
				{
					ownerType: "USER",
					ownerId: "owner_1",
					parentJobId: "job_1",
					sourceAssetId: "asset_1",
				},
				client as never,
			);
			if (["image/gif", "image/svg+xml"].includes(mimeType)) expect(result).toBeNull();
			else expect(result).toMatchObject({ editSessionId: "session_1", sourceAssetId: "asset_1" });
		},
	);
});
