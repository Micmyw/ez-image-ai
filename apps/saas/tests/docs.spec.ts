import { expect, test } from "@playwright/test";

const baseUrl = process.env.NEXT_PUBLIC_SAAS_URL ?? "http://localhost:3000";
const legacyUnnamespacedEndpoints = [
	"/api/search?query=EzPic",
	"/llms.txt",
	"/llms-full.txt",
	"/llms.mdx",
	"/llms.mdx/quick-start",
	"/og/image.png",
	"/og/quick-start/image.png",
] as const;

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("same-origin documentation", () => {
	for (const path of ["/docs", "/docs/quick-start"] as const) {
		test(`${path} renders factual noindex documentation`, async ({ page }) => {
			const response = await page.goto(path);
			expect(response?.status()).toBe(200);
			expect(response?.headers()["x-robots-tag"], path).toBe("noindex, follow");
			expect(new URL(page.url()).pathname).toBe(path);
			await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
			const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
			expect(canonical).not.toBeNull();
			expect(new URL(canonical!).origin).toBe(new URL(baseUrl).origin);
			expect(new URL(canonical!).pathname).toBe(path);
			const directives = await robotsDirectives(page);
			expect(directives.has("noindex")).toBe(true);
			expect(directives.has("follow")).toBe(true);
			await expect(page.locator("main")).not.toContainText(/acme|lorem ipsum|my app/i);
		});
	}

	test("Docs navigation and search results stay below /docs", async ({ page, request }) => {
		await page.goto("/docs");
		await expect(page.locator('a[href="/docs/quick-start"]').first()).toBeVisible();

		const response = await request.get("/docs/api/search?query=EzPic");
		expect(response.status()).toBe(200);
		expect(response.headers()["x-robots-tag"]).toBe("noindex, follow");
		expect(response.headers()["content-type"]).toContain("application/json");
		const body = await response.text();
		expect(body).toContain("/docs");
		expect(body).not.toMatch(/acme|lorem ipsum|my app/i);
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
			expect(body, endpoint).toMatch(/EzPic/i);
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
