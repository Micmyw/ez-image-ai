import { expect, test } from "@playwright/test";

test("bots receive indexable public tools and noindex personal or fallback views in initial HTML", async ({
	request,
	baseURL,
}) => {
	test.setTimeout(180_000);
	const cases = [
		["/create", "/create", "index, follow"],
		["/create?mode=video", "/create", "index, follow"],
		["/examples", "/examples", "index, follow"],
		["/contact", "/contact", "index, follow"],
		["/changelog", "/changelog", "index, follow"],
		["/video-effects/hotel-lobby-ai", "/video-effects/hotel-lobby-ai", "index, follow"],
		["/docs/video-beta", "/docs/video-beta", "index, follow"],
		[
			"/video-effects/hotel-lobby-ai?lang=invalid",
			"/video-effects/hotel-lobby-ai",
			"index, follow",
		],
		["/blog/raindance-ai-trend?lang=invalid", "/blog/raindance-ai-trend", "index, follow"],
		["/?lang=de", "/?lang=de", "index, follow"],
		["/privacy?lang=de", "/privacy?lang=de", "index, follow"],
		["/privacy?lang=fr", "/privacy", "noindex, follow"],
		["/docs/video-beta?lang=de", "/docs/video-beta", "noindex, follow"],
		["/create?videoJob=private", "/create", "noindex, nofollow"],
		["/?job=private&lang=es", "/?lang=es", "noindex, nofollow"],
		["/image-to-image?asset=private", "/image-to-image", "noindex, nofollow"],
		["/photo-to-coloring-page?guestJob=private", "/photo-to-coloring-page", "noindex, nofollow"],
		[
			"/video-effects/hotel-lobby-ai?job=private",
			"/video-effects/hotel-lobby-ai",
			"noindex, nofollow",
		],
		["/blog/raindance-ai-trend?mode=duo", "/blog/raindance-ai-trend", "noindex, follow"],
		["/blog?q=editing", "/blog", "noindex, follow"],
	] as const;
	const evidence = [];
	for (const userAgent of ["Googlebot", "OAI-SearchBot", "GPTBot", "ChatGPT-User"]) {
		for (const [path, canonical, robots] of cases) {
			const response = await request.get(path, { headers: { "User-Agent": userAgent } });
			const html = await response.text();
			expect(response.status(), `${userAgent} ${path}`).toBe(200);
			expect(html, path).toContain(`<meta name="robots" content="${robots}"`);
			expect(html, path).toContain(`rel="canonical" href="${new URL(canonical, baseURL).href}"`);
			expect(response.headers()["x-robots-tag"], path).toBe(
				robots.startsWith("noindex") ? robots : undefined,
			);
			evidence.push({ userAgent, path, robots, status: response.status(), canonical });
		}
	}
	await test.info().attach("bot-initial-html", {
		body: JSON.stringify(evidence, null, 2),
		contentType: "application/json",
	});
});

test("public navigation exposes the newly indexable pages and private boundaries remain protected", async ({
	request,
	page,
}) => {
	await page.goto("/video-effects/hotel-lobby-ai");
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(
		"Hotel Lobby AI Video Generator",
	);
	await expect(page.locator(".ve-beta")).toBeVisible();
	await expect(page.locator(".ve-page video")).toHaveCount(0);
	for (const path of ["/create", "/examples", "/contact", "/changelog", "/docs/video-beta"]) {
		await expect(page.locator(`a[href="${path}"]`).first()).toBeAttached();
	}
	await page.screenshot({
		path: test.info().outputPath("hotel-lobby-public-desktop.png"),
		fullPage: false,
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({
		path: test.info().outputPath("hotel-lobby-public-mobile.png"),
		fullPage: false,
	});
	for (const path of ["/history", "/assets", "/video/history", "/checkout-return"]) {
		const response = await request.get(path, { maxRedirects: 0 });
		expect(response.status(), path).toBe(307);
		expect(response.headers().location, path).toContain("/login");
	}
	const login = await request.get("/login");
	expect(await login.text()).toContain('<meta name="robots" content="noindex, nofollow"');
	for (const path of ["/docs/llms.txt", "/docs/llms-full.txt", "/docs/llms.mdx/quick-start"]) {
		const response = await request.get(path);
		expect(response.headers()["x-robots-tag"], path).toBe("noindex, follow");
	}
	const draft = await request.get("/blog/how-to-make-hotel-lobby-ai-video");
	expect(draft.status()).toBe(404);
});
