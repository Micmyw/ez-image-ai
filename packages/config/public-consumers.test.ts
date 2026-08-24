import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const originalSiteName = process.env.NEXT_PUBLIC_SITE_NAME;

afterEach(() => {
	if (originalSiteName === undefined) delete process.env.NEXT_PUBLIC_SITE_NAME;
	else process.env.NEXT_PUBLIC_SITE_NAME = originalSiteName;
	vi.resetModules();
});

describe("public EzPic identity consumers", () => {
	it("uses the configured site name in email and OpenAPI surfaces", async () => {
		process.env.NEXT_PUBLIC_SITE_NAME = "Configured Editor";

		const [{ config: mailConfig }, { getOpenApiTitle }] = await Promise.all([
			import("../mail/config"),
			import("../api/orpc/product-metadata"),
		]);

		expect(mailConfig.appName).toBe("Configured Editor");
		expect(getOpenApiTitle()).toBe("Configured Editor API");
	});

	it("documents every public identity variable without template domains", () => {
		const exampleEnvironment = readFileSync(
			path.join(repositoryRoot, ".env.local.example"),
			"utf8",
		);

		for (const key of [
			"NEXT_PUBLIC_MARKETING_URL",
			"NEXT_PUBLIC_SAAS_URL",
			"NEXT_PUBLIC_SUPPORT_EMAIL",
			"NEXT_PUBLIC_SITE_NAME",
			"NEXT_PUBLIC_SITE_DESCRIPTION",
		]) {
			expect(exampleEnvironment).toContain(`${key}=`);
		}
		expect(exampleEnvironment).not.toMatch(/supastarter|example\.com/i);
	});

	it("renders configured email branding and keeps preview links neutral", () => {
		const wrapperSource = readFileSync(
			path.join(repositoryRoot, "packages/mail/components/Wrapper.tsx"),
			"utf8",
		);
		const notificationSource = readFileSync(
			path.join(repositoryRoot, "packages/mail/emails/Notification.tsx"),
			"utf8",
		);

		expect(wrapperSource).toContain("label={config.appName}");
		expect(notificationSource).not.toMatch(/example\.com/i);
	});
});
