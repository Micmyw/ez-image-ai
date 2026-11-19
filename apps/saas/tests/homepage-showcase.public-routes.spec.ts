import path from "node:path";

import { devices, expect, test, type Page } from "@playwright/test";

import {
	HOMEPAGE_SHOWCASE_COMPACT_COMPARISON,
	HOMEPAGE_SHOWCASE_DELAY_MS,
	HOMEPAGE_SHOWCASE_KEYS,
	HOMEPAGE_SHOWCASE_MEDIA,
	HOMEPAGE_SHOWCASE_SEEN_KEY,
} from "../modules/landing/lib/homepage-showcase";
import { captureConsentedGrowthEvents, type CapturedGrowthEvent } from "./growth-events";

const { before, poster } = HOMEPAGE_SHOWCASE_MEDIA[HOMEPAGE_SHOWCASE_KEYS[0]];
const firstComparison: string[] = [before, poster].sort();
const compactComparison: string[] = Object.values(HOMEPAGE_SHOWCASE_COMPACT_COMPARISON).sort();
const allComparisonSources = [...firstComparison, ...compactComparison];
const showcaseSelector = '[data-test="homepage-showcase"]';
const enhancedShowcaseSelector = `${showcaseSelector}[data-showcase-enhanced]`;
const nextChunks = /\/_next\/static\/[^?]+\.js(?:\?.*)?$/;
const nextStylesheets = /\/_next\/static\/[^?]+\.css(?:\?.*)?$/;

async function holdRequests(page: Page, url: string | RegExp) {
	const ready = Promise.withResolvers<void>();
	await page.route(url, async (route) => {
		await ready.promise;
		await route.continue();
	});
	return ready.resolve;
}

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

for (const { device, viewport, original, sources } of [
	{
		device: "desktop",
		viewport: { width: 1440, height: 900 },
		original: before,
		sources: firstComparison,
	},
	{
		device: "mobile",
		viewport: { width: 390, height: 844 },
		original: HOMEPAGE_SHOWCASE_COMPACT_COMPARISON.before,
		sources: compactComparison,
	},
]) {
	test.describe(`${device} startup`, () => {
		const { deviceScaleFactor, hasTouch, isMobile, userAgent } = devices["Pixel 7"];
		test.use(
			device === "mobile"
				? { viewport, deviceScaleFactor, hasTouch, isMobile, userAgent }
				: { viewport },
		);
		test(`paints the first ${device} showcase comparison before hydration and requests each photo once`, async ({
			page,
		}) => {
			test.setTimeout(75_000);
			await page.emulateMedia({ reducedMotion: "reduce" });
			const requests: string[] = [];
			page.on("request", (request) => {
				if (request.method() === "GET") requests.push(new URL(request.url()).pathname);
			});
			const comparisonRequests = () =>
				requests.filter((url) => allComparisonSources.includes(url)).sort();
			const releaseStylesheets = await holdRequests(page, nextStylesheets);
			const releaseChunks = await holdRequests(page, nextChunks);
			const dialog = page.locator(showcaseSelector);
			const photos = dialog.locator(".homepage-showcase-comparison img");
			const close = dialog.getByRole("button", { name: "Close previews", exact: true });

			try {
				await page.goto("/?utm_source=showcase-check", { waitUntil: "commit" });
				await expect.poll(() => requests.some((url) => nextStylesheets.test(url))).toBe(true);
				await expect
					.poll(comparisonRequests, {
						message: "the original photo should be requested while CSS is blocked",
					})
					.toContain(original);
				releaseStylesheets();
				await expect.poll(comparisonRequests).toEqual(sources);
				await expect(dialog).toBeVisible();
				await expect(page.locator(enhancedShowcaseSelector)).toHaveCount(0);
				for (const href of sources) {
					await expect(
						page.locator(`link[rel="preload"][as="image"][href="${href}"]`),
					).toHaveAttribute("fetchpriority", "high");
				}
				await expect(photos).toHaveCount(2);
				for (const photo of await photos.all()) await expect(photo).toBeInViewport({ ratio: 0.4 });
				await expect
					.poll(() =>
						photos.evaluateAll((images) =>
							images
								.filter(
									(image): image is HTMLImageElement =>
										image instanceof HTMLImageElement &&
										image.complete &&
										image.naturalWidth > 0 &&
										image.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
								)
								.map((image) => new URL(image.currentSrc).pathname)
								.sort(),
						),
					)
					.toEqual(sources);
				await expect(dialog.getByRole("heading")).toHaveText("Your photo, painted differently.");
				await close.focus();
				await expect(close).toBeFocused();
				const shownBeforeHydration = await dialog.elementHandle();

				releaseChunks();
				await expect(page.locator(enhancedShowcaseSelector)).toBeVisible();
				expect(
					await dialog.evaluate((node, previous) => node === previous, shownBeforeHydration),
				).toBe(true);
				await expect(close).toBeFocused();
			} finally {
				releaseStylesheets();
				releaseChunks();
			}

			const images = dialog.locator(
				".homepage-showcase-comparison img, .homepage-showcase-picker img",
			);
			await expect(images).toHaveCount(2 + HOMEPAGE_SHOWCASE_KEYS.length);
			await expect
				.poll(() =>
					images.evaluateAll((items) =>
						items.every((item) => item instanceof HTMLImageElement && item.naturalWidth > 0),
					),
				)
				.toBe(true);
			expect(comparisonRequests()).toEqual(sources);
			for (const key of HOMEPAGE_SHOWCASE_KEYS.slice(1)) {
				const media = HOMEPAGE_SHOWCASE_MEDIA[key];
				expect(requests).toContain(media.thumbnail);
				expect(requests).not.toContain(media.poster);
				if ("before" in media) expect(requests).not.toContain(media.before);
				if ("images" in media) {
					for (const image of media.images) expect(requests).not.toContain(image);
				}
				if ("video" in media) expect(requests).not.toContain(media.video);
			}
			await dialog.getByRole("button", { name: "Vintage portrait", exact: true }).click();
			await expect(dialog.locator('[data-test="showcase-create"]')).toHaveAttribute(
				"href",
				"/create?example=vintage-photo",
			);
		});
	});
}

test("paints the original with the edited photo and Next.js still pending", async ({ page }) => {
	test.setTimeout(75_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	const requests: string[] = [];
	page.on("request", (request) => {
		const pathname = new URL(request.url()).pathname;
		if (request.method() === "GET" && allComparisonSources.includes(pathname)) {
			requests.push(pathname);
		}
	});
	const releaseChunks = await holdRequests(page, nextChunks);
	const releaseEdited = await holdRequests(page, `**${poster}`);
	const dialog = page.locator(showcaseSelector);
	const comparison = dialog.locator(".homepage-showcase-comparison");
	const original = comparison.locator('img[data-showcase-source="before"]');
	const edited = comparison.locator('img[data-showcase-source="poster"]');
	const slider = dialog.getByRole("slider", { name: "Drag to compare" });
	try {
		await page.goto("/", { waitUntil: "commit" });
		await expect.poll(() => [...requests].sort()).toEqual(firstComparison);
		await expect(dialog).toBeVisible();
		await expect(page.locator(enhancedShowcaseSelector)).toHaveCount(0);
		await expect(original).toHaveAttribute("src", before);
		await expect(original).toBeInViewport({ ratio: 0.9 });
		await expect
			.poll(() =>
				original.evaluate(
					(image: HTMLImageElement) =>
						image.complete &&
						image.naturalWidth > 0 &&
						image.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
				),
			)
			.toBe(true);
		await expect(edited).toBeHidden();
		await expect(slider).toBeHidden();

		releaseChunks();
		await expect(page.locator(enhancedShowcaseSelector)).toBeVisible();
		await expect(original).toBeInViewport({ ratio: 0.9 });
		await expect(edited).toBeHidden();
		await expect(slider).toBeHidden();

		releaseEdited();
		await expect(edited).toBeVisible();
		await expect
			.poll(() => edited.evaluate((image: HTMLImageElement) => image.naturalWidth))
			.toBeGreaterThan(0);
		await expect(slider).toBeVisible();
		await slider.focus();
		await page.keyboard.press("End");
		await expect(slider).toHaveValue("100");
		await expect(comparison).toHaveCSS("--showcase-position", "100%");
		await page.keyboard.press("Home");
		await expect(slider).toHaveValue("0");
		await expect(comparison).toHaveCSS("--showcase-position", "0%");
		expect([...requests].sort()).toEqual(firstComparison);
	} finally {
		releaseChunks();
		releaseEdited();
	}
});

for (const action of ["close button", "Escape"] as const) {
	test(`dismisses the early showcase with ${action} and stays closed through hydration`, async ({
		page,
	}) => {
		test.setTimeout(75_000);
		await page.clock.install();
		const releaseChunks = await holdRequests(page, nextChunks);
		const dialog = page.locator(showcaseSelector);
		const trigger = page.getByRole("button", { name: "Explore new ideas", exact: true });
		try {
			await page.goto("/", { waitUntil: "commit" });
			await expect(dialog).toBeVisible();
			await expect(page.locator(enhancedShowcaseSelector)).toHaveCount(0);
			await expect(page.locator("button.homepage-showcase-trigger")).toBeAttached();
			if (action === "Escape") await page.keyboard.press("Escape");
			else await dialog.getByRole("button", { name: "Close previews", exact: true }).click();
			await expect(dialog).toBeHidden();
			await expect(trigger).toBeFocused();
		} finally {
			releaseChunks();
		}

		await expect(page.locator(enhancedShowcaseSelector)).toBeAttached();
		await page.clock.runFor(HOMEPAGE_SHOWCASE_DELAY_MS + 500);
		await expect(dialog).toBeHidden();
		await expect(trigger).toBeFocused();
		await trigger.click();
		await expect(
			dialog.getByRole("button", { name: "Vintage portrait", exact: true }),
		).toBeVisible();
	});
}

test("the automatic showcase waits while a privacy choice has focus", async ({ page, context }) => {
	test.setTimeout(75_000);
	await page.clock.install();
	await page.route("**/api/analytics/policy", (route) =>
		route.fulfill({ json: { requiresOptIn: true, privacySignal: false, analyticsAllowed: false } }),
	);
	const releaseOriginal = await holdRequests(page, `**${before}`);
	const originalResponse = page.waitForResponse(`**${before}`);
	const dialog = page.locator(showcaseSelector);
	const banner = page.getByRole("region", { name: "We value your privacy", exact: true });
	const reject = banner.getByRole("button", { name: "Reject non-essential", exact: true });
	try {
		await page.goto("/", { waitUntil: "domcontentloaded" });
		await expect(reject).toBeVisible();
		await reject.focus();
		await expect(reject).toBeFocused();
		releaseOriginal();
		expect(await (await originalResponse).finished()).toBeNull();
		await page.clock.runFor(HOMEPAGE_SHOWCASE_DELAY_MS + 500);
		await expect(dialog).toBeHidden();
		await expect(reject).toBeFocused();
		await reject.click();
		await expect(dialog).toBeVisible();
		await expect(banner).toHaveCount(0);
		expect((await context.cookies()).find((cookie) => cookie.name === "consent")?.value).toBe(
			"false",
		);
	} finally {
		releaseOriginal();
	}
});

test("the automatic showcase waits until focus leaves the mobile navigation drawer and opener", async ({
	page,
}) => {
	test.setTimeout(75_000);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.clock.install();
	const releaseOriginal = await holdRequests(
		page,
		`**${HOMEPAGE_SHOWCASE_COMPACT_COMPARISON.before}`,
	);
	const preview = page.locator(showcaseSelector);
	const navigation = page.getByRole("button", { name: "Open navigation", exact: true });
	const drawer = page.locator('[data-test="header-navigation-drawer"]');
	try {
		await page.goto("/", { waitUntil: "domcontentloaded" });
		await expect(page.locator(enhancedShowcaseSelector)).toBeAttached();
		// Hold the drawer bundle after the homepage controls have hydrated.
		const releaseDrawer = await holdRequests(page, nextChunks);
		try {
			await navigation.click();
			await expect(navigation).toHaveAttribute("aria-expanded", "true");
			await expect(drawer).toBeHidden();
			releaseOriginal();
			await preview
				.locator('img[data-showcase-source="before"]')
				.evaluate((image: HTMLImageElement) => image.decode());
			await page.clock.runFor(HOMEPAGE_SHOWCASE_DELAY_MS + 500);
			await expect(preview).toBeHidden();
			await expect(navigation).toHaveAttribute("aria-expanded", "true");
		} finally {
			releaseDrawer();
		}

		await expect(drawer).toBeVisible();
		const images = drawer.locator("summary").filter({ hasText: "AI Image" });
		await images.click();
		await page.clock.runFor(500);
		await expect(preview).toBeHidden();
		await expect(images).toBeFocused();
		await expect(drawer.locator('a[href="/image-to-image"]')).toBeVisible();
		await drawer.getByRole("button", { name: "Close", exact: true }).click();
		await expect(drawer).toBeHidden();
		await expect(navigation).toBeFocused();
		await page.clock.runFor(500);
		await expect(preview).toBeHidden();
		await expect(navigation).toBeFocused();
		await page.getByRole("heading", { level: 1 }).click();
		await expect(preview).toBeVisible();
	} finally {
		releaseOriginal();
	}
});

test("the automatic showcase leaves keyboard focus in the language menu and on its opener", async ({
	page,
}) => {
	test.setTimeout(75_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.clock.install();
	const releaseOriginal = await holdRequests(page, `**${before}`);
	const preview = page.locator(showcaseSelector);
	const language = page.getByRole("button", { name: "Language", exact: true });
	const menu = page.getByRole("menu");
	try {
		await page.goto("/", { waitUntil: "domcontentloaded" });
		await expect(page.locator(enhancedShowcaseSelector)).toBeAttached();
		const releaseMenu = await holdRequests(page, nextChunks);
		try {
			await expect(preview).toBeHidden();
			await expect(language).toBeVisible();
			await language.focus();
			await expect(language).toBeFocused();
			await page.keyboard.press("ArrowDown");
			await expect(language).toHaveAttribute("aria-busy", "true");
			await expect(menu).toBeHidden();
			releaseOriginal();
			await preview
				.locator('img[data-showcase-source="before"]')
				.evaluate((image: HTMLImageElement) => image.decode());
			await page.clock.runFor(HOMEPAGE_SHOWCASE_DELAY_MS + 500);
			await expect(preview).toBeHidden();
			await expect(language).toBeFocused();
		} finally {
			releaseMenu();
		}

		await expect(menu.getByRole("menuitemradio", { name: "English", exact: true })).toBeFocused();
		await page.keyboard.press("ArrowDown");
		const german = menu.getByRole("menuitemradio", { name: "Deutsch", exact: true });
		await page.clock.runFor(500);
		await expect(preview).toBeHidden();
		await expect(german).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();
		await expect(language).toBeFocused();
		await page.clock.runFor(500);
		await expect(preview).toBeHidden();
		await expect(language).toBeFocused();
		await page.getByRole("heading", { level: 1 }).click();
		await expect(preview).toBeVisible();
	} finally {
		releaseOriginal();
	}
});

test("leaves workspace, recovery and anchor links free of automatic previews and image requests", async ({
	page,
}) => {
	test.setTimeout(75_000);
	await page.clock.install();
	const requests: string[] = [];
	page.on("request", (request) => requests.push(new URL(request.url()).pathname));
	for (const href of [
		"/create",
		"/?job=example",
		"/?videoJob=example",
		"/?mode=video",
		"/?reuseJob=example",
		"/#image-editor",
	]) {
		await test.step(href, async () => {
			await page.goto(href);
			await page.clock.runFor(HOMEPAGE_SHOWCASE_DELAY_MS + 500);
			await expect(page.locator(showcaseSelector)).toBeHidden();
			for (const photo of allComparisonSources) {
				await expect(page.locator(`link[rel="preload"][as="image"][href="${photo}"]`)).toHaveCount(
					0,
				);
			}
			expect(requests.filter((url) => allComparisonSources.includes(url))).toEqual([]);
		});
	}
});

for (const href of ["/#image-editor", "/?job=example", "/create"]) {
	test(`rechecks ${href} before showing a scheduled homepage preview`, async ({ page }) => {
		test.setTimeout(75_000);
		const now = new Date();
		await page.clock.install({ time: now });
		await page.clock.pauseAt(new Date(now.getTime() + 60_000));
		const photosRequested: string[] = [];
		page.on("requestfinished", (request) => {
			const pathname = new URL(request.url()).pathname;
			if (firstComparison.includes(pathname)) photosRequested.push(pathname);
		});
		const releaseChunks = await holdRequests(page, nextChunks);
		const dialog = page.locator(showcaseSelector);
		try {
			await page.goto("/", { waitUntil: "commit" });
			await expect.poll(() => [...photosRequested].sort()).toEqual(firstComparison);
			await expect(dialog.locator(`img[src="${poster}"]`)).toBeAttached();
			await expect(dialog).toBeHidden();
			await page.evaluate((path) => history.replaceState(history.state, "", path), href);
			await page.clock.runFor(HOMEPAGE_SHOWCASE_DELAY_MS + 500);
			await expect(dialog).toBeHidden();
		} finally {
			releaseChunks();
			await page.clock.resume();
		}
		await page.waitForLoadState();
		await page.clock.runFor(HOMEPAGE_SHOWCASE_DELAY_MS + 500);
		await expect(dialog).toBeHidden();
	});
}

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
		await expect(page.locator(enhancedShowcaseSelector)).toBeVisible();
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
	await expect(page.locator(enhancedShowcaseSelector)).toBeVisible();
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
				const e = document.querySelector<HTMLElement>('[data-test="homepage-showcase"][open]');
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
				const e = document.querySelector<HTMLElement>('[data-test="homepage-showcase"][open]');
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
	await page.mouse.click(3, 3);
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
