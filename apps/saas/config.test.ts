import { afterEach, describe, expect, it, vi } from "vitest";

const publicProductEnvironmentKeys = [
	"NEXT_PUBLIC_MARKETING_URL",
	"NEXT_PUBLIC_SAAS_URL",
	"NEXT_PUBLIC_SUPPORT_EMAIL",
	"NEXT_PUBLIC_SITE_NAME",
	"NEXT_PUBLIC_SITE_DESCRIPTION",
] as const;

const originalEnvironment = Object.fromEntries(
	publicProductEnvironmentKeys.map((key) => [key, process.env[key]]),
);

afterEach(() => {
	for (const key of publicProductEnvironmentKeys) {
		const value = originalEnvironment[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	vi.resetModules();
});

describe("SaaS product configuration", () => {
	it("uses the complete environment-backed public EzPic identity", async () => {
		process.env.NEXT_PUBLIC_MARKETING_URL = "https://www.configured.test";
		process.env.NEXT_PUBLIC_SAAS_URL = "https://app.configured.test";
		process.env.NEXT_PUBLIC_SUPPORT_EMAIL = "help@configured.test";
		process.env.NEXT_PUBLIC_SITE_NAME = "Configured Editor";
		process.env.NEXT_PUBLIC_SITE_DESCRIPTION = "Configured image editing description";

		const { config } = await import("./config");

		expect(config).toMatchObject({
			appName: "Configured Editor",
			appDescription: "Configured image editing description",
			marketingUrl: "https://www.configured.test",
			saasUrl: "https://app.configured.test",
			supportEmail: "help@configured.test",
		});
	});

	it("falls back to the neutral EzPic product identity", async () => {
		for (const key of publicProductEnvironmentKeys) delete process.env[key];

		const { config } = await import("./config");

		expect(config).toMatchObject({
			appName: "EzPic",
			appDescription: expect.stringMatching(/image edit/i),
		});
		expect(config).not.toHaveProperty("supportEmail");
	});
});
