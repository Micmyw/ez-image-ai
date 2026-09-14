import { expect, test } from "@playwright/test";

import { INSPIRATION, MODEL_PAGES, modelPath } from "../modules/models/lib/model-pages";

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 90_000 });

for (const model of MODEL_PAGES) {
	test(`${model.name} has its own English page and selected generator`, async ({
		page,
		context,
	}) => {
		await context.addCookies([
			{ name: "NEXT_LOCALE", value: "de", url: process.env.NEXT_PUBLIC_SAAS_URL! },
		]);
		const response = await page.goto(modelPath(model.key));
		expect(response?.status()).toBe(200);
		await expect(page.locator("h1")).toHaveCount(1);
		await expect(page.locator("h1")).toContainText(`${model.name}AI Image Generator`);
		await expect(page.locator("html")).toHaveAttribute("lang", "en");
		await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
			"href",
			new URL(modelPath(model.key), process.env.NEXT_PUBLIC_SAAS_URL!).href,
		);
		await expect(page.locator('meta[name="description"]')).toHaveAttribute(
			"content",
			model.description,
		);
		await expect(page.locator('meta[name="robots"]')).not.toHaveAttribute("content", /noindex/);
		await expect(page.locator('[data-test="landing-model-trigger"]')).toContainText(model.name, {
			timeout: 30_000,
		});
		await page.getByRole("button", { name: "Use this prompt" }).click();
		await expect(page.locator("#landing-edit-prompt")).toHaveValue(
			INSPIRATION[model.artwork].prompt,
		);
		await expect(page.getByRole("button", { name: /sign in to generate/i }).first()).toBeEnabled();
	});
}

test("the directory links all models and an unknown model returns 404", async ({ page }) => {
	await page.goto("/models");
	await expect(page.locator("h1")).toHaveCount(1);
	for (const model of MODEL_PAGES)
		await expect(
			page.locator(`.model-directory-card[href="${modelPath(model.key)}"]`),
		).toBeVisible();
	const response = await page.goto("/models/not-a-real-model");
	expect(response?.status()).toBe(404);
});

for (const width of [1440, 390]) {
	test(`model artwork and generator fit at ${width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 1000 });
		await page.goto("/models/gpt-image-2");
		await expect(page.locator('[data-test="landing-model-trigger"]')).toContainText("GPT Image 2", {
			timeout: 30_000,
		});
		await page.locator(".model-artwork").scrollIntoViewIfNeeded();
		await expect
			.poll(() =>
				page
					.locator(".model-artwork img")
					.evaluate((image) => (image as HTMLImageElement).naturalWidth),
			)
			.toBeGreaterThan(0);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		await page.evaluate(() => window.scrollTo(0, 0));
		for (const artwork of await page.locator(".model-page img").all()) {
			await artwork.scrollIntoViewIfNeeded();
			await expect
				.poll(() => artwork.evaluate((image) => (image as HTMLImageElement).naturalWidth))
				.toBeGreaterThan(0);
		}
		await page.evaluate(() => window.scrollTo(0, 0));
		await page.screenshot({ path: testInfo.outputPath(`model-${width}.png`), fullPage: true });
		await page.goto("/models");
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		for (const artwork of await page.locator(".model-directory-card img").all()) {
			await artwork.scrollIntoViewIfNeeded();
			await expect
				.poll(() => artwork.evaluate((image) => (image as HTMLImageElement).naturalWidth))
				.toBeGreaterThan(0);
		}
		await page.evaluate(() => window.scrollTo(0, 0));
		await page.screenshot({ path: testInfo.outputPath(`models-${width}.png`), fullPage: true });
	});
}

test("text prompt and settings survive signing in without an upload", async ({ page }) => {
	const uploads: string[] = [];
	page.on("request", (request) => {
		if (/createUploadSession|guest-drafts/.test(request.url())) uploads.push(request.url());
	});
	await page.goto("/models/gpt-image-2");
	await expect(page.locator('[data-test="landing-model-trigger"]')).toContainText("GPT Image 2", {
		timeout: 30_000,
	});
	const prompt = "A cobalt ceramic vase beside a window, warm light, no lettering";
	await page.locator("#landing-edit-prompt").fill(prompt);
	await page
		.getByRole("button", { name: /sign in to generate/i })
		.first()
		.click();
	await expect(page).toHaveURL(/\/login\?redirectTo=/);
	expect(page.url()).not.toContain("cobalt");
	const draft = await page.evaluate(() =>
		JSON.parse(sessionStorage.getItem("ezpic.editor-upgrade.v1")!),
	);
	expect(draft.draft.input).toMatchObject({
		kind: "text-to-image",
		prompt,
		skuKey: "gpt-image-2-1k",
	});
	expect(draft.draft.input).not.toHaveProperty("sourceAssetId");
	await page.getByLabel(/email/i).fill(`media-e2e-funded-${process.env.E2E_RUN_ID}@example.test`);
	await page.locator('input[type="password"]').fill(process.env.E2E_USER_PASSWORD!);
	await expect(page.locator('button[type="submit"]')).toBeEnabled({ timeout: 30_000 });
	await page.locator('button[type="submit"]').click();
	await expect(page).toHaveURL(/\/create\?model=image-gpt-image-2$/, { timeout: 60_000 });
	await expect(page.getByLabel(/edit instruction|image prompt/i)).toHaveValue(prompt);
	await expect(page.locator('[data-test="editor-model-trigger"]')).toContainText("GPT Image 2");
	await expect(page.getByRole("button", { name: /review credits/i })).toBeEnabled({
		timeout: 30_000,
	});
	expect(uploads).toEqual([]);
});

test("login waits for hydration and never defaults credentials to a GET form", async ({
	browser,
}) => {
	const context = await browser.newContext({
		javaScriptEnabled: false,
		storageState: { cookies: [], origins: [] },
	});
	try {
		const page = await context.newPage();
		await page.goto(`${process.env.NEXT_PUBLIC_SAAS_URL}/login`);
		await expect(page.locator('[data-auth-form="login"] form')).toHaveAttribute("method", "post");
		await expect(page.locator('button[type="submit"]')).toBeDisabled();
	} finally {
		await context.close();
	}
});
