import { expect, test } from "@playwright/test";

const marketingUrl = process.env.NEXT_PUBLIC_MARKETING_URL ?? "http://localhost:3001";
const approvedPaths = ["/", "/pricing", "/privacy", "/terms"] as const;

test.describe("English-only index boundary", () => {
	for (const path of approvedPaths) {
		test(`${path} is indexable with its configured production canonical`, async ({ page }) => {
			await page.goto(path);
			await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
				"content",
				/index,\s*follow/i,
			);
			const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
			expect(canonical).not.toBeNull();
			expect(new URL(canonical!).origin).toBe(new URL(marketingUrl).origin);
			expect(new URL(canonical!).pathname).toBe(path);
			await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
		});
	}

	for (const path of ["/de", "/de/pricing", "/de/privacy", "/de/terms"]) {
		test(`${path} stays outside the index`, async ({ page }) => {
			await page.goto(path);
			await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
				"content",
				/noindex,\s*follow/i,
			);
		});
	}

	test("sitemap and robots expose exactly the approved English URLs", async ({ request }) => {
		const sitemap = await request.get("/sitemap.xml");
		expect(sitemap.ok()).toBe(true);
		const sitemapText = await sitemap.text();
		const urls = [...sitemapText.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => {
			const url = new URL(match[1]!);
			return `${url.origin}${url.pathname}`;
		});
		expect(urls).toEqual(
			approvedPaths.map((path) => {
				const url = new URL(path, marketingUrl);
				return `${url.origin}${url.pathname}`;
			}),
		);
		expect(sitemapText).not.toMatch(
			/\/(?:de|es|fr|login|history|assets|edits|checkout|admin)(?:\/|<)/,
		);

		const robots = await request.get("/robots.txt");
		expect(robots.ok()).toBe(true);
		const robotsText = await robots.text();
		expect(robotsText).toContain("User-Agent: *");
		expect(robotsText).toContain("Allow: /");
		expect(robotsText).toContain(`Sitemap: ${new URL("/sitemap.xml", marketingUrl).href}`);
	});

	test("GSC verification fails closed when no valid configured token exists", async ({ page }) => {
		await page.goto("/");
		const configuredToken = process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION?.trim();
		const validToken = configuredToken && /^[A-Za-z0-9_-]{30,128}$/.test(configuredToken);
		if (validToken) {
			await expect(page.locator('meta[name="google-site-verification"]')).toHaveAttribute(
				"content",
				configuredToken,
			);
		} else {
			await expect(page.locator('meta[name="google-site-verification"]')).toHaveCount(0);
		}
	});
});
