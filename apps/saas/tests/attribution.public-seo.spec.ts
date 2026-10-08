import { expect, test } from "@playwright/test";

const cookieName = "ezimage_first_touch";
const triggerKey = "ezimage.checkout-trigger.v1";

test.beforeEach(async ({ page, baseURL }) => {
	const origin = new URL(baseURL ?? "http://localhost:3000").origin;
	// These UI checks never submit authentication, generation, or real checkout.
	await page.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (url.origin !== origin) return route.abort();
		if (!url.pathname.startsWith("/api/")) return route.continue();
		if (url.pathname.endsWith("get-session"))
			return route.fulfill({ contentType: "application/json", body: "null" });
		if (
			url.pathname.includes("createCheckout") ||
			url.pathname.includes("createCreditPack") ||
			url.pathname.includes("createGeneration")
		)
			throw new Error("This attribution UI check must not create business actions");
		const json = url.pathname.endsWith("getPublicCatalog")
			? { products: [] }
			: url.pathname.endsWith("getPendingSubscriptionCheckout")
				? null
				: url.pathname.includes("ProviderAvailability")
					? { providers: [] }
					: [];
		return route.fulfill({ contentType: "application/json", body: JSON.stringify({ json }) });
	});
});

test("consented first touch survives content to pricing navigation and stores only safe source fields", async ({
	page,
	context,
}) => {
	test.setTimeout(120_000);
	await page.goto(
		"/blog/1980s-ai-photo?utm_source=google&utm_medium=cpc&utm_campaign=fall&token=private-token#private",
		{ referer: "https://www.google.com/search?token=private-referrer" },
	);
	await expect(page.getByRole("button", { name: "Allow optional", exact: true })).toBeVisible();
	expect((await context.cookies()).some((cookie) => cookie.name === cookieName)).toBe(false);
	await page.getByRole("button", { name: "Allow optional", exact: true }).click();
	await expect
		.poll(async () => (await context.cookies()).some((cookie) => cookie.name === cookieName))
		.toBe(true);
	const firstValue = (await context.cookies()).find((cookie) => cookie.name === cookieName)!.value;
	const first = JSON.parse(decodeURIComponent(firstValue));
	expect(first).toMatchObject({
		landingPath: "/blog/1980s-ai-photo",
		referrerOrigin: "https://www.google.com",
		source: "campaign",
		utmSource: "google",
		utmMedium: "cpc",
		utmCampaign: "fall",
	});
	expect(JSON.stringify(first)).not.toMatch(/private|token|\?|#/);
	await page.locator('a[href="/pricing"]:visible').first().click();
	await expect(page).toHaveURL(/\/pricing(?:\?|$)/);
	await expect
		.poll(() =>
			page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null")?.path, triggerKey),
		)
		.toBe("/blog/1980s-ai-photo");
	expect((await context.cookies()).find((cookie) => cookie.name === cookieName)?.value).toBe(
		firstValue,
	);
	await page.locator('a[href^="/pricing?plan=ultimate"]:visible').first().click();
	await expect(page.getByRole("dialog")).toBeVisible();
	expect(
		await page.evaluate(
			(key) => JSON.parse(sessionStorage.getItem(key) ?? "null")?.path,
			triggerKey,
		),
	).toBe("/blog/1980s-ai-photo");
	await page.screenshot({
		path: test.info().outputPath("content-purchase-trigger.png"),
		animations: "disabled",
	});
});

test("declined attribution remains absent across later public navigation", async ({
	page,
	context,
}) => {
	test.setTimeout(120_000);
	await page.goto("/blog/1980s-ai-photo?utm_source=google");
	await page.getByRole("button", { name: "Decline optional", exact: true }).click();
	await page.locator('a[href="/pricing"]:visible').first().click();
	await expect(page).toHaveURL(/\/pricing(?:\?|$)/);
	expect((await context.cookies()).some((cookie) => cookie.name === cookieName)).toBe(false);
	expect(await page.evaluate((key) => sessionStorage.getItem(key), triggerKey)).toBeNull();
	await page.reload();
	await expect(page.getByRole("button", { name: "Allow optional", exact: true })).toHaveCount(0);
	expect((await context.cookies()).some((cookie) => cookie.name === cookieName)).toBe(false);
});
