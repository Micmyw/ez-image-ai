import { expect, test } from "@playwright/test";

const HOME_TITLE = "AI Image Editor No Restrictions — Edit Images with Prompts | EzPic";
const HOME_H1 = "AI Image Editor With Prompts, Without the Usual Restrictions";
const HOME_DESCRIPTION =
	"Upload an image and describe the change. Edit backgrounds, objects, colors, lighting and styles with private AI image editing and transparent credits. Start with free credits.";

test.describe("home page", () => {
	test("serves the exact homepage metadata, one H1, canonical, and accurate JSON-LD", async ({
		page,
	}) => {
		await page.goto("/");

		await expect(page).toHaveTitle(HOME_TITLE);
		await expect(page.locator('meta[name="description"]')).toHaveAttribute(
			"content",
			HOME_DESCRIPTION,
		);
		const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
		expect(canonical).not.toBeNull();
		expect(new URL(canonical!).origin).toBe(new URL(page.url()).origin);
		expect(new URL(canonical!).pathname).toBe("/");
		await expect(page.getByRole("heading", { level: 1, name: HOME_H1 })).toBeVisible();
		await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
		await expect
			.poll(() =>
				page
					.locator('img[src^="/examples/"]')
					.evaluateAll(
						(images: HTMLImageElement[]) =>
							images.length > 0 &&
							images.every((image) => image.complete && image.naturalWidth > 0),
					),
			)
			.toBe(true);

		const schemas = await page.locator('script[type="application/ld+json"]').allTextContents();
		expect(schemas).toHaveLength(1);
		const schemaText = schemas[0] ?? "";
		expect(JSON.parse(schemaText)).toMatchObject({
			"@context": "https://schema.org",
			"@graph": [
				{ "@type": "WebSite", name: "EzPic" },
				{ "@type": "SoftwareApplication", name: "EzPic", operatingSystem: "Web" },
			],
		});
		expect(schemaText).not.toMatch(
			/"(?:provider|modelId|(?:aggregate)?rating|review|offers?|price)"\s*:/i,
		);

		await expect(page.locator('[data-test="color-mode-toggle"]')).toBeVisible();
	});

	test("renders the PR 3 modules in the required user-journey order", async ({ page }) => {
		await page.goto("/");

		const expectedOrder = [
			"image-editor",
			"before-after",
			"examples",
			"no-restrictions",
			"how-it-works",
			"trust",
			"pricing",
			"faq",
			"final-cta",
		];
		const actualOrder = await page
			.locator("main section[id]")
			.evaluateAll((sections) => sections.map((section) => section.id));

		expect(actualOrder).toEqual(expectedOrder);
		const publicCopy = await page.locator("main").innerText();
		expect(publicCopy).not.toMatch(
			/\b(?:video|unlimited|uncensored|free forever|no usage limits|4k|watermark[- ]free)\b/i,
		);
	});

	for (const viewport of [
		{ name: "mobile", width: 390, height: 844 },
		{ name: "tablet", width: 768, height: 1024 },
		{ name: "desktop", width: 1440, height: 900 },
	]) {
		test(`keeps the editor usable and captures ${viewport.name} responsive evidence`, async ({
			page,
		}, testInfo) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height });
			await page.goto("/");
			await expect(page.getByRole("heading", { level: 1, name: HOME_H1 })).toBeVisible();
			await expect(page.getByRole("main")).toBeVisible();
			await expect(page.getByLabel(/source image/i)).toBeAttached();
			await expect(page.getByLabel(/describe your edit/i)).toBeVisible();
			await expect(page.getByRole("radiogroup", { name: /edit mode/i })).toBeVisible();
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
			).toBe(true);

			await testInfo.attach(`homepage-${viewport.name}`, {
				body: await page.screenshot({ fullPage: true }),
				contentType: "image/png",
			});
		});
	}
});
