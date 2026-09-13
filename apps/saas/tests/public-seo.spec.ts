import { expect, test } from "@playwright/test";

test("all sitemap targets publish consistent indexable HTML without JavaScript", async ({
	request,
}) => {
	test.setTimeout(90_000);
	const sitemapResponse = await request.get("/sitemap.xml");
	expect(sitemapResponse.status()).toBe(200);
	const xml = await sitemapResponse.text();
	expect(xml).not.toContain("<lastmod>");
	const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!);
	expect(urls).toHaveLength(12);
	const evidence = [];
	for (const url of urls) {
		const response = await request.get(url, { headers: { Cookie: "NEXT_LOCALE=de" } });
		const html = await response.text();
		expect(response.status(), url).toBe(200);
		expect(response.headers()["x-robots-tag"], url).toBeUndefined();
		expect(html, url).toContain('<html lang="en"');
		const canonical = /rel="canonical" href="([^"]+)"/.exec(html)?.[1];
		expect(canonical, url).toBeDefined();
		expect(new URL(canonical!).href, url).toBe(new URL(url).href);
		expect(html, url).toMatch(/<meta name="robots" content="index, follow"/);
		expect(html.match(/<h1(?=\s|>)/g), url).toHaveLength(1);
		expect(html, url).toMatch(/<meta name="description" content="[^"]+"/);
		if (new URL(url).pathname === "/") {
			expect(html).toContain('"@type":"WebSite"');
			expect(html).not.toContain('"@type":"FAQPage"');
			expect(html).toContain('href="/blog/ai-image-editing-prompts"');
		}
		evidence.push({ url, status: response.status(), language: "en", indexable: true });
	}
	await test.info().attach("initial-html-inventory", {
		body: JSON.stringify(evidence, null, 2),
		contentType: "application/json",
	});
});

test("unmatched public paths return a real 404 with useful public navigation", async ({
	request,
	page,
}) => {
	// The protected routes can each require a separate cold dev-server compilation.
	test.setTimeout(120_000);
	for (const path of [
		"/missing-public-page/nested",
		"/blog/missing-article",
		"/docs/missing-topic",
	]) {
		const response = await request.get(path, { maxRedirects: 0 });
		expect(response.status(), path).toBe(404);
		expect(response.headers().location, path).toBeUndefined();
		const html = await response.text();
		expect(html).toContain("noindex");
	}
	// A single segment can be an organization slug: it is an actual protected route.
	for (const path of ["/history", "/example-organization"]) {
		const response = await request.get(path, { maxRedirects: 0 });
		expect(response.status(), path).toBe(307);
		expect(response.headers().location, path).toContain("/login");
	}
	await page.goto("/missing-public-page/nested");
	await expect(page.getByRole("heading", { level: 1, name: "404" })).toBeVisible();
	await expect(page.getByRole("link", { name: /return to the homepage/i })).toHaveAttribute(
		"href",
		"/",
	);
});

test("public pages keep stable English while account pages retain the locale cookie", async ({
	page,
	context,
}) => {
	test.setTimeout(60_000);
	const baseUrl = process.env.NEXT_PUBLIC_SAAS_URL ?? "http://localhost:3000";
	await context.addCookies([{ name: "NEXT_LOCALE", value: "de", url: baseUrl }]);
	for (const path of ["/", "/privacy", "/pricing", "/blog", "/docs/quick-start"]) {
		await page.goto(path);
		await expect(page.locator("html"), path).toHaveAttribute("lang", "en");
		if (path === "/privacy") {
			await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
		}
	}
	await page.goto("/login");
	await expect(page.locator("html")).toHaveAttribute("lang", "de");
	expect((await context.cookies()).find((cookie) => cookie.name === "NEXT_LOCALE")?.value).toBe(
		"de",
	);
	await page.getByRole("link", { name: "EzPic", exact: true }).first().click();
	await expect(page.locator("html")).toHaveAttribute("lang", "en");
	await page
		.getByRole("banner")
		.getByRole("link", { name: /sign in/i })
		.click();
	await expect(page.locator("html")).toHaveAttribute("lang", "de");
});

test("an unavailable editor provides recovery without submitting an edit", async ({ page }) => {
	let capabilityRequests = 0;
	let draftRequests = 0;
	page.on("request", (request) => {
		if (request.method() === "POST" && /guest-draft|draft\/continue/.test(request.url()))
			draftRequests += 1;
	});
	await page.route("**/api/media/guest-capability", async (route) => {
		capabilityRequests += 1;
		await route.fulfill({
			json: {
				version: "public-seo-e2e",
				enabled: false,
				reason: "GUEST_ENVIRONMENT_DISABLED",
				products: [],
				upload: { mimeTypes: ["image/jpeg", "image/png", "image/webp"], maximumBytes: 10485760 },
				queueEstimate: { kind: "capacity" },
			},
		});
	});
	await page.goto("/");
	const editor = page.locator('[data-test="landing-generator"]');
	await expect(editor.getByText(/editing is unavailable right now/i)).toBeVisible();
	await expect(editor.getByRole("button", { name: /try .* free/i })).toHaveCount(0);
	await editor.getByLabel(/describe your edit/i).fill("Keep the mug and soften the background");
	await expect(editor.getByRole("link", { name: /prompt guide/i })).toHaveAttribute(
		"href",
		"/blog/ai-image-editing-prompts",
	);
	await expect(editor.getByRole("link", { name: /contact support/i })).toHaveAttribute(
		"href",
		"/contact",
	);
	const beforeRetry = capabilityRequests;
	await editor.getByRole("button", { name: /check edit availability again/i }).click();
	await expect.poll(() => capabilityRequests).toBe(beforeRetry + 1);
	await expect(editor.getByLabel(/describe your edit/i)).toHaveValue(
		"Keep the mug and soften the background",
	);
	expect(draftRequests).toBe(0);
});

for (const width of [390, 320]) {
	test(`consent choices do not cover the mobile editor at ${width}px`, async ({
		page,
		context,
	}) => {
		await context.clearCookies();
		await page.setViewportSize({ width, height: 844 });
		await page.goto("/");
		const choices = page.getByRole("button", { name: "Decline optional", exact: true });
		await expect(choices).toBeVisible();
		const action = page.locator(
			'[data-test="landing-generator"] button[aria-describedby="landing-stage-status"]',
		);
		await action.scrollIntoViewIfNeeded();
		const unobscured = await action.evaluate((element) => {
			const box = element.getBoundingClientRect();
			const atCenter = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
			// Disabled buttons have pointer-events:none, so their parent can receive the hit.
			return (
				element === atCenter || element.contains(atCenter) || Boolean(atCenter?.contains(element))
			);
		});
		expect(unobscured).toBe(true);
		await page.screenshot({ path: test.info().outputPath(`editor-${width}.png`) });
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
		await choices.click();
		await expect(choices).toHaveCount(0);
		await page.reload();
		await expect(choices).toHaveCount(0);
	});
}
