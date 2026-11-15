import { afterEach, describe, expect, it, vi } from "vitest";

import {
	ensureGuestBrowserSubject,
	guestUploadIdentity,
	readGuestBrowserSubject,
} from "./guest-browser";

afterEach(() => vi.unstubAllEnvs());
describe("stable guest browser versus per-upload identity", () => {
	it("keeps the signed browser subject stable across different upload request IDs", () => {
		vi.stubEnv("BETTER_AUTH_SECRET", "test-only-guest-browser-secret-0000000000000000");
		vi.stubEnv("NODE_ENV", "test");
		const response = new Headers();
		const subject = ensureGuestBrowserSubject(new Headers(), response);
		const headers = new Headers({ cookie: response.get("set-cookie")!.split(";")[0]! });
		expect(readGuestBrowserSubject(headers)).toBe(subject);
		expect(ensureGuestBrowserSubject(headers, new Headers())).toBe(subject);
		const first = guestUploadIdentity(subject, "upload-request-a");
		const second = guestUploadIdentity(subject, "upload-request-b");
		expect(first.ownerId).not.toBe(second.ownerId);
		expect(first.assetId).not.toBe(second.assetId);
		expect(guestUploadIdentity(subject, "upload-request-a")).toEqual(first);
		expect(ensureGuestBrowserSubject(new Headers(), new Headers())).not.toBe(subject);
		expect(
			readGuestBrowserSubject(new Headers({ cookie: "ezpic_guest=forged.signature" })),
		).toBeNull();
	});
});
