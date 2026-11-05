import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Locator } from "@playwright/test";

import { buildChristmasResultPreview } from "./fixtures/christmas-result-preview.mjs";
import { buildWallpaperResultInteraction } from "./fixtures/wallpaper-result-interaction.mjs";

const indexableRoutes = [
	"/",
	"/pricing",
	"/privacy",
	"/terms",
	"/blog",
	"/changelog",
	"/contact",
	"/create",
	"/examples",
] as const;
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

test("Vidu Q4 guide separates official access from other EzImageAI models", async ({
	page,
	request,
}, testInfo) => {
	test.setTimeout(120_000);
	await mockPublicImageAvailability(page);
	const path = "/blog/vidu-q4-preview";
	const response = await request.get(path);
	expect(response.ok()).toBe(true);
	const html = await response.text();
	expect(html).toContain("EzImageAI does not currently offer Vidu Q4 Preview");
	expect(html).toContain("Documented inputs and output limits");
	for (const width of [1440, 390]) {
		await page.setViewportSize({ width, height: 900 });
		await expectPublicPage(page, path, "index");
		await expect(page).toHaveTitle("Vidu Q4 Preview: Features, Pricing & API Guide | EzImageAI");
		await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
		const article = page.locator("article.blog-prose");
		await expect(
			article.getByRole("link", { name: "Try Q4 Preview on Vidu's official site", exact: true }),
		).toHaveAttribute("href", "https://www.vidu.com/vidu-q4");
		await expect(
			article.getByRole("link", { name: "EzImageAI video editor — other models", exact: true }),
		).toHaveAttribute("href", "/create?mode=video");
		await expect(article.getByRole("button", { name: "Copy prompt", exact: true })).toHaveCount(3);
		await expect(
			page.locator('[data-test="landing-generator"], [data-test="registered-generator"]'),
		).toHaveCount(0);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		await page.screenshot({ path: testInfo.outputPath(`vidu-q4-${width}.png`), fullPage: true });
	}
	await expectPublicPage(page, "/blog", "index");
	await expect(page.locator(`a[href="${path}"]`).first()).toBeVisible();
	await page.goto(`${path}?lang=de`);
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
	await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
		"href",
		new URL(path, baseUrl).href,
	);
	await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(0);
});

async function mockPublicImageAvailability(
	page: import("@playwright/test").Page,
	aspectRatios = ["auto", "1:1"],
) {
	const product = {
		key: "image-nano-banana-2-lite",
		label: "Nano Banana 2 Lite",
		description: "Fast private image editing",
		credits: "5",
		accessHint: "guest-trial",
		aspectRatios,
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
					aspectRatios,
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

test("Christmas wallpaper homepage entry works on desktop and mobile", async ({
	page,
}, testInfo) => {
	test.setTimeout(120_000);
	await mockPublicImageAvailability(page);
	await page.goto("/");
	await expect(page.getByRole("heading", { level: 1 })).toContainText(
		/AI Image Editor &(?:amp;)? Prompt Photo Editor/i,
	);
	const entry = page.locator(".christmas-entry");
	await expect(page.locator(".christmas-quick-entry")).toHaveAttribute(
		"href",
		"/christmas-wallpaper",
	);
	await expect(page.locator("footer a[href='/christmas-wallpaper']")).toBeAttached();
	await page.setViewportSize({ width: 1440, height: 900 });
	await entry.scrollIntoViewIfNeeded();
	await page.mouse.move(0, 850);
	const phones = entry.locator(".christmas-entry-phone");
	const initialTransforms = await phones.evaluateAll((nodes) =>
		nodes.map((node) => getComputedStyle(node).transform),
	);
	await entry.getByRole("heading").hover();
	await expect
		.poll(() =>
			phones.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).transform)),
		)
		.toEqual(initialTransforms);
	for (const style of ["street", "fireplace", "pet"]) {
		const phone = entry.locator(`.christmas-entry-phone.${style}`);
		await phone.hover();
		await expect(phone).toHaveCSS("translate", "0px -6px");
		for (const other of ["street", "fireplace", "pet"].filter((value) => value !== style)) {
			await expect(entry.locator(`.christmas-entry-phone.${other}`)).toHaveCSS("translate", "none");
		}
	}
	await page.emulateMedia({ reducedMotion: "reduce" });
	await entry.locator(".christmas-entry-phone.fireplace").hover();
	await expect(entry.locator(".christmas-entry-phone.fireplace")).toHaveCSS("translate", "none");
	await page.emulateMedia({ reducedMotion: "no-preference" });
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 900 });
		await entry.scrollIntoViewIfNeeded();
		await expect
			.poll(() =>
				page
					.locator(".studio-topbar")
					.evaluate((node) => Math.round(node.getBoundingClientRect().top)),
			)
			.toBe(0);
		await expect(entry.locator("img")).toHaveCount(3);
		await expect
			.poll(() =>
				entry
					.locator("img")
					.evaluateAll((images) =>
						images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
					),
			)
			.toBe(true);
		expect(await entry.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
		await entry.screenshot({ path: testInfo.outputPath(`christmas-home-${width}.png`) });
		await page.screenshot({ path: testInfo.outputPath(`christmas-sticky-${width}.png`) });
	}
	await page.locator('[data-test="header-navigation-trigger"]').click();
	await expect(page.locator(".studio-header-drawer")).toBeVisible();
	await page.keyboard.press("Escape");
	await entry.getByRole("link").focus();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/christmas-wallpaper$/, { timeout: 30_000 });
	await expect(page.locator(".christmas-style-grid article")).toHaveCount(6);
});

test("Christmas wallpaper presets preserve photos and export clean crops at actual resolution", async ({
	page,
}, testInfo) => {
	test.setTimeout(120_000);
	await mockPublicImageAvailability(page, ["auto", "1:1", "9:16", "16:9"]);
	await page.goto("/christmas-wallpaper");
	await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
	await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
		"href",
		new URL("/christmas-wallpaper", baseUrl).href,
	);
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /index, follow/);
	await expect(page.locator(".christmas-style-grid article")).toHaveCount(6);
	const prompt = page.locator("#landing-edit-prompt");
	await expect(prompt).toHaveValue(/tall 9:16 composition/);
	const snow = page.locator(".christmas-snow");
	await expect(snow).toHaveAttribute("aria-hidden", "true");
	await expect(snow).toHaveCSS("pointer-events", "none");
	await expect(snow).toHaveCSS("mask-image", "none");
	expect(await snow.evaluate((node) => node.getBoundingClientRect().height)).toBeCloseTo(
		await page.locator(".christmas-page").evaluate((node) => node.getBoundingClientRect().height),
		0,
	);
	const snowLayers = await snow.evaluate((node) =>
		["::before", "::after"].map((pseudo) => {
			const style = getComputedStyle(node, pseudo);
			return {
				animation: style.animationName,
				opacity: Number(style.opacity),
				transform: style.transform,
			};
		}),
	);
	expect(snowLayers.map((layer) => layer.animation)).toEqual([
		"christmas-snow-fall",
		"christmas-snow-fall",
	]);
	for (const layer of snowLayers) expect(layer.opacity).toBeGreaterThanOrEqual(0.6);
	await expect
		.poll(() => snow.evaluate((node) => getComputedStyle(node, "::before").transform))
		.not.toBe(snowLayers[0].transform);
	const snowTexture = await page.request.get("/images/christmas/snowflakes.svg");
	expect(snowTexture.ok()).toBe(true);
	await expect(page.locator('[data-test="landing-output-settings-trigger"]')).toContainText("9:16");
	const editor = page.locator(".christmas-editor");
	await editor.getByRole("button", { name: "Desktop", exact: true }).click();
	await expect(prompt).toHaveValue(/main subject in the right half/);
	await expect(page.locator('[data-test="landing-output-settings-trigger"]')).toContainText("16:9");
	await editor.getByRole("button", { name: "Phone", exact: true }).click();
	await page
		.locator('input[type="file"]')
		.first()
		.setInputFiles(path.resolve(__dirname, "../public/images/christmas/pet.webp"));
	await expect(page.locator('[data-test="landing-source-panel"] img')).toBeVisible();
	await page.locator(".christmas-style-grid article").nth(2).getByRole("button").click();
	await expect(prompt).toHaveValue(/clear glass snow globe/);
	await expect(page.locator('[data-test="landing-source-panel"] img')).toBeVisible();
	await prompt.fill("My own Christmas instruction");
	page.once("dialog", (dialog) => dialog.dismiss());
	await page.locator(".christmas-style-grid article").nth(4).getByRole("button").click();
	await expect(prompt).toHaveValue("My own Christmas instruction");
	page.once("dialog", (dialog) => dialog.accept());
	await editor.getByRole("button", { name: "Create a scene", exact: true }).click();
	await expect(prompt).toHaveValue(/Create the scene without people/);
	await expect(page.locator('[data-test="landing-source-panel"] img')).toHaveCount(0);
	await expect(page.locator("#landing-source-image")).toHaveCount(0);
	await editor.getByRole("button", { name: "Use my photo", exact: true }).click();
	await expect(page.locator("#landing-source-image")).toHaveCount(1);
	for (const width of [1920, 1440, 390, 320]) {
		await page.setViewportSize({ width, height: 900 });
		await page.evaluate(() => window.scrollTo(0, 0));
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		await page.screenshot({ path: testInfo.outputPath(`christmas-${width}.png`), fullPage: true });
		if (width === 1920)
			await page.screenshot({ path: testInfo.outputPath("christmas-snow-desktop.png") });
	}
	await page.locator(".christmas-faq").scrollIntoViewIfNeeded();
	expect(await snow.evaluate((node) => node.getBoundingClientRect().bottom)).toBeGreaterThan(0);
	await page.screenshot({ path: testInfo.outputPath("christmas-snow-bottom-mobile.png") });
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.getByRole("button", { name: "Try preview & crop" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByRole("button", { name: "Download wallpaper" })).toBeEnabled();
	await expect(dialog.locator("canvas")).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath("christmas-crop.png") });
	const firstDownload = page.waitForEvent("download");
	await dialog.getByRole("button", { name: "Download wallpaper" }).click();
	const first = await firstDownload;
	const firstBytes = await readFile((await first.path())!);
	const dimensions = `${firstBytes.readUInt32BE(16)} × ${firstBytes.readUInt32BE(20)} px · PNG`;
	await expect(dialog.locator("output")).toHaveText(dimensions);
	expect(firstBytes.readUInt32BE(16)).toBeLessThanOrEqual(941);
	await dialog.getByRole("checkbox", { name: "Show screen controls" }).uncheck();
	const secondDownload = page.waitForEvent("download");
	await dialog.getByRole("button", { name: "Download wallpaper" }).click();
	const secondBytes = await readFile((await (await secondDownload).path())!);
	expect(secondBytes.equals(firstBytes)).toBe(true); // DOM clock never enters exported pixels.
	await dialog.getByLabel("Screen shape").selectOption("desktop");
	await expect(dialog.locator("output")).toContainText("941 × 529");
	await page.setViewportSize({ width: 320, height: 800 });
	await dialog.getByLabel("Screen shape").selectOption("tall");
	expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
	await dialog.screenshot({ path: testInfo.outputPath("christmas-crop-mobile.png") });
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await page.goto("/christmas-wallpaper?lang=de");
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
	await page.goto("/christmas-wallpaper?job=private-example");
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
	await mockPublicImageAvailability(page, ["auto", "1:1"]);
	await page.goto("/christmas-wallpaper");
	await page
		.locator(".christmas-editor")
		.getByRole("button", { name: "Desktop", exact: true })
		.click();
	await expect(page.locator(".christmas-editor [role='alert']")).toContainText("does not support");
	await expect(prompt).toHaveValue(/tall 9:16 composition/);
});

test("Christmas screen preview follows ready results and preserves applied crops", async ({
	page,
}, testInfo) => {
	test.setTimeout(120_000);
	await mockPublicImageAvailability(page, ["auto", "1:1", "9:16", "16:9"]);
	// Exercise portrait/landscape comparison with local, pre-existing artwork.
	await page.route("**/images/christmas/street.webp", (route) =>
		route.fulfill({
			path: path.resolve(
				__dirname,
				"../public/images/landing/variants/case-mediterranean-room-960.5746aa7c4de00985.webp",
			),
			contentType: "image/webp",
		}),
	);
	await page.goto("/christmas-wallpaper");
	await expect(
		page.locator(".christmas-editor").getByRole("button", { name: "Desktop", exact: true }),
	).toBeEnabled();
	await page.locator(".christmas-page").evaluate((node) => {
		for (const child of Array.from(node.children)) (child as HTMLElement).style.display = "none";
		const fixture = document.createElement("div");
		fixture.id = "wallpaper-interaction-fixture";
		node.append(fixture);
	});
	await page.addStyleTag({
		content: await readFile(
			path.resolve(__dirname, "../modules/christmas/wallpaper-crop.css"),
			"utf8",
		),
	});
	await page.addScriptTag({
		content: await buildWallpaperResultInteraction(path.resolve(__dirname, "..")),
	});
	await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
	const fixture = page.locator("#wallpaper-interaction-fixture");
	const preview = fixture.locator(".christmas-preview");
	const picture = preview.locator(".christmas-device img");
	const setState = (next: Record<string, unknown>) =>
		page.evaluate((next) => (window as any).wallpaperFixture.set(next), next);
	await expect(preview).toHaveAttribute("data-wallpaper-source", "result");
	await expect(picture).toHaveAttribute("src", "/images/christmas/street.webp");
	await expect(preview).toContainText("Your result");
	const comparison = fixture.locator(".christmas-editor [data-comparison-view]");
	await expect(comparison).toHaveAttribute("data-comparison-view", "side-by-side");
	await expect(comparison.locator("img")).toHaveCount(2);
	await expect
		.poll(() =>
			comparison
				.locator("img")
				.evaluateAll((images) =>
					images.every(
						(image) =>
							(image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
					),
				),
		)
		.toBe(true);
	for (const width of [1440, 390]) {
		await page.setViewportSize({ width, height: 900 });
		const original = comparison.getByAltText("Original source image");
		const result = comparison.getByAltText("Edited result image");
		await expect(original).toHaveCSS("object-fit", "contain");
		await expect(result).toHaveCSS("object-fit", "contain");
		await expect(original.locator("..")).toHaveCSS("clip-path", "none");
		const originalBounds = (await original.boundingBox())!;
		const resultBounds = (await result.boundingBox())!;
		if (width === 1440)
			expect(originalBounds.x + originalBounds.width).toBeLessThan(resultBounds.x);
		else expect(originalBounds.y + originalBounds.height).toBeLessThan(resultBounds.y);
		await comparison.screenshot({ path: testInfo.outputPath(`comparison-complete-${width}.png`) });
		await comparison.getByRole("button", { name: "Enlarge original", exact: true }).click();
		const enlarged = page.getByRole("dialog");
		await expect(enlarged.locator("img")).toHaveAttribute(
			"src",
			"/images/christmas/fireplace.webp",
		);
		await expect(enlarged.locator("img")).toHaveCSS("object-fit", "contain");
		await enlarged.screenshot({ path: testInfo.outputPath(`comparison-enlarged-${width}.png`) });
		await page.keyboard.press("Escape");
		await expect(enlarged).toHaveCount(0);
		await comparison.getByRole("button", { name: "Enlarge result", exact: true }).click();
		await expect(enlarged.locator("img")).toHaveAttribute("src", "/images/christmas/street.webp");
		await enlarged.locator("img").click();
		await expect(enlarged).toHaveCount(0);
	}
	await fixture.getByRole("button", { name: "Slider", exact: true }).click();
	const originalLayer = comparison.locator("[style*='clip-path']");
	await expect(originalLayer).toHaveCSS(
		"background-color",
		await comparison.evaluate((node) => getComputedStyle(node).backgroundColor),
	);
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 900 });
		const handle = comparison.locator("div[aria-hidden=true] > span");
		const frameBounds = await comparison.boundingBox();
		const handleBounds = await handle.boundingBox();
		expect(handleBounds!.y + handleBounds!.height / 2).toBeCloseTo(
			frameBounds!.y + frameBounds!.height / 2,
			0,
		);
		await comparison.screenshot({
			path: testInfo.outputPath(`comparison-mixed-ratios-${width}.png`),
		});
	}
	await page.setViewportSize({ width: 1440, height: 900 });
	await fixture.getByRole("button", { name: "Show original", exact: true }).click();
	await expect(originalLayer).toHaveCSS("clip-path", "inset(0px 0% 0px 0px)");
	await comparison.screenshot({ path: testInfo.outputPath("comparison-full-original.png") });
	await fixture.getByRole("button", { name: "Show result", exact: true }).click();
	await expect(originalLayer).toHaveCSS("clip-path", "inset(0px 100% 0px 0px)");
	await comparison.screenshot({ path: testInfo.outputPath("comparison-full-result.png") });
	await fixture.locator(".christmas-style-grid article").nth(4).getByRole("button").click();
	await expect(preview).toHaveAttribute("data-wallpaper-source", "example");
	await expect(picture).toHaveAttribute("src", "/images/christmas/pink.webp");
	await expect(preview).toContainText("Pink Christmas");
	await preview.screenshot({ path: testInfo.outputPath("christmas-selected-example.png") });
	await preview.getByRole("button", { name: "Your result", exact: true }).click();
	await expect(picture).toHaveAttribute("src", "/images/christmas/street.webp");
	await expect(preview).not.toContainText("Pink Christmas");
	// Reselecting the already active style must also open its example.
	await fixture.locator(".christmas-style-grid article").nth(4).getByRole("button").click();
	await expect(picture).toHaveAttribute("src", "/images/christmas/pink.webp");
	await preview.getByRole("button", { name: "Your result", exact: true }).click();
	await preview.getByRole("button", { name: "Preview & crop" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByRole("button", { name: "Apply to preview" })).toBeEnabled();
	await dialog.getByLabel("Screen shape").selectOption("desktop");
	await dialog.getByLabel("Zoom", { exact: true }).fill("1.5");
	await dialog.getByLabel("Move vertically").fill("75");
	await dialog.getByRole("checkbox", { name: "Show screen controls" }).uncheck();
	await dialog.getByRole("button", { name: "Apply to preview" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(preview.locator(".christmas-device-screen")).toHaveCSS(
		"aspect-ratio",
		"1920 / 1080",
	);
	await expect(preview.locator(".christmas-desktop-icons")).toHaveCount(0);
	await expect(picture).toHaveCSS("position", "absolute");
	await preview.getByRole("button", { name: "Style example", exact: true }).click();
	await expect(picture).toHaveAttribute("src", "/images/christmas/pink.webp");
	await preview.getByRole("button", { name: "Your result", exact: true }).click();
	await expect(picture).toHaveAttribute("src", "/images/christmas/street.webp");
	await expect
		.poll(() =>
			picture.evaluate((node: HTMLImageElement) => {
				const bounds = node.getBoundingClientRect();
				return bounds.width / bounds.height / (node.naturalWidth / node.naturalHeight);
			}),
		)
		.toBeCloseTo(1, 2);
	await preview.getByRole("button", { name: "Preview & crop" }).click();
	await expect(dialog.getByLabel("Screen shape")).toHaveValue("desktop");
	await expect(dialog.getByLabel("Zoom", { exact: true })).toHaveValue("1.5");
	await expect(dialog.getByLabel("Move vertically")).toHaveValue("75");
	await expect(dialog.getByRole("checkbox", { name: "Show screen controls" })).not.toBeChecked();
	const download = page.waitForEvent("download");
	await dialog.getByRole("button", { name: "Download wallpaper" }).click();
	const bytes = await readFile((await (await download).path())!);
	await expect(dialog.locator("output")).toHaveText(
		`${bytes.readUInt32BE(16)} × ${bytes.readUInt32BE(20)} px · PNG`,
	);
	await page.keyboard.press("Escape");
	await preview.getByRole("button", { name: "Style example", exact: true }).click();
	await setState({ asset: "globe" });
	await expect(picture).toHaveAttribute("src", "/images/christmas/globe.webp");
	await expect(preview.locator(".christmas-device-screen")).toHaveCSS(
		"aspect-ratio",
		"1080 / 1920",
	);
	await comparison.getByRole("button", { name: "Enlarge original", exact: true }).last().click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await setState({ denied: true });
	await page.evaluate(() => (window as any).wallpaperFixture.invalidate());
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(preview.locator("[role=alert]")).toBeVisible();
	await expect(picture).toHaveCount(0);
	await setState({ denied: false, owner: "owner-2" });
	await expect(picture).toHaveCount(0);
	await setState({ owner: null, asset: "pet" });
	await expect(picture).toHaveAttribute("src", "/images/christmas/pet.webp");
	await preview.getByRole("button", { name: "Preview & crop" }).click();
	await expect(dialog.getByRole("button", { name: "Apply to preview" })).toBeEnabled();
	await dialog.getByLabel("Zoom", { exact: true }).fill("1.25");
	await dialog.getByRole("button", { name: "Apply to preview" }).click();
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 900 });
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		await preview.evaluate((node) => window.scrollBy(0, node.getBoundingClientRect().top - 120));
		await preview.screenshot({
			path: testInfo.outputPath(`christmas-result-preview-${width}.png`),
		});
	}
	await setState({ expiresAt: new Date(Date.now() + 1200).toISOString() });
	await expect(preview).toHaveAttribute("data-wallpaper-source", "example");
	await expect(picture).toHaveAttribute("src", "/images/christmas/pink.webp");
	await setState({ expiresAt: "2099-01-01T00:00:00Z", phase: "ready" });
	await expect(preview).toHaveAttribute("data-wallpaper-source", "result");
	await setState({ phase: "waiting" });
	await expect(preview).toHaveAttribute("data-wallpaper-source", "example");
	await setState({ phase: "ready" });
	await expect(preview).toHaveAttribute("data-wallpaper-source", "result");
	await setState({ phase: "closed" });
	await expect(preview).toHaveAttribute("data-wallpaper-source", "example");
});

test("Christmas wallpaper account status and history stay readable in the seasonal theme", async ({
	page,
}, testInfo) => {
	test.setTimeout(120_000);
	await mockPublicImageAvailability(page, ["auto", "1:1", "9:16", "16:9"]);
	await page.goto("/christmas-wallpaper");
	await expect(
		page.locator(".christmas-editor").getByRole("button", { name: "Desktop", exact: true }),
	).toBeEnabled();
	await page.locator(".christmas-editor").evaluate((editor) => {
		const fixture = document.createElement("div");
		fixture.id = "christmas-account-fixture";
		fixture.style.marginTop = "24px";
		editor.append(fixture);
	});
	await page.addScriptTag({
		content: await buildChristmasResultPreview(path.resolve(__dirname, "..")),
	});
	const fixture = page.locator("#christmas-account-fixture");
	await expect(
		fixture.getByRole("heading", { name: "Checking your reference image" }),
	).toBeVisible();
	await expect(fixture.locator(".studio-recent button")).toHaveCount(2);
	// Measure inherited text against the actual opaque surface in the loaded app CSS.
	const contrasts = await fixture.evaluate((node) => {
		const luminance = (color: string) => {
			const values = color
				.match(/[\d.]+/g)!
				.slice(0, 3)
				.map(Number)
				.map((value) => {
					const channel = value / 255;
					return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
				});
			return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
		};
		return [...node.querySelectorAll("h2, .studio-recent button.bg-background .font-medium")].map(
			(element) => {
				const foreground = luminance(getComputedStyle(element).color);
				const surface = element.closest("section, button")!;
				const background = luminance(getComputedStyle(surface).backgroundColor);
				return (
					(Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
				);
			},
		);
	});
	expect(contrasts).toHaveLength(2);
	for (const contrast of contrasts) expect(contrast).toBeGreaterThan(4.5);
	await fixture.screenshot({ path: testInfo.outputPath("christmas-account-components.png") });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await expect
		.poll(() =>
			page
				.locator(".christmas-snow")
				.evaluate((node) =>
					["::before", "::after"].map((pseudo) => getComputedStyle(node, pseudo).animationName),
				),
		)
		.toEqual(["none", "none"]);
});

test("editing examples open the create page with an editable prompt", async ({ page }) => {
	await mockPublicImageAvailability(page);
	await expectPublicPage(page, "/examples", "index");
	await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
	await expect(page.locator('#examples a[href^="/create?example="]')).toHaveCount(12);
	await page.locator('#examples a[href="/create?example=mediterranean"]').click();
	await expect(page).toHaveURL(/\/create\?example=mediterranean$/, { timeout: 30_000 });
	await expect(page.locator("#landing-edit-prompt")).toHaveValue(/sunlit mediterranean retreat/i);
});

test.describe("image-to-image landing page", () => {
	test.use({ contextOptions: { reducedMotion: "reduce" } });
	test.beforeEach(async ({ page }) => {
		await mockPublicImageAvailability(page);
	});

	for (const width of [1440, 390, 320]) {
		test(`has focused metadata and preserves the shared composer at ${width}px`, async ({
			page,
			context,
		}) => {
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
			const generator = page.locator('[data-test="landing-generator"]');
			const prompt = generator.getByRole("textbox", { name: "Image prompt", exact: true });
			const action = generator.locator('[data-test="landing-generate"]');
			await expect(page.locator('[data-test="landing-model-trigger"]')).toContainText(
				"Nano Banana 2 Lite",
			);
			await page.getByRole("button", { name: "Use this prompt" }).first().click();
			await expect(prompt).toHaveValue(/Keep the product, its shape/);
			await expect(page.getByRole("heading", { level: 1 })).toBeInViewport();
			await expect(action).toBeEnabled();
			await expect(page.locator("#landing-source-image")).toHaveAttribute(
				"aria-label",
				"Reference image · optional",
			);
			await expect(page.locator('[data-test="landing-source-panel"] button')).toHaveAccessibleName(
				/optional/i,
			);
			const [sourceRect, promptRect, controlsRect] = await Promise.all([
				box(generator.locator("[data-reference-upload]")),
				box(prompt),
				box(generator.locator('[data-test="landing-controls-panel"]')),
			]);
			expect(sourceRect.x + sourceRect.width).toBeLessThanOrEqual(promptRect.x);
			expect(Math.abs(sourceRect.y - promptRect.y)).toBeLessThan(2);
			expect(controlsRect.y).toBeGreaterThan(
				Math.max(sourceRect.y + sourceRect.height, promptRect.y + promptRect.height),
			);
			await generator.getByRole("button", { name: /^Open output settings:/ }).click();
			const settings = page.locator('[data-test="landing-output-settings-panel"]');
			await expect(settings).toBeVisible();
			await expect(settings.locator('[data-fixed-setting="resolution"]')).toHaveText("1K");
			await settings.getByText("1:1", { exact: true }).click();
			await expect(settings.getByRole("radio", { name: "1:1", exact: true })).toBeChecked();
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
				true,
			);
			await page.keyboard.press("Escape");
			await expect(settings).toBeHidden();
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
			await expect(
				generator.getByRole("textbox", { name: "Edit instruction", exact: true }),
			).toHaveValue(/Keep the product, its shape/);
			await expect(action).toBeEnabled();
			await page.getByRole("button", { name: /remove image/i }).click();
			await expect(prompt).toHaveValue(/Keep the product, its shape/);
			await expect(action).toBeEnabled();
		});
	}

	for (const locale of ["de", "es", "fr"]) {
		test(`indexes the translated ${locale} page with its own canonical`, async ({ page }) => {
			const response = await page.goto(`/image-to-image?lang=${locale}`);
			expect(response?.status()).toBe(200);
			expect(response?.headers()["x-robots-tag"]).toBeUndefined();
			await expect(page.locator("html")).toHaveAttribute("lang", locale);
			await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
			await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(
				"Image to Image AI Generator",
			);
			await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
				"href",
				new URL(`/image-to-image?lang=${locale}`, baseUrl).href,
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
				expect(initialHeading.replace(/<[^>]*>/g, "")).toMatch(
					/ai image editor &(?:amp;)? prompt photo editor/i,
				);
				expect(html).toContain("flexible prompt editing");
				expect(html).toContain("How does prompt-based photo editing work?");
				await expect(page).toHaveTitle(/AI Image Editor &(?:amp;)? Prompt Photo Editor/);
				await expect(page.locator('meta[name="description"]')).toHaveAttribute(
					"content",
					"Edit photos with your own prompt. Describe what to change, keep images private, and review credits before generating. Safety and usage limits apply.",
				);
				await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
					"content",
					await page.title(),
				);
				const explanation = page.locator("#faq details").filter({
					hasText: "How does prompt-based photo editing work?",
				});
				await explanation.locator("summary").click();
				await expect(explanation.locator("p")).toBeVisible();
				await expect(explanation).toContainText("model capabilities, and plan limits still apply");
				for (const width of [1440, 390, 320]) {
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
		await expect(yearly).toContainText("-50%");
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
		await expect(page.locator('[data-test="public-pricing-creator-price"]')).toHaveText("$9.50");
		await expect(page.locator('[data-test="public-pricing-ultimate-price"]')).toHaveText("$24.50");
		await expect(page.locator('[data-test="public-pricing-studio-price"]')).toHaveText("$39.50");
		await expect(page.locator('[data-test="public-pricing-creator-annual-summary"]')).toContainText(
			/\$114.*\$114.*50%.*12 monthly payments/,
		);
		await expect(
			page.locator('[data-test="public-pricing-ultimate-annual-summary"]'),
		).toContainText(/\$294.*\$294.*50%.*12 monthly payments/);
		await expect(page.locator('[data-test="public-pricing-studio-annual-summary"]')).toContainText(
			/\$474.*\$474.*50%.*12 monthly payments/,
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

async function box(locator: Locator) {
	return locator.evaluate((element) => {
		const { x, y, width, height } = element.getBoundingClientRect();
		return { x, y, width, height };
	});
}

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
