import {
	getRedirectUrl,
	unstable_getResponseFromNextConfig,
} from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";

import nextConfig from "./next.config";

async function redirectFor(pathname: string) {
	return unstable_getResponseFromNextConfig({
		url: `https://app.example.com${pathname}`,
		nextConfig,
	});
}

describe("legacy public URL redirects", () => {
	it.each([
		["/legal/privacy-policy", "https://app.example.com/privacy"],
		["/legal/terms", "https://app.example.com/terms"],
		["/de", "https://app.example.com/"],
		["/es/pricing", "https://app.example.com/pricing"],
		["/fr/blog/launch-notes", "https://app.example.com/blog/launch-notes"],
		["/de/settings", "https://app.example.com/settings"],
	])("permanently redirects %s to its same-origin replacement", async (source, destination) => {
		const response = await redirectFor(source);

		expect(response.status).toBe(308);
		expect(getRedirectUrl(response)).toBe(destination);
	});

	it("does not treat an organization slug as a retired locale", async () => {
		const organizationSettings = await redirectFor("/acme/settings");
		expect(organizationSettings.status).toBe(308);
		expect(getRedirectUrl(organizationSettings)).toBe(
			"https://app.example.com/acme/settings/general",
		);

		const organizationRoot = await redirectFor("/acme");
		expect(organizationRoot.status).not.toBe(308);
		expect(organizationRoot.headers.get("location")).toBeNull();
	});
});
