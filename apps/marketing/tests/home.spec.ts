import { expect, test } from "@playwright/test";

test.describe("home page", () => {
	test("should load", async ({ page }) => {
		await page.goto("/");

		await expect(
			page.getByRole("heading", {
				name: "An AI image editor that starts with your image",
			}),
		).toBeVisible();

		await expect(page.locator('[data-test="color-mode-toggle"]')).toBeVisible();
	});
});
