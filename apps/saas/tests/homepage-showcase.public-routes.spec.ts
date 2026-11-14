import path from "node:path";

import { expect, test } from "@playwright/test";

import { HOMEPAGE_SHOWCASE_SEEN_KEY } from "../modules/landing/lib/homepage-showcase";
import { captureConsentedGrowthEvents, type CapturedGrowthEvent } from "./growth-events";

test.use({
	storageState: { cookies: [], origins: [] },
	video: { mode: "on", size: { width: 1440, height: 900 } },
});
test.beforeEach(async ({ page }) => {
	await page.route("**/api/analytics/traffic", (route) => route.fulfill({ status: 204 }));
	const product = {
		key: "image-nano-banana-2-lite",
		label: "Nano Banana 2 Lite",
		description: "Fast private image editing",
		credits: "5",
		accessHint: "guest-trial",
		aspectRatios: ["auto", "1:1"],
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
					aspectRatios: ["auto", "1:1"],
					controls: [],
				},
			],
		},
	};
	await page.route("**/api/media/guest-capability", (route) =>
		route.fulfill({
			json: {
				version: "showcase-e2e",
				enabled: true,
				reason: null,
				upload: {
					mimeTypes: ["image/jpeg", "image/png", "image/webp"],
					maximumBytes: 10 * 1024 * 1024,
				},
				products: [product],
				queueEstimate: { kind: "capacity" },
			},
		}),
	);
	await page.route("**/api/rpc/media/getPublicCatalog**", (route) =>
		route.fulfill({
			json: {
				json: {
					catalogVersion: "showcase-e2e",
					pricingVersion: "showcase-e2e",
					products: [{ ...product, inputKinds: ["text-to-image", "image-to-image"] }],
				},
			},
		}),
	);
});

for (const width of [1440, 390, 320]) {
	test(`image-first showcase fills a wide stage at ${width}px`, async ({ page }) => {
		test.setTimeout(75_000);
		await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });
		const mediaRequests: string[] = [];
		page.on("request", (r) => {
			if (r.url().endsWith(".mp4")) mediaRequests.push(r.url());
		});
		await page.goto("/");
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole("heading")).toHaveText("Your photo, painted differently.");
		await expect(dialog.locator("video")).toHaveCount(0);
		expect(mediaRequests).toHaveLength(0);
		expect(
			await dialog
				.locator(".homepage-showcase-picker button span")
				.evaluateAll((labels) => labels.every((label) => label.scrollWidth <= label.clientWidth)),
		).toBe(true);
		await expect
			.poll(() =>
				dialog
					.locator("img")
					.evaluateAll((images) =>
						images.every((i) => i instanceof HTMLImageElement && i.complete && i.naturalWidth > 0),
					),
			)
			.toBe(true);
		await expect
			.poll(() =>
				dialog.evaluate(
					(e) => e.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length,
				),
			)
			.toBe(0);
		const slider = dialog.getByRole("slider", { name: "Drag to compare" });
		await slider.focus();
		await page.keyboard.press("End");
		await expect(slider).toHaveValue("100");
		await page.keyboard.press("Home");
		await expect(slider).toHaveValue("0");
		await slider.fill("50");
		expect(
			await dialog.evaluate((e) => {
				const b = e.getBoundingClientRect();
				return (
					b.left >= 0 &&
					b.top >= 0 &&
					b.right <= innerWidth &&
					b.bottom <= innerHeight &&
					e.scrollWidth <= e.clientWidth
				);
			}),
		).toBe(true);
		await page.addStyleTag({ content: "nextjs-portal {visibility:hidden}" });
		await page.screenshot({
			path: path.resolve("../../output/playwright/homepage-showcase-v2", `watercolor-${width}.png`),
		});
		await dialog.getByRole("button", { name: "Vintage portrait", exact: true }).click();
		await expect(dialog.locator('[data-test="showcase-create"]')).toHaveAttribute(
			"href",
			"/create?example=vintage-photo",
		);
		await expect(dialog.locator(".homepage-showcase-portrait img")).toHaveCount(2);
		await expect(dialog.locator(".homepage-showcase-portrait")).toHaveAttribute(
			"data-ready",
			"true",
		);
		expect(
			await dialog
				.locator(".homepage-showcase-result")
				.evaluate((e) => Number(getComputedStyle(e).opacity)),
		).toBeLessThan(0.3);
		await expect(dialog.locator(".homepage-showcase-source")).toBeVisible();
		await expect
			.poll(() =>
				dialog
					.locator(".homepage-showcase-scene")
					.evaluate(
						(e) =>
							e.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length,
					),
			)
			.toBe(0);
		if (width === 1440) {
			await page.screenshot({
				path: path.resolve("../../output/playwright/homepage-showcase-v2/vintage.png"),
			});
			// Observe a real reading interval after the reveal, also captured in the browser video.
			await page.waitForTimeout(5000);
			await expect(
				dialog.getByRole("button", { name: "Vintage portrait", exact: true }),
			).toHaveAttribute("aria-pressed", "true");
		}
		await dialog.getByRole("button", { name: "Christmas", exact: true }).click();
		await expect(dialog.locator(".homepage-showcase-triptych img")).toHaveCount(3);
		await expect(dialog.locator(".homepage-showcase-triptych")).toHaveAttribute(
			"data-ready",
			"true",
		);
		expect(
			await dialog
				.locator(".homepage-showcase-triptych img")
				.last()
				.evaluate((e) => Number(getComputedStyle(e).opacity)),
		).toBeLessThan(0.3);
		await expect
			.poll(() =>
				dialog
					.locator(".homepage-showcase-scene")
					.evaluate(
						(e) =>
							e.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length,
					),
			)
			.toBe(0);
		await expect(dialog.locator('[data-test="showcase-create"]')).toHaveAttribute(
			"href",
			"/christmas-wallpaper",
		);
		if (width === 1440) {
			await page.screenshot({
				path: path.resolve("../../output/playwright/homepage-showcase-v2/christmas.png"),
			});
			await page.waitForTimeout(5000);
			await expect(dialog.getByRole("button", { name: "Christmas", exact: true })).toHaveAttribute(
				"aria-pressed",
				"true",
			);
		}
		await dialog.getByRole("button", { name: "Music video", exact: true }).click();
		const video = dialog.locator("video");
		await expect
			.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 })
			.toBeGreaterThan(width === 1440 ? 6 : 0.5);
		const dimensions = await video.evaluate((v: HTMLVideoElement) => ({
			width: v.videoWidth,
			height: v.videoHeight,
			ratio: v.clientWidth / v.clientHeight,
			muted: v.muted,
		}));
		expect(dimensions).toMatchObject({ width: 960, height: 540, muted: true });
		expect(dimensions.ratio).toBeCloseTo(16 / 9, 1);
		await expect(dialog.locator('[data-test="showcase-create"]')).toHaveAttribute(
			"href",
			"/video-templates/green-booth-freestyle",
		);
		await dialog.getByRole("button", { name: "Turn sound on", exact: true }).click();
		expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
		await dialog.getByRole("button", { name: "Pause preview", exact: true }).click();
		const handle = await video.elementHandle();
		if (width === 1440)
			await page.screenshot({
				path: path.resolve("../../output/playwright/homepage-showcase-v2/landscape-video.png"),
			});
		await dialog.getByRole("button", { name: "Watercolor", exact: true }).click();
		expect(
			await handle!.evaluate((v: HTMLVideoElement) => ({
				paused: v.paused,
				src: v.getAttribute("src"),
			})),
		).toEqual({ paused: true, src: null });
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		expect(
			await page.evaluate((key) => localStorage.getItem(key), HOMEPAGE_SHOWCASE_SEEN_KEY),
		).toBeNull();
	});
}

test("entrance stays centered and the picture survives the closing transition", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.getByRole("dialog")).toBeVisible();
	const originalScroll = await page.evaluate(() => window.scrollY);
	await page.getByRole("button", { name: "Close previews" }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	expect(await page.evaluate(() => window.scrollY)).toBe(originalScroll);
	const frames = await page.evaluate(async () => {
		document.querySelector<HTMLButtonElement>(".homepage-showcase-trigger")!.click();
		const frames: { x: number; y: number; opacity: number }[] = [];
		const start = performance.now();
		await new Promise<void>((resolve) => {
			const step = () => {
				const e = document.querySelector<HTMLElement>('[data-test="homepage-showcase"]');
				if (e) {
					const b = e.getBoundingClientRect();
					frames.push({
						x: b.x + b.width / 2,
						y: b.y + b.height / 2,
						opacity: Number(getComputedStyle(e).opacity),
					});
				}
				if (performance.now() - start < 550) requestAnimationFrame(step);
				else resolve();
			};
			requestAnimationFrame(step);
		});
		return frames;
	});
	expect(frames.length).toBeGreaterThan(4);
	expect(frames.some((f) => f.opacity > 0 && f.opacity < 0.99)).toBe(true);
	expect(Math.max(...frames.map((f) => f.x)) - Math.min(...frames.map((f) => f.x))).toBeLessThan(3);
	expect(Math.max(...frames.map((f) => f.y)) - Math.min(...frames.map((f) => f.y))).toBeLessThan(
		30,
	);
	const closing = await page.evaluate(async () => {
		(
			document.querySelector(
				'[data-test="homepage-showcase"] > button:last-child',
			) as HTMLButtonElement
		).click();
		const frames: { opacity: number; hasImage: boolean }[] = [];
		const start = performance.now();
		await new Promise<void>((resolve) => {
			const step = () => {
				const e = document.querySelector<HTMLElement>('[data-test="homepage-showcase"]');
				if (e)
					frames.push({
						opacity: Number(getComputedStyle(e).opacity),
						hasImage: !!e.querySelector(".homepage-showcase-comparison img"),
					});
				if (performance.now() - start < 400) requestAnimationFrame(step);
				else resolve();
			};
			requestAnimationFrame(step);
		});
		return frames;
	});
	expect(closing.some((f) => f.opacity > 0 && f.opacity < 1)).toBe(true);
	expect(closing.every((f) => f.hasImage)).toBe(true);
	await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("birthday artwork rotates slowly, pauses, tracks the displayed variant and opens the real example", async ({
	page,
}) => {
	test.setTimeout(90_000);
	const received = await captureConsentedGrowthEvents(page);
	await page.route("**/api/analytics/events", (route) =>
		route.fulfill({ json: { accepted: true } }),
	);
	await page.goto("/");
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.getByRole("button", { name: "Close previews" }).click();
	const card = page.locator('[data-quick-start="birthday-card"]');
	await card.scrollIntoViewIfNeeded();
	await page.mouse.move(0, 0);
	await expect
		.poll(() =>
			card
				.locator("img")
				.evaluateAll((images) => images.every((img) => (img as HTMLImageElement).naturalWidth > 0)),
		)
		.toBe(true);
	await expect(card).toHaveAttribute("data-homepage-variant", "birthday-portrait");
	await expect(card.locator('[data-active="true"] img')).toHaveAttribute("alt", /smiling woman/);
	// A full reading beat before the eight-second change.
	await page.waitForTimeout(4000);
	await expect(card).toHaveAttribute("data-homepage-variant", "birthday-portrait");
	await expect(card).toHaveAttribute("data-homepage-variant", "birthday-dog", { timeout: 10000 });
	await card.hover();
	await page.waitForTimeout(8500);
	await expect(card).toHaveAttribute("data-homepage-variant", "birthday-dog");
	await card.click();
	await expect
		.poll(() =>
			received.some(
				(event) =>
					event.name === "homepage_idea_selected" &&
					event.properties.homepageVariant === "birthday-dog",
			),
		)
		.toBe(true);
	await page.getByRole("button", { name: "Show birthday portrait", exact: true }).click();
	await expect(card).toHaveAttribute("data-homepage-variant", "birthday-portrait");
	await card.click();
	await expect
		.poll(() =>
			received.some(
				(event) =>
					event.name === "homepage_idea_selected" &&
					event.properties.homepageVariant === "birthday-portrait",
			),
		)
		.toBe(true);
	await expect(page.getByRole("textbox", { name: "Image prompt", exact: true })).toHaveValue(
		/^Create a playful birthday photo card/,
	);
	const example = page.locator('[data-example="birthdayPortrait"]');
	await example.scrollIntoViewIfNeeded();
	await expect(example).toContainText("Made with EzImageAI");
	await expect(example.locator("img")).toHaveAttribute("src", /case-birthday-portrait/);
	await example.getByRole("button").click();
	await expect(page.getByRole("textbox", { name: "Image prompt", exact: true })).toHaveValue(
		/^Create a playful birthday photo card/,
	);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.getByRole("button", { name: "Show dog birthday card", exact: true }).click();
	await expect(card).toHaveAttribute("data-homepage-variant", "birthday-dog");
	await page.getByRole("button", { name: "Play birthday previews", exact: true }).click();
	await page.mouse.move(0, 0);
	await page.getByRole("button", { name: "Pause birthday previews", exact: true }).blur();
	await page.waitForTimeout(8500);
	await expect(card).toHaveAttribute("data-homepage-variant", "birthday-dog");
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await card.screenshot({
		path: path.resolve(
			"../../output/playwright/birthday-card-live-2026-11-13/birthday-dog-mobile.png",
		),
	});
	await page.getByRole("button", { name: "Show birthday portrait", exact: true }).click();
	await card.screenshot({
		path: path.resolve(
			"../../output/playwright/birthday-card-live-2026-11-13/birthday-portrait-mobile.png",
		),
	});
	await page.goto("/examples?lang=de");
	await expect(page.locator('[data-example="birthdayPortrait"]')).toContainText(
		"Mit EzImageAI erstellt",
	);
});

test("homepage idea clicks reach analytics separately from automatic previews and keep creation usable", async ({
	page,
}) => {
	test.setTimeout(75_000);
	await captureConsentedGrowthEvents(page);
	const received: CapturedGrowthEvent[] = [];
	await page.route("**/api/analytics/events", (route) => {
		received.push(route.request().postDataJSON().event);
		return route.fulfill({ json: { accepted: true } });
	});
	await page.route(/https:\/\/(?:www\.)?(?:clarity\.ms|googletagmanager\.com)\//, (route) =>
		route.abort(),
	);
	await page.goto("/");
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	const ideaEvents = () => received.filter((event) => event.name.startsWith("homepage_idea_"));
	expect(ideaEvents()).toHaveLength(0);
	await dialog.getByRole("button", { name: "Vintage portrait", exact: true }).click();
	await dialog.getByRole("button", { name: "Christmas", exact: true }).click();
	await dialog.getByRole("button", { name: "Music video", exact: true }).click();
	await dialog.getByRole("button", { name: "Watercolor", exact: true }).click();
	await expect.poll(() => ideaEvents().length).toBe(4);
	expect(
		ideaEvents().map((event) => [
			event.name,
			event.properties.homepageIdea,
			event.properties.homepagePlacement,
		]),
	).toEqual([
		["homepage_idea_preview_selected", "vintage-photo", "showcase"],
		["homepage_idea_preview_selected", "christmas", "showcase"],
		["homepage_idea_preview_selected", "green-booth-freestyle", "showcase"],
		["homepage_idea_preview_selected", "watercolor", "showcase"],
	]);
	await dialog.getByRole("link", { name: "Try this photo edit" }).click();
	await expect(page.getByRole("textbox", { name: "Image prompt", exact: true })).toHaveValue(
		/^Reinterpret this image/,
	);
	await expect.poll(() => ideaEvents().length).toBe(5);
	expect(ideaEvents()[4]).toMatchObject({
		name: "homepage_idea_selected",
		properties: { homepageIdea: "watercolor", homepagePlacement: "showcase" },
	});
	await page.locator('[data-quick-start="birthday-card"]').click();
	await expect.poll(() => ideaEvents().length).toBe(6);
	expect(ideaEvents()[5]).toMatchObject({
		name: "homepage_idea_selected",
		properties: { homepageIdea: "birthday-card", homepagePlacement: "quick-start" },
	});
	await page.unroute("**/api/analytics/events");
	await page.route("**/api/analytics/events", (route) => route.abort());
	await page.getByRole("button", { name: "Explore new ideas" }).click();
	await dialog.getByRole("button", { name: "Vintage portrait", exact: true }).click();
	await dialog.getByRole("link", { name: "Restyle my portrait" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByRole("textbox", { name: "Image prompt", exact: true })).toHaveValue(
		/^Restyle the uploaded portrait/,
	);
});

test("photo CTA closes smoothly, retains the upload and focuses the image editor from video mode", async ({
	page,
}) => {
	test.setTimeout(75_000);
	await page.goto("/");
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.keyboard.press("Escape");
	await page.locator("#landing-source-image").setInputFiles({
		name: "keep-me.png",
		mimeType: "image/png",
		buffer: Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"base64",
		),
	});
	await page.locator('[data-generator-panel="image"] [data-generator-mode="video"]').click();
	await expect(page.locator('[data-generator-panel="video"]')).toBeVisible();
	await page.getByRole("button", { name: "Explore new ideas" }).click();
	await page.getByRole("link", { name: "Try this photo edit" }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	const prompt = page.getByRole("textbox", { name: "Edit instruction", exact: true });
	await expect(prompt).toHaveValue(/^Reinterpret this image as a soft watercolor/);
	await expect(prompt).toBeFocused();
	await expect(page.getByRole("img", { name: /preview of keep-me/i })).toBeVisible();
	await expect(page).toHaveURL(/\/$/);
});

test("homepage refresh reopens previews and translated photo presets retain their direct Create links", async ({
	page,
}) => {
	test.setTimeout(75_000);
	await page.addInitScript((key) => localStorage.setItem(key, "seen"), HOMEPAGE_SHOWCASE_SEEN_KEY);
	await page.goto("/?lang=de");
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "Vorschau schließen" }).click();
	await expect(dialog).toHaveCount(0);
	await page.reload();
	await page.getByRole("button", { name: "Neue Ideen entdecken" }).waitFor();
	await expect(dialog).toBeVisible();
	await expect(dialog.locator('[data-test="showcase-create"]')).toHaveAttribute(
		"href",
		"/create?lang=de&example=watercolor",
	);
	await page.locator('[data-test="showcase-backdrop"]').click({ position: { x: 3, y: 3 } });
	await expect(dialog).toHaveCount(0);
	await page.goto("/create?lang=de&example=watercolor");
	await expect(page.locator('[data-test="landing-prompt-panel"] textarea')).toHaveValue(
		/^Interpretiere dieses Bild/,
	);
	await expect(page.getByRole("button", { name: "Neue Ideen entdecken" })).toHaveCount(0);
	await page.getByRole("link", { name: "EzImageAI", exact: true }).first().click();
	await expect(dialog).toBeVisible();
});

test("reduced motion disables sweeps and keeps the landscape preview playable after a load error", async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto("/");
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	expect(await dialog.evaluate((e) => e.getAnimations({ subtree: true }).length)).toBe(0);
	for (const name of ["Vintage portrait", "Christmas"]) {
		await dialog.getByRole("button", { name, exact: true }).click();
		expect(await dialog.evaluate((e) => e.getAnimations({ subtree: true }).length)).toBe(0);
	}
	await page.route("**/videos/homepage-showcase/green-booth-freestyle.mp4", (r) => r.abort());
	await dialog.getByRole("button", { name: "Music video", exact: true }).click();
	await expect(dialog.getByRole("button", { name: "Replay preview" })).toBeVisible();
	await expect(dialog.getByRole("link", { name: "Make this video" })).toBeEnabled();
	await page.unroute("**/videos/homepage-showcase/green-booth-freestyle.mp4");
	await dialog.getByRole("button", { name: "Replay preview" }).click();
	await expect
		.poll(() => dialog.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime))
		.toBeGreaterThan(0.5);
});
