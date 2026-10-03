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

const effectPath = "/blog/1980s-ai-photo";
const articleTitle = "1980s AI Photo Ideas & Prompts";
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
			await expect(page.getByRole("heading", { level: 1 })).toHaveText(articleTitle);
			await expect(page).toHaveTitle(new RegExp(escapeRegExp(articleTitle)));
			await expect(page.locator('meta[name="description"]')).toHaveAttribute(
				"content",
				expect.stringContaining("Three ways to give a portrait"),
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
			await expect(page.locator("article.photo-idea-article")).toContainText(
				"Four product generations",
			);
			await expect(page.locator("#image-editor")).toHaveCount(1);
			await expect(page.locator(`article.photo-idea-article a[href="${guidePath}"]`)).toBeVisible();
			const sitemap = await request.get("/sitemap.xml");
			expect(sitemap.status()).toBe(200);
			const xml = await sitemap.text();
			expect(xml).toContain(`<loc>${new URL(effectPath, baseURL).href}</loc>`);
			expect(xml).not.toContain(`<loc>${new URL("/effects", baseURL).href}</loc>`);
			expect(xml).not.toContain("/effects/1980s-ai-photo");
			expect(xml).not.toContain("/effects-preview/");
			for (const path of [
				"/effects-preview/1980s-ai-photo",
				"/effects/unknown-1980s-verification",
			]) {
				expect((await request.get(path, { maxRedirects: 0 })).status(), path).toBe(404);
			}
		});
	});

	test("homepage recommendations and Blog Photo Ideas lead to one canonical article", async ({
		page,
		baseURL,
	}) => {
		await page.goto("/");
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(
			/AI Image Editor No Restrictions/i,
		);
		const featured = page
			.locator("[data-photo-ideas-recommendations] .blog-card")
			.filter({ has: page.locator(`a[href="${effectPath}"]`) });
		await expect(featured).toHaveCount(1);
		await expect(featured.locator(`img[alt="${effect.cover!.alt}"]`)).toHaveCount(1);
		await page.goto("/blog?category=photo-ideas");
		await assertCanonical(page, new URL("/blog", baseURL).href, false);
		const directory = page.locator(".blog-directory");
		await expect(directory.locator(".blog-card")).toHaveCount(1);
		await expect(
			directory.getByRole("button", { name: "Photo Ideas", exact: true }),
		).toHaveAttribute("aria-pressed", "true");
		await directory.getByRole("heading", { name: articleTitle }).getByRole("link").click();
		await expect(page).toHaveURL(new URL(effectPath, baseURL).href);
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(articleTitle);
		await expect(page.locator(".effect-preset-card")).toHaveCount(3);
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
		await expect(page.locator(".blog-filters")).toBeVisible();
		await expect(page.locator(".blog-results")).toHaveText("3 posts");
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

	test("Photo Ideas, Resources navigation and the article fit mobile and desktop", async ({
		page,
	}, testInfo) => {
		test.setTimeout(180_000);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto("/blog?category=photo-ideas");
		await declineOptionalConsent(page);
		await expect(page.locator(".blog-directory .blog-card")).toHaveCount(1);
		await screenshot(page, testInfo, "photo-ideas-blog-390-firstfold.png");
		await page.locator('[data-test="header-navigation-trigger"]').click();
		const drawer = page.locator('[data-test="header-navigation-drawer"]');
		await expect(drawer).toBeVisible();
		await drawer.locator("summary").filter({ hasText: "Resources" }).click();
		for (const href of ["/blog", "/examples", "/docs"])
			await expect(drawer.locator(`a[href="${href}"]`)).toBeVisible();
		await expect(drawer.locator('a[href="/effects"]')).toHaveCount(0);
		await screenshot(page, testInfo, "resources-mobile-navigation.png");
		await drawer.locator('a[href="/blog"]').click();
		await expect(page).toHaveURL(/\/blog$/);
		await expect(drawer).toBeHidden();
		for (const width of [360, 390, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			for (const [name, path] of [
				["blog", "/blog"],
				["article", effectPath],
				["guide", guidePath],
			] as const) {
				await page.goto(path);
				await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
				await assertNoHorizontalOverflow(page, `${path} at ${width}px`);
				if (path === effectPath) {
					for (const preset of effect.presets)
						await page.locator(`#preset-${preset.id}`).scrollIntoViewIfNeeded();
					await page.locator("#image-editor").scrollIntoViewIfNeeded();
					await assertNoHorizontalOverflow(page, `editor at ${width}px`);
					await screenshot(page, testInfo, `1980s-editor-${width}.png`);
				}
				await page.evaluate(() => window.scrollTo(0, 0));
				await screenshot(page, testInfo, `${name}-${width}-firstfold.png`);
				await screenshot(page, testInfo, `${name}-${width}-full.png`, true);
			}
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

async function assertCanonical(page: Page, expected: string, indexable = true) {
	await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", expected);
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
		"content",
		indexable ? /(?:^|,\s*)index(?:,|$)/ : "noindex, follow",
	);
	if (indexable)
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
