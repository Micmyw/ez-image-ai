import { describe, expect, it, vi } from "vitest";

import { expireGuestMedia } from "./expire-guest-media";

describe("guest media expiry handler", () => {
	it("uses one immutable cutoff for authorization denial and cleanup scheduling", async () => {
		const now = new Date("2026-08-28T00:00:00.000Z");
		const expire = vi.fn(async () => ({
			expiredAssets: 3,
			expiredJobs: 1,
			cleanupEvents: 5,
			removedAnonymousUsers: 0,
		}));

		await expect(expireGuestMedia({ now, limit: 25 }, { expire })).resolves.toEqual({
			expiredAssets: 3,
			expiredJobs: 1,
			cleanupEvents: 5,
			removedAnonymousUsers: 0,
		});
		expect(expire).toHaveBeenCalledWith({ now, limit: 25 });
	});
});
