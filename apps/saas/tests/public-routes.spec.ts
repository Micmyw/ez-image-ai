import { expect, test } from "@playwright/test";

const indexableRoutes = ["/", "/pricing", "/privacy", "/terms", "/blog"] as const;
const noindexRoutes = ["/changelog", "/contact", "/create"] as const;
const requiredFooterRoutes = [
	"/image-to-image",
	"/privacy",
	"/terms",
	"/blog",
	"/changelog",
	"/contact",
	"/docs",
] as const;
const baseUrl = process.env.NEXT_PUBLIC_SAAS_URL ?? "http://localhost:3000";
const legacyRedirects: ReadonlyArray<{ from: string; to: string }> = [
	{ from: "/legal/privacy-policy", to: "/privacy" },
	{ from: "/legal/terms", to: "/terms" },
	...(["de", "es", "fr"] as const).flatMap((locale) => [
		{ from: `/${locale}`, to: "/" },
		{ from: `/${locale}/docs/quick-start`, to: "/docs/quick-start" },
	]),
];

test.use({ storageState: { cookies: [], origins: [] } });

async function mockPublicImageAvailability(page: import("@playwright/test").Page) {
	const product = {
		key: "image-nano-banana-2-lite",
		label: "Nano Banana 2 Lite",
		description: "Fast private image editing",
		credits: "5",
		accessHint: "guest-trial",
		aspectRatios: ["auto", "1:1"],
		skuMatrix: {
			defaultSkuKey: "nano-banana-2-lite-1k",
			dimensions: [
				{ key: "resolution", label: "Resolution", options: [{ key: "1k", label: "1K" }] },
			],
			cells: [
				{
					skuKey: "nano-banana-2-lite-1k",
					label: "1K",
					parameterValues: { resolution: "1k" },
					credits: 5,
					aspectRatios: ["auto", "1:1"],
					controls: [],
				},
			],
		},
	};
	await page.route("**/api/media/guest-capability", (route) =>
		route.fulfill({
			json: {
				version: "image-to-image-e2e",
				enabled: true,
				reason: null,
				upload: {
					mimeTypes: ["image/jpeg", "image/png", "image/webp"],
					maximumBytes: 10 * 1024 * 1024,
				},
				products: [product],
				queueEstimate: { kind: "capacity" },
			},
		}),
	);
	await page.route("**/api/rpc/media/getPublicCatalog**", (route) =>
		route.fulfill({
			json: {
				json: {
					catalogVersion: "image-to-image-e2e",
					pricingVersion: "image-to-image-e2e",
					products: [{ ...product, inputKinds: ["text-to-image", "image-to-image"] }],
				},
			},
		}),
	);
}

test.describe("image-to-image landing page", () => {
	test.use({ contextOptions: { reducedMotion: "reduce" } });
	test.beforeEach(async ({ page }) => {
		await mockPublicImageAvailability(page);
	});

	for (const width of [1440, 390]) {
		test(`has focused metadata and requires an image at ${width}px`, async ({ page, context }) => {
			test.setTimeout(90_000);
			await page.setViewportSize({ width, height: 900 });
			await context.addCookies([
				{ name: "NEXT_LOCALE", value: "de", url: new URL(baseUrl).origin },
			]);
			await expectPublicPage(page, "/image-to-image", "index");
			await expect(page.locator("html")).toHaveAttribute("lang", "en");
			await expect(page).toHaveTitle("Image to Image AI Generator | EzImageAI");
			await expect(page.getByRole("heading", { level: 1 })).toHaveText(
				"Image to Image AI Generator",
			);
			await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
				"content",
				await page.title(),
			);
			const schemas = await page
				.locator('script[type="application/ld+json"]')
				.evaluateAll((scripts) =>
					scripts.flatMap((script) => {
						const data = JSON.parse(script.textContent ?? "{}");
						return data["@graph"] ?? [data];
					}),
				);
			expect(schemas).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						"@type": "BreadcrumbList",
						itemListElement: expect.arrayContaining([
							expect.objectContaining({
								position: 2,
								name: "Image to Image AI",
								item: new URL("/image-to-image", baseUrl).href,
							}),
						]),
					}),
				]),
			);
			const action = page.locator('[data-test="landing-generate"]');
			await expect(page.locator('[data-test="landing-model-trigger"]')).toContainText(
				"Nano Banana 2 Lite",
			);
			await page.getByRole("button", { name: "Use this prompt" }).first().click();
			await expect(page.locator("textarea")).toHaveValue(/Keep the product, its shape/);
			await expect(page.getByRole("heading", { level: 1 })).toBeInViewport();
			await expect(action).toBeDisabled();
			await expect(page.locator("#landing-source-image")).toHaveAttribute(
				"aria-label",
				"Reference image · required",
			);
			await expect(
				page.locator('[data-test="landing-source-panel"] button'),
			).not.toHaveAccessibleName(/optional/i);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
				true,
			);
			await page.screenshot({
				path: test.info().outputPath(`image-to-image-${width}-viewport.png`),
			});
			await page.screenshot({
				path: test.info().outputPath(`image-to-image-${width}.png`),
				fullPage: true,
			});
			await page.locator("#landing-source-image").setInputFiles({
				name: "reference.png",
				mimeType: "image/png",
				buffer: Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
					"base64",
				),
			});
			await expect(page.getByRole("img", { name: /preview of reference.png/i })).toBeVisible();
			await expect(action).toBeEnabled();
			await page.getByRole("button", { name: /remove image/i }).click();
			await expect(action).toBeDisabled();
		});
	}

	for (const locale of ["de", "es", "fr"]) {
		test(`keeps the ${locale} interface noindex with an English canonical`, async ({ page }) => {
			const response = await page.goto(`/image-to-image?lang=${locale}`);
			expect(response?.status()).toBe(200);
			expect(response?.headers()["x-robots-tag"]).toBe("noindex, follow");
			await expect(page.locator("html")).toHaveAttribute("lang", locale);
			await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
			await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(
				"Image to Image AI Generator",
			);
			await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
				"href",
				new URL("/image-to-image", baseUrl).href,
			);
		});
	}
});

test.describe("consolidated public routes", () => {
	for (const path of indexableRoutes) {
		test(`${path} is an indexable same-origin page`, async ({ page }) => {
			if (path === "/") {
				test.setTimeout(90_000);
				await mockPublicImageAvailability(page);
			}
			const response = await expectPublicPage(page, path, "index");
			if (path === "/") {
				const html = await response!.text();
				const initialHeading = html.match(/<h1(?:\s|>)[\s\S]*?<\/h1>/)?.[0] ?? "";
				expect(initialHeading.replace(/<[^>]*>/g, "")).toMatch(/ai image editor no restrictions/i);
				expect(html).toContain("flexible prompt editing");
				expect(html).toContain("AI image editor with prompt no restrictions");
				await expect(page).toHaveTitle(/AI Image Editor No Restrictions/);
				await expect(page.locator('meta[name="description"]')).toHaveAttribute(
					"content",
					"AI image editor no restrictions: edit photos with prompts beyond fixed templates. Private images and clear credits; safety and usage limits apply.",
				);
				await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
					"content",
					await page.title(),
				);
				const explanation = page.locator("#faq details").filter({
					hasText: "What does “AI image editor with prompt no restrictions” mean on EzImageAI?",
				});
				await explanation.locator("summary").click();
				await expect(explanation.locator("p")).toBeVisible();
				await expect(explanation).toContainText("model capabilities, and plan limits still apply");
				for (const width of [1440, 390]) {
					await page.setViewportSize({ width, height: 900 });
					await page.getByRole("heading", { level: 1 }).scrollIntoViewIfNeeded();
					const intro = page.locator("#image-editor h1 ~ p");
					await expect(intro).toHaveCount(1);
					await expect(intro).toHaveText("Upload an image and describe the change you want.");
					await expect(intro).toBeVisible();
					expect(
						await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
					).toBe(true);
					await page.screenshot({ path: test.info().outputPath(`seo-home-${width}.png`) });
				}
			}
		});
	}

	for (const path of noindexRoutes) {
		test(`${path} is public but excluded from indexing`, async ({ page }) => {
			await expectPublicPage(page, path, "noindex");
		});
	}

	test("the landing footer exposes every public destination", async ({ page }) => {
		await mockPublicImageAvailability(page);
		await page.goto("/");
		const footer = page.getByRole("contentinfo");
		await expect(footer).toBeVisible();

		for (const path of requiredFooterRoutes) {
			await expect(
				footer.locator(`a[href="${path}"]`),
				`missing footer link ${path}`,
			).toBeVisible();
		}
	});

	test("pricing defaults to yearly and exposes three subscriptions plus four credit packs", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto("/pricing");
		const intervalFieldset = page.getByRole("group", {
			name: "Monthly, Yearly, Credit Packs",
		});
		const monthly = page.locator('[data-test="public-pricing-interval-month"]');
		const yearly = page.locator('[data-test="public-pricing-interval-year"]');
		const creditPacksTab = page.locator('[data-test="public-pricing-credit-packs-tab"]');

		await expect(yearly).toHaveAttribute("aria-pressed", "true");
		await expect(monthly).toHaveAttribute("aria-pressed", "false");
		await expect(yearly).toContainText("-17%");
		await expect(intervalFieldset).toBeVisible();
		const intervalWidths = await intervalFieldset.evaluate((element) => ({
			clientWidth: element.clientWidth,
			scrollWidth: element.scrollWidth,
		}));
		expect(intervalWidths.scrollWidth).toBeLessThanOrEqual(intervalWidths.clientWidth);
		await expect(page.locator('[data-test="public-pricing-plan"]')).toHaveCount(3);
		await expect(
			page.locator('[data-test="public-pricing-plan"][data-plan-id="creator"]'),
		).toContainText("Pro");
		await expect(
			page.locator('[data-test="public-pricing-plan"][data-plan-id="ultimate"]'),
		).toContainText("Ultimate");
		await expect(
			page.locator('[data-test="public-pricing-plan"][data-plan-id="studio"]'),
		).toContainText("Max");
		await expect(page.locator('[data-test="public-pricing-creator-price"]')).toHaveText("$15.83");
		await expect(page.locator('[data-test="public-pricing-ultimate-price"]')).toHaveText("$40.83");
		await expect(page.locator('[data-test="public-pricing-studio-price"]')).toHaveText("$65.83");
		await expect(page.locator('[data-test="public-pricing-creator-annual-summary"]')).toContainText(
			/\$190.*\$38.*17%.*12 monthly payments/,
		);
		await expect(
			page.locator('[data-test="public-pricing-ultimate-annual-summary"]'),
		).toContainText(/\$490.*\$98.*17%.*12 monthly payments/);
		await expect(page.locator('[data-test="public-pricing-studio-annual-summary"]')).toContainText(
			/\$790.*\$158.*17%.*12 monthly payments/,
		);

		await monthly.click();
		await expect(monthly).toHaveAttribute("aria-pressed", "true");
		await expect(page.locator('[data-test="public-pricing-creator-price"]')).toHaveText("$19");
		await expect(page.locator('[data-test="public-pricing-ultimate-price"]')).toHaveText("$49");
		await expect(page.locator('[data-test="public-pricing-studio-price"]')).toHaveText("$79");

		await creditPacksTab.click();
		await expect(creditPacksTab).toHaveAttribute("aria-pressed", "true");
		await expect(page.locator("#public-subscription-pricing")).toBeHidden();
		await expect(page.locator('[data-test="public-pricing-credit-packs"]')).toBeVisible();
		await expect(page.locator('[data-test="public-credit-pack"]')).toHaveCount(4);

		for (const pack of [
			{ key: "credits-1500", base: "1,500", subscriber: "1,800", price: "$59" },
			{ key: "credits-3000", base: "3,000", subscriber: "3,600", price: "$109" },
			{ key: "credits-5000", base: "5,000", subscriber: "6,000", price: "$169" },
			{ key: "credits-8000", base: "8,000", subscriber: "9,600", price: "$259" },
		] as const) {
			const card = page.locator(`[data-test="public-credit-pack"][data-pack-key="${pack.key}"]`);
			await expect(card).toContainText(`${pack.base} Credits`);
			await expect(card).toContainText(pack.price);
			await expect(card).toContainText(`Subscribers receive ${pack.subscriber} credits`);
			await expect(card).toContainText("Valid for 6 months");
		}
	});

	test("the Blog exposes at least one factual article at a stable route", async ({ page }) => {
		await page.goto("/blog");
		const articleLink = page.locator('main a[href^="/blog/"]').first();
		await expect(articleLink).toBeVisible();
		const href = await articleLink.getAttribute("href");
		expect(href).toMatch(/^\/blog\/[a-z0-9][a-z0-9/-]*$/);
		await expectPublicPage(page, href!, "index");
		await expect(page.locator("main")).not.toContainText(
			/acme|lorem ipsum|favorite things|awesome second post/i,
		);
	});

	test("contact fails closed to a configured mail link and never renders a form", async ({
		page,
	}) => {
		await page.goto("/contact");
		await expect(page.locator("form")).toHaveCount(0);
		const configuredEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim();
		const mailLinks = page.locator('a[href^="mailto:"]');
		const mailHrefs = await mailLinks.evaluateAll((links) =>
			links.map((link) => link.getAttribute("href")),
		);
		if (configuredEmail) {
			expect(mailHrefs.length).toBeGreaterThan(0);
			for (const href of mailHrefs) {
				const target = new URL(href!);
				expect(target.protocol).toBe("mailto:");
				expect(decodeURIComponent(target.pathname)).toBe(configuredEmail);
			}
		} else {
			expect(mailHrefs).toEqual([]);
		}
	});

	test("the OpenAPI reference remains available at /api/docs", async ({ request }) => {
		const response = await request.get("/api/docs");
		expect(response.status()).toBe(200);
		expect(response.headers()["content-type"]).toContain("text/html");
		expect(await response.text()).toMatch(/EzImageAI/i);
	});

	test("public legal pages stay English regardless of the account locale cookie", async ({
		browser,
	}) => {
		const context = await browser.newContext({
			baseURL: baseUrl,
			storageState: { cookies: [], origins: [] },
		});
		try {
			const page = await context.newPage();
			const cookieUrl = new URL(baseUrl).origin;

			await context.addCookies([{ name: "NEXT_LOCALE", value: "de", url: cookieUrl }]);
			const privacyResponse = await page.goto("/privacy");
			expect(privacyResponse?.status()).toBe(200);
			expect(new URL(page.url()).pathname).toBe("/privacy");
			await expect(page.locator("html")).toHaveAttribute("lang", "en");
			await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
			await expect(
				page.getByRole("heading", { level: 2, name: "Private media and access" }),
			).toBeVisible();

			await context.addCookies([{ name: "NEXT_LOCALE", value: "es", url: cookieUrl }]);
			const termsResponse = await page.goto("/terms");
			expect(termsResponse?.status()).toBe(200);
			expect(new URL(page.url()).pathname).toBe("/terms");
			await expect(page.locator("html")).toHaveAttribute("lang", "en");
			await expect(page.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeVisible();
			await expect(
				page.getByRole("heading", { level: 2, name: "Accounts and the editing workflow" }),
			).toBeVisible();
		} finally {
			await context.close();
		}
	});

	for (const redirect of legacyRedirects) {
		test(`${redirect.from} permanently redirects to ${redirect.to}`, async ({ request }) => {
			const response = await request.get(redirect.from, { maxRedirects: 0 });
			expect(response.status()).toBe(308);
			const location = response.headers().location;
			expect(location).toBeDefined();
			expect(new URL(location!, baseUrl).pathname).toBe(redirect.to);
			expect(new URL(location!, baseUrl).origin).toBe(new URL(baseUrl).origin);
		});
	}
});

async function expectPublicPage(
	page: import("@playwright/test").Page,
	path: string,
	indexing: "index" | "noindex",
) {
	const response = await page.goto(path);
	expect(response?.status()).toBe(200);
	expect(new URL(page.url()).pathname).toBe(path);
	await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);

	const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
	expect(canonical).not.toBeNull();
	expect(new URL(canonical!).origin).toBe(new URL(baseUrl).origin);
	expect(new URL(canonical!).pathname).toBe(path);

	const robots = (await page.locator('meta[name="robots"]').getAttribute("content")) ?? "";
	const directives = new Set(
		robots
			.split(",")
			.map((directive) => directive.trim().toLowerCase())
			.filter(Boolean),
	);
	expect(directives.has(indexing)).toBe(true);
	expect(directives.has("follow")).toBe(true);
	if (indexing === "index") expect(directives.has("noindex")).toBe(false);
	return response;
}
