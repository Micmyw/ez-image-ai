import {
	canReceiveNewFreeAllowance,
	getRequestFreeEligibility,
	runWithCloudflareFreeEligibility,
} from "@repo/utils/free-eligibility";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	ensureGuestBrowserSubject,
	guestUploadIdentity,
	readGuestBrowserSubject,
} from "./guest-browser";

afterEach(() => vi.unstubAllEnvs());

describe("trusted free-benefit request scope", () => {
	it("does not accept headers, proxy configuration or absent scope as proof", () => {
		vi.stubEnv("MEDIA_TRUSTED_PROXY_PROVIDER", "cloudflare");
		vi.stubEnv("CF_IPCOUNTRY", "US");
		expect(getRequestFreeEligibility()).toEqual({ status: "unverified", countryCode: null });
		expect(canReceiveNewFreeAllowance()).toBe(false);
	});
	it.each([undefined, null, "XX", "ZZ", "us", "USA", ""])(
		"treats malformed/unknown country %s as unverified",
		(country) => {
			expect(runWithCloudflareFreeEligibility(country, getRequestFreeEligibility).status).toBe(
				"unverified",
			);
		},
	);
	it("excludes only IN and keeps concurrent requests isolated", async () => {
		const actual = await Promise.all(
			["IN", "US", "CN", "BR"].map((country) =>
				runWithCloudflareFreeEligibility(country, async () => {
					await Promise.resolve();
					return [country, getRequestFreeEligibility().countryCode, canReceiveNewFreeAllowance()];
				}),
			),
		);
		expect(actual).toEqual([
			["IN", "IN", false],
			["US", "US", true],
			["CN", "CN", true],
			["BR", "BR", true],
		]);
		expect(getRequestFreeEligibility().status).toBe("unverified");
	});
});

describe("server-issued guest browser credential", () => {
	it("issues an HttpOnly credential, accepts it again and rejects tampering", () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("BETTER_AUTH_SECRET", "guest-test-signing-secret-longer-than-thirty-two");
		const response = new Headers();
		const subject = ensureGuestBrowserSubject(new Headers(), response);
		const setCookie = response.get("set-cookie")!;
		expect(setCookie).toContain("__Host-ezpic_guest=");
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("Secure");
		const headers = new Headers({ cookie: setCookie.split(";")[0]! });
		expect(readGuestBrowserSubject(headers)).toBe(subject);
		expect(ensureGuestBrowserSubject(headers, new Headers())).toBe(subject);
		const tampered = new Headers({
			cookie: headers.get("cookie")!.replace(/.$/, (last) => (last === "a" ? "b" : "a")),
		});
		expect(readGuestBrowserSubject(tampered)).toBeNull();
		expect(guestUploadIdentity(subject, "request-1")).toEqual(
			guestUploadIdentity(subject, "request-1"),
		);
		expect(guestUploadIdentity(subject, "request-2").sessionId).not.toBe(
			guestUploadIdentity(subject, "request-1").sessionId,
		);
	});
});
