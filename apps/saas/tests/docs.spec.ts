import { expect, test } from "@playwright/test";

const baseUrl = process.env.NEXT_PUBLIC_SAAS_URL ?? "http://localhost:3000";
const legacyUnnamespacedEndpoints = [
	"/api/search?query=EzImageAI",
	"/llms.txt",
	"/llms-full.txt",
	"/llms.mdx",
	"/llms.mdx/quick-start",
	"/og/image.png",
	"/og/quick-start/image.png",
] as const;

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("same-origin documentation", () => {
	for (const path of ["/docs", "/docs/quick-start", "/docs/image-editing"] as const) {
		test(`${path} renders factual indexable documentation`, async ({ page }) => {
			const response = await page.goto(path);
			expect(response?.status()).toBe(200);
			// Browsers repair nested paragraphs before hydration; inspect the server HTML as well.
			expect(await response!.text()).not.toMatch(/<p(?:\s[^>]*)?>\s*<p(?:\s[^>]*)?>/);
			expect(response?.headers()["x-robots-tag"], path).toBeUndefined();
			expect(new URL(page.url()).pathname).toBe(path);
			await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
			const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
			expect(canonical).not.toBeNull();
			expect(new URL(canonical!).origin).toBe(new URL(baseUrl).origin);
			expect(new URL(canonical!).pathname).toBe(path);
			const directives = await robotsDirectives(page);
			expect(directives.has("noindex")).toBe(false);
			expect(directives.has("index")).toBe(true);
			expect(directives.has("follow")).toBe(true);
			await expect(page.locator("main")).not.toContainText(/acme|lorem ipsum|my app/i);
		});
	}

	test("Docs keeps readable typography and layout at desktop and mobile widths", async ({
		page,
	}, testInfo) => {
		await page.setViewportSize({ width: 1350, height: 940 });
		await page.goto("/docs/quick-start");
		const heading = page.getByRole("heading", { level: 1 });
		await expect(heading).toBeVisible();
		const headingSize = () =>
			heading.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
		await expect
			.poll(headingSize, { message: "The hydrated Docs heading is at least 28px" })
			.toBeGreaterThanOrEqual(28);
		await expect
			.poll(headingSize, { message: "The hydrated Docs heading is at most 38px" })
			.toBeLessThanOrEqual(38);
		const sidebar = page.locator("#nd-sidebar");
		await expect(sidebar).toBeVisible();
		const sidebarBox = await sidebar.boundingBox();
		const articleBox = await page.locator("#nd-page").boundingBox();
		expect(sidebarBox!.width).toBeGreaterThan(200);
		expect(articleBox!.width).toBeGreaterThan(500);
		expect(articleBox!.x).toBeGreaterThanOrEqual(sidebarBox!.x + sidebarBox!.width - 1);
		await page.screenshot({ path: testInfo.outputPath("documentation-desktop.png") });
		await page.setViewportSize({ width: 390, height: 844 });
		await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
		expect((await page.locator("#nd-page").boundingBox())!.width).toBeGreaterThan(350);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			390,
		);
		await page.screenshot({ path: testInfo.outputPath("documentation-mobile.png") });
	});

	test("Docs navigation and search results stay below /docs", async ({ page, request }) => {
		await page.goto("/docs");
		await expect(page.locator('a[href="/docs/quick-start"]').first()).toBeVisible();

		const response = await request.get("/docs/api/search?query=EzImageAI");
		expect(response.status()).toBe(200);
		expect(response.headers()["x-robots-tag"]).toBe("noindex, follow");
		expect(response.headers()["content-type"]).toContain("application/json");
		const body = await response.text();
		expect(body).toContain("/docs");
		expect(body).not.toMatch(/acme|lorem ipsum|my app/i);
	});

	test("Docs navigation preserves homepage gallery geometry", async ({ page }, testInfo) => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.setViewportSize({ width: 1350, height: 940 });
		await page.goto("/docs/quick-start");
		await expect(page.locator("#nd-page")).toBeVisible();
		await page.getByRole("link", { name: "EzImageAI", exact: true }).click();
		await expect(page).toHaveURL(`${baseUrl}/`);
		await expect(page.locator("#docs-root")).toHaveCount(0);
		await expect(page.locator("#examples-title")).toHaveCSS("font-size", "48px");
		await expect(page.locator("#examples-title")).toHaveCSS("text-align", "left");

		const cards = page.locator("#examples article");
		await expect(cards).toHaveCount(12);
		for (const card of await cards.all()) {
			await card.scrollIntoViewIfNeeded();
			await assertShowcaseCardGeometry(card);
		}
		await cards.first().hover();
		await expect(cards.first().locator(".showcase-caption")).toHaveCSS("opacity", "1");
		await expect(cards.first().locator(".showcase-action")).toBeVisible();
		await expect(cards.first().getByRole("heading", { level: 3 })).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath("gallery-after-docs-desktop.png") });

		await page.setViewportSize({ width: 390, height: 844 });
		// This desktop-browser context keeps a fine pointer at a narrow viewport.
		// Keyboard focus exposes the same overlay without assuming touch emulation.
		await page.keyboard.press("Tab");
		for (const card of await cards.all()) {
			await card.scrollIntoViewIfNeeded();
			await card.getByRole("button").focus();
			await assertShowcaseCardGeometry(card);
			await expect(card.locator(".showcase-caption")).toHaveCSS("opacity", "1");
			await expect(card.locator(".showcase-action")).toBeVisible();
			await expect(card.getByRole("button")).toHaveAccessibleName(/Use this prompt/);
			await expect(card.getByRole("heading", { level: 3 })).toBeVisible();
		}
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			390,
		);
		await cards.first().scrollIntoViewIfNeeded();
		await cards.first().getByRole("button").focus();
		await page.screenshot({ path: testInfo.outputPath("gallery-after-docs-mobile.png") });
	});

	test("Docs publishes namespaced LLM and raw Markdown endpoints", async ({ request }) => {
		for (const endpoint of [
			"/docs/llms.txt",
			"/docs/llms-full.txt",
			"/docs/llms.mdx",
			"/docs/llms.mdx/quick-start",
		] as const) {
			const response = await request.get(endpoint);
			expect(response.status(), endpoint).toBe(200);
			expect(response.headers()["x-robots-tag"], endpoint).toBe("noindex, follow");
			const body = await response.text();
			expect(body, endpoint).toMatch(/EzImageAI/i);
			expect(body, endpoint).not.toMatch(/acme|lorem ipsum|my app/i);
		}
	});

	test("Docs publishes root and nested Open Graph images below /docs/og", async ({ request }) => {
		for (const endpoint of ["/docs/og/image.png", "/docs/og/quick-start/image.png"] as const) {
			const response = await request.get(endpoint);
			expect(response.status(), endpoint).toBe(200);
			expect(response.headers()["x-robots-tag"], endpoint).toBe("noindex, follow");
			expect(response.headers()["content-type"], endpoint).toMatch(/^image\//i);
		}
	});

	test("legacy unnamespaced Docs artifacts are unavailable", async ({ request }) => {
		for (const endpoint of legacyUnnamespacedEndpoints) {
			const response = await request.get(endpoint, { maxRedirects: 0 });
			expect(response.status(), endpoint).toBe(404);
		}
	});
});

async function assertShowcaseCardGeometry(card: import("@playwright/test").Locator) {
	const button = card.getByRole("button");
	const image = card.getByRole("img");
	const caption = card.locator(".showcase-caption");
	await expect(image).toHaveJSProperty("complete", true);
	expect(await image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(
		0,
	);
	await expect(caption).toHaveCSS("position", "absolute");
	const imageBox = (await image.boundingBox())!;
	const buttonBox = (await button.boundingBox())!;
	const captionBox = (await caption.boundingBox())!;
	for (const dimension of ["width", "height"] as const) {
		expect(Math.abs(buttonBox[dimension] - imageBox[dimension])).toBeLessThan(2);
		expect(Math.abs(captionBox[dimension] - imageBox[dimension])).toBeLessThan(2);
	}
	for (const axis of ["x", "y"] as const) {
		expect(Math.abs(captionBox[axis] - imageBox[axis])).toBeLessThan(2);
	}
}

async function robotsDirectives(page: import("@playwright/test").Page): Promise<Set<string>> {
	const content = await page.locator('meta[name="robots"]').getAttribute("content");
	expect(content).not.toBeNull();
	return new Set(
		(content ?? "")
			.split(",")
			.map((directive) => directive.trim().toLowerCase())
			.filter(Boolean),
	);
}
