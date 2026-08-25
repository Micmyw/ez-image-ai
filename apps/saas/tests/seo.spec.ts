import { expect, test } from "@playwright/test";

const authenticatedNoindexPaths = [
	"/create",
	"/history",
	"/assets",
	"/edits",
	"/checkout-return",
	"/admin/media",
] as const;

test.describe("SaaS index boundary", () => {
	test("login remains noindex and nofollow", async ({ browser }) => {
		const context = await browser.newContext();
		const page = await context.newPage();

		await page.goto("/login");
		await expectNoindexNofollow(page);

		await context.close();
	});

	test("authenticated product routes remain noindex and nofollow", async ({ page }) => {
		for (const path of authenticatedNoindexPaths) {
			await page.goto(path);
			await expectNoindexNofollow(page);
		}
	});
});

async function expectNoindexNofollow(page: import("@playwright/test").Page) {
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
		"content",
		/noindex,\s*nofollow/i,
	);
}
