import { writeFile } from "node:fs/promises";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import {
	createEffectsAdminFixture,
	loginEffectsAdmin,
	type EffectsAdminFixture,
} from "./helpers/effects-admin";
import { readEightiesEffect } from "./helpers/effects-content";

const widths = [360, 390, 768, 1280, 1440] as const;
const effectPath = "/blog/1980s-ai-photo";
const previewPath = "/effects-preview/1980s-ai-photo";
const promptGuidePath = "/blog/ai-image-editing-prompts";
const privacyGuidePath = "/blog/private-image-editing-workflow";
const authoredEffect = readEightiesEffect();
const isPublished = authoredEffect.status === "published";
const studioPrompt = authoredEffect.presets.find(
	(preset) => preset.id === "studio-portrait",
)!.prompt;
const sourceImage = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

type MediaUiState = {
	uploads: number;
	catalogRequests: number;
	catalogFulfilledRequests: number;
	lastFulfilledCatalogRequest: number;
	mutations: string[];
};
const mediaFixtures = new WeakMap<Page, MediaUiState>();
const previewDiagnostics = new WeakMap<Page, () => Promise<void>>();

test.use({
	storageState: { cookies: [], origins: [] },
	contextOptions: { reducedMotion: "reduce" },
});

test.describe("Photo Ideas publication and legacy boundaries", () => {
	test("legacy Effects links permanently redirect and Blog owns discovery", async ({
		page,
		request,
		baseURL,
	}) => {
		const directoryRedirect = await request.get("/effects", { maxRedirects: 0 });
		expect(directoryRedirect.status()).toBe(308);
		expect(directoryRedirect.headers().location).toBe("/blog?category=photo-ideas");
		const oldDetail = await request.get("/effects/1980s-ai-photo?preset=family-snapshot&lang=de", {
			maxRedirects: 0,
		});
		expect(oldDetail.status()).toBe(isPublished ? 308 : 404);
		if (isPublished) {
			const target = new URL(oldDetail.headers().location!, baseURL);
			expect(target.pathname).toBe(effectPath);
			expect(target.searchParams.get("preset")).toBe("family-snapshot");
			expect(target.searchParams.get("lang")).toBe("de");
		}
		await page.goto("/blog?category=photo-ideas");
		await expect(page.locator(".blog-directory .blog-card")).toHaveCount(isPublished ? 1 : 0);
		await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
			"href",
			new URL("/blog", baseURL).href,
		);
		const xml = await (await request.get("/sitemap.xml")).text();
		expect(xml).not.toContain("/effects/");
		if (isPublished) expect(xml).toContain(effectPath);
	});

	test("unpublished, unknown, reserved category, and unauthorized preview return real 404s", async ({
		request,
	}) => {
		for (const path of [
			...(!isPublished ? [effectPath, `${effectPath}?preset=family-snapshot`] : []),
			previewPath,
			"/effects/unknown-effect-for-browser-verification",
			"/effects/category/retro-vintage",
			"/blog?page=2",
			"/blog/category/prompt-writing",
		]) {
			const response = await request.get(path, { maxRedirects: 0 });
			expect(response.status(), path).toBe(404);
			expect(await response.text(), path).not.toContain(studioPrompt);
		}
	});

	test("the homepage groups content under Resources and preserves its editor", async ({ page }) => {
		const noGeneration = await mockMediaUi(page);
		await page.goto("/");
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(
			/AI Image Editor No Restrictions/i,
		);
		await expect(page.locator('a[href="/effects"]')).toHaveCount(0);
		await page.locator('[data-test="studio-resources-menu"]').click();
		const menu = page.locator(".studio-navigation-popover");
		for (const href of ["/blog", "/examples", "/docs"])
			await expect(menu.locator(`a[href="${href}"]`)).toBeVisible();
		await page.keyboard.press("Escape");
		const footer = page.getByRole("contentinfo");
		await expect(footer.locator(`a[href="${effectPath}"]`)).toBeVisible();
		await expect(page.locator("[data-photo-ideas-recommendations] .blog-card")).toHaveCount(
			isPublished ? 1 : 0,
		);
		expect(noGeneration.mutations).toEqual([]);
	});
});

test.describe("Guides browsing and article interactions", () => {
	test("Blog keeps both old guides and filters its new Photo Idea", async ({ page }) => {
		await page.goto("/blog");
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(
			"AI Photo Ideas, Prompts & Editing Guides",
		);
		const directory = page.locator(".blog-directory");
		await expect(directory.locator(`h2 a[href="${promptGuidePath}"]`)).toBeVisible();
		await expect(directory.locator(`h2 a[href="${privacyGuidePath}"]`)).toBeVisible();
		await expect(directory.getByRole("searchbox")).toHaveCount(1);
		await expect(directory.getByRole("button", { name: "Photo Ideas", exact: true })).toBeVisible();
		await expect(directory.locator("article")).toHaveCount(isPublished ? 3 : 2);
		await expect(page).toHaveURL(/\/blog$/);
	});

	for (const article of [
		{
			path: promptGuidePath,
			title: "How to Write AI Image Editing Prompts",
			date: "2026-09-12",
			text: "a request to preserve identity is not a guarantee",
		},
		{
			path: privacyGuidePath,
			title: "Private AI Image Editing: Uploads, Access, and Retention",
			date: "2026-09-05",
			text: "not automatically added to a public gallery",
		},
	]) {
		test(`preserves ${article.path}, article content, and real publication metadata`, async ({
			page,
			baseURL,
		}) => {
			const response = await page.goto(article.path);
			expect(response?.status()).toBe(200);
			await expect(page.getByRole("heading", { level: 1 })).toHaveText(article.title);
			await expect(page.locator("article.blog-prose")).toContainText(article.text);
			await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
				"href",
				new URL(article.path, baseURL).href,
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
						"@type": "BlogPosting",
						headline: article.title,
						datePublished: article.date,
						author: expect.objectContaining({
							"@type": "Organization",
							name: "EzImageAI Editorial Team",
						}),
					}),
				]),
			);
			const html = await response!.text();
			expect(html).toContain(article.text);
			const themeLinks = page.locator(`article.blog-prose a[href^="${effectPath}?"]`);
			if (isPublished && article.path === promptGuidePath)
				await expect(themeLinks.first()).toBeVisible();
			else await expect(themeLinks).toHaveCount(0);
		});
	}

	test("article TOC has unique real anchors, keyboard navigation, and copy feedback", async ({
		page,
		context,
	}) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto(promptGuidePath);
		const headings = await page
			.locator("article.blog-prose h2[id], article.blog-prose h3[id]")
			.evaluateAll((elements) => elements.map((element) => element.id));
		expect(new Set(headings).size).toBe(headings.length);
		const toc = page.locator("nav.blog-toc");
		for (const href of await toc
			.locator("a")
			.evaluateAll((links) => links.map((link) => link.getAttribute("href")))) {
			expect(href).toMatch(/^#[a-z0-9-]+$/);
			await expect(page.locator(href!)).toHaveCount(1);
		}
		const portraitLink = toc.getByRole("link", { name: "Portrait: adjust the light", exact: true });
		await portraitLink.focus();
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/#portrait-adjust-the-light$/);
		await expect(
			page.getByRole("heading", { name: "Portrait: adjust the light", exact: true }),
		).toBeInViewport();
		const prompt = page.locator("article.blog-prose pre").first();
		const expectedPrompt = await prompt.innerText();
		const copyFeedbackId = await page
			.getByRole("button", { name: "Copy prompt", exact: true })
			.first()
			.getAttribute("aria-describedby");
		expect(copyFeedbackId).toBeTruthy();
		const copy = page.locator(`button[aria-describedby="${copyFeedbackId}"]`);
		await copy.focus();
		await page.keyboard.press("Enter");
		await expect(copy).toHaveText("Copied");
		await expect(page.locator(`output[id="${copyFeedbackId}"]`)).toHaveText("Copied");
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expectedPrompt);
	});

	test("clipboard failure offers selectable prompt text", async ({ page }) => {
		await page.addInitScript(() => {
			Object.defineProperty(navigator, "clipboard", {
				configurable: true,
				value: {
					writeText: async () => {
						throw new Error("Clipboard disabled for this test");
					},
				},
			});
		});
		await page.goto(promptGuidePath);
		await page.getByRole("button", { name: "Copy prompt", exact: true }).first().click();
		await expect(
			page.getByText("Copy was unavailable. Select the prompt below and copy it manually.", {
				exact: true,
			}),
		).toBeVisible();
		await page.getByRole("button", { name: "Select prompt", exact: true }).click();
		expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
			await page.locator("article.blog-prose pre").first().innerText(),
		);
	});

	test("Photo Ideas, Blog, and the prompt article fit all five acceptance widths", async ({
		page,
	}, testInfo) => {
		test.setTimeout(180_000);
		for (const width of widths) {
			await page.setViewportSize({ width, height: 900 });
			for (const [name, path] of [
				["photo-ideas", "/blog?category=photo-ideas"],
				["guides-directory", "/blog"],
				["prompt-guide", promptGuidePath],
			] as const) {
				await page.goto(path);
				await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
				await assertNoHorizontalOverflow(page, `${name} at ${width}px`);
				if (name === "prompt-guide" && width < 1200) {
					const mobileToc = page.locator("details.blog-toc-mobile");
					await expect(mobileToc).toBeVisible();
					await mobileToc.locator("summary").click();
					await expect(
						mobileToc.getByRole("link", { name: "Portrait: adjust the light", exact: true }),
					).toBeVisible();
					await assertNoHorizontalOverflow(page, `expanded TOC at ${width}px`);
				}
				await page.screenshot({
					path: testInfo.outputPath(`${name}-${width}.png`),
					fullPage: true,
				});
			}
		}
	});
});

test.describe("protected editorial preview with a temporary local administrator", () => {
	test.skip(
		process.env.E2E_EFFECTS_ADMIN_PREVIEW !== "true",
		"Set E2E_EFFECTS_ADMIN_PREVIEW=true and an explicit matching local E2E_EFFECTS_DATABASE_URL.",
	);
	test.setTimeout(120_000);
	let admin: EffectsAdminFixture | undefined;

	test.beforeAll(async ({ baseURL }) => {
		admin = await createEffectsAdminFixture(baseURL!);
	});
	test.afterAll(async () => {
		await admin?.cleanup();
	});
	test.beforeEach(async ({ page }, testInfo) => {
		previewDiagnostics.set(page, collectPreviewDiagnostics(page, testInfo));
	});
	test.afterEach(async ({ page }) => {
		await previewDiagnostics.get(page)?.();
		previewDiagnostics.delete(page);
	});

	test("three presets, custom prompt/settings confirmation, source retention, and no automatic generation", async ({
		page,
		context,
	}, testInfo) => {
		const media = await mockMediaUi(page);
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await loginEffectsAdmin(page, admin!);
		await makeHydratedCatalogStale(page);
		await gotoReadyPreview(page, `${previewPath}?preset=studio-portrait`, media);
		const preset = page.getByLabel("Choose a preset", { exact: true });
		const prompt = page.locator("#generation-prompt");
		await expect(preset.locator("option")).toHaveCount(3);
		await expect(prompt).toHaveValue(studioPrompt);
		await expect(page.getByText(/Private editorial preview/)).toBeVisible();
		await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
		await expect(page.locator('[data-test="generation-submit"]')).toBeDisabled();
		await page
			.locator('#registered-generator input[type="file"]')
			.setInputFiles({ name: "local-reference.png", mimeType: "image/png", buffer: sourceImage });
		const source = page.getByRole("img", { name: "Selected source image", exact: true });
		await expect(source).toBeVisible();
		const originalPreview = await source.getAttribute("src");
		await expect(page.locator('[data-test="generation-submit"]')).toBeEnabled();
		await prompt.fill("Keep my customized portrait lighting and natural expression.");
		await preset.selectOption("family-snapshot");
		const confirmation = page.getByRole("alertdialog");
		await expect(confirmation).toBeVisible();
		await confirmation.getByRole("button", { name: "Keep my changes", exact: true }).click();
		await expect(prompt).toHaveValue(
			"Keep my customized portrait lighting and natural expression.",
		);
		await expect(preset).toHaveValue("studio-portrait");
		await preset.selectOption("family-snapshot");
		await confirmation.getByRole("button", { name: "Use preset", exact: true }).click();
		await expect(prompt).toHaveValue(
			authoredEffect.presets.find((item) => item.id === "family-snapshot")!.prompt,
		);
		await expect(source).toHaveAttribute("src", originalPreview!);
		const settingsTrigger = page.locator('[data-test="editor-output-settings-trigger"]');
		await settingsTrigger.click();
		const settings = page.locator('[data-test="editor-output-settings-panel"]');
		await expect(settings).toBeVisible();
		await expect(settings.getByRole("radio", { name: "4:3", exact: true })).toBeChecked();
		await settings.getByText("1:1", { exact: true }).click();
		await expect(settings.getByRole("radio", { name: "1:1", exact: true })).toBeChecked();
		await page.keyboard.press("Escape");
		await expect(settings).toBeHidden();
		await preset.selectOption("street-portrait");
		await expect(confirmation).toBeVisible();
		await confirmation.getByRole("button", { name: "Use preset", exact: true }).click();
		await expect(prompt).toHaveValue(
			authoredEffect.presets.find((item) => item.id === "street-portrait")!.prompt,
		);
		await expect(source).toHaveAttribute("src", originalPreview!);
		await settingsTrigger.click();
		await expect(settings).toBeVisible();
		await expect(settings.getByRole("radio", { name: "4:5", exact: true })).toBeChecked();
		await page.keyboard.press("Escape");
		await expect(settings).toBeHidden();
		await page
			.locator(".effect-workbench-controls")
			.getByRole("button", { name: "Copy prompt", exact: true })
			.click();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
			await prompt.inputValue(),
		);
		await page.screenshot({
			path: testInfo.outputPath("effect-preview-source-preserved.png"),
			fullPage: true,
		});
		expect(media.uploads).toBe(1);
		expect(media.mutations).toEqual([]);
	});

	test("invalid preset uses the safe default and unavailable catalog keeps prompts usable", async ({
		page,
	}) => {
		const media = await mockMediaUi(page, { available: false });
		await loginEffectsAdmin(page, admin!);
		await makeHydratedCatalogStale(page);
		await gotoReadyPreview(
			page,
			`${previewPath}?preset=not-registered&model=untrusted-route`,
			media,
		);
		await expect(page.getByLabel("Choose a preset", { exact: true })).toHaveValue(
			"studio-portrait",
		);
		await expect(page.locator("#generation-prompt")).toHaveValue(studioPrompt);
		await expect(
			page.getByText(/This preset’s model or output settings are currently unavailable/),
		).toBeVisible();
		await expect(page.locator('[data-test="generation-submit"]')).toBeDisabled();
		await expect(
			page.getByRole("button", { name: "Copy prompt", exact: true }).first(),
		).toBeEnabled();
		expect(media.mutations).toEqual([]);
	});

	test("the actual protected preview fits all acceptance widths", async ({ page }, testInfo) => {
		test.setTimeout(180_000);
		const media = await mockMediaUi(page);
		await loginEffectsAdmin(page, admin!);
		await makeHydratedCatalogStale(page);
		await gotoReadyPreview(page, previewPath, media);
		await expect(page.locator("#generation-prompt")).toBeVisible();
		for (const width of widths) {
			await page.setViewportSize({ width, height: 900 });
			await page.getByRole("heading", { level: 1 }).scrollIntoViewIfNeeded();
			await assertNoHorizontalOverflow(page, `editorial preview at ${width}px`);
			await page.screenshot({
				path: testInfo.outputPath(`effect-preview-${width}.png`),
				fullPage: true,
			});
			if (width === 360 || width === 1440) {
				await page.evaluate(() => window.scrollTo(0, 0));
				await page.screenshot({
					path: testInfo.outputPath(`effect-preview-${width}-viewport.png`),
					fullPage: false,
				});
			}
		}
		expect(media.mutations).toEqual([]);
	});
});

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
	const widths = await page.evaluate(() => ({
		viewport: innerWidth,
		document: document.documentElement.scrollWidth,
		body: document.body.scrollWidth,
	}));
	expect(widths.document, `${label}: document width`).toBeLessThanOrEqual(widths.viewport);
	expect(widths.body, `${label}: body width`).toBeLessThanOrEqual(widths.viewport);
}

/** Expire the server-hydrated five-minute catalog so the browser requests the explicit fixture. */
async function makeHydratedCatalogStale(page: Page) {
	await page.addInitScript(() => {
		// Leave timers, animation frames, performance.now, and the Date constructor native.
		// Only the query cache's Date.now freshness calculation needs to advance.
		const realDateNow = Date.now.bind(Date);
		Date.now = () => realDateNow() + 360_001;
	});
}

async function gotoReadyPreview(page: Page, path: string, media: MediaUiState) {
	// A fulfilled request that began during login cannot satisfy this page's readiness.
	const previousRequests = media.catalogRequests;
	await page.goto(path);
	await expect
		.poll(() => media.lastFulfilledCatalogRequest, {
			message: "This preview's catalog has returned",
		})
		.toBeGreaterThan(previousRequests);
	await expect(page.locator('#registered-generator[data-editor-ready="true"]')).toHaveCount(1);
	await expect(page.locator("#registered-generator")).toHaveCount(1);
	await expect(page.locator("#registered-generator")).toBeVisible();
	await expect(page.locator("#generation-prompt")).toHaveCount(1);
	await expect(page.locator("#generation-prompt")).toBeVisible();
	await expect(page.locator('[data-test="generation-submit"]')).toHaveCount(1);
}

/** Bounded local-preview diagnostics; never attach credentials, receipt tokens, or image bytes. */
function collectPreviewDiagnostics(page: Page, testInfo: TestInfo): () => Promise<void> {
	const browserErrors: { kind: string; message: string }[] = [];
	const failedRequests: { path: string; method: string; error: string | undefined }[] = [];
	const uploadResponses: Record<string, unknown>[] = [];
	const responseReads: Promise<void>[] = [];
	page.on("pageerror", (error) => {
		if (browserErrors.length < 20)
			browserErrors.push({ kind: "pageerror", message: error.message.slice(0, 3_000) });
	});
	page.on("console", (message) => {
		if (message.type() === "error" && browserErrors.length < 20)
			browserErrors.push({ kind: "console", message: message.text().slice(0, 3_000) });
	});
	page.on("requestfailed", (request) => {
		if (failedRequests.length < 20)
			failedRequests.push({
				path: new URL(request.url()).pathname,
				method: request.method(),
				error: request.failure()?.errorText,
			});
	});
	page.on("response", (response) => {
		if (
			new URL(response.url()).pathname !== "/api/media/temporary-references" ||
			responseReads.length >= 8
		)
			return;
		const read = async () => {
			const request = response.request();
			const record: Record<string, unknown> = {
				status: response.status(),
				method: request.method(),
				contentType: response.headers()["content-type"],
				requestContentType: request.headers()["content-type"],
				declaredUploadSize: request.headers()["x-upload-size"],
				requestBodyBytes: request.postDataBuffer()?.byteLength,
			};
			try {
				const body: unknown = await response.json();
				if (body && typeof body === "object" && !Array.isArray(body)) {
					const receipt = body as Record<string, unknown>;
					record.keys = Object.keys(receipt);
					record.assetIdType = typeof receipt.assetId;
					record.assetIdIsUuid =
						typeof receipt.assetId === "string" &&
						/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(receipt.assetId);
					record.tokenLength = typeof receipt.token === "string" ? receipt.token.length : null;
					record.expiresAtType = typeof receipt.expiresAt;
					record.expiresInRealTimeMs =
						typeof receipt.expiresAt === "string"
							? Date.parse(receipt.expiresAt) - Date.now()
							: null;
				} else record.bodyType = Array.isArray(body) ? "array" : typeof body;
			} catch (error) {
				record.readError = error instanceof Error ? error.message.slice(0, 500) : "unreadable";
			}
			uploadResponses.push(record);
		};
		responseReads.push(read());
	});
	return async () => {
		await Promise.allSettled(responseReads);
		const dom = await page
			.evaluate(() => {
				function describe(element: Element) {
					const rect = element.getBoundingClientRect();
					const style = getComputedStyle(element);
					return {
						tag: element.tagName,
						id: element.id,
						className: element.getAttribute("class")?.slice(0, 250),
						dataTest: element.getAttribute("data-test"),
						editorReady: element.getAttribute("data-editor-ready"),
						hidden: element.hasAttribute("hidden"),
						ariaHidden: element.getAttribute("aria-hidden"),
						display: style.display,
						visibility: style.visibility,
						bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
					};
				}
				const selectors = [
					"#generation-prompt",
					"#registered-generator",
					"[data-test='generation-submit']",
					"#effect-preset",
					"#registered-generator input[type='file']",
					"img[alt='Selected source image']",
				];
				return {
					path: location.pathname,
					readyState: document.readyState,
					dateNowOffsetMs: Date.now() - new Date().getTime(),
					viewport: { width: innerWidth, height: innerHeight },
					selections: Object.fromEntries(
						selectors.map((selector) => [
							selector,
							Array.from(document.querySelectorAll(selector)).map((element) => {
								const ancestors = [];
								let parent = element.parentElement;
								while (parent && ancestors.length < 8) {
									ancestors.push(describe(parent));
									parent = parent.parentElement;
								}
								return {
									...describe(element),
									ancestors,
									...(element instanceof HTMLInputElement && element.type === "file"
										? {
												files: Array.from(element.files ?? []).map((file) => ({
													size: file.size,
													type: file.type,
												})),
											}
										: {}),
									...(element instanceof HTMLImageElement
										? {
												complete: element.complete,
												naturalWidth: element.naturalWidth,
												sourceScheme: element.src.split(":")[0],
											}
										: {}),
								};
							}),
						]),
					),
				};
			})
			.catch((error: unknown) => ({
				unavailable: error instanceof Error ? error.message.slice(0, 1_000) : "Page unavailable",
			}));
		const diagnosticsPath = testInfo.outputPath("effects-preview-diagnostics.json");
		await writeFile(
			diagnosticsPath,
			JSON.stringify(
				{
					dom,
					browserErrors,
					failedRequests,
					uploadResponses,
					mediaFixture: mediaFixtures.get(page),
				},
				null,
				2,
			),
		);
		await testInfo.attach("effects-preview-diagnostics", {
			contentType: "application/json",
			path: diagnosticsPath,
		});
	};
}

/** These UI fixtures provide no provider integration, payment, or real generated-image evidence. */
async function mockMediaUi(page: Page, { available = true }: { available?: boolean } = {}) {
	const state: MediaUiState = {
		uploads: 0,
		catalogRequests: 0,
		catalogFulfilledRequests: 0,
		lastFulfilledCatalogRequest: 0,
		mutations: [],
	};
	mediaFixtures.set(page, state);
	const product = {
		key: "image-nano-banana-2-lite",
		label: "Nano Banana 2 Lite",
		description: "Local browser fixture",
		credits: "5",
		accessHint: "guest-trial",
		inputKinds: ["text-to-image", "image-to-image"],
		aspectRatios: ["auto", "1:1", "4:3", "4:5"],
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
					aspectRatios: ["auto", "1:1", "4:3", "4:5"],
					controls: [],
				},
			],
		},
	};
	await page.route("**/api/media/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/api/media/guest-capability")
			return route.fulfill({
				json: {
					version: "effects-browser-fixture",
					enabled: available,
					reason: available ? null : "UNAVAILABLE",
					upload: {
						mimeTypes: ["image/png", "image/jpeg", "image/webp"],
						maximumBytes: 10 * 1024 * 1024,
					},
					products: available ? [product] : [],
					queueEstimate: { kind: "capacity" },
				},
			});
		if (path === "/api/media/temporary-references" && route.request().method() === "POST") {
			state.uploads += 1;
			return route.fulfill({
				json: {
					assetId: "ea0d5e6d-c690-4d53-980d-070abf4e194a",
					token: "local-effects-browser-fixture",
					expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
				},
			});
		}
		state.mutations.push(path);
		return route.abort("blockedbyclient");
	});
	await page.route("**/api/rpc/media/**", async (route) => {
		const name = new URL(route.request().url()).pathname.split("/").at(-1);
		if (name === "getPublicCatalog") {
			const requestNumber = ++state.catalogRequests;
			await route.fulfill({
				json: {
					json: {
						catalogVersion: "effects-browser-fixture",
						pricingVersion: "effects-browser-fixture",
						products: available ? [product] : [],
					},
				},
			});
			state.catalogFulfilledRequests += 1;
			state.lastFulfilledCatalogRequest = Math.max(
				state.lastFulfilledCatalogRequest,
				requestNumber,
			);
			return;
		}
		if (name === "getCreditAccount")
			return route.fulfill({
				json: { json: { spendableCredits: "100", maximumInputBytes: 10 * 1024 * 1024 } },
			});
		if (name === "listJobs")
			return route.fulfill({ json: { json: { items: [], nextCursor: null } } });
		state.mutations.push(name ?? "unknown-media-rpc");
		return route.abort("blockedbyclient");
	});
	return state;
}
