import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as baseUrlExports from "./base-url";

const { getBaseUrl } = baseUrlExports;
const baseUrlModule = baseUrlExports as typeof baseUrlExports & {
	parseProductionMarketingOrigin?: (value: string | undefined) => string | undefined;
	parseGoogleSiteVerification?: (value: string | undefined) => string | undefined;
};

describe("getBaseUrl (marketing)", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env.NEXT_PUBLIC_MARKETING_URL;
		delete process.env.NEXT_PUBLIC_VERCEL_URL;
		delete process.env.PORT;
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("returns the NEXT_PUBLIC_MARKETING_URL when set", () => {
		process.env.NEXT_PUBLIC_MARKETING_URL = "https://marketing.example.com";
		expect(getBaseUrl()).toBe("https://marketing.example.com");
	});

	it("returns a Vercel URL when NEXT_PUBLIC_VERCEL_URL is set", () => {
		process.env.NEXT_PUBLIC_VERCEL_URL = "my-marketing.vercel.app";
		expect(getBaseUrl()).toBe("https://my-marketing.vercel.app");
	});

	it("returns localhost:3001 by default", () => {
		expect(getBaseUrl()).toBe("http://localhost:3001");
	});

	it("uses PORT env when set and no other env vars", () => {
		process.env.PORT = "5000";
		expect(getBaseUrl()).toBe("http://localhost:5000");
	});

	it("prefers NEXT_PUBLIC_MARKETING_URL over NEXT_PUBLIC_VERCEL_URL", () => {
		process.env.NEXT_PUBLIC_MARKETING_URL = "https://marketing.example.com";
		process.env.NEXT_PUBLIC_VERCEL_URL = "my-marketing.vercel.app";
		expect(getBaseUrl()).toBe("https://marketing.example.com");
	});

	it("rejects placeholder and insecure non-loopback canonical origins", () => {
		expect(baseUrlModule.parseProductionMarketingOrigin).toBeTypeOf("function");
		if (!baseUrlModule.parseProductionMarketingOrigin) return;

		expect(
			baseUrlModule.parseProductionMarketingOrigin("https://marketing.placeholder.invalid"),
		).toBeUndefined();
		expect(
			baseUrlModule.parseProductionMarketingOrigin("http://marketing.example.com"),
		).toBeUndefined();
		expect(baseUrlModule.parseProductionMarketingOrigin("https://ezpic.example")).toBe(
			"https://ezpic.example",
		);
		expect(baseUrlModule.parseProductionMarketingOrigin("http://localhost:3001/")).toBe(
			"http://localhost:3001",
		);
	});

	it("renders GSC verification only for a real configured token", () => {
		expect(baseUrlModule.parseGoogleSiteVerification).toBeTypeOf("function");
		if (!baseUrlModule.parseGoogleSiteVerification) return;

		for (const value of [
			undefined,
			"",
			"replace-me",
			"placeholder",
			"google-site-verification=replace_me",
			"short",
			"token with spaces",
		]) {
			expect(baseUrlModule.parseGoogleSiteVerification(value)).toBeUndefined();
		}
		expect(
			baseUrlModule.parseGoogleSiteVerification("0123456789abcdefghijklmnopqrstuvwxyz_ABCD-EFGH"),
		).toBe("0123456789abcdefghijklmnopqrstuvwxyz_ABCD-EFGH");
	});
});
