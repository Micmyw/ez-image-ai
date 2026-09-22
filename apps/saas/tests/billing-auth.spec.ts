import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("billing page authentication", () => {
	test.describe.configure({ timeout: 180_000 });
	const password = "LocalBillingAuth!2026";
	const userIds: string[] = [];
	let userId: string;
	let email: string;
	let pool: pg.Pool | undefined;

	test.beforeAll(async () => {
		const url = new URL(process.env.TEST_DATABASE_URL ?? "http://unsafe.invalid");
		if (
			!["localhost", "127.0.0.1"].includes(url.hostname) ||
			!url.pathname.includes("test") ||
			process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL
		)
			throw new Error("UNSAFE_BILLING_AUTH_TEST_DATABASE");
		pool = new pg.Pool({ connectionString: url.toString() });
		const authRequire = createRequire(require.resolve("@repo/auth"));
		const { hashPassword } = await import(
			pathToFileURL(authRequire.resolve("better-auth/crypto")).href
		);
		userId = crypto.randomUUID();
		email = `billing-auth-${userId}@example.test`;
		userIds.push(userId);
		await pool.query(
			'INSERT INTO "user" (id, email, name, "emailVerified", "onboardingComplete", "createdAt", "updatedAt") VALUES ($1, $2, $3, true, true, now(), now())',
			[userId, email, "Billing auth E2E"],
		);
		await pool.query(
			'INSERT INTO account (id, "userId", "providerId", "accountId", password, "createdAt", "updatedAt") VALUES ($1, $2, $3, $2, $4, now(), now())',
			[crypto.randomUUID(), userId, "credential", await hashPassword(password)],
		);
	});

	test.afterAll(async () => {
		try {
			if (userIds.length) await pool?.query('DELETE FROM "user" WHERE id = ANY($1)', [userIds]);
		} finally {
			await pool?.end();
		}
	});

	test("redirects a direct signed-out billing request without an Unauthorized render error", async ({
		page,
	}) => {
		await expectBillingRedirect(page, "/login");
		await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
	});

	test("renders billing for a member and redirects when the server session expires", async ({
		page,
	}) => {
		await signIn(page, email, password);

		const response = await page.goto("/settings/billing");
		expect(response?.status()).toBe(200);
		await expect(page.getByRole("heading", { name: "Billing", exact: true })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Change your plan" })).toBeVisible();

		const expired = await pool!.query(
			'UPDATE session SET "expiresAt" = now() - interval \'1 minute\' WHERE "userId" = $1',
			[userId],
		);
		expect(expired.rowCount).toBeGreaterThan(0);
		await expectBillingRedirect(page, "/login");
		await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
	});

	test("keeps anonymous trial sessions out of account billing", async ({ page }) => {
		await signIn(page, email, password);
		// Keep Better Auth's real signed cookie, but model a persisted trial user.
		// Trial admission is separate from the account-rendering boundary under test.
		await pool!.query(
			'UPDATE "user" SET "isAnonymous" = true, "onboardingComplete" = false WHERE id = $1',
			[userId],
		);
		try {
			await expectBillingRedirect(page, "/try");
		} finally {
			await pool!.query(
				'UPDATE "user" SET "isAnonymous" = false, "onboardingComplete" = true WHERE id = $1',
				[userId],
			);
		}
	});
});

async function signIn(page: Page, email: string, password: string) {
	const session = page.waitForResponse(
		(response) =>
			response.url().includes("/api/auth/get-session") && response.request().method() === "GET",
		{ timeout: 90_000 },
	);
	await page.goto("/login");
	await session;
	await expect(page.locator('button[type="submit"]')).toBeEnabled({ timeout: 90_000 });
	await page.getByLabel(/email/i).fill(email);
	await page.locator('input[type="password"]').fill(password);
	await page.locator('button[type="submit"]').click();
	await expect(page).toHaveURL(/\/create/, { timeout: 60_000 });
}

async function expectBillingRedirect(page: Page, destination: "/login" | "/try") {
	// Inspect the original server response too: a layout redirect can otherwise
	// hide a child's unhandled error from the final page visible in the browser.
	const response = await page.request.get("/settings/billing", { maxRedirects: 0 });
	expect([200, 307]).toContain(response.status());
	const body = await response.text();
	expect(body).not.toMatch(/Unauthorized|UNAUTHORIZED/);
	if (response.status() === 307) {
		expect(response.headers().location).toBe(destination);
	}
	const errors: Error[] = [];
	const onError = (error: Error) => errors.push(error);
	page.on("pageerror", onError);
	try {
		await page.goto("/settings/billing");
		await expect(page).toHaveURL(new RegExp(`${destination}(?:\\?|$)`), { timeout: 60_000 });
		expect(errors).toEqual([]);
	} finally {
		page.off("pageerror", onError);
	}
}
