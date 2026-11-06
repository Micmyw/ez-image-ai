import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

async function publicSession(page: Page) {
	// Optional original-byte fixtures avoid local proxy DNS affecting image-optimizer QA.
	// Production image security and source sample URLs remain unchanged.
	if (process.env.VIDEO_TEMPLATE_POSTER_FIXTURE_MANIFEST) {
		const fixtures: Record<string, { path: string; contentType: string }> = JSON.parse(
			await readFile(process.env.VIDEO_TEMPLATE_POSTER_FIXTURE_MANIFEST, "utf8"),
		);
		await page.route("**/_next/image?**", async (route) => {
			const source = new URL(route.request().url()).searchParams.get("url");
			const fixture = source ? fixtures[source] : undefined;
			if (!fixture) return route.continue();
			return route.fulfill({
				body: await readFile(fixture.path),
				contentType: fixture.contentType,
			});
		});
	}
	await page
		.context()
		.addCookies([
			{ name: "consent", value: "false", url: test.info().project.use.baseURL as string },
		]);
	await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
	await page.route("**/api/auth/organization/list**", (route) => route.fulfill({ json: [] }));
	// Shared navigation reads these independently of the template catalog. Keep the
	// public presentation checks independent of database availability and API compilation.
	await page.route("**/api/rpc/media/getPublicCatalog**", (route) =>
		route.fulfill({ json: { json: { products: [] } } }),
	);
	await page.route("**/api/analytics/policy", (route) =>
		route.fulfill({
			json: { requiresOptIn: true, privacySignal: false, analyticsAllowed: false },
		}),
	);
}

test("template directory is poster-first and preserves existing canonical destinations", async ({
	page,
}) => {
	await publicSession(page);
	const requests: string[] = [];
	page.on("request", (request) => {
		if (/\.mp4(?:\?|$)/.test(request.url())) requests.push(request.url());
	});
	const response = await page.goto("/video-templates", { waitUntil: "domcontentloaded" });
	await expect(page.getByRole("heading", { name: "Find a scene. Make it yours." })).toBeVisible();
	await expect(page.locator("main article")).toHaveCount(9);
	await expect(page.locator("main article .vt-preview img")).toHaveCount(9);
	await expect(page.locator(".vt-preview").getByText("Preview", { exact: true })).toHaveCount(0);
	await expect(page.locator(".vt-sample-credit")).toHaveCount(0);
	await expect(page.locator(".vt-preview-action").first()).toHaveCSS(
		"background-color",
		"rgba(0, 0, 0, 0)",
	);
	await expect(page.locator(".vt-no-sample")).toHaveCount(0);
	await expect(page.getByText("Sample not published", { exact: true })).toHaveCount(0);
	const moreTools = page.getByRole("region", { name: "More video tools" });
	await expect(moreTools.getByRole("listitem")).toHaveCount(3);
	await expect(moreTools.locator(".vt-preview")).toHaveCount(0);
	await expect(page.locator("main video")).toHaveCount(0);
	expect(requests).toEqual([]);
	expect(response?.headers()["x-robots-tag"]).toBe("noindex, follow");
	await expect(
		page.getByRole("link", { name: "Hotel Lobby · EzPic", exact: true }),
	).toHaveAttribute("href", "/video-effects/hotel-lobby-ai");
	await expect(
		page.getByRole("link", { name: "Hotel Lobby · Original", exact: true }),
	).toHaveAttribute("href", "/video-templates/source-hotel-lobby");
	await expect(page.getByRole("link", { name: "Flying Car", exact: true })).toHaveAttribute(
		"href",
		"/video-templates/flying-car",
	);
	await expect(page.getByRole("link", { name: /Flying Car ·/ })).toHaveCount(0);
	await page.getByRole("button", { name: "Pets", exact: true }).click();
	await expect(page.locator("main article")).toHaveCount(2);
	await expect(page.getByRole("link", { name: "Kung Fu Cat", exact: true })).toBeVisible();
	await expect(moreTools).toHaveCount(0);
	await page.getByRole("button", { name: "All templates", exact: true }).click();
	await page.getByRole("searchbox", { name: "Find a template" }).fill("Raindance");
	await expect(page.locator("main article")).toHaveCount(0);
	await expect(moreTools.getByRole("listitem")).toHaveCount(1);
	await expect(moreTools.getByRole("link", { name: "Raindance", exact: true })).toHaveAttribute(
		"href",
		"/blog/raindance-ai-trend",
	);
});

test("template directory assigns only one requested video source and closes it", async ({
	page,
}) => {
	await publicSession(page);
	// Keep fixture media pending: this checks source allocation, not playback/provider quality.
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/*.mp4", async (route) => {
		await held;
		await route.abort().catch(() => undefined);
	});
	try {
		await page.goto("/video-templates", { waitUntil: "domcontentloaded" });
		await page.locator("main article .vt-preview").first().hover();
		await expect(page.locator("main video")).toHaveCount(1);
		await expect(page.locator("main video")).toHaveAttribute("src", /orange-studio\.mp4$/);
		await expect(page.locator("main video")).toHaveJSProperty("muted", true);
		await page.locator("main article .vt-preview").nth(1).hover();
		await expect(page.locator("main video")).toHaveCount(1);
		await expect(page.locator("main video")).toHaveAttribute("src", /bulin-47\.mp4$/);
		await page.getByRole("heading", { name: "Find a scene. Make it yours." }).hover();
		await expect(page.locator("main video")).toHaveCount(0);
		await page.getByRole("button", { name: "Play Flying Car example", exact: true }).click();
		await expect(page.locator("main video")).toHaveCount(1);
		await expect(page.locator("main video")).toHaveAttribute(
			"src",
			"https://ezairapvideo.com/flyingcar/templates/v1/curved-ramp/preview.mp4",
		);
		await page.getByRole("button", { name: "Close Flying Car example", exact: true }).click();
		await expect(page.locator("main video")).toHaveCount(0);
	} finally {
		release();
	}
});

test("Flying Car has one entry, original sequence choices and a clear sign-in workspace", async ({
	page,
}) => {
	await publicSession(page);
	await page.goto("/video-templates/flying-car", { waitUntil: "domcontentloaded" });
	await expect(page.getByRole("heading", { name: "Flying Car AI", exact: true })).toBeVisible();
	await expect(
		page.getByRole("img", { name: "Flying Car source example", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Play Flying Car example", exact: true }),
	).toBeEnabled();
	await expect(page.getByRole("link", { name: "Sign in to create", exact: true })).toHaveAttribute(
		"href",
		"/login?redirectTo=%2Fvideo-templates%2Fflying-car",
	);
	await expect(page.getByRole("definition").filter({ hasText: "15 seconds" })).toBeVisible();
	await expect(page.getByLabel("Stunt sequence", { exact: true })).toHaveValue(
		"flying-car-curved-ramp-showcase",
	);
	await expect(page.locator("#vt-stunt option")).toHaveCount(4);
	await expect(page.locator("link[rel=canonical]")).toHaveAttribute(
		"href",
		/\/video-templates\/flying-car$/,
	);
	await expect(page.getByRole("button", { name: /Create for/ })).toHaveCount(0);
	await expect(page.locator("main video")).toHaveCount(0);
});

test("Hotel Lobby shows its template-defined duration without a zero-second option", async ({
	page,
}) => {
	await publicSession(page);
	await page.goto("/video-templates/source-hotel-lobby", { waitUntil: "domcontentloaded" });
	await expect(page.getByText("Determined by the template", { exact: true })).toBeVisible();
	await expect(page.locator("select#vt-duration")).toHaveCount(0);
	await expect(page.getByText("0 seconds", { exact: true })).toHaveCount(0);
});

test("Green Booth explains the real performance and shows the two photo roles before sign-in", async ({
	page,
}) => {
	await publicSession(page);
	const response = await page.goto("/video-templates/green-booth-freestyle", {
		waitUntil: "domcontentloaded",
	});
	const html = await response!.text();
	expect(html).toContain("What is Green Booth Freestyle AI?");
	expect(html).toContain("black stand microphone");
	await expect(
		page.getByRole("heading", { name: "Green Booth Freestyle AI", exact: true }),
	).toBeVisible();
	await expect(page.locator(".vt-guest-inputs .vt-upload")).toHaveCount(2);
	await expect(page.getByText("Left · hype partner", { exact: true })).toBeVisible();
	await expect(page.getByText("Right · lead rapper", { exact: true })).toBeVisible();
	await expect(page.locator("#template-creator select")).toHaveCount(0);
	await expect(page.getByText("10 seconds", { exact: true })).toBeVisible();
	await expect(page.locator(".vt-preview img")).toHaveCSS("object-fit", "contain");
	await expect(page.locator(".vt-preview-action")).toBeEnabled();
	await expect(page.locator(".vt-preview-action")).toBeEmpty();
	await expect(page.locator(".vt-sample-credit")).toHaveCount(0);
	await expect
		.poll(() =>
			page
				.locator(".vt-preview img")
				.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
		)
		.toBe(true);
	await page.screenshot({
		path: test.info().outputPath("green-booth-desktop.png"),
		fullPage: true,
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: test.info().outputPath("green-booth-mobile.png"), fullPage: true });
});

test("hover playback advances the original example and leaving removes the player", async ({
	page,
}) => {
	await publicSession(page);
	await page.goto("/video-templates", { waitUntil: "domcontentloaded" });
	await expect(page.locator("main .vt-preview-action").first()).toBeEnabled();
	await page.locator("main article .vt-preview").first().hover();
	await expect
		.poll(
			async () =>
				page
					.locator("main video")
					.evaluate(
						(video: HTMLVideoElement) => !video.paused && video.muted && video.currentTime > 0,
					),
			{ timeout: 20000 },
		)
		.toBe(true);
	await page.getByRole("heading", { name: "Find a scene. Make it yours." }).hover();
	await expect(page.locator("main video")).toHaveCount(0);
});

test.describe("touch previews", () => {
	test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
	test("touch visitors can explicitly play and close an example", async ({ page }) => {
		await publicSession(page);
		await page.goto("/video-templates", { waitUntil: "domcontentloaded" });
		await page.getByRole("button", { name: "Play Original Rap example", exact: true }).tap();
		await expect(page.locator("main video")).toHaveCount(1);
		await expect(page.locator("main video")).toHaveJSProperty("controls", true);
		await expect(page.locator("main video")).toHaveJSProperty("muted", false);
		const videoBounds = await page.locator("main video").boundingBox();
		const closeBounds = await page
			.getByRole("button", { name: "Close Original Rap example", exact: true })
			.boundingBox();
		expect(closeBounds!.height).toBeLessThan(videoBounds!.height / 2);
		await page.getByRole("button", { name: "Close Original Rap example", exact: true }).tap();
		await expect(page.locator("main video")).toHaveCount(0);
	});
});

test("reduced-motion visitors retain an explicit keyboard preview without hover autoplay", async ({
	page,
}) => {
	await publicSession(page);
	await page.emulateMedia({ reducedMotion: "reduce" });
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/*.mp4", async (route) => {
		await held;
		await route.abort().catch(() => undefined);
	});
	try {
		await page.goto("/video-templates", { waitUntil: "domcontentloaded" });
		const preview = page.getByRole("button", { name: "Play Original Rap example", exact: true });
		await expect(preview).toBeEnabled();
		await page.locator("main article .vt-preview").first().hover();
		await expect(page.locator("main video")).toHaveCount(0);
		await preview.focus();
		await page.keyboard.press("Enter");
		await expect(page.locator("main video")).toHaveCount(1);
		await page.keyboard.press("Escape");
		await expect(page.locator("main video")).toHaveCount(0);
	} finally {
		release();
	}
});

test("signed-in controls change the cast and keep optional quality settings collapsed", async ({
	page,
}) => {
	await publicSession(page);
	const now = new Date().toISOString();
	await page.route("**/api/auth/get-session**", (route) =>
		route.fulfill({
			json: {
				user: {
					id: "ui-template-user",
					name: "Preview",
					email: "preview@example.invalid",
					emailVerified: true,
					isAnonymous: false,
					createdAt: now,
					updatedAt: now,
				},
				session: {
					id: "ui-template-session",
					userId: "ui-template-user",
					token: "ui-only",
					expiresAt: "2099-01-01T00:00:00.000Z",
					createdAt: now,
					updatedAt: now,
				},
			},
		}),
	);
	const mutations: string[] = [];
	await page.route("**/api/rpc/videoTemplates/**", (route) => {
		const url = route.request().url();
		if (url.includes("/access"))
			return route.fulfill({ json: { json: { available: true, maximumInputBytes: 10485760 } } });
		if (url.includes("/jobs/list"))
			return route.fulfill({ json: { json: { items: [], nextCursor: null } } });
		mutations.push(url);
		return route.abort();
	});
	await page.goto("/video-templates/spin-me-round", { waitUntil: "domcontentloaded" });
	const trio = page.getByRole("button", { name: "Trio", exact: true });
	await expect(trio).toBeEnabled();
	await trio.click();
	await expect(page.locator("#template-creator input[type=file]")).toHaveCount(3);
	await expect(page.locator(".vt-settings-details")).not.toHaveAttribute("open", "");
	await page.getByText("More video settings", { exact: false }).click();
	await expect(page.getByLabel("Duration", { exact: true })).toHaveValue("15");
	await page.getByRole("button", { name: "Solo", exact: true }).click();
	await expect(page.locator("#template-creator input[type=file]")).toHaveCount(1);
	await expect(page.getByLabel("Duration", { exact: true })).toHaveValue("12");
	await expect(page.getByRole("button", { name: "Get credit quote", exact: true })).toBeDisabled();
	expect(mutations).toEqual([]);
});

test("private image handoff survives directory navigation and the sign-in return", async ({
	page,
}) => {
	await publicSession(page);
	const response = await page.goto("/video-templates?asset=owned-image-id", {
		waitUntil: "domcontentloaded",
	});
	expect(response?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
	const link = page.getByRole("link", { name: "Bulin 47", exact: true });
	await expect(link).toHaveAttribute("href", "/video-templates/bulin-47?asset=owned-image-id");
	await link.click();
	await expect(page).toHaveURL(/\/video-templates\/bulin-47\?asset=owned-image-id$/, {
		timeout: 30000,
	});
	await expect(
		page.getByRole("heading", { name: "Bulin 47 AI", exact: true, level: 1 }),
	).toBeVisible({
		timeout: 30000,
	});
	await expect(page.getByRole("link", { name: "Sign in to create", exact: true })).toHaveAttribute(
		"href",
		"/login?redirectTo=%2Fvideo-templates%2Fbulin-47%3Fasset%3Downed-image-id",
	);
	await expect(page.getByRole("button", { name: /Create for/ })).toHaveCount(0);
});

for (const width of [320, 390, 768, 1440])
	test(`template directory and detail fit ${width}px without horizontal overflow`, async ({
		page,
	}) => {
		await publicSession(page);
		await page.setViewportSize({ width, height: 900 });
		for (const path of ["/video-templates", "/video-templates/spin-me-round"]) {
			await page.goto(path, { waitUntil: "domcontentloaded" });
			await expect(page.locator("main h1")).toBeVisible();
			await expect(page.locator("main .vt-preview-action").first()).toBeEnabled();
			for (const poster of await page.locator("main .vt-preview img").all()) {
				await poster.scrollIntoViewIfNeeded();
				await expect
					.poll(() =>
						poster.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
					)
					.toBe(true);
			}
			await page.evaluate(() => window.scrollTo(0, 0));
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
			).toBe(true);
			if (width === 390 || width === 1440)
				await page.screenshot({
					path: test
						.info()
						.outputPath(`${path.endsWith("spin-me-round") ? "detail" : "directory"}-${width}.png`),
					fullPage: true,
				});
		}
	});
