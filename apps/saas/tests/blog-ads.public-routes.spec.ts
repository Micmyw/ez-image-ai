import { expect, test } from "@playwright/test";

import { expectNoAdvertising, watchAdFreeBrowsing } from "./helpers/ad-free-browsing";

const articlePath = "/blog/tesco-ai-meal-planning-assistant";
const baseUrl = process.env.NEXT_PUBLIC_SAAS_URL ?? "http://localhost:3000";
const articlePaths = [
	"/blog/private-image-editing-workflow",
	"/blog/ai-image-editing-prompts",
	articlePath,
];

test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: "block" });

// Removed advertising controls and preview query parameters must not leave requests
// or layout slots behind, even after a route reload or a mobile viewport change.
for (const width of [1440, 390]) {
	test(`blog articles have no advertising requests or empty slots at ${width}px`, async ({
		page,
	}, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		const observed = await watchAdFreeBrowsing(page, baseUrl);
		for (const path of articlePaths) {
			for (const query of ["", "?blogAdTest=banner", "?blogAdTest=native"]) {
				const response = await page.goto(`${path}${query}`);
				expect(response?.status()).toBe(200);
				const csp = response?.headers()["content-security-policy"] ?? "";
				expect(csp).not.toMatch(/ads\.ezimageai\.com|highrevenueformat|profitableratecpmnetwork/);
				expect(csp).toContain("https://www.clarity.ms");
				await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
				await page.locator("[data-footer-navigation]").scrollIntoViewIfNeeded();
				await expectNoAdvertising(page, observed);
			}
		}
		await page.reload();
		await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
		await expectNoAdvertising(page, observed);
		await testInfo.attach("ad-free-blog-network.json", {
			body: JSON.stringify(observed, null, 2),
			contentType: "application/json",
		});
	});
}

test("publishes one canonical article with metadata, factual boundaries and an official source", async ({
	page,
	request,
}) => {
	test.setTimeout(60_000);
	const evidence = await watchAdFreeBrowsing(page, baseUrl);
	const response = await page.goto(articlePath);
	expect(response?.status()).toBe(200);
	const title = "Tesco AI Meal Planner: What the 2026 Rollout Confirms";
	const description =
		"Tesco reports a wider AI meal planner rollout from September 2026. See the confirmed timeline, access unknowns and difference from Your Clubcard Prices.";
	const canonical = new URL(articlePath, baseUrl).href;
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
	await expect(page).toHaveTitle(`${title} | EzImageAI`);
	await expect(page.locator('meta[name="description"]')).toHaveCount(1);
	await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", description);
	await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
	await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", canonical);
	await expect(page.locator('meta[property="og:type"]')).toHaveAttribute("content", "article");
	await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
		"content",
		`${title} | EzImageAI`,
	);
	const schemas = await page.locator('script[type="application/ld+json"]').evaluateAll((scripts) =>
		scripts.flatMap((script) => {
			const data = JSON.parse(script.textContent ?? "{}");
			return data["@graph"] ?? [data];
		}),
	);
	expect(schemas).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				"@type": "BlogPosting",
				url: canonical,
				headline: title,
				description,
				datePublished: "2026-10-11",
				inLanguage: "en",
			}),
			expect.objectContaining({
				"@type": "BreadcrumbList",
				itemListElement: expect.arrayContaining([
					expect.objectContaining({ position: 3, name: title, item: canonical }),
				]),
			}),
		]),
	);
	const body = page.locator(".blog-prose");
	await expect(body).toContainText("April 2026");
	await expect(body).toContainText("September 2026");
	await expect(body).toContainText("Your Clubcard Prices");
	await expect(body).toContainText(
		"2.5 million customers; this is not a meal-assistant access count",
	);
	await expect(body).toContainText("We have not tested the feature in a live Tesco account");
	await expect(body).not.toContainText(
		/all 23 million.*(?:access|available)|every Clubcard member has access/i,
	);
	await expect(
		page.locator('.blog-sources a[href="https://www.tescoplc.com/interim-results-202627/"]'),
	).toHaveCount(1);
	await expect(body).toContainText("11 October 2026");
	const sitemap = await request.get("/sitemap.xml");
	expect(sitemap.status()).toBe(200);
	expect(await sitemap.text()).toContain(`<loc>${canonical}</loc>`);
	await expectNoAdvertising(page, evidence);
	const screenshotPath = test.info().outputPath("tesco-ai-news-article.png");
	await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" });
	await test.info().attach("tesco-ai-news-article", {
		path: screenshotPath,
		contentType: "image/png",
	});
});

test("AI News filters populated articles and its query URL follows the existing noindex rule", async ({
	page,
}) => {
	const evidence = await watchAdFreeBrowsing(page, baseUrl);
	await page.goto("/blog");
	const filter = page.getByRole("button", { name: "AI News", exact: true });
	await filter.click();
	await expect(filter).toHaveAttribute("aria-pressed", "true");
	await expect(page.locator(`.blog-grid h2 a[href="${articlePath}"]`)).toBeVisible();
	const labels = await page.locator(".blog-grid .blog-card .blog-category").allTextContents();
	expect(labels.length).toBeGreaterThan(0);
	expect(labels.every((label) => label === "AI News")).toBe(true);
	await expectNoAdvertising(page, evidence);
	const response = await page.goto("/blog?category=ai-news");
	expect(response?.status()).toBe(200);
	await expect(page.getByRole("button", { name: "AI News", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.locator(`.blog-grid h2 a[href="${articlePath}"]`)).toBeVisible();
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
	await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
		"href",
		new URL("/blog", baseUrl).href,
	);
	await expect(page.locator("[data-blog-ads]")).toHaveCount(0);
	await expectNoAdvertising(page, evidence);
});
