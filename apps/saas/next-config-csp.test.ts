import "next/dist/server/node-environment-baseline";
import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";

import nextConfig from "./next.config";

describe("Turnstile content security policy", () => {
	it.each(["/", "/try"])("allows the verification script and frame on %s", async (pathname) => {
		const response = await unstable_getResponseFromNextConfig({
			url: `https://ezimageai.com${pathname}`,
			nextConfig,
		});
		const directives = new Map(
			(response.headers.get("content-security-policy") ?? "").split(";").map((value) => {
				const [name, ...sources] = value.trim().split(/\s+/);
				return [name, sources];
			}),
		);

		expect(directives.get("script-src")).toContain("https://challenges.cloudflare.com");
		expect(directives.get("frame-src")).toEqual(["https://challenges.cloudflare.com"]);
		expect(directives.get("default-src")).toEqual(["'self'"]);
		expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
	});
});
