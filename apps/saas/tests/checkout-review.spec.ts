import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";
import pg from "pg";

// Real local authentication and UI; provider outcomes are fixtures. The API and
// serializable closure transaction have separate unit and PostgreSQL coverage.
test.use({ storageState: { cookies: [], origins: [] } });
test.describe("checkout review browser flow", () => {
	test.describe.configure({ timeout: 180_000 });
	let userId: string;
	let email: string;
	let pool: pg.Pool | undefined;
	const password = "LocalCheckoutReview!2026";
	test.beforeAll(async () => {
		const url = new URL(process.env.TEST_DATABASE_URL ?? "http://unsafe.invalid");
		if (
			!["localhost", "127.0.0.1"].includes(url.hostname) ||
			url.port !== "55432" ||
			!url.pathname.includes("test") ||
			process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL
		)
			throw new Error("UNSAFE_CHECKOUT_REVIEW_TEST_DATABASE");
		pool = new pg.Pool({ connectionString: url.toString() });
		const authRequire = createRequire(require.resolve("@repo/auth"));
		const { hashPassword } = await import(
			pathToFileURL(authRequire.resolve("better-auth/crypto")).href
		);
		email = `checkout-review-${crypto.randomUUID()}@example.test`;
		userId = crypto.randomUUID();
		await pool.query(
			'INSERT INTO "user" (id, email, name, role, "emailVerified", "onboardingComplete", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, true, true, now(), now())',
			[userId, email, "Checkout review E2E", "admin"],
		);
		await pool.query(
			'INSERT INTO account (id, "userId", "providerId", "accountId", password, "createdAt", "updatedAt") VALUES ($1, $2, $3, $2, $4, now(), now())',
			[crypto.randomUUID(), userId, "credential", await hashPassword(password)],
		);
	});
	test.afterAll(async () => {
		if (userId) await pool?.query('DELETE FROM "user" WHERE id=$1', [userId]);
		await pool?.end();
	});
	test.beforeEach(async ({ page }) => {
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
	});
	test("requires review evidence, preserves the operation on retry and shows the closed result", async ({
		page,
	}, testInfo) => {
		const snapshot = {
			id: "review-ui-order",
			ownerType: "USER",
			ownerId: "customer-reference",
			planId: "studio",
			interval: "month",
			status: "PROVIDER_PENDING",
			recoveryStatus: "REVIEW",
			updatedAt: "2026-09-22T04:00:00.000Z",
			canReview: true,
			resolvedAt: null as string | null,
		};
		await page.route("**/api/rpc/payments/getAdminCheckoutReview**", (route) =>
			route.fulfill({ json: { json: snapshot } }),
		);
		const submissions: Record<string, unknown>[] = [];
		await page.route("**/api/rpc/payments/resolveAdminCheckoutReview", async (route) => {
			submissions.push(route.request().postDataJSON().json);
			if (submissions.length === 1) {
				await route.fulfill({
					status: 503,
					json: {
						json: {
							defined: false,
							code: "SERVICE_UNAVAILABLE",
							status: 503,
							message: "CHECKOUT_REVIEW_PROVIDER_UNCONFIRMED",
						},
					},
				});
				return;
			}
			Object.assign(snapshot, {
				status: "CANCELED",
				recoveryStatus: "CLOSED",
				canReview: false,
				resolvedAt: new Date().toISOString(),
			});
			await route.fulfill({ json: { json: snapshot } });
		});
		await page.goto("/admin/media");
		const panel = page.locator("#checkout-review");
		await panel.getByLabel("Order reference", { exact: true }).fill(snapshot.id);
		await panel.getByRole("button", { name: "Load checkout" }).click();
		const close = panel.getByRole("button", { name: "Close reviewed checkout" });
		await expect(close).toBeDisabled();
		await panel
			.getByLabel(/Support case reference/)
			.fill("Support case E2E; merchant records checked");
		await panel.getByLabel(/Reason for closure/).fill("Customer left before authorizing payment");
		await panel.getByRole("checkbox").nth(0).check();
		await expect(close).toBeDisabled();
		await panel.getByRole("checkbox").nth(1).check();
		await expect(close).toBeEnabled();
		await panel.screenshot({ path: testInfo.outputPath("checkout-review-desktop.png") });
		await page.setViewportSize({ width: 390, height: 900 });
		await expect(close).toBeVisible();
		await panel.screenshot({ path: testInfo.outputPath("checkout-review-mobile.png") });
		await close.click();
		await expect(panel.getByRole("alert")).toContainText("PayPal did not confirm");
		await close.click();
		await expect(panel.getByRole("status")).toContainText("This checkout is closed");
		expect(submissions).toHaveLength(2);
		expect(submissions[0]).toEqual(submissions[1]);
		expect(submissions[0]).toMatchObject({
			customerConfirmedNoApproval: true,
			merchantRecordsReviewed: true,
			expectedUpdatedAt: snapshot.updatedAt,
		});
		expect(submissions[0]).not.toHaveProperty("providerObservation");
	});
	test("keeps review polling read-only and lets a customer explicitly retry", async ({ page }) => {
		let closed = false;
		let reads = 0;
		const refreshes: Record<string, unknown>[] = [];
		const pending = {
			id: "review-ui-order",
			provider: "paypal",
			planId: "studio",
			interval: "month",
			status: "REVIEW",
			canResume: false,
			canChange: false,
			waitUntil: null,
			checkedAt: null,
		};
		await page.route("**/api/rpc/payments/getPendingSubscriptionCheckout**", (route) => {
			reads++;
			return route.fulfill({ json: { json: closed ? null : pending } });
		});
		await page.route("**/api/rpc/payments/refreshPendingSubscriptionCheckout", (route) => {
			refreshes.push(route.request().postDataJSON().json);
			return route.fulfill({ json: { json: pending } });
		});
		await page.clock.install();
		await page.goto("/settings/billing");
		const banner = page.getByRole("region", { name: "Unfinished subscription checkout" });
		await expect(banner).toContainText("Automatic checks have stopped");
		const before = reads;
		await page.clock.fastForward(31_000);
		await expect.poll(() => reads).toBeGreaterThan(before);
		expect(refreshes).toHaveLength(0);
		await banner.getByRole("button", { name: "Check payment status" }).click();
		await expect.poll(() => refreshes.length).toBe(1);
		expect(refreshes[0]).toEqual({ checkoutIntentId: pending.id, retryReview: true });
		closed = true;
		await page.clock.fastForward(31_000);
		await expect(banner).toHaveCount(0);
	});
});
