import { describe, expect, it, vi } from "vitest";

import { createGuestDraftUploadIntent, getGuestCapability } from "./guest-draft-client";

describe("same-origin landing guest client", () => {
	it("loads public capability from the SaaS origin", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({
				version: "capability-v1",
				enabled: true,
				reason: null,
				upload: {
					mimeTypes: ["image/jpeg", "image/png", "image/webp"],
					maximumBytes: 10 * 1024 * 1024,
				},
				product: { key: "image-fast", label: "Standard Edit", credits: "4" },
				queueEstimate: { kind: "capacity" },
			}),
		);

		const result = await getGuestCapability(fetcher as typeof fetch);

		expect(result.enabled).toBe(true);
		expect(fetcher).toHaveBeenCalledWith(
			"/api/media/guest-capability",
			expect.objectContaining({ credentials: "same-origin" }),
		);
	});

	it("creates private upload intents without a second application origin", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({
				sessionId: "session-1",
				assetId: "asset-1",
				uploadUrl: "https://storage.example.com/private-upload",
				completionToken: "c".repeat(43),
				expiresAt: "2026-09-01T00:00:00.000Z",
			}),
		);

		await createGuestDraftUploadIntent(
			{
				capabilityVersion: "capability-v1",
				contentType: "image/png",
				bytes: 128,
				sha256: "a".repeat(64),
				turnstileToken: "local-token",
			},
			fetcher as typeof fetch,
		);

		expect(fetcher).toHaveBeenCalledWith(
			"/api/media/guest-drafts/upload-intents",
			expect.objectContaining({ credentials: "same-origin", method: "POST" }),
		);
	});
});
