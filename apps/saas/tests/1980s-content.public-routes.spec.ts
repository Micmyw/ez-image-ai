import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
	expect,
	test,
	type APIRequestContext,
	type Locator,
	type Page,
	type TestInfo,
} from "@playwright/test";

import type { EffectAsset, EffectExample, EffectPreset } from "../modules/effects/lib/types";
import { readEightiesEffect } from "./helpers/effects-content";

const effectPath = "/effects/1980s-ai-photo";
const guidePath = "/blog/ai-image-editing-prompts";
const publicRoot = resolve(__dirname, "../public");
const effect = readEightiesEffect();
const presetIds = ["studio-portrait", "family-snapshot", "street-portrait"] as const;
const messages = JSON.parse(
	readFileSync(resolve(__dirname, "../../../packages/i18n/translations/en/saas.json"), "utf8"),
) as { media: { create: { products: Record<string, { label: string }> } } };
const blockedRequests = new WeakMap<Page, string[]>();

test.use({
	storageState: { cookies: [], origins: [] },
	contextOptions: { reducedMotion: "reduce" },
});

test.beforeEach(async ({ page, baseURL }) => {
	const url = new URL(baseURL ?? "http://localhost:3000");
	expect(["localhost", "127.0.0.1", "[::1]"]).toContain(url.hostname);
	expect(url.protocol).toBe("http:");
	const blocked: string[] = [];
	blockedRequests.set(page, blocked);
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		const readOnlyMedia = ["/api/media/guest-capability", "/api/rpc/media/getPublicCatalog"];
		const businessApi = /^\/api\/(?:media|rpc\/(?:media|payments|billing))\//.test(path);
		const safeRead = ["GET", "HEAD", "OPTIONS"].includes(request.method()) && !businessApi;
		if (safeRead || readOnlyMedia.includes(path)) return route.continue();
		blocked.push(`${request.method()} ${path}`);
		return route.abort("blockedbyclient");
	});
});

test.afterEach(async ({ page }) => {
	expect(
		blockedRequests.get(page) ?? [],
		"Read/copy/navigation must not submit a business mutation",
	).toEqual([]);
});

test.describe("1980s real published content — local public-route acceptance", () => {
	test.beforeEach(async ({ baseURL }, testInfo) => {
		if (effect.status === "draft") {
			const description =
				"content-blocked: 1980s remains draft; real reviewed product outputs and publication approval are required. Empty-directory or protected-preview checks do not complete this acceptance.";
			testInfo.annotations.push({ type: "content-blocked", description });
			await testInfo.attach("1980s-content-blocked", {
				contentType: "application/json",
				body: Buffer.from(
					JSON.stringify(
						{
							status: "content-blocked",
							localBaseURL: baseURL,
							contentStatus: effect.status,
							presets: effect.presets.map((preset) => ({
								id: preset.id,
								version: preset.version,
								matchingExamples: matchingExamples(preset).length,
							})),
							localPublicAcceptance: "not executed",
							generationAndProductionPublication: "outside this read-only suite",
						},
						null,
						2,
					),
				),
			});
			test.skip(true, description);
		}
		expect(
			effect.status,
			"The first complete 1980s theme must be published to pass public acceptance",
		).toBe("published");
	});

	test("each current preset has matching reviewed product evidence and real local image bytes", async ({
		request,
	}) => {
		expect(effect.presets.map((preset) => preset.id)).toEqual(presetIds);
		expect(effect.cover).toBeDefined();
		expect(effect.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
		expect(effect.lastTestedAt).toBeDefined();
		expect(effect.examples.some((example) => example.output.src === effect.cover?.src)).toBe(true);
		const assets = new Map<string, EffectAsset>();
		assets.set(effect.cover!.src, effect.cover!);
		for (const preset of effect.presets) {
			const examples = matchingExamples(preset);
			expect(examples.length, `${preset.id} needs a current reviewed output`).toBeGreaterThan(0);
			for (const example of examples) {
				expect(example.provenance.kind).toBe("product-generation");
				expect(example.provenance.evidence.trim()).not.toBe("");
				expect(example.productKey).toBe(preset.productKey);
				expect(example.parameters).toEqual(preset.parameters);
				expect(Number.isFinite(Date.parse(example.testedAt))).toBe(true);
				expect(messages.media.create.products[example.productKey]?.label).toBeTruthy();
				expect(preset.tests).toContainEqual(
					expect.objectContaining({
						exampleId: example.id,
						version: preset.version,
						prompt: preset.prompt,
						productKey: preset.productKey,
						parameters: preset.parameters,
						testedAt: example.testedAt,
						outcome: "passed",
					}),
				);
				assets.set(example.input.src, example.input);
				assets.set(example.output.src, example.output);
			}
		}
		for (const asset of assets.values()) await assertPublicAsset(request, asset);
	});

	test.describe("server-rendered content", () => {
		test.use({ javaScriptEnabled: false });
		test("anonymous HTML contains all three complete prompts, real captions, model/date, and canonical links", async ({
			page,
			request,
			baseURL,
		}) => {
			const response = await page.goto(effectPath);
			expect(response?.status()).toBe(200);
			await expect(page.getByRole("heading", { level: 1 })).toHaveText(effect.title);
			await expect(page).toHaveTitle(effect.seoTitle);
			await expect(page.locator('meta[name="description"]')).toHaveAttribute(
				"content",
				effect.seoDescription,
			);
			await assertCanonical(page, new URL(effectPath, baseURL).href);
			await expect(page.locator(".effect-preset-card")).toHaveCount(3);
			for (const preset of effect.presets) {
				const card = page.locator(`#preset-${preset.id}`);
				await expect(card.getByRole("heading", { level: 3 })).toHaveText(preset.name);
				expect(await card.locator("details.effect-prompt-disclosure pre").textContent()).toBe(
					preset.prompt,
				);
				const example = matchingExamples(preset)[0]!;
				const figure = card.locator(`figure[data-example-id="${example.id}"]`);
				await expect(figure).toHaveCount(1);
				await expect(figure.locator("figcaption")).toContainText(example.caption);
				await expect(figure.locator("time")).toHaveAttribute("datetime", example.testedAt);
				await expect(figure.locator("figcaption")).toContainText(
					messages.media.create.products[example.productKey]!.label,
				);
				await expect(figure.locator("figcaption")).toContainText(example.parameters.aspectRatio);
				await expect(figure.getByRole("button", { name: "Original", exact: true })).toHaveCount(1);
				await expect(figure.getByRole("button", { name: "Generated", exact: true })).toHaveCount(1);
				for (const asset of [example.input, example.output]) {
					const image = figure.locator("img");
					const metadata = await image.evaluateAll((images) =>
						images.map((item) => ({
							alt: item.getAttribute("alt"),
							width: item.getAttribute("width"),
							height: item.getAttribute("height"),
							src: item.getAttribute("src"),
						})),
					);
					expect(metadata).toContainEqual(
						expect.objectContaining({
							alt: asset.alt,
							width: String(asset.width),
							height: String(asset.height),
						}),
					);
					expect(
						metadata.some((item) => originalImagePath(item.src ?? "", baseURL!) === asset.src),
					).toBe(true);
				}
			}
			await expect(page.getByRole("link", { name: "Copy a prompt", exact: true })).toHaveAttribute(
				"href",
				"#effect-presets",
			);
			await expect(
				page.getByRole("link", { name: "Try with my photo", exact: true }),
			).toHaveAttribute("href", "#image-editor");
			await expect(page.locator(`.effect-guide-links a[href="${guidePath}"]`)).toBeVisible();
			const sitemap = await request.get("/sitemap.xml");
			expect(sitemap.status()).toBe(200);
			const xml = await sitemap.text();
			expect(xml).toContain(`<loc>${new URL(effectPath, baseURL).href}</loc>`);
			expect(xml).toContain(`<loc>${new URL("/effects", baseURL).href}</loc>`);
			expect(xml).not.toContain("/effects-preview/");
			for (const path of [
				"/effects-preview/1980s-ai-photo",
				"/effects/unknown-1980s-verification",
			]) {
				expect((await request.get(path, { maxRedirects: 0 })).status(), path).toBe(404);
			}
		});
	});

	test("the homepage and one real directory card lead to the canonical theme and three presets", async ({
		page,
		baseURL,
	}) => {
		await page.goto("/");
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(
			/AI Image Editor No Restrictions/i,
		);
		const featured = page
			.locator(".effect-card")
			.filter({ has: page.locator(`a[href^="${effectPath}"]`) });
		await expect(featured).toHaveCount(1);
		await expect(featured.locator("img")).toHaveAttribute("alt", effect.cover!.alt);
		await page.locator('a[href="/effects"]').first().click();
		await expect(page).toHaveURL(new URL("/effects", baseURL).href);
		await expect(page.getByRole("heading", { level: 1 })).toContainText("AI Photo Effects");
		await assertCanonical(page, new URL("/effects", baseURL).href);
		const directory = page.locator(".effects-directory.is-single");
		await expect(directory.locator(".effect-card.is-featured")).toHaveCount(1);
		await expect(directory.locator(".effect-card h2")).toHaveText(effect.title);
		await expect(directory.getByRole("searchbox")).toHaveCount(0);
		await expect(directory.locator("select, .effects-count")).toHaveCount(0);
		await expect(directory.locator(".effects-preset-links a")).toHaveCount(3);
		for (const preset of effect.presets) {
			const link = directory.getByRole("link", { name: new RegExp(escapeRegExp(preset.name)) });
			await expect(link).toHaveAttribute(
				"href",
				`${effectPath}?preset=${preset.id}&from=effects-directory#image-editor`,
			);
			await expect(link.locator("img")).toHaveAttribute(
				"alt",
				matchingExamples(preset)[0]!.output.alt,
			);
		}
		await expect(directory).not.toContainText(/trending|\d+ effects/i);
		await directory.getByRole("link", { name: /Explore prompts & try it/ }).click();
		await expect(page).toHaveURL(
			new RegExp(`${escapeRegExp(effectPath)}\\?from=effects-directory$`),
		);
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(effect.title);
	});

	test("each copy is exact and each preset prepares the same prompt without generation", async ({
		page,
		context,
		baseURL,
	}) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await page.goto(effectPath);
		await declineOptionalConsent(page);
		await expect(page.locator("#landing-edit-prompt")).toHaveValue(
			effect.presets.find((preset) => preset.id === effect.defaultPresetId)!.prompt,
		);
		for (const preset of effect.presets) {
			const card = page.locator(`#preset-${preset.id}`);
			await card.getByRole("button", { name: "Copy prompt", exact: true }).click();
			await expect(card.locator(".effect-copy-status")).toHaveText("Copied");
			expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(preset.prompt);
			await card.getByRole("button", { name: "Use this preset", exact: true }).click();
			await expect(page.locator("#effect-preset")).toHaveValue(preset.id);
			await expect(page.locator("#landing-edit-prompt")).toHaveValue(preset.prompt);
			expect(new URL(page.url()).searchParams.get("preset")).toBe(preset.id);
			await assertCanonical(page, new URL(effectPath, baseURL).href);
		}
		await page.goto(
			`${effectPath}?preset=family-snapshot&source=ai-image-editing-prompts&utm_source=chatgpt.com`,
		);
		await expect(page.locator("#effect-preset")).toHaveValue("family-snapshot");
		await expect(page.locator("#landing-edit-prompt")).toHaveValue(
			effect.presets.find((preset) => preset.id === "family-snapshot")!.prompt,
		);
		await assertCanonical(page, new URL(effectPath, baseURL).href);
	});

	test("the existing guide uses real comparison images and a copyable exact preset CTA", async ({
		page,
		context,
		baseURL,
	}, testInfo) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await page.goto("/blog");
		await declineOptionalConsent(page);
		await expect(page.locator(".blog-filters, .blog-results")).toHaveCount(0);
		const card = page
			.locator(".blog-card-with-cover")
			.filter({ has: page.locator(`a[href="${guidePath}"]`) });
		await expect(card).toHaveCount(1);
		const comparison = card.locator(".blog-card-comparison");
		await expect(comparison.locator("img")).toHaveCount(2);
		const preset = effect.presets.find((candidate) => candidate.id === "studio-portrait")!;
		const example = matchingExamples(preset)[0]!;
		for (const asset of [example.input, example.output])
			await expect(comparison.getByAltText(asset.alt, { exact: true })).toHaveCount(1);
		await page.setViewportSize({ width: 1440, height: 1000 });
		await loadedImage(comparison.locator("img").first());
		await page.screenshot({
			path: testInfo.outputPath("1980s-blog-directory-desktop.png"),
			fullPage: true,
		});
		await card.getByRole("heading").getByRole("link").click();
		await expect(page).toHaveURL(new URL(guidePath, baseURL).href);
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(
			"How to Write AI Image Editing Prompts",
		);
		await assertCanonical(page, new URL(guidePath, baseURL).href);
		await expect(page.locator(".blog-cover img")).toHaveAttribute("alt", example.output.alt);
		const feature = page.locator(".blog-effect-feature");
		await expect(feature).toHaveCount(1);
		await expect(feature.locator(`figure[data-example-id="${example.id}"]`)).toHaveCount(1);
		expect(await feature.locator(".blog-preset-prompt pre").textContent()).toBe(preset.prompt);
		await feature.getByRole("button", { name: "Copy prompt", exact: true }).click();
		await expect(feature.locator(".blog-preset-prompt output")).toHaveText("Copied");
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(preset.prompt);
		const cta = feature.locator(".blog-effect-feature-cta");
		await expect(cta).toHaveAttribute(
			"href",
			`${effectPath}?preset=studio-portrait&source=ai-image-editing-prompts`,
		);
		await feature.scrollIntoViewIfNeeded();
		await page.screenshot({ path: testInfo.outputPath("1980s-blog-preset-desktop.png") });
		await cta.click();
		await expect(page.locator("#effect-preset")).toHaveValue(preset.id);
		await expect(page.locator("#landing-edit-prompt")).toHaveValue(preset.prompt);
	});

	test("390px first fold shows the real theme and effect, mobile navigation works, and 360px does not overflow", async ({
		page,
	}, testInfo) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto("/effects");
		await declineOptionalConsent(page);
		await page.evaluate(() => window.scrollTo(0, 0));
		const featured = page.locator(".effects-directory .effect-card.is-featured");
		await assertFirstFold(featured.locator("h2"), featured.locator("img"), 160);
		await screenshot(page, testInfo, "1980s-directory-390-firstfold.png");
		const menu = page.locator('[data-test="header-navigation-trigger"]');
		await expect(menu).toHaveCount(1);
		await menu.click();
		const drawer = page.locator('[data-test="header-navigation-drawer"]');
		await expect(drawer).toBeVisible();
		for (const href of ["/effects", "/blog", "/docs"])
			await expect(drawer.locator(`a[href="${href}"]`)).toBeVisible();
		await screenshot(page, testInfo, "1980s-mobile-navigation.png");
		await drawer.locator('a[href="/blog"]').click();
		await expect(page).toHaveURL(/\/blog$/);
		await expect(drawer).toBeHidden();
		await page.goto(effectPath);
		await page.evaluate(() => window.scrollTo(0, 0));
		await assertFirstFold(
			page.getByRole("heading", { level: 1 }),
			page.locator(".effect-mobile-example .effect-example-frame:not([hidden]) img"),
			100,
		);
		await screenshot(page, testInfo, "1980s-detail-390-firstfold.png");
		await page.setViewportSize({ width: 360, height: 844 });
		for (const path of ["/effects", effectPath, "/blog", guidePath]) {
			await page.goto(path);
			await assertNoHorizontalOverflow(page, `${path} at 360px`);
			if (path === effectPath) {
				for (const preset of effect.presets)
					await page.locator(`#preset-${preset.id} summary`).click();
				await assertNoHorizontalOverflow(page, "all three complete prompts expanded at 360px");
			}
			await screenshot(
				page,
				testInfo,
				`1980s-${path === effectPath ? "detail" : path === guidePath ? "guide" : path.slice(1)}-360.png`,
				true,
			);
		}
		await page.setViewportSize({ width: 1440, height: 1000 });
		for (const path of ["/effects", effectPath]) {
			await page.goto(path);
			await assertNoHorizontalOverflow(page, `${path} desktop`);
			await loadedImage(
				page.locator(
					path === effectPath
						? ".effect-desktop-example .effect-example-frame:not([hidden]) img"
						: ".effects-directory .effect-card img",
				),
			);
			await screenshot(
				page,
				testInfo,
				`1980s-${path === effectPath ? "detail" : "directory"}-desktop.png`,
				true,
			);
			await page.evaluate(() => window.scrollTo(0, 0));
			await screenshot(
				page,
				testInfo,
				`1980s-${path === effectPath ? "detail" : "directory"}-desktop-firstfold.png`,
			);
		}
	});
});

test.describe("Docs style smoke independent of 1980s publication", () => {
	for (const path of [
		"/docs",
		"/docs/quick-start",
		"/docs/image-editing",
		"/docs/credits",
		"/docs/privacy",
	]) {
		test(`${path} retains styled readable content on desktop and mobile`, async ({
			page,
		}, testInfo) => {
			await page.setViewportSize({ width: 1440, height: 1000 });
			const response = await page.goto(path);
			expect(response?.status()).toBe(200);
			await declineOptionalConsent(page);
			const root = page.locator("#docs-root");
			const heading = root.getByRole("heading", { level: 1 });
			const article = root.locator("#nd-page");
			await expect(heading).toHaveCount(1);
			await expect(root.locator(".docs-prose")).toBeVisible();
			await expect(root.locator(".docs-prose")).toHaveCSS("font-size", "14px");
			expect(
				await heading.evaluate((node) => parseFloat(getComputedStyle(node).fontSize)),
			).toBeGreaterThanOrEqual(28);
			await expect(root.locator("#nd-sidebar")).toBeVisible();
			expect((await article.boundingBox())!.width).toBeGreaterThan(500);
			await assertNoHorizontalOverflow(page, `${path} desktop`);
			await screenshot(page, testInfo, `${path.replaceAll("/", "-").slice(1)}-desktop.png`, true);
			await page.setViewportSize({ width: 390, height: 844 });
			await page.evaluate(() => window.scrollTo(0, 0));
			await expect(heading).toBeVisible();
			expect((await article.boundingBox())!.width).toBeGreaterThan(340);
			await assertNoHorizontalOverflow(page, `${path} mobile`);
			await screenshot(page, testInfo, `${path.replaceAll("/", "-").slice(1)}-390.png`);
		});
	}
});

function matchingExamples(preset: EffectPreset): EffectExample[] {
	return effect.examples.filter(
		(example) =>
			preset.exampleIds.includes(example.id) &&
			example.presetId === preset.id &&
			example.presetVersion === preset.version,
	);
}

async function assertPublicAsset(request: APIRequestContext, asset: EffectAsset) {
	expect(asset.src).toMatch(
		/^\/images\/effects\/1980s-ai-photo\/[a-zA-Z0-9_.-]+\.(webp|png|jpe?g|avif)$/,
	);
	expect(asset.alt.trim()).not.toBe("");
	expect(asset.width).toBeGreaterThan(256);
	expect(asset.height).toBeGreaterThan(256);
	expect(asset.rights.evidence.trim()).not.toBe("");
	expect(asset.rights.holder.trim()).not.toBe("");
	expect(Number.isFinite(Date.parse(asset.rights.verifiedAt))).toBe(true);
	const file = resolve(publicRoot, `.${asset.src}`);
	expect(file.startsWith(`${publicRoot}\\`) || file.startsWith(`${publicRoot}/`)).toBe(true);
	expect((await stat(file)).isFile()).toBe(true);
	const local = await readFile(file);
	expect(
		local.byteLength,
		`${asset.src} must contain image bytes, not an empty placeholder`,
	).toBeGreaterThan(512);
	const response = await request.get(asset.src);
	expect(response.status(), asset.src).toBe(200);
	expect(response.headers()["content-type"], asset.src).toMatch(/^image\//);
	expect(
		createHash("sha256")
			.update(await response.body())
			.digest("hex"),
		asset.src,
	).toBe(createHash("sha256").update(local).digest("hex"));
}

async function assertCanonical(page: Page, expected: string) {
	await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", expected);
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
		"content",
		/(?:^|,\s*)index(?:,|$)/,
	);
	await expect(page.locator('meta[name="robots"]')).not.toHaveAttribute("content", /noindex/);
}

async function declineOptionalConsent(page: Page) {
	const banner = page.locator("[data-consent-banner]");
	if (await banner.count()) {
		await banner.getByRole("button", { name: "Decline optional", exact: true }).click();
		await expect(banner).toHaveCount(0);
	}
}

async function loadedImage(image: Locator) {
	await expect(image).toHaveCount(1);
	await expect(image).toBeVisible();
	await expect(image).toHaveJSProperty("complete", true);
	expect(await image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(
		0,
	);
}

async function assertFirstFold(title: Locator, image: Locator, minimumImageHeight: number) {
	await loadedImage(image);
	await expect(title).toBeInViewport();
	const titleBox = (await title.boundingBox())!;
	const imageBox = (await image.boundingBox())!;
	expect(titleBox.y).toBeGreaterThanOrEqual(0);
	expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(844);
	expect(imageBox.width).toBeGreaterThanOrEqual(240);
	expect(
		Math.min(844, imageBox.y + imageBox.height) - Math.max(0, imageBox.y),
		"A recognizable part of the real effect must be visible before scrolling",
	).toBeGreaterThanOrEqual(minimumImageHeight);
}

async function assertNoHorizontalOverflow(page: Page, label: string) {
	await expect
		.poll(
			() =>
				page.evaluate(
					() =>
						Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
				),
			{ message: label },
		)
		.toBeLessThanOrEqual(0);
}

async function screenshot(page: Page, testInfo: TestInfo, name: string, fullPage = false) {
	await page.screenshot({ path: testInfo.outputPath(name), fullPage });
}

function originalImagePath(src: string, baseURL: string): string {
	const url = new URL(src, baseURL);
	return url.pathname === "/_next/image" ? (url.searchParams.get("url") ?? "") : url.pathname;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
