import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";
import pg from "pg";

import { submitPasswordSignIn } from "./helpers/password-sign-in";

// Real local authentication, database read and admin UI. Fixtures create no
// provider checkout/payment and the test never generates media or sends email.
test.use({ storageState: { cookies: [], origins: [] } });
test.describe("order attribution administration", () => {
	test.describe.configure({ timeout: 180_000 });
	const suffix = crypto.randomUUID();
	const userId = `attribution-admin-${suffix}`;
	const email = `attribution-${suffix}@example.test`;
	const password = "LocalAttribution!2026";
	const planId = `attribution-plan-${suffix}`;
	const purchaseId = `attribution-order-${suffix}`;
	const checkoutId = `attribution-checkout-${suffix}`;
	let pool: pg.Pool | undefined;

	test.beforeAll(async () => {
		const url = new URL(process.env.TEST_DATABASE_URL ?? "http://unsafe.invalid");
		const localTarget =
			url.pathname === "/ezimage_attribution_test" &&
			Number(url.port) >= 49152 &&
			Number(url.port) <= 65535;
		const ciTarget =
			process.env.CI === "true" &&
			url.port === "55432" &&
			url.pathname === "/ai_media_foundation_test";
		if (
			url.protocol !== "postgresql:" ||
			url.hostname !== "127.0.0.1" ||
			(!localTarget && !ciTarget) ||
			url.search ||
			url.hash ||
			process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL
		)
			throw new Error("UNSAFE_ATTRIBUTION_E2E_DATABASE");
		pool = new pg.Pool({ connectionString: url.toString() });
		const authRequire = createRequire(require.resolve("@repo/auth"));
		const { hashPassword } = await import(
			pathToFileURL(authRequire.resolve("better-auth/crypto")).href
		);
		await pool.query(
			'INSERT INTO "user" (id, email, name, role, "emailVerified", "onboardingComplete", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, true, true, now(), now())',
			[userId, email, "Attribution admin E2E", "admin"],
		);
		await pool.query(
			'INSERT INTO account (id, "userId", "providerId", "accountId", password, "createdAt", "updatedAt") VALUES ($1, $2, $3, $2, $4, now(), now())',
			[crypto.randomUUID(), userId, "credential", await hashPassword(password)],
		);
		await pool.query(
			'INSERT INTO billing_plan (id, provider, "providerPriceId", name, "creditsPerPeriod", "priceMicros", currency, metadata, "productKind", "updatedAt") VALUES ($1, $2, $3, $4, 100, 1000000, $5, $6, $7, now())',
			[planId, "waffo", `price-${suffix}`, "Local attribution fixture", "USD", "{}", "CREDIT_PACK"],
		);
		const attribution = {
			version: 1,
			registration: {
				version: 1,
				landingPath: "/blog/photo-ideas",
				referrerOrigin: "https://search.example.test",
				source: "campaign",
				utmSource: "search",
				utmMedium: "organic",
				utmCampaign: "autumn",
				capturedAt: "2026-10-01T12:00:00.000Z",
				registeredAt: "2026-10-02T12:00:00.000Z",
			},
			triggerPath: "/photo-to-coloring-page",
			triggeredAt: "2026-10-08T11:59:00.000Z",
		};
		await pool.query(
			'INSERT INTO purchase (id, "userId", type, "productKind", provider, "customerId", "priceId", status, attribution, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now(), now())',
			[
				purchaseId,
				userId,
				"SUBSCRIPTION",
				"PLAN",
				"waffo",
				"local-private-customer",
				"local-private-price",
				"active",
				JSON.stringify(attribution),
			],
		);
		await pool.query(
			`INSERT INTO payment_checkout_intent (id, provider, "ownerType", "ownerId", "submittedByUserId", "productKind", "billingPlanId", "planKey", interval, "idempotencyKey", status,
			 "creditPackCatalogVersion", "creditPackPricingVersion", "creditPackSubscriberEligibilityVersion", "creditPackBaseCredits", "creditPackBonusCredits", "creditPackTotalCredits", "creditPackExpiryMonths", "creditPackSubscriberBonusEligible", "creditPackEligibilityEvaluatedAt", "updatedAt")
			 VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, 'local-fixture', 'local-fixture', 'local-fixture', 500, 0, 500, 6, false, now(), now())`,
			[
				checkoutId,
				"waffo",
				"USER",
				userId,
				"CREDIT_PACK",
				planId,
				"pack-500",
				"one-time",
				`local-${suffix}`,
				"COMPLETED",
			],
		);
	});
	test.afterAll(async () => {
		if (!pool) return;
		await pool.query("DELETE FROM payment_checkout_intent WHERE id=$1", [checkoutId]);
		await pool.query('DELETE FROM "user" WHERE id=$1', [userId]);
		await pool.query("DELETE FROM billing_plan WHERE id=$1", [planId]);
		await pool.end();
	});

	test("shows actual registration source, trigger page, inherited renewal meaning and historical unknowns", async ({
		page,
	}, testInfo) => {
		const session = page.waitForResponse(
			(response) =>
				response.url().includes("/api/auth/get-session") && response.request().method() === "GET",
			{ timeout: 90_000 },
		);
		await page.goto("/login?redirectTo=%2Fadmin%2Fmedia");
		await session;
		await expect(page.locator('button[type="submit"]')).toBeEnabled({ timeout: 90_000 });
		await page.getByLabel(/email/i).fill(email);
		await page.locator('input[type="password"]').fill(password);
		await submitPasswordSignIn(page);
		await expect(page).toHaveURL(/\/admin\/media$/, { timeout: 60_000 });
		const panel = page.locator("#payment-attribution");
		await expect(panel).toBeVisible({ timeout: 90_000 });
		await panel.getByLabel("Order or checkout reference (optional)").fill(purchaseId);
		await panel.getByRole("button", { name: "Find reference" }).click();
		await expect(panel).toContainText("https://search.example.test");
		await expect(panel).toContainText("/blog/photo-ideas");
		await expect(panel).toContainText("/photo-to-coloring-page");
		await expect(panel).toContainText(
			"Subscription renewals inherit this original checkout attribution.",
		);
		await expect(panel).not.toContainText("local-private");
		await panel.screenshot({ path: testInfo.outputPath("order-attribution-desktop.png") });
		await page.setViewportSize({ width: 390, height: 900 });
		await expect(panel.getByText("Page that triggered checkout", { exact: true })).toBeVisible();
		await panel.screenshot({ path: testInfo.outputPath("order-attribution-mobile.png") });
		await panel.getByLabel("Order or checkout reference (optional)").fill(checkoutId);
		await panel.getByRole("button", { name: "Find reference" }).click();
		await expect(panel).toContainText(checkoutId);
		await expect(panel).toContainText("Credit pack");
		await expect(panel.getByText("Unknown", { exact: true }).first()).toBeVisible();
		await expect(panel).not.toContainText("/blog/photo-ideas");
	});
});
