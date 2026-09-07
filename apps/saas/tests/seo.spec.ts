import { expect, test } from "@playwright/test";

const baseUrl = process.env.NEXT_PUBLIC_SAAS_URL ?? "http://localhost:3000";

const indexBoundaryCases = [
	{
		family: "authentication",
		expectedPath: "/login",
		path: "/login",
		redirectsToLogin: false,
	},
	{
		family: "guest workspace",
		expectedPath: "/login",
		path: "/try",
		redirectsToLogin: true,
	},
	{
		family: "authenticated product",
		expectedPath: "/login",
		path: "/dashboard",
		redirectsToLogin: true,
	},
	{
		family: "administration",
		expectedPath: "/login",
		path: "/admin/users",
		redirectsToLogin: true,
	},
	{
		family: "checkout",
		expectedPath: "/login",
		path: "/checkout-return",
		redirectsToLogin: true,
	},
] as const;

test.describe("SaaS index boundary", () => {
	for (const route of indexBoundaryCases) {
		test(`${route.family} route ${route.path} remains noindex and nofollow`, async ({
			browser,
		}) => {
			const context = await browser.newContext({
				baseURL: baseUrl,
				storageState: { cookies: [], origins: [] },
			});
			try {
				const page = await context.newPage();
				const response = await page.goto(route.path);
				expect(response?.status()).toBe(200);
				expect(new URL(page.url()).pathname).toBe(route.expectedPath);
				if (route.redirectsToLogin) {
					expect(
						response?.request().redirectedFrom(),
						`${route.path} must redirect to login`,
					).not.toBeNull();
				} else {
					expect(
						response?.request().redirectedFrom(),
						`${route.path} must render directly`,
					).toBeNull();
				}
				await expectNoindexNofollow(page);
			} finally {
				await context.close();
			}
		});
	}
});

async function expectNoindexNofollow(page: import("@playwright/test").Page) {
	const content = await page.locator('meta[name="robots"]').getAttribute("content");
	expect(content).not.toBeNull();
	const directives = new Set(
		(content ?? "")
			.split(",")
			.map((directive) => directive.trim().toLowerCase())
			.filter(Boolean),
	);
	expect(directives.has("noindex")).toBe(true);
	expect(directives.has("nofollow")).toBe(true);
}
