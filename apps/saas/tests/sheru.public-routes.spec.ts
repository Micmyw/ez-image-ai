import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

async function mockCatalog(page: Page) {
	await page.route("**/api/analytics/**", (route) => route.fulfill({ status: 204 }));
	const product = {
		key: "image-nano-banana-2",
		label: "Nano Banana 2",
		description: "Private image editing",
		credits: "9",
		accessHint: "paid-account",
		aspectRatios: ["1:1", "4:5"],
		skuMatrix: {
			defaultSkuKey: "nano-banana-2-1k",
			dimensions: [
				{ key: "resolution", label: "Resolution", options: [{ key: "1k", label: "1K" }] },
			],
			cells: [
				{
					skuKey: "nano-banana-2-1k",
					label: "1K",
					parameterValues: { resolution: "1k" },
					credits: 9,
					aspectRatios: ["1:1", "4:5"],
					controls: [
						{
							key: "outputFormat",
							label: "Format",
							defaultValue: "png",
							options: [{ key: "png", label: "PNG" }],
						},
					],
				},
			],
		},
	};
	const products = [
		product,
		{
			...product,
			key: "image-gpt-image-2-6-sunburst",
			label: "GPT Image 2.6 Sunburst",
			credits: "25",
			skuMatrix: {
				...product.skuMatrix,
				defaultSkuKey: "gpt-image-2-6-sunburst-1k",
				cells: [
					{ ...product.skuMatrix.cells[0], skuKey: "gpt-image-2-6-sunburst-1k", credits: 25 },
				],
			},
		},
	];
	await page.route("**/api/media/guest-capability", (route) =>
		route.fulfill({
			json: {
				version: "sheru-local-fixture",
				enabled: true,
				reason: null,
				upload: {
					mimeTypes: ["image/jpeg", "image/png", "image/webp"],
					maximumBytes: 10 * 1024 * 1024,
				},
				products,
				queueEstimate: { kind: "capacity" },
			},
		}),
	);
	await page.route("**/api/rpc/media/getPublicCatalog**", (route) =>
		route.fulfill({
			json: {
				json: {
					catalogVersion: "sheru-local-fixture",
					pricingVersion: "sheru-local-fixture",
					products: products.map((product) => ({
						...product,
						inputKinds: ["text-to-image", "image-to-image"],
					})),
				},
			},
		}),
	);
}

for (const width of [1440, 390, 320]) {
	test(`Sheru prepares a photo before offering paid access at ${width}px`, async ({
		page,
	}, testInfo) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width, height: 1000 });
		await page.emulateMedia({ reducedMotion: "reduce" });
		await mockCatalog(page);
		const generationRequests: string[] = [];
		await page.route("**/api/media/guest-*/**", (route) => {
			if (route.request().url().includes("/guest-generations"))
				generationRequests.push(route.request().url());
			return route.abort();
		});
		await page.goto("/");
		const feature = page.locator(".quick-start-feature");
		const recommendation = feature.locator('[data-quick-start="sheru-bhai"]');
		await expect(recommendation).toHaveAttribute("href", "/blog/sheru-bhai-ai-photo");
		await expect(recommendation).toContainText("Create your Sheru photo");
		await feature.scrollIntoViewIfNeeded();
		await expect
			.poll(() =>
				feature
					.locator("img")
					.evaluateAll(
						(images) =>
							images.length === 2 &&
							images.every(
								(img) =>
									(img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0,
							),
					),
			)
			.toBe(true);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
		await feature.screenshot({
			path: testInfo.outputPath(`sheru-home-${width}.png`),
			animations: "disabled",
		});
		if (width === 320) {
			await recommendation.focus();
			await recommendation.press("Enter");
		} else await recommendation.click();
		// The isolated development server compiles the destination on its first navigation.
		await expect(page).toHaveURL(/\/blog\/sheru-bhai-ai-photo$/, { timeout: 45_000 });
		await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sheru Bhai AI Photo Prompts");
		const rejectOptionalCookies = page.getByRole("button", {
			name: "Reject non-essential",
			exact: true,
		});
		if (await rejectOptionalCookies.isVisible()) await rejectOptionalCookies.click();
		await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "index, follow");
		await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
			"href",
			/\/blog\/sheru-bhai-ai-photo$/,
		);
		const coStar = page.getByRole("button", { name: "Photo with Sheru", exact: true });
		await expect(coStar).toHaveAttribute("aria-pressed", "true");
		const generator = page.locator('[data-test="landing-generator"]');
		await expect(generator.locator("textarea")).toBeEditable();
		await expect(page.getByRole("button", { name: /copy.*prompt/i })).toHaveCount(0);
		await expect(page.locator(".illustrated-prompts")).toHaveCount(0);
		const chooser = page.waitForEvent("filechooser");
		await generator.locator('[data-test="landing-generate"]').click();
		expect((await chooser).isMultiple()).toBe(false);
		await page
			.locator("#landing-source-image")
			.setInputFiles(
				path.resolve(__dirname, "../public/images/effects/sheru-bhai-ai-photo/with-sheru.webp"),
			);
		await expect(page.locator('[data-test="landing-source-panel"] img')).toBeVisible();
		await page.getByRole("button", { name: "Turn me into Sheru", exact: true }).click();
		await expect(generator.locator("textarea")).toBeEditable();

		await expect(page.locator('[data-test="landing-source-panel"] img')).toBeVisible();
		await expect(page.locator('[data-test="paid-template-dialog"]')).toHaveCount(0);
		await expect(page.locator(".effect-style-preview img")).toHaveAttribute("src", /become-sheru/);
		await expect(page.locator(".effect-style-preview img")).toBeVisible();
		await expect
			.poll(() =>
				page
					.locator(".effect-style-preview img")
					.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
			)
			.toBe(true);
		await expect(page.locator(".effect-style-preview figcaption")).toContainText(
			"made separately from the editor",
		);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
		await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
		await page.screenshot({
			path: testInfo.outputPath(`sheru-${width}.png`),
			fullPage: true,
			animations: "disabled",
		});
		await generator.locator("textarea").fill("Keep my pose and add warm coastal lighting.");
		await generator.locator('[data-test="landing-model-trigger"]').click();
		await page.getByRole("button", { name: "GPT Image", exact: true }).click();
		await page.locator('[data-test="landing-model-image-gpt-image-2-6-sunburst"]').click();
		await expect(generator.locator("textarea")).toHaveValue(
			"Keep my pose and add warm coastal lighting.",
		);
		await generator.locator('[data-test="landing-generate"]').click();
		const dialog = page.locator('[data-test="paid-template-dialog"]');
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText("$2.99");
		await expect(dialog).toContainText("3");
		await expect
			.poll(() => dialog.evaluate((element) => element.getBoundingClientRect().width))
			.toBeLessThanOrEqual(448);
		await expect(dialog).toHaveCSS("opacity", "1");
		await page.screenshot({
			path: testInfo.outputPath(`sheru-payment-${width}.png`),
			animations: "disabled",
		});
		await dialog.getByRole("button", { name: "Keep editing" }).click();
		await expect(dialog).toHaveCount(0);
		await expect(generator.locator("textarea")).toBeEditable();

		await expect(page.locator('[data-test="landing-source-panel"] img')).toBeVisible();
		expect(generationRequests).toEqual([]);
	});
}
