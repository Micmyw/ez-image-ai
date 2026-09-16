import { expect, test } from "@playwright/test";

test("all sitemap targets publish consistent indexable HTML without JavaScript", async ({
	request,
}) => {
	test.setTimeout(180_000);
	const sitemapResponse = await request.get("/sitemap.xml");
	expect(sitemapResponse.status()).toBe(200);
	const xml = await sitemapResponse.text();
	const modifiedDates = [...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)];
	const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!);
	expect(urls).toHaveLength(25);
	expect(modifiedDates).toHaveLength(urls.length);
	for (const [, date] of modifiedDates) expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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

test("image sitemap lists crawlable images present on their public pages", async ({
	request,
	page,
}) => {
	test.setTimeout(180_000);
	const response = await request.get("/sitemap-images.xml", { maxRedirects: 0 });
	expect(response.status()).toBe(200);
	expect(response.headers()["content-type"]).toContain("application/xml");
	const entries = await page.evaluate(
		(xml) => {
			const doc = new DOMParser().parseFromString(xml, "application/xml");
			if (doc.querySelector("parsererror")) throw new Error("Invalid image sitemap XML");
			return Array.from(doc.getElementsByTagName("url")).map((entry) => ({
				url: entry.getElementsByTagName("loc")[0]!.textContent!,
				images: Array.from(
					entry.getElementsByTagNameNS("http://www.google.com/schemas/sitemap-image/1.1", "loc"),
				).map((image) => image.textContent!),
			}));
		},
		await response.text(),
	);
	expect(entries).toHaveLength(14);
	const imageUrls = new Set<string>();
	for (const entry of entries) {
		const pageResponse = await request.get(entry.url);
		expect(pageResponse.status(), entry.url).toBe(200);
		const html = await pageResponse.text();
		const renderedImages = await page.evaluate((markup) => {
			const doc = new DOMParser().parseFromString(markup, "text/html");
			return Array.from(doc.querySelectorAll("img[src]")).map((image) => image.getAttribute("src"));
		}, html);
		for (const image of entry.images) {
			expect(renderedImages, `${entry.url}: ${image}`).toContain(new URL(image).pathname);
			imageUrls.add(image);
		}
	}
	const robots = await (await request.get("/robots.txt")).text();
	const disallowed = [...robots.matchAll(/^Disallow: (.+)$/gm)].map((match) => match[1]!.trim());
	for (const image of imageUrls) {
		expect(
			disallowed.some((prefix) => new URL(image).pathname.startsWith(prefix)),
			image,
		).toBe(false);
		const imageResponse = await request.get(image, { maxRedirects: 0 });
		expect(imageResponse.status(), image).toBe(200);
		expect(imageResponse.headers()["content-type"], image).toContain("image/webp");
	}
	await test.info().attach("public-image-inventory", {
		body: JSON.stringify({ pages: entries.length, uniqueImages: imageUrls.size, entries }, null, 2),
		contentType: "application/json",
	});
});

test("robots advertises both sitemaps and an absent index stays a 404", async ({
	request,
	baseURL,
}) => {
	test.setTimeout(120_000);
	const robots = await request.get("/robots.txt");
	expect(robots.status()).toBe(200);
	const text = await robots.text();
	for (const path of ["/sitemap.xml", "/sitemap-images.xml"]) {
		expect(text).toContain(`Sitemap: ${new URL(path, baseURL).href}`);
	}
	for (const method of ["GET", "HEAD"]) {
		const missing = await request.fetch("/sitemap_index.xml", { method, maxRedirects: 0 });
		expect(missing.status()).toBe(404);
		expect(missing.headers().location).toBeUndefined();
	}
	for (const path of ["/assets", "/history", "/example-organization"]) {
		const protectedResponse = await request.get(path, { maxRedirects: 0 });
		expect(protectedResponse.status(), path).toBe(307);
		expect(protectedResponse.headers().location, path).toContain("/login");
	}
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
