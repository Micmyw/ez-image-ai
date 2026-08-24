import fs from "node:fs/promises";

import { expect, test as setup } from "@playwright/test";

const authFile = "playwright/.auth/user.json";

setup("authenticate deterministic creators", async ({ browser }) => {
	setup.setTimeout(180_000);
	const runId = requiredEnvironment("E2E_RUN_ID");
	const password = requiredEnvironment("E2E_USER_PASSWORD");
	await fs.mkdir("playwright/.auth", { recursive: true });
	await authenticate(browser, `media-e2e-funded-${runId}@example.test`, password, authFile);
	await authenticate(
		browser,
		`media-e2e-empty-${runId}@example.test`,
		password,
		"playwright/.auth/empty.json",
	);
});

async function authenticate(
	browser: import("@playwright/test").Browser,
	email: string,
	password: string,
	path: string,
) {
	const context = await browser.newContext();
	const page = await context.newPage();
	const sessionResponse = page.waitForResponse(
		(response) =>
			response.url().includes("/api/auth/get-session") && response.request().method() === "GET",
	);
	await page.goto("/login");
	await sessionResponse;
	await expect(page.locator('button[type="submit"]')).toBeEnabled({ timeout: 120_000 });
	await page.getByLabel(/email/i).fill(email);
	await page.locator('input[type="password"]').fill(password);
	await page.locator('button[type="submit"]').click();
	await expect(page).toHaveURL(/\/create/, { timeout: 60_000 });
	await expect(page.getByLabel(/edit instruction/i)).toBeVisible({ timeout: 120_000 });
	await context.storageState({ path });
	await context.close();
}

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required for media E2E`);
	return value;
}
