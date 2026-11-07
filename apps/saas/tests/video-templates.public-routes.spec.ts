import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

async function publicSession(page: Page) {
	// Keep unrelated account/navigation reads out of this fixture-only UI suite.
	await page.route("**/api/rpc/**", (route) =>
		route.fulfill({
			status: 401,
			json: { code: "UNAUTHORIZED", message: "Fixture-only navigation" },
		}),
	);
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
	await expect(page.getByRole("combobox", { name: "Stunt sequence" })).toContainText("Curved Ramp");
	await page.getByRole("combobox", { name: "Stunt sequence" }).click();
	await expect(page.getByRole("option")).toHaveCount(4);
	await page.keyboard.press("Escape");
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

async function templateSession(page: Page) {
	await publicSession(page);
	await page.route("**/api/rpc/payments/listPurchases", (route) =>
		route.fulfill({ json: { json: [] } }),
	);
	await page.route("**/api/rpc/media/getCreditAccount", (route) =>
		route.fulfill({
			json: {
				json: {
					spendableCredits: "1000",
					reservedCredits: "0",
					creditDebt: "0",
					version: 1,
					activeJobs: 0,
					maximumInputBytes: 10_000_000,
				},
			},
		}),
	);
	await page.route("**/api/rpc/videoV1/availability", (route) =>
		route.fulfill({ json: { json: { available: true } } }),
	);
	await page.route("**/api/rpc/notifications/unreadCount", (route) =>
		route.fulfill({ json: { json: { count: 0 } } }),
	);
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
			return route.fulfill({
				json: {
					json: {
						available: true,
						maximumInputBytes: 10_000_000,
						pricing: {
							version: 1,
							creditsByOptions: {
								'["standard","duo",12,"720p","9:16"]': "300",
								'["standard","solo",12,"720p","9:16"]': "200",
								'["standard","trio",15,"720p","9:16"]': "400",
								'["pro","solo",12,"1080p","9:16"]': "500",
							},
						},
					},
				},
			});
		if (url.includes("/jobs/list"))
			return route.fulfill({ json: { json: { items: [], nextCursor: null } } });
		mutations.push(url);
		return route.abort();
	});
	return mutations;
}

test("signed-in controls use named models and constrain dependent choices", async ({ page }) => {
	const mutations = await templateSession(page);
	await page.goto("/video-templates/spin-me-round", { waitUntil: "domcontentloaded" });
	await page.getByRole("button", { name: "Trio", exact: true }).click();
	await expect(page.locator("#template-creator input[type=file]")).toHaveCount(3);
	await page.locator(".vt-video-settings > summary").click();
	await expect(page.getByRole("combobox", { name: "Duration", exact: true })).toContainText(
		"15 seconds",
	);
	await page.getByRole("button", { name: "Solo", exact: true }).click();
	await expect(page.locator("#template-creator input[type=file]")).toHaveCount(1);
	await expect(page.getByRole("combobox", { name: "Duration", exact: true })).toContainText(
		"12 seconds",
	);
	const model = page.getByRole("combobox", { name: "Video model" });
	await model.click();
	await page.getByRole("option", { name: "Seedance 2", exact: true }).click();
	await page.getByRole("combobox", { name: "Resolution" }).click();
	await page.getByRole("option", { name: "1080p", exact: true }).click();
	await expect(page.getByRole("button", { name: "Create for 500 credits" })).toBeDisabled();
	await model.click();
	await page.getByRole("option", { name: "Seedance 2 Mini", exact: true }).click();
	await page.getByRole("combobox", { name: "Resolution" }).click();
	await expect(page.getByRole("option", { name: "1080p", exact: true })).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(page.locator("#template-creator select")).toHaveCount(0);
	expect(mutations).toEqual([]);
});

test("Rap keeps one creative field and compact uploads, with adaptive portrait and landscape previews", async ({
	page,
}) => {
	await templateSession(page);
	await page.setViewportSize({ width: 1440, height: 1000 });
	for (const path of ["original-rap", "flying-car"]) {
		await page.goto(`/video-templates/${path}`, { waitUntil: "domcontentloaded" });
		await expect(page.locator(".vt-preview-action")).toBeEnabled();
		await expect(page.locator('#template-creator input[type="file"]').first()).toBeEnabled();
		const preview = page.locator('.vt-preview[data-layout="detail"]');
		const poster = preview.locator("img");
		await expect
			.poll(() =>
				poster.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
			)
			.toBe(true);
		const geometry = () =>
			preview.evaluate((element) => {
				const image = element.querySelector("img")!;
				const bounds = element.getBoundingClientRect();
				return {
					ratio: bounds.width / bounds.height,
					naturalRatio: image.naturalWidth / image.naturalHeight,
					width: bounds.width,
					height: bounds.height,
				};
			});
		await expect
			.poll(async () => {
				const value = await geometry();
				return Math.abs(value.ratio - value.naturalRatio);
			})
			.toBeLessThan(0.015);
		expect((await geometry()).height).toBeLessThanOrEqual(722);
		if (path === "original-rap") {
			await expect(page.locator("#template-creator textarea")).toHaveCount(1);
			await expect(
				page.locator("#vt-language, #vt-occasion, #vt-custom-stage, #vt-tier"),
			).toHaveCount(0);
			const box = await page.locator(".vt-upload").first().boundingBox();
			expect(box!.height).toBeLessThanOrEqual(150);
			await page.getByRole("button", { name: "Neon Rap", exact: true }).click();
			await expect(page.locator(".vt-inputs input[type=file]")).toHaveCount(1);
			await expect(page.locator(".vt-preview img")).toHaveAttribute(
				"alt",
				"Original Rap · Neon Rap source example",
			);
			await expect
				.poll(() =>
					poster.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
				)
				.toBe(true);
			await page
				.getByRole("button", { name: "Play Original Rap · Neon Rap example", exact: true })
				.click();
			await expect
				.poll(
					() =>
						preview.locator("video").evaluate((video: HTMLVideoElement) => video.videoWidth > 0),
					{ timeout: 20000 },
				)
				.toBe(true);
			await expect
				.poll(() =>
					preview.evaluate((element) => {
						const video = element.querySelector("video")!;
						const box = element.getBoundingClientRect();
						return Math.abs(box.width / box.height - video.videoWidth / video.videoHeight);
					}),
				)
				.toBeLessThan(0.015);
			await page
				.getByRole("button", { name: "Close Original Rap · Neon Rap example", exact: true })
				.click();
			await expect(preview.locator("video")).toHaveCount(0);
			await expect
				.poll(async () => {
					const value = await geometry();
					return Math.abs(value.ratio - value.naturalRatio);
				})
				.toBeLessThan(0.015);
		}
		await page.screenshot({ path: test.info().outputPath(`${path}-desktop.png`), fullPage: false });
		await page
			.locator(".vt-workspace")
			.screenshot({ path: test.info().outputPath(`${path}-workspace.png`) });
	}
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/video-templates/original-rap", { waitUntil: "domcontentloaded" });
	await expect(page.locator(".vt-video-settings > summary")).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true,
	);
	await page.screenshot({ path: test.info().outputPath("rap-mobile.png"), fullPage: true });
});

test("oversized photos are compressed before the upload session and invalid photos never upload", async ({
	page,
}) => {
	const mutations = await templateSession(page);
	const sessions: { contentType: string; byteSize: number }[] = [];
	let uploaded: Buffer | null = null;
	await page.route("**/api/rpc/videoTemplates/uploads/create", async (route) => {
		const request = route.request().postDataJSON();
		sessions.push(request.json);
		await route.fulfill({
			json: {
				json: {
					sessionId: "compressed-session",
					uploadUrl: `${test.info().project.use.baseURL}/template-upload-fixture`,
				},
			},
		});
	});
	await page.route("**/template-upload-fixture", async (route) => {
		uploaded = route.request().postDataBuffer();
		await route.fulfill({ status: 200, body: "" });
	});
	await page.route("**/api/rpc/videoTemplates/uploads/complete", (route) =>
		route.fulfill({ json: { json: { assetId: "compressed-photo" } } }),
	);
	await page.goto("/video-templates/rap-neon-rap", { waitUntil: "domcontentloaded" });
	const input = page.locator('input[type="file"]').first();
	await expect(input).toBeEnabled();
	const original = await sharp(randomBytes(3200 * 2400 * 3), {
		raw: { width: 3200, height: 2400, channels: 3 },
	})
		.png()
		.toBuffer();
	expect(original.length).toBeGreaterThan(10_000_000);
	await input.setInputFiles({ name: "large-photo.png", mimeType: "image/png", buffer: original });
	await expect(page.getByText("Photo ready", { exact: true })).toBeVisible({ timeout: 30000 });
	expect(sessions).toHaveLength(1);
	expect(sessions[0]!.contentType).toBe("image/webp");
	expect(sessions[0]!.byteSize).toBeLessThanOrEqual(10_000_000);
	expect(uploaded!.length).toBe(sessions[0]!.byteSize);
	const metadata = await sharp(uploaded!).metadata();
	expect(metadata.width).toBe(2560);
	expect(metadata.height).toBe(1920);
	await expect(page.locator(".vt-upload img")).toHaveAttribute("src", /^blob:/);
	await input.setInputFiles({
		name: "broken.png",
		mimeType: "image/png",
		buffer: Buffer.alloc(10_000_001),
	});
	await expect(
		page.getByText("This photo could not be optimized.", { exact: false }),
	).toBeVisible();
	expect(sessions).toHaveLength(1);
	await expect(page.locator(".vt-upload img")).toHaveAttribute("src", /^blob:/);
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
