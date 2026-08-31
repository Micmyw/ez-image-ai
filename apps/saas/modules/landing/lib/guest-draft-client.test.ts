import { describe, expect, it, vi } from "vitest";

import {
	completeGuestDraftUpload,
	createGuestDraftUploadIntent,
	getGuestCapability,
} from "./guest-draft-client";

describe("same-origin landing guest client", () => {
	it("loads public capability from the SaaS origin", async () => {
		const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			Response.json({
				version: "capability-v1",
				enabled: true,
				reason: null,
				upload: {
					mimeTypes: ["image/jpeg", "image/png", "image/webp"],
					maximumBytes: 10 * 1024 * 1024,
				},
				products: [
					{
						key: "image-fast",
						label: "Standard Edit",
						description: "Everyday private edits",
						credits: "4",
						accessHint: "guest-trial",
					},
					{
						key: "image-quality",
						label: "Quality Edit",
						description: "Higher fidelity private edits",
						credits: "10",
						accessHint: "paid-account",
					},
				],
				queueEstimate: { kind: "capacity" },
			}),
		);

		const result = await getGuestCapability(fetcher as typeof fetch);

		expect(result.products.map((product) => product.key)).toEqual(["image-fast", "image-quality"]);
		expect(JSON.stringify(result)).not.toMatch(/provider|modelId|costMicros|weight/i);
		expect(fetcher).toHaveBeenCalledWith(
			"/api/media/guest-capability",
			expect.objectContaining({ credentials: "same-origin" }),
		);
	});

	it("creates private upload intents without a second application origin", async () => {
		const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
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
				productKey: "image-quality",
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
		const requestBody = fetcher.mock.calls[0]?.[1]?.body;
		expect(typeof requestBody).toBe("string");
		expect(JSON.parse(requestBody as string)).toMatchObject({
			productKey: "image-quality",
		});
	});

	it("keeps the server-authorized paid tier in the account handoff", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({
				status: "READY",
				claimToken: "c".repeat(43),
				continueUrl: "/draft/continue",
				productKey: "image-quality",
				accessHint: "paid-account",
			}),
		);

		const result = await completeGuestDraftUpload(
			{
				sessionId: "session-1",
				completionToken: "d".repeat(43),
				capabilityVersion: "capability-v1",
				productKey: "image-quality",
				sha256: "a".repeat(64),
				prompt: "Preserve the product details",
			},
			{ fetcher: fetcher as typeof fetch },
		);

		expect(result).toEqual({
			action: "/draft/continue",
			claimToken: "c".repeat(43),
			productKey: "image-quality",
			accessHint: "paid-account",
		});
	});
});
