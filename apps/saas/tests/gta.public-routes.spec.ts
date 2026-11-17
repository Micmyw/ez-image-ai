import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { GTA_PAGES } from "../modules/gta/lib/config";
import { buildGtaResultPreview } from "./fixtures/gta-result-preview.mjs";

async function mockGtaCatalog(page: Page) {
	const aspectRatios = ["auto", "1:1", "9:16", "16:9"];
	const product = {
		key: "image-minimax-h3",
		label: "MiniMax H3 Image",
		description: "Private image editing",
		credits: "5",
		accessHint: "guest-trial",
		aspectRatios,
		skuMatrix: {
			defaultSkuKey: "minimax-h3-1k",
			dimensions: [
				{ key: "resolution", label: "Resolution", options: [{ key: "1k", label: "1K" }] },
			],
			cells: [
				{
					skuKey: "minimax-h3-1k",
					label: "1K",
					parameterValues: { resolution: "1k" },
					credits: 5,
					aspectRatios,
					controls: [],
				},
			],
		},
	};
	const products = [
		product,
		...(["sunburst", "flare"] as const).map((model) => ({
			...product,
			key: `image-gpt-image-2-6-${model}`,
			label: `GPT Image 2.6 ${model}`,
			accessHint: "paid-account",
			credits: model === "sunburst" ? "25" : "20",
			skuMatrix: {
				...product.skuMatrix,
				defaultSkuKey: `gpt-image-2-6-${model}-1k`,
				cells: [
					{
						...product.skuMatrix.cells[0],
						skuKey: `gpt-image-2-6-${model}-1k`,
						credits: model === "sunburst" ? 25 : 20,
					},
				],
			},
		})),
	];
	await page.route("**/api/media/guest-capability", (route) =>
		route.fulfill({
			json: {
				version: "gta-ui-e2e",
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
					catalogVersion: "gta-ui-e2e",
					pricingVersion: "gta-ui-e2e",
					products: products.map((product) => ({
						...product,
						inputKinds: ["text-to-image", "image-to-image"],
					})),
				},
			},
		}),
	);
}

function observeGenerationSubmissions(page: Page) {
	const submissions: string[] = [];
	page.on("request", (request) => {
		if (
			request.method() === "POST" &&
			/\/(submitGeneration|submitGuestGeneration)(?:\?|$)/.test(request.url())
		)
			submissions.push(request.url());
	});
	return submissions;
}

test("GTA defaults to Sunburst, keeps model changes editable, and opens paid access without a free run", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await mockGtaCatalog(page);
	const submissions = observeGenerationSubmissions(page);
	await page.goto("/gta-6-wallpaper");
	const editor = page.locator(".gta-editor");
	const model = editor.locator('[data-test="landing-model-trigger"]');
	await expect(model).toContainText("Sunburst");
	await expect(model).toBeEnabled();
	const chooser = page.waitForEvent("filechooser");
	await editor.locator('[data-test="landing-generate"]').click();
	expect((await chooser).isMultiple()).toBe(false);
	await editor.getByRole("button", { name: "Create a scene", exact: true }).click();
	await editor.getByText("Additional instructions", { exact: false }).click();
	await editor.locator("#gta-extra-instructions").fill("Add a coral sky and no lettering");
	await model.click();
	await page.getByRole("button", { name: "MiniMax", exact: true }).click();
	await page.locator('[data-test="landing-model-minimax-h3-1k"]').click();
	await expect(model).toContainText("MiniMax");
	await expect(editor.locator("#gta-extra-instructions")).toHaveValue(
		"Add a coral sky and no lettering",
	);
	await expect(editor.locator('[data-test="landing-generate"]')).not.toContainText("free");
	await editor.locator('[data-test="landing-generate"]').click();
	await expect(page.locator('[data-test="paid-template-dialog"]')).toBeVisible();
	await expect(page.locator('[data-test="paid-template-dialog"]')).toContainText("$2.99");
	expect(submissions).toEqual([]);
});

async function mountGtaPreviewFixture(page: Page, intent = "loading-art") {
	const bundle = await buildGtaResultPreview(path.resolve(__dirname, ".."), intent);
	if (intent === "wallpaper") {
		await mockGtaCatalog(page);
		await page.goto("/gta-6-wallpaper");
		await expect(page.locator(".gta-editor [data-reference-upload]")).toBeVisible();
		// Retain the real app's CSS for Base UI's modal and pointer-event layers.
		await page.locator(".gta-page").evaluate((node) => {
			for (const child of Array.from(node.children)) (child as HTMLElement).style.display = "none";
			const fixture = document.createElement("div");
			fixture.id = "gta-fixture";
			node.append(fixture);
		});
		await page.addScriptTag({ content: bundle });
		return;
	}
	await page.route("**/gta-preview-fixture", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: '<div id="gta-fixture"></div><script src="/gta-preview-fixture.js"></script>',
		}),
	);
	await page.route("**/gta-preview-fixture.js", (route) =>
		route.fulfill({ contentType: "application/javascript", body: bundle }),
	);
	await page.goto("/gta-preview-fixture");
}

test("GTA names survive anonymous bootstrap and result changes but clear for another account", async ({
	page,
}) => {
	await mountGtaPreviewFixture(page);
	const name = page.getByRole("textbox");
	await expect(page.getByRole("button", { name: "Download style preview" })).toBeEnabled();
	await name.fill("Alex Rivera");
	const set = async (next: Record<string, unknown>) =>
		page.evaluate(
			(next) =>
				(
					window as unknown as { gtaFixture: { set: (value: Record<string, unknown>) => void } }
				).gtaFixture.set(next),
			next,
		);
	await set({ owner: "anonymous-1", anonymous: true });
	await expect(name).toHaveValue("Alex Rivera");
	await set({ asset: "result-1" });
	await expect(page.getByRole("button", { name: "Download my art" })).toBeEnabled();
	await expect(name).toHaveValue("Alex Rivera");
	await set({ asset: "result-2" });
	await expect(name).toHaveValue("Alex Rivera");
	await page.getByRole("button", { name: "Style preview", exact: true }).click();
	await expect(name).toHaveValue("Alex Rivera");
	await set({ owner: "registered-2", anonymous: false, asset: null });
	await expect(name).toHaveValue("");
});

test("GTA wallpaper preserves an applied result crop while showing a composition guide", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await mountGtaPreviewFixture(page, "wallpaper");
	await page.evaluate(() => (window as any).gtaFixture.set({ asset: "result-1" }));
	await expect(page.getByText("Your wallpaper", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Preview & crop" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByRole("button", { name: "Apply to preview" })).toBeEnabled();
	await dialog.getByLabel("Screen shape").selectOption("desktop");
	await dialog.getByLabel("Zoom", { exact: true }).fill("1.5");
	await dialog.getByRole("button", { name: "Apply to preview" }).click();
	await page.getByRole("button", { name: "Style example", exact: true }).click();
	await expect(page.getByText("Composition guide")).toBeVisible();
	await expect(page.locator("#gta-fixture img")).toHaveCount(0);
	await page.getByRole("button", { name: "Your result", exact: true }).click();
	await page.getByRole("button", { name: "Preview & crop" }).click();
	await expect(dialog.getByLabel("Screen shape")).toHaveValue("desktop");
	await expect(dialog.getByLabel("Zoom", { exact: true })).toHaveValue("1.5");
});

for (const [intent, content] of Object.entries(GTA_PAGES)) {
	test(`GTA ${intent} has a distinct canonical and usable mobile content`, async ({
		page,
		request,
	}, testInfo) => {
		test.setTimeout(120_000);
		await mockGtaCatalog(page);
		const response = await page.goto(content.path);
		expect(response?.status()).toBe(200);
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(content.h1);
		await expect
			.poll(() =>
				page
					.locator(".gta-hero-art img")
					.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
			)
			.toBe(true);
		await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /index, follow/);
		await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
			"href",
			new URL(content.path, page.url()).href,
		);
		await expect(page.locator(".gta-scene-grid article")).toHaveCount(6);
		for (const comparison of await page.locator(".gta-comparison-result img").all())
			await expect(comparison).toHaveCSS("object-fit", "contain");
		const source = await request.get(content.path);
		const html = await source.text();
		expect(html).toContain(content.h1);
		expect(html).toContain("gta-faq-title");
		expect(html).toContain("gta-comparisons-title");
		expect(html).toContain("/images/gta/");
		const other = GTA_PAGES[intent === "wallpaper" ? "loading-art" : "wallpaper"];
		await expect(page.locator(`.gta-related a[href="${other.path}"]`)).toBeVisible();
		for (const width of [1440, 390, 320]) {
			await page.setViewportSize({ width, height: 900 });
			const upload = page.locator(".gta-editor [data-reference-upload]");
			await expect(upload).toBeVisible();
			const uploadBounds = (await upload.boundingBox())!;
			const inputBounds = (await page
				.locator('[data-test="landing-composer-inputs"]')
				.boundingBox())!;
			expect(uploadBounds.width).toBeGreaterThan(inputBounds.width * 0.9);
			await expect(page.locator('[data-test="landing-generate"]')).toHaveCSS(
				"background-color",
				"rgb(239, 123, 102)",
			);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
				true,
			);
			await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
			for (const comparison of await page.locator(".gta-comparison-result img").all()) {
				await comparison.scrollIntoViewIfNeeded();
				await expect
					.poll(() =>
						comparison.evaluate(
							(image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
						),
					)
					.toBe(true);
			}
			await page.locator(".gta-hero-art").scrollIntoViewIfNeeded();
			await page.locator(".gta-hero-art img").evaluate((image: HTMLImageElement) => image.decode());
			await page.screenshot({
				path: testInfo.outputPath(`gta-${intent}-${width}.png`),
				fullPage: true,
			});
			await page.locator(".gta-workbench").screenshot({
				path: testInfo.outputPath(`gta-${intent}-workbench-${width}.png`),
			});
		}
		await page.goto(`${content.path}?lang=fr`);
		await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex, follow/);
		await page.goto(`${content.path}?resume=workspace`);
		await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
			"content",
			/noindex, nofollow/,
		);
	});
}

test("GTA wallpaper choices keep the reference available and never submit a generation", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await mockGtaCatalog(page);
	const submissions = observeGenerationSubmissions(page);
	await page.goto("/gta-6-wallpaper");
	const editor = page.locator(".gta-editor");
	const summary = page.locator(".gta-draft-summary");
	await expect(summary).toContainText("Beach Sunset · 9:16");
	await expect(page.locator("#landing-edit-prompt")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Try an instruction" })).toHaveCount(0);
	await page
		.locator("#landing-source-image")
		.setInputFiles(path.resolve(__dirname, "../public/images/christmas/pet.webp"));
	await expect(page.locator('[data-test="landing-source-panel"] img')).toBeVisible();
	await editor.getByRole("button", { name: "Create a scene", exact: true }).click();
	await expect(page.locator(".gta-workbench")).toHaveAttribute("data-input-mode", "scene");
	await editor.getByRole("button", { name: "Use my photo", exact: true }).click();
	await expect(page.locator('[data-test="landing-source-panel"] img')).toBeVisible();
	await editor.getByRole("button", { name: "Desktop · 16:9", exact: true }).click();
	await expect(summary).toContainText("16:9");
	await page.locator(".gta-scene-grid article").nth(1).getByRole("button").click();
	await expect(summary).toContainText("Neon Boulevard");
	await page.reload();
	await expect(summary).toContainText("Neon Boulevard");
	expect(submissions).toEqual([]);
	await page.goto("/gta-6-wallpaper#scene=marina&format=phone&mode=scene");
	await expect(summary).toContainText("Marina Blue Hour · 9:16");
	await expect(page.locator(".gta-workbench")).toHaveAttribute("data-input-mode", "scene");
	expect(submissions).toEqual([]);
});

test("GTA wallpaper crop exports actual pixels and keeps screen overlays out of the file", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await mockGtaCatalog(page);
	const submissions = observeGenerationSubmissions(page);
	await page.goto("/gta-6-wallpaper");
	await page.getByRole("button", { name: "Try preview & crop", exact: true }).click();
	const dialog = page.getByRole("dialog");
	const downloadButton = dialog.getByRole("button", { name: "Download wallpaper", exact: true });
	await expect(downloadButton).toBeEnabled();
	await dialog.getByLabel("Screen shape").selectOption("phone");
	const firstDownload = page.waitForEvent("download");
	await downloadButton.click();
	const first = await readFile((await (await firstDownload).path())!);
	await expect(dialog.locator("output")).toHaveText(
		`${first.readUInt32BE(16)} × ${first.readUInt32BE(20)} px · PNG`,
	);
	await dialog.getByRole("checkbox", { name: "Show screen controls" }).uncheck();
	const secondDownload = page.waitForEvent("download");
	await downloadButton.click();
	const second = await readFile((await (await secondDownload).path())!);
	expect(second.equals(first)).toBe(true);
	expect(submissions).toEqual([]);
});

test("GTA scene sharing keeps private return and job parameters out of its clipboard fallback", async ({
	page,
}) => {
	await mockGtaCatalog(page);
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: () => Promise.reject(new Error("Clipboard unavailable")) },
		});
	});
	await page.goto("/gta-6-wallpaper?resume=workspace&job=private-job");
	await page.getByRole("button", { name: "Copy scene link", exact: true }).click();
	const link = page.getByRole("textbox", { name: "Scene link", exact: true });
	await expect(link).toHaveValue(/\/gta-6-wallpaper#scene=beach-sunset/);
	expect(await link.inputValue()).not.toMatch(/job|resume|private/);
});

test("GTA loading-screen names are plain text and local exports keep the same base dimensions", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await mockGtaCatalog(page);
	const submissions = observeGenerationSubmissions(page);
	await page.goto("/gta-loading-screen-generator");
	const preview = page.getByRole("complementary", { name: "Loading-screen art preview" });
	const download = preview.getByRole("button", { name: "Download style preview", exact: true });
	await expect(download).toBeEnabled();
	const cleanDownload = page.waitForEvent("download");
	await download.click();
	const clean = await readFile((await (await cleanDownload).path())!);
	await preview.getByRole("textbox").fill("Alex <script>");
	await expect(preview.getByRole("button", { name: "With my name", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(preview.locator("script")).toHaveCount(0);
	const namedDownload = page.waitForEvent("download");
	await download.click();
	const named = await readFile((await (await namedDownload).path())!);
	expect(named.readUInt32BE(16)).toBe(clean.readUInt32BE(16));
	expect(named.readUInt32BE(20)).toBe(clean.readUInt32BE(20));
	expect(named.equals(clean)).toBe(false);
	await preview.getByRole("textbox").fill("梅👩🏽‍💻é".repeat(24));
	const graphemes = await preview.getByRole("textbox").inputValue();
	expect([
		...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(graphemes),
	]).toHaveLength(24);
	expect(submissions).toEqual([]);
});

test("GTA shared drafts retain new choices and optional instructions without exposing the template", async ({
	page,
}) => {
	await mockGtaCatalog(page);
	await page.goto(
		"/gta-loading-screen-generator#scene=neon-boulevard&format=desktop&position=right&mode=photo",
	);
	await expect(page.getByRole("button", { name: "Left", exact: true })).toBeEnabled();
	await page.locator(".gta-extra-details summary").click();
	await page.getByLabel("Details to include").fill("Warm light and a blue jacket");
	await page.getByRole("button", { name: "Use Marina Blue Hour scene" }).click();
	await expect(page.getByLabel("Details to include")).toHaveValue("Warm light and a blue jacket");
	await page.getByRole("button", { name: "Left", exact: true }).click();
	await expect(page).toHaveURL(/scene=marina&format=desktop&position=left&mode=photo/);
	await page.reload();
	await expect(page.getByRole("button", { name: "Use Marina Blue Hour scene" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.getByRole("button", { name: "Left", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.locator(".gta-art-stage canvas")).toHaveAttribute("aria-label", /on the left/);
});

test("GTA composition guides preserve layout and the name when a matching illustration is unavailable", async ({
	page,
}) => {
	await mockGtaCatalog(page);
	await page.goto("/gta-loading-screen-generator");
	const preview = page.getByRole("complementary", { name: "Loading-screen art preview" });
	await expect(preview.getByRole("button", { name: "Download style preview" })).toBeEnabled();
	await preview.getByRole("textbox").fill("Alex Rivera");
	await page.getByRole("button", { name: "Left", exact: true }).click();
	await expect(preview.getByRole("textbox")).toHaveValue("Alex Rivera");
	await expect(preview.locator(".gta-composition-guide")).toHaveAttribute("data-format", "desktop");
	await expect(preview.locator(".gta-composition-guide")).toHaveAttribute("data-portrait", "left");
	await expect(preview.locator(".gta-composition-frame")).toHaveCSS("aspect-ratio", "16 / 9");
	await expect(
		preview.getByRole("button", { name: "Generate to download your art" }),
	).toBeDisabled();
	await page.getByRole("button", { name: "Use Marina Blue Hour scene" }).click();
	await expect(preview.getByRole("textbox")).toHaveValue("Alex Rivera");
	await expect(preview.getByRole("button", { name: "Download style preview" })).toBeEnabled();
	await page.goto("/gta-6-wallpaper#scene=neon-boulevard&format=desktop&mode=scene");
	await expect(page.locator(".gta-composition-frame")).toHaveCSS("aspect-ratio", "16 / 9");
	await expect(page.locator(".christmas-device.phone")).toHaveCount(0);
});
