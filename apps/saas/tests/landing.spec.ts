import { gzipSync } from "node:zlib";

import { expect, type Locator, type Page, test } from "@playwright/test";

const ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const capability = {
	version: "landing-e2e-v2",
	enabled: true,
	reason: null,
	upload: {
		mimeTypes: ["image/jpeg", "image/png", "image/webp"],
		maximumBytes: 10 * 1024 * 1024,
	},
	products: [
		{
			key: "image-nano-banana-2-lite",
			label: "Nano Banana 2 Lite",
			description: "Fast private 1K image editing",
			credits: "5",
			accessHint: "guest-trial",
			aspectRatios: ["auto", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9"],
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
						aspectRatios: ["auto", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9"],
						controls: [],
					},
				],
			},
		},
		{
			key: "image-gpt-image-2",
			label: "GPT Image 2",
			description: "Detailed private image editing with 1K, 2K, and 4K options",
			credits: "7",
			accessHint: "paid-account",
			aspectRatios: [
				"auto",
				"1:1",
				"3:2",
				"2:3",
				"4:3",
				"3:4",
				"5:4",
				"4:5",
				"16:9",
				"9:16",
				"2:1",
				"1:2",
				"3:1",
				"1:3",
				"21:9",
				"9:21",
			],
			skuMatrix: {
				defaultSkuKey: "gpt-image-2-1k",
				dimensions: [
					{
						key: "resolution",
						label: "Resolution",
						options: [
							{ key: "1k", label: "1K" },
							{ key: "2k", label: "2K" },
							{ key: "4k", label: "4K" },
						],
					},
				],
				cells: [
					{
						skuKey: "gpt-image-2-1k",
						label: "1K",
						parameterValues: { resolution: "1k" },
						credits: 7,
						aspectRatios: [
							"auto",
							"1:1",
							"3:2",
							"2:3",
							"4:3",
							"3:4",
							"5:4",
							"4:5",
							"16:9",
							"9:16",
							"2:1",
							"1:2",
							"3:1",
							"1:3",
							"21:9",
							"9:21",
						],
						controls: [
							{
								key: "background",
								label: "Background",
								defaultValue: "opaque",
								options: [
									{ key: "auto", label: "Automatic" },
									{ key: "opaque", label: "Opaque" },
									{ key: "transparent", label: "Transparent" },
								],
							},
						],
					},
					{
						skuKey: "gpt-image-2-2k",
						label: "2K",
						parameterValues: { resolution: "2k" },
						credits: 11,
						aspectRatios: ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "2:1", "1:2", "21:9"],
						controls: [],
					},
					{
						skuKey: "gpt-image-2-4k",
						label: "4K",
						parameterValues: { resolution: "4k" },
						credits: 17,
						aspectRatios: [
							"3:2",
							"2:3",
							"4:3",
							"3:4",
							"4:5",
							"5:4",
							"16:9",
							"9:16",
							"2:1",
							"1:2",
							"21:9",
						],
						controls: [],
					},
				],
			},
		},
		{
			key: "image-seedream-5-pro",
			label: "Seedream 5 Pro",
			description: "Private image editing with Basic and High options",
			credits: "8",
			accessHint: "paid-account",
			aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"],
			skuMatrix: {
				defaultSkuKey: "seedream-5-pro-basic-1k",
				dimensions: [
					{
						key: "resolution",
						label: "Resolution",
						options: [
							{ key: "1k", label: "1K" },
							{ key: "2k", label: "2K" },
						],
					},
					{
						key: "quality",
						label: "Quality",
						options: [
							{ key: "basic", label: "Basic" },
							{ key: "high", label: "High" },
						],
					},
				],
				cells: [
					{
						skuKey: "seedream-5-pro-basic-1k",
						label: "1K · Basic",
						parameterValues: { resolution: "1k", quality: "basic" },
						credits: 8,
						aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"],
						controls: [
							{
								key: "outputFormat",
								label: "Output format",
								defaultValue: "png",
								options: [
									{ key: "png", label: "PNG" },
									{ key: "jpeg", label: "JPEG" },
								],
							},
						],
					},
					{
						skuKey: "seedream-5-pro-high-2k",
						label: "2K · High",
						parameterValues: { resolution: "2k", quality: "high" },
						credits: 15,
						aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"],
						controls: [
							{
								key: "outputFormat",
								label: "Output format",
								defaultValue: "png",
								options: [
									{ key: "png", label: "PNG" },
									{ key: "jpeg", label: "JPEG" },
								],
							},
						],
					},
				],
			},
		},
	],
	queueEstimate: { kind: "capacity" },
} as const;

test.beforeEach(async ({ page }) => {
	await page.route("**/api/rpc/media/getPublicCatalog**", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				json: {
					catalogVersion: "2026-09-14.1",
					pricingVersion: "2026-09-13.2",
					products: capability.products.map((product) => ({
						...product,
						inputKinds: ["text-to-image", "image-to-image"],
					})),
				},
			}),
		}),
	);
	await page.route("**/api/media/guest-capability", async (route) => {
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify(capability),
		});
	});
});

for (const width of [1440, 390]) {
	test(`tool navigation opens a guest workspace and preserves edits while selecting models at ${width}px`, async ({
		page,
	}) => {
		// This journey compiles several routes on a fresh local Next.js dev server.
		test.setTimeout(90_000);
		await page.setViewportSize({ width, height: 1000 });
		await page.route("**/api/rpc/media/getPublicCatalog**", (route) =>
			route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({
					json: {
						catalogVersion: "2026-09-07.2",
						pricingVersion: "2026-09-13.1",
						products: capability.products.map((product) => ({
							...product,
							inputKinds: ["text-to-image", "image-to-image"],
						})),
					},
				}),
			}),
		);
		await page.goto("/");
		await expect(page.locator('[data-test="landing-model-trigger"]')).toContainText(
			"Nano Banana 2 Lite",
		);
		await expect(page.locator(".studio-sidebar")).toHaveCount(0);
		const menu =
			width <= 1200
				? page.locator('[data-test="header-navigation-drawer"]')
				: page.locator(".studio-navigation-popover");
		if (width <= 1200) {
			await page.locator('[data-test="header-navigation-trigger"]').click();
			await menu.locator("summary").filter({ hasText: "AI Models" }).click();
		} else {
			await page.locator('[data-test="studio-models-menu"]').click();
		}
		await menu.locator('a[href="/models/gpt-image-2"]').click();
		await expect(page).toHaveURL(/\/models\/gpt-image-2$/, { timeout: 30_000 });
		await page.goto("/create?model=image-gpt-image-2");
		await expect(page.locator('[data-test="landing-model-trigger"]')).toContainText("GPT Image 2");
		await expect(page.locator('a[href^="/settings"]')).toHaveCount(0);
		await expect(page.locator('a[href="/history"]')).toHaveCount(0);
		await page
			.locator("#landing-edit-prompt")
			.fill("Keep this prompt and source while changing models.");
		await page.locator("#landing-source-image").setInputFiles({
			name: "navigation-source.png",
			mimeType: "image/png",
			buffer: Buffer.from(ONE_PIXEL_PNG, "base64"),
		});
		const sourcePreview = page.getByRole("img", { name: /preview of navigation-source\.png/i });
		await expect(sourcePreview).toBeVisible();
		const sourcePreviewUrl = await sourcePreview.getAttribute("src");
		const workspaceNavigation =
			width <= 1200
				? page.locator('[data-test="header-navigation-drawer"]')
				: page.locator(".studio-sidebar");
		if (width <= 1200) {
			await page.locator('[data-test="header-navigation-trigger"]').click();
			await workspaceNavigation.locator("summary").filter({ hasText: "AI Models" }).click();
		}
		await expect(workspaceNavigation).toBeVisible();
		await workspaceNavigation.locator('a[href="/create?model=image-nano-banana-2-lite"]').click();
		await expect(page.locator('[data-test="landing-model-trigger"]')).toContainText(
			"Nano Banana 2 Lite",
		);
		await expect(page.locator("#landing-edit-prompt")).toHaveValue(
			"Keep this prompt and source while changing models.",
		);
		await expect(sourcePreview).toBeVisible();
		await expect(sourcePreview).toHaveAttribute("src", sourcePreviewUrl!);
		if (width <= 1200) await expect(workspaceNavigation).toBeHidden();
		await page.goBack();
		await expect(page.locator('[data-test="landing-model-trigger"]')).toContainText("GPT Image 2");
		await page.reload();
		await expect(page.locator('[data-test="landing-model-trigger"]')).toContainText("GPT Image 2");
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
		await page.goto("/create?model=unknown-model");
		await expect(
			page.getByText("The requested model is unavailable. Choose an available model to continue."),
		).toBeVisible();
		const settings = await page.request.get("/settings/general", { maxRedirects: 0 });
		expect(settings.status()).toBe(307);
		expect(settings.headers().location).toContain("/login");
	});
}

test("account controls load when the browser receives a signed-in session", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.route("**/api/auth/get-session**", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				user: {
					id: "mobile-ui-owner",
					name: "Mobile UI test",
					email: "mobile-ui@example.test",
					emailVerified: true,
					isAnonymous: false,
				},
				session: { id: "mobile-ui-session", userId: "mobile-ui-owner" },
			}),
		}),
	);
	await page.route("**/api/rpc/notifications/unreadCount**", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({ json: { count: 0 } }),
		}),
	);
	await page.goto("/");
	// The signed-in header replaces the initial guest header when the session loads.
	await expect(page.locator(".studio-header-user-controls")).toBeAttached();
	await page.locator('[data-test="header-navigation-trigger"]').click();
	const userMenu = page
		.locator('[data-test="header-navigation-drawer"]')
		.getByRole("button", { name: "User menu", exact: true });
	await userMenu.click();
	await expect(page.getByRole("menu")).toContainText("mobile-ui@example.test");
	await expect(page.getByRole("menuitem", { name: "Account settings", exact: true })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(userMenu).toBeFocused();
});

test("the production homepage excludes account tools, charts, and documentation styles", async ({
	page,
	request,
}, testInfo) => {
	test.skip(process.env.E2E_USE_PRODUCTION_BUILD !== "true", "Requires production bundles");
	const cspViolations: string[] = [];
	await page.exposeFunction("recordCspViolation", (directive: string) => {
		cspViolations.push(directive);
	});
	await page.addInitScript(() => {
		document.addEventListener("securitypolicyviolation", (event) => {
			void (
				window as unknown as { recordCspViolation: (value: string) => Promise<void> }
			).recordCspViolation(`${event.violatedDirective}: ${event.blockedURI}`);
		});
	});
	await page.setViewportSize({ width: 1350, height: 940 });
	const response = await page.goto("/");
	await expect(stage(page, "ready")).toBeVisible();
	expect(cspViolations, "Client validation must work without attempting unsafe-eval").toEqual([]);
	const resources = await page.evaluate(() => {
		const scripts = new Set([...document.scripts].map((script) => script.src));
		// Hydration can remove script tags after loading; keep those network resources too.
		for (const entry of performance.getEntriesByType("resource")) {
			const url = new URL(entry.name);
			if (url.origin === location.origin && url.pathname.endsWith(".js")) scripts.add(url.href);
		}
		return {
			scripts: [...scripts].filter((src) => src.startsWith(location.origin)),
			styles: [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(
				(link) => link.href,
			),
			inlineStyles: [...document.querySelectorAll("style[data-href]")].map(
				(style) => style.textContent ?? "",
			),
		};
	});
	const readResources = (urls: string[]) =>
		Promise.all(
			urls.map(async (url) => {
				const response = await request.get(url);
				expect(response.ok(), url).toBe(true);
				return response.text();
			}),
		);
	const scripts = await readResources(resources.scripts);
	const externalStyles = await readResources(resources.styles);
	const styles = [...externalStyles, ...resources.inlineStyles];
	const html = (await response?.text()) ?? "";
	expect(
		resources.styles.length,
		"Shared styles must remain independently cacheable",
	).toBeGreaterThan(0);
	expect(resources.inlineStyles, "Do not duplicate global CSS inside HTML and RSC").toHaveLength(0);
	for (const marker of ["current-editor-result", "notifications.markAllRead"]) {
		expect
			.soft(
				scripts.some((source) => source.includes(marker)),
				`Visitors must not download signed-in tools (${marker})`,
			)
			.toBe(false);
	}
	expect(
		scripts.some((source) => source.includes("recharts")),
		"Homepage must not load the chart library",
	).toBe(false);
	expect(
		styles.some((source) => source.includes("#nd-sidebar")),
		"Documentation CSS belongs to /docs",
	).toBe(false);
	expect(response?.headers()["content-security-policy"]).toContain(
		"https://static.cloudflareinsights.com",
	);
	await expect(page.locator('link[rel="preload"][as="image"][media]')).toHaveAttribute(
		"media",
		"(min-width: 768px)",
	);
	const summary = {
		firstPartyScripts: scripts.length,
		javascriptBytes: scripts.reduce((total, source) => total + Buffer.byteLength(source), 0),
		javascriptGzipBytes: scripts.reduce((total, source) => total + gzipSync(source).length, 0),
		htmlBytes: Buffer.byteLength(html),
		htmlGzipBytes: gzipSync(html).length,
		stylesheets: resources.styles.length,
		inlineStylesheets: resources.inlineStyles.length,
		cssBytes: styles.reduce((total, source) => total + Buffer.byteLength(source), 0),
		cssGzipBytes: styles.reduce((total, source) => total + gzipSync(source).length, 0),
	};
	const initialTextGzipBytes =
		summary.javascriptGzipBytes +
		summary.htmlGzipBytes +
		externalStyles.reduce((total, source) => total + gzipSync(source).length, 0);
	expect(summary.htmlGzipBytes, "Keep the initial document below 64 KiB gzip").toBeLessThan(
		64 * 1024,
	);
	// Count inline styles inside HTML only. Moving CSS into HTML must not conceal
	// a transfer regression behind a smaller number of stylesheet requests.
	expect(
		initialTextGzipBytes,
		"Initial HTML, scripts, and external CSS exceed the budget",
	).toBeLessThan(520 * 1024);
	console.log("Homepage production resources:", JSON.stringify(summary));
	await testInfo.attach("homepage-resources.json", {
		body: JSON.stringify(summary, null, 2),
		contentType: "application/json",
	});
	await page.evaluate(() => document.fonts.ready.then(() => undefined));
	await page.screenshot({ path: testInfo.outputPath("homepage-desktop.png") });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: testInfo.outputPath("homepage-mobile.png") });
	await page.goto("/docs/quick-start");
	await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
	await page.setViewportSize({ width: 1350, height: 940 });
	await page.screenshot({ path: testInfo.outputPath("documentation-desktop.png") });
});

test("the homepage shares one model catalog request between navigation and editor", async ({
	page,
}) => {
	let catalogRequests = 0;
	page.on("request", (request) => {
		if (request.url().includes("/api/rpc/media/getPublicCatalog")) catalogRequests += 1;
	});
	await page.goto("/");
	await expect(stage(page, "ready")).toBeVisible();
	await page.locator('[data-test="studio-models-menu"]').click();
	await expect(page.locator(".studio-navigation-popover")).toBeVisible();
	expect(catalogRequests).toBe(1);
});

test("the landing generator reports capability checking before it becomes ready", async ({
	page,
}) => {
	const capabilityRequested = deferred<void>();
	const capabilityGate = deferred<void>();
	await page.route("**/api/media/guest-capability", async (route) => {
		capabilityRequested.resolve();
		await capabilityGate.promise;
		await route.fulfill({ contentType: "application/json", body: JSON.stringify(capability) });
	});

	await page.goto("/");
	await capabilityRequested.promise;
	try {
		await expect(stage(page, "checking")).toBeVisible();
		await expect(page.getByText(/wait while model availability is checked/i)).toBeVisible();
		await expect(page.getByRole("button", { name: /checking model availability/i })).toBeDisabled();
	} finally {
		capabilityGate.resolve();
	}
	await expect(stage(page, "ready")).toBeVisible();
});

test("a failed capability check can be retried without reloading the page", async ({ page }) => {
	let attempts = 0;
	let allowCapability = false;
	await page.route("**/api/rpc/media/getPublicCatalog**", (route) =>
		route.fulfill({
			status: allowCapability ? 200 : 503,
			contentType: "application/json",
			body: JSON.stringify({
				json: {
					products: allowCapability
						? capability.products.map((product) => ({
								...product,
								inputKinds: ["text-to-image", "image-to-image"],
							}))
						: [],
				},
			}),
		}),
	);
	await page.route("**/api/media/guest-capability", async (route) => {
		attempts += 1;
		if (!allowCapability) {
			await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
			return;
		}
		await route.fulfill({ contentType: "application/json", body: JSON.stringify(capability) });
	});

	await page.goto("/");
	await expect(stage(page, "failed")).toBeVisible();
	const retryName = /check availability/i;
	await expect(
		page.locator('[data-test="landing-generator"]').getByRole("button", { name: retryName }),
	).toBeEnabled();

	await page.locator("#examples").scrollIntoViewIfNeeded();
	const dock = page.locator('[data-test="floating-editor-dock"]');
	await dock.getByRole("button", { name: /open the quick editor/i }).click();
	const floatingRetry = dock.getByRole("button", { name: retryName });
	await expect(floatingRetry).toBeEnabled();
	const beforeRetry = attempts;
	allowCapability = true;
	await floatingRetry.click();
	await expect(stage(page, "ready")).toBeVisible();
	expect(attempts).toBe(beforeRetry + 1);
});

test("an inconsistent enabled capability without products fails closed", async ({ page }) => {
	await page.route("**/api/rpc/media/getPublicCatalog**", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({ json: { products: [] } }),
		}),
	);
	await page.route("**/api/media/guest-capability", async (route) => {
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({ ...capability, products: [] }),
		});
	});

	await page.goto("/");
	await expect(stage(page, "ready")).toBeVisible();
	await expect(page.getByText(/generation is unavailable right now/i)).toBeVisible();
	await expect(page.getByRole("group", { name: /image model/i })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /check availability/i })).toBeEnabled();
	await expect(page.getByRole("button", { name: /try free/i })).toHaveCount(0);
});

test("the public root exposes the image editor before authentication", async ({ page }) => {
	await page.goto("/");

	await expect(page).toHaveURL(/\/$/);
	await expect(page).toHaveTitle(/AI Image Editor No Restrictions/i);
	const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
	expect(canonical).not.toBeNull();
	expect(new URL(canonical!).origin).toBe(new URL(page.url()).origin);
	await expect(
		page.getByRole("heading", {
			level: 1,
			name: /ai image editor no restrictions/i,
		}),
	).toBeVisible();
	await expect(page.locator("#landing-source-image")).toBeAttached();
	await expect(
		page
			.locator('[data-test="landing-generator"]')
			.getByRole("button", { name: /add a reference image/i }),
	).toBeVisible();
	await expect(page.getByLabel(/describe your (?:image|edit)/i)).toBeVisible();
	await expect(page.locator('[data-test="landing-model-trigger"]')).toContainText(
		"Nano Banana 2 Lite",
	);
	await expect(page.locator('[data-test="landing-model-image-gpt-image-2"]')).toHaveCount(0);
	await expect(page.locator('[data-test="landing-model-image-seedream-5-pro"]')).toHaveCount(0);
	await expect(page.getByRole("button", { name: /sign in to generate/i })).toBeVisible();
	await expect(page.getByRole("banner").getByRole("link", { name: /sign in/i })).toHaveAttribute(
		"href",
		"/login",
	);
	expect(
		await page
			.locator("main section[id]")
			.evaluateAll((sections) => sections.map((section) => section.id)),
	).toEqual([
		"image-editor",
		"models",
		"examples",
		"before-after",
		"creator-workflows",
		"how-it-works",
		"pricing",
		"faq",
	]);
	const storyWall = page.locator('[data-test="user-story-wall"]');
	await expect(storyWall).toContainText(/six composite creator profiles/i);
	await expect(storyWall.locator("#creator-workflows-disclaimer")).toContainText(
		/not customer testimonials, published case studies, or promised results/i,
	);
	await expect(page.locator("body")).not.toContainText(
		/raphael|openrouter|sourceful|riverflow|providerModelId|providerCostMicros|providerTaskId|KIE_API_KEY|api\.kie\.ai/i,
	);
});

test("the editor follows the user as a compact dock and expands without losing input", async ({
	page,
}) => {
	await page.goto("/");
	await expect(stage(page, "ready")).toBeVisible();

	const dock = page.locator('[data-test="floating-editor-dock"]');
	await expect(dock).toHaveCount(0);

	await page.locator("#examples").scrollIntoViewIfNeeded();
	await expect(dock).toBeVisible();
	await expect(dock.locator('[data-test="floating-editor-expanded"]')).toHaveCount(0);

	await dock.getByRole("button", { name: /open the quick editor/i }).click();
	await expect(dock.locator('[data-test="floating-editor-expanded"]')).toBeVisible();

	const floatingPrompt = dock.getByLabel(/describe your (?:image|edit)/i);
	await floatingPrompt.fill("Turn the background into a quiet lilac studio");
	await expect(page.getByLabel(/describe your (?:image|edit)/i).first()).toHaveValue(
		"Turn the background into a quiet lilac studio",
	);

	await page.keyboard.press("Escape");
	await expect(dock.locator('[data-test="floating-editor-expanded"]')).toHaveCount(0);
	await expect(dock.getByRole("button", { name: /open the quick editor/i })).toBeFocused();

	await dock.getByRole("button", { name: /open the quick editor/i }).click();
	await expect(floatingPrompt).toBeFocused();
	await page.locator('[data-test="landing-generator"]').scrollIntoViewIfNeeded();
	await expect(dock).toHaveCount(0);
	await expect(page.getByLabel(/describe your (?:image|edit)/i).first()).toBeFocused();
});

test("the landing generator supports model and SKU choice plus drop, replace, and removal", async ({
	page,
}) => {
	await page.goto("/");

	const nano = page.locator('[data-test="landing-model-trigger"]');
	const gpt = page.locator('[data-test="landing-model-trigger"]');
	const action = page.getByRole("button", { name: /sign in to generate/i });
	await expect(nano).toContainText("Nano Banana 2 Lite");
	await expect(action).toBeDisabled();
	await expect(page.getByText(/describe the image you want to continue/i)).toBeVisible();

	await selectModel(page, "GPT Image", "image-gpt-image-2");
	await expect(gpt).toContainText("GPT Image 2");
	await page.getByRole("button", { name: /open output settings/i }).click();
	const automaticAspectRatio = page.getByRole("radio", { name: "Automatic", exact: true });
	const landscapeAspectRatio = page.getByRole("radio", { name: "16:9", exact: true });
	await expect(automaticAspectRatio).toBeChecked();
	await expect(page.getByRole("button", { name: "1K", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await page.getByRole("button", { name: "4K", exact: true }).click();
	await expect(page.getByText("17", { exact: true })).toBeVisible();
	await page.getByText("16:9", { exact: true }).click();
	await expect(landscapeAspectRatio).toBeChecked();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("button", { name: /open output settings/i })).toContainText("4K");

	const dropZone = page.locator('[data-test="landing-generator"]').getByRole("button", {
		name: /add a reference image/i,
	});
	await dropPng(page, dropZone, "dropped-source.png");
	await expect(page.getByRole("img", { name: /preview of dropped-source\.png/i })).toBeVisible();
	await expect(
		page.getByText(/gpt image 2 requires sign-in and a pro, ultimate, or max plan/i),
	).toBeVisible();
	await expect(page.getByText(/describe the image you want to continue/i)).toBeVisible();

	await page.locator("#landing-source-image").setInputFiles(pngFile("replacement-source.png"));
	await expect(
		page.getByRole("img", { name: /preview of replacement-source\.png/i }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: /replace image/i })).toBeVisible();

	await page
		.getByLabel(/describe your (?:image|edit)/i)
		.fill("Keep the subject and replace the background");
	await expect(page.getByRole("button", { name: /continue/i })).toBeEnabled();

	await page.getByRole("button", { name: /remove image/i }).click();
	await expect(page.getByRole("img", { name: /preview of replacement-source\.png/i })).toHaveCount(
		0,
	);
	await expect(gpt).toContainText("GPT Image 2");
	await expect(page.getByLabel(/describe your (?:image|edit)/i)).toHaveValue(
		"Keep the subject and replace the background",
	);
	await expect(page.getByRole("button", { name: /sign in to generate/i })).toBeEnabled();
});

test("the selected model and SKU cross each private-upload stage without leaking routing details", async ({
	page,
}) => {
	const intentGate = deferred<void>();
	const uploadGate = deferred<void>();
	const verificationGate = deferred<void>();
	const intentRequested = deferred<void>();
	const uploadRequested = deferred<void>();
	const verificationRequested = deferred<void>();
	const handoffRequested = deferred<void>();
	let intentBody: Record<string, unknown> | undefined;
	let completionBody: Record<string, unknown> | undefined;
	let handoffBody = "";

	await page.route("**/api/media/guest-drafts/upload-intents", async (route) => {
		intentBody = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
		intentRequested.resolve();
		await intentGate.promise;
		const appOrigin = new URL(route.request().url()).origin;
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				sessionId: "landing-session",
				assetId: "landing-asset",
				uploadUrl: `${appOrigin}/__landing-upload/source`,
				completionToken: "c".repeat(43),
				expiresAt: "2026-09-01T00:00:00.000Z",
			}),
		});
	});
	await page.route("**/__landing-upload/source", async (route) => {
		uploadRequested.resolve();
		await uploadGate.promise;
		await route.fulfill({ status: 200, body: "" });
	});
	await page.route("**/api/media/guest-drafts/upload-completions", async (route) => {
		completionBody = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
		verificationRequested.resolve();
		await verificationGate.promise;
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				status: "READY",
				claimToken: "d".repeat(43),
				continueUrl: "/draft/continue",
				productKey: "image-gpt-image-2",
				skuKey: "gpt-image-2-4k",
				accessHint: "paid-account",
			}),
		});
	});
	await page.route("**/draft/continue", async (route) => {
		handoffBody = route.request().postData() ?? "";
		handoffRequested.resolve();
		await route.fulfill({ status: 204 });
	});

	await page.goto("/");
	await selectModel(page, "GPT Image", "image-gpt-image-2");
	await page.getByRole("button", { name: /open output settings/i }).click();
	await expect(page.getByText("Background", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Transparent", exact: true }).click();
	await page.getByRole("button", { name: "4K", exact: true }).click();
	await expect(page.getByText("Background", { exact: true })).toHaveCount(0);
	await page.getByText("16:9", { exact: true }).click();
	await page.keyboard.press("Escape");
	await page.locator("#landing-source-image").setInputFiles(pngFile("gpt-source.png"));
	await page.getByLabel(/describe your (?:image|edit)/i).fill("Preserve the product details");
	await page.getByRole("button", { name: /continue/i }).click();

	await intentRequested.promise;
	await expect(stage(page, "preparing")).toBeVisible();
	expect(intentBody).toMatchObject({ productKey: "image-gpt-image-2" });
	intentGate.resolve();

	await uploadRequested.promise;
	await expect(stage(page, "uploading")).toBeVisible();
	uploadGate.resolve();

	await verificationRequested.promise;
	await expect(stage(page, "verifying")).toBeVisible();
	expect(completionBody).toMatchObject({
		productKey: "image-gpt-image-2",
		skuKey: "gpt-image-2-4k",
		aspectRatio: "16:9",
	});
	expect(completionBody).not.toHaveProperty("background");
	await expect(page.locator("body")).not.toContainText(
		/openrouter|sourceful|riverflow|providerModelId|providerCostMicros|providerTaskId|KIE_API_KEY|api\.kie\.ai/i,
	);
	verificationGate.resolve();

	await handoffRequested.promise;
	await expect(stage(page, "handoff")).toBeVisible();
	expect(handoffBody).toContain("intent=continue-account-draft");
});

test("a retryable failure preserves the image, prompt, and selected model", async ({ page }) => {
	let attempts = 0;
	const secondAttempt = deferred<Record<string, unknown>>();
	await page.route("**/api/media/guest-drafts/upload-intents", async (route) => {
		attempts += 1;
		if (attempts === 2) {
			secondAttempt.resolve(
				JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>,
			);
		}
		await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
	});

	await page.goto("/");
	const gpt = page.locator('[data-test="landing-model-trigger"]');
	const prompt = page.getByLabel(/describe your (?:image|edit)/i);
	await selectModel(page, "GPT Image", "image-gpt-image-2");
	await page.locator("#landing-source-image").setInputFiles(pngFile("retry-source.png"));
	await prompt.fill("Keep this prompt through the retry");
	await page.getByRole("button", { name: /continue/i }).click();

	await expect(stage(page, "failed")).toBeVisible();
	await expect(page.getByRole("img", { name: /preview of retry-source\.png/i })).toBeVisible();
	await expect(prompt).toHaveValue("Keep this prompt through the retry");
	await expect(gpt).toContainText("GPT Image 2");
	await page.getByRole("button", { name: /retry/i }).click();
	await expect(secondAttempt.promise).resolves.toMatchObject({ productKey: "image-gpt-image-2" });
});

test("the landing page proves edits with an interactive comparison and visual examples", async ({
	page,
}) => {
	await page.goto("/");

	const comparison = page.getByRole("slider", {
		name: /compare original and edited illustration/i,
	});
	await page.locator("#before-after").scrollIntoViewIfNeeded();
	await expect(comparison).toBeVisible();
	await expect(comparison).toHaveValue("52");

	await page.getByRole("button", { name: /show original/i }).click();
	await expect(comparison).toHaveValue("0");
	await page.getByRole("button", { name: /show edit direction/i }).click();
	await expect(comparison).toHaveValue("100");
	await comparison.fill("36");
	await expect(comparison).toHaveValue("36");

	const examples = page.locator("#examples article");
	await page.locator("#examples").scrollIntoViewIfNeeded();
	await expect(examples).toHaveCount(12);
	await expect(page.locator("#examples img")).toHaveCount(12);
	expect(
		await page
			.locator("#examples img")
			.evaluateAll((images) =>
				images.every((image) => image instanceof HTMLImageElement && image.naturalWidth > 0),
			),
	).toBe(true);

	expect(
		await page
			.locator("#examples img")
			.evaluateAll((images) =>
				images.every(
					(image) =>
						image instanceof HTMLImageElement &&
						Math.abs(
							image.clientHeight - (image.clientWidth * image.naturalHeight) / image.naturalWidth,
						) < 2,
				),
			),
		"example images preserve their original proportions",
	).toBe(true);

	const prompt = page.getByLabel(/describe your (?:image|edit)/i);
	await page
		.locator("#examples")
		.getByRole("button", { name: /mediterranean quiet/i })
		.click();
	await expect(prompt).toHaveValue(/sunlit mediterranean retreat/i);
	await expect(prompt).toBeFocused();
});

test("creator workflows become static when reduced motion is requested", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto("/");

	const workflows = page.locator("#creator-workflows");
	await expect(workflows.locator(".creator-workflows-track").first()).toHaveCSS(
		"animation-name",
		"none",
	);
	await expect(workflows.locator(".creator-workflows-duplicate").first()).toBeHidden();
	await expect(workflows.locator('button[aria-controls="creator-workflows-motion"]')).toBeHidden();
});

test("creator workflow movement can be paused and resumed", async ({ page }) => {
	await page.goto("/");

	const workflows = page.locator("#creator-workflows");
	const track = workflows.locator(".creator-workflows-track--one");
	const pauseButton = workflows.getByRole("button", { name: /pause movement/i });
	await workflows.scrollIntoViewIfNeeded();
	await expect(track).toHaveCSS("animation-play-state", "running");

	await pauseButton.click();
	await expect(track).toHaveCSS("animation-play-state", "paused");
	const resumeButton = workflows.getByRole("button", { name: /resume movement/i });
	await resumeButton.click();
	await expect(track).toHaveCSS("animation-play-state", "running");
});

function pngFile(name: string) {
	return {
		name,
		mimeType: "image/png",
		buffer: Buffer.from(ONE_PIXEL_PNG, "base64"),
	};
}

async function dropPng(page: Page, dropZone: Locator, name: string) {
	const dataTransfer = await page.evaluateHandle(
		({ base64, fileName }) => {
			const binary = atob(base64);
			const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
			const transfer = new DataTransfer();
			transfer.items.add(new File([bytes], fileName, { type: "image/png" }));
			return transfer;
		},
		{ base64: ONE_PIXEL_PNG, fileName: name },
	);
	await dropZone.dispatchEvent("dragenter", { dataTransfer });
	await dropZone.dispatchEvent("dragover", { dataTransfer });
	await dropZone.dispatchEvent("drop", { dataTransfer });
	await dataTransfer.dispose();
}

function stage(page: Page, value: string) {
	return page.locator(`[data-test="landing-stage"][data-stage="${value}"]`);
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

test("the landing tool stays usable at desktop and narrow mobile widths", async ({
	page,
}, testInfo) => {
	for (const viewport of [
		{ width: 1440, height: 1000 },
		{ width: 390, height: 844 },
		{ width: 320, height: 800 },
	]) {
		await page.setViewportSize(viewport);
		await page.goto("/");
		await expect(page.getByLabel(/describe your (?:image|edit)/i)).toBeVisible();
		await expect(
			page
				.locator('[data-test="landing-generator"]')
				.getByRole("button", { name: /add a reference image/i }),
		).toBeVisible();
		await expect(page.getByRole("button", { name: /sign in to generate/i })).toBeVisible();
		await expect(page.locator('[data-test="landing-model-trigger"]')).toContainText(
			"Nano Banana 2 Lite",
		);
		if (viewport.width < 768) {
			const navigation = page.locator('[data-test="header-navigation-trigger"]');
			await expect(navigation).toBeVisible();
			await navigation.click();
			const drawer = page.locator('[data-test="header-navigation-drawer"]');
			await drawer.locator("summary").filter({ hasText: "Image Tools" }).click();
			await expect(drawer.locator('.studio-drawer-links a[href="/create"]')).toBeVisible();
			await drawer.locator("summary").filter({ hasText: "AI Models" }).click();
			await expect(drawer.locator('a[href="/models/gpt-image-2"]')).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(drawer).toBeHidden();
			await expect(page.locator('[data-test="landing-model-trigger"]')).toBeVisible();
		}
		const [sourceRect, promptRect, tierRect] = await Promise.all([
			box(
				page
					.locator('[data-test="landing-generator"]')
					.getByRole("button", { name: /add a reference image/i }),
			),
			box(page.getByLabel(/describe your (?:image|edit)/i)),
			box(page.locator('[data-test="landing-model-trigger"]')),
		]);
		const controls = await box(page.locator('[data-test="landing-controls-panel"]'));
		const action = await box(page.locator('[data-test="landing-generate"]'));
		const composer = await box(page.locator('[data-test="landing-generator"]'));
		const help = await box(page.locator('[data-test="landing-generator-help"]'));
		expect(help.y).toBeGreaterThanOrEqual(composer.y + composer.height);
		if (viewport.width >= 768) {
			expect(Math.abs(tierRect.y - action.y)).toBeLessThan(2);
			expect(controls.height).toBeLessThanOrEqual(50);
		}
		expect(sourceRect.x).toBeLessThan(promptRect.x);
		expect(Math.abs(sourceRect.y - promptRect.y)).toBeLessThan(2);
		expect(
			Math.max(sourceRect.y + sourceRect.height, promptRect.y + promptRect.height),
		).toBeLessThan(tierRect.y);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
			`${viewport.width}px horizontal overflow`,
		).toBe(true);
		const exampleColumns = await page
			.locator("#examples article")
			.evaluateAll((examples) => [
				...new Set(examples.map((example) => Math.round(example.getBoundingClientRect().x))),
			]);
		expect(exampleColumns).toHaveLength(viewport.width >= 1280 ? 4 : 2);
		await selectModel(page, "GPT Image", "image-gpt-image-2");
		await page
			.locator("#landing-source-image")
			.setInputFiles(pngFile(`source-${viewport.width}.png`));
		await page.getByLabel(/describe your (?:image|edit)/i).fill("Keep the subject sharp");
		await expect(page.getByRole("button", { name: /continue/i })).toBeEnabled();
		await testInfo.attach(`landing-${viewport.width}`, {
			body: await page
				.locator("#image-editor")
				.screenshot({ path: testInfo.outputPath(`generator-${viewport.width}.png`) }),
			contentType: "image/png",
		});
	}
});

test("the before-and-after control has a visible keyboard focus treatment", async ({ page }) => {
	await page.goto("/");
	const slider = page.getByRole("slider", { name: /compare original and edited illustration/i });
	await slider.focus();
	await expect(slider).toBeFocused();
	const frame = page.locator('[data-test="before-after-frame"]');
	await expect(frame).toBeVisible();
	expect(await frame.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
});

async function box(locator: Locator) {
	return locator.evaluate((element) => {
		const { x, y, width, height } = element.getBoundingClientRect();
		return { x, y, width, height };
	});
}

async function selectModel(page: Page, family: string, productKey: string, prefix = "landing") {
	await page.locator(`[data-test="${prefix}-model-trigger"]`).click();
	await page
		.getByRole("dialog", { name: "Image models", exact: true })
		.getByRole("group", { name: "Model families", exact: true })
		.getByRole("button", { name: new RegExp(family, "i") })
		.click();
	await page.locator(`[data-test="${prefix}-model-${productKey}"]`).click();
}

test("model families expose descriptions and quality changes update the quoted credits", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 1100 });
	await page.goto("/");
	await page.locator('[data-test="landing-model-trigger"]').click();
	const menu = page.getByRole("dialog", { name: "Image models", exact: true });
	await expect(menu).toBeVisible();
	await expect(menu.getByRole("button", { name: /Nano Banana 2 Lite/ })).toContainText(
		"Portraits and everyday retouching",
	);
	await menu.getByRole("button", { name: /Seedream/ }).click();
	await expect(menu.getByRole("button", { name: /Seedream 5 Pro/ })).toContainText(
		"From 8 credits",
	);
	await testInfo.attach("model-menu", {
		body: await page.screenshot({
			path: testInfo.outputPath("model-menu.png"),
			animations: "disabled",
		}),
		contentType: "image/png",
	});
	await page.locator('[data-test="landing-model-image-seedream-5-pro"]').click();
	await page.getByRole("button", { name: /^Open output settings:/ }).click();
	await page.getByRole("button", { name: "High", exact: true }).click();
	await expect(page.getByRole("button", { name: "2K", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.locator('[data-test="landing-settings-credits"]')).toContainText(
		"2K · High · 15",
	);
	await expect(page.locator('[data-test="landing-generate"]')).toContainText("15");
	await testInfo.attach("quality-pricing", {
		body: await page.screenshot({
			path: testInfo.outputPath("quality-pricing.png"),
			animations: "disabled",
		}),
		contentType: "image/png",
	});
	await page.getByRole("button", { name: "Basic", exact: true }).click();
	await expect(page.getByRole("button", { name: "1K", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.locator('[data-test="landing-generate"]')).toContainText("8");
	await page.keyboard.press("Escape");
	await page.locator("#faq").scrollIntoViewIfNeeded();
	const dock = page.locator('[data-test="floating-editor-dock"]');
	await dock.getByRole("button", { name: /open the quick editor/i }).click();
	await selectModel(page, "GPT Image", "image-gpt-image-2", "floating");
	await dock.getByRole("button", { name: /^Open output settings:/ }).click();
	await page.getByRole("button", { name: "4K", exact: true }).click();
	await expect(dock.locator('[data-test="floating-generate"]')).toContainText("17");
	await page.keyboard.press("Escape");
	await expect(dock.locator('[data-test="floating-editor-expanded"]')).toBeVisible();
});
