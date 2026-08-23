import { describe, expect, it, vi } from "vitest";

import { expireMediaUploads } from "./expire-media-uploads";

describe("expireMediaUploads", () => {
	it("runs draft and upload-session expiration from one bounded maintenance job", async () => {
		const now = new Date("2026-08-14T00:00:00Z");
		const expireDrafts = vi.fn(async () => 2);
		const expireUploadSessions = vi.fn(async () => 3);
		await expect(
			expireMediaUploads({ now, limit: 1000 }, { expireDrafts, expireUploadSessions }),
		).resolves.toEqual({ expiredDrafts: 2, expiredUploadSessions: 3 });
		expect(expireDrafts).toHaveBeenCalledWith(now);
		expect(expireUploadSessions).toHaveBeenCalledWith(now, 500);
	});
});
