import { afterEach, describe, expect, it, vi } from "vitest";

import { getGuestCapability } from "./guest-capability";

describe("marketing guest capability client", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("loads the exact public snapshot without cross-origin credentials", async () => {
		const snapshot = {
			version: "guest-v17",
			enabled: true,
			reason: null,
			upload: { mimeTypes: ["image/jpeg", "image/png", "image/webp"], maximumBytes: 10_485_760 },
			product: { key: "image-fast", label: "Standard Edit", credits: "4" },
			queueEstimate: { kind: "capacity" },
		};
		const fetchMock = vi.fn().mockResolvedValue(Response.json(snapshot));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getGuestCapability("https://app.test")).resolves.toEqual(snapshot);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://app.test/api/media/guest-capability",
			expect.objectContaining({ method: "GET", credentials: "omit" }),
		);
	});
});
