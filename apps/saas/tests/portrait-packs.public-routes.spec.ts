import { expect, type Page, test } from "@playwright/test";

const firstPack = ["red-carpet", "sunhat", "lobby", "surf-club", "disco-silver"];
const nextPack = ["poolside", "cobalt-gallery", "raspberry-satin", "cyan-rain", "golden-coast"];

test.beforeEach(async ({ page }) => {
	// Keep this UI fixture on the dedicated mock boundaries below.
	await page.route("**/api/**", (route) => route.fulfill({ status: 404, json: { mocked: true } }));
	await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
	await page.route("**/api/analytics/policy", (route) =>
		route.fulfill({ json: { requiresOptIn: true, privacySignal: false } }),
	);
	await page.route("**/api/analytics/traffic", (route) =>
		route.fulfill({ json: { accepted: true } }),
	);
});

test("standalone draw measures the visible CTA and activation with explicit consent", async ({
	baseURL,
	context,
	page,
}) => {
	await context.addCookies([
		{ name: "consent", value: "true", url: baseURL! },
		{ name: "consent_version", value: "2", url: baseURL! },
	]);
	const observations: unknown[] = [];
	await page.route("**/api/analytics/policy", (route) =>
		route.fulfill({ json: { requiresOptIn: true, privacySignal: false } }),
	);
	await page.route("**/api/analytics/events", (route) => {
		const body = route.request().postDataJSON();
		if (body.event.name === "portrait_pack_observed") {
			expect(body.path).toBe("/portrait-packs");
			observations.push(body.event.properties.portraitPack);
		}
		return route.fulfill({ json: { accepted: true } });
	});
	let allowStatus!: () => void;
	const statusGate = new Promise<void>((resolve) => {
		allowStatus = resolve;
	});
	await page.route("**/api/rpc/portraitPacks/status", async (route) => {
		await statusGate;
		await route.fulfill({ json: { json: { state: "guestTrial", remaining: 2, cards: null } } });
	});
	await page.route("**/api/rpc/portraitPacks/open", (route) =>
		route.fulfill({
			json: {
				json: { state: "guestTrial", remaining: 1, cards: firstPack, opened: true },
			},
		}),
	);
	await page.goto("/portrait-packs");
	try {
		await page.addStyleTag({
			content: '[data-test="portrait-pack-experience"] {margin-top: 120vh}',
		});
	} finally {
		allowStatus();
	}
	const pack = page.getByRole("button", { name: "Open pack", exact: true }).first();
	await expect(pack).toBeEnabled();
	expect(observations).toEqual([]);
	await pack.scrollIntoViewIfNeeded();
	const impression = { placement: "public-page", cta: "draw", stage: "impression" };
	await expect.poll(() => observations).toEqual([impression]);
	await pack.click();
	await expect(page.locator('[data-test="portrait-pack-cards"]')).toBeVisible();
	await expect.poll(() => observations).toEqual([impression, { ...impression, stage: "clicked" }]);
	await page.getByRole("button", { name: "Open another pack" }).click();
	await page.locator('[data-test="portrait-pack-open"]').click();
	await expect(page.locator('[data-test="portrait-pack-cards"]')).toBeVisible();
	expect(observations).toHaveLength(2);
});

test("guest opens two five-card packs and can sign in for two more", async ({ page }) => {
	let opened = 0;
	await page.route("**/api/rpc/portraitPacks/status", (route) =>
		route.fulfill({
			json: {
				json: {
					state: opened === 2 ? "guestUsed" : "guestTrial",
					remaining: 2 - opened,
					cards: opened === 2 ? nextPack : opened ? firstPack : null,
				},
			},
		}),
	);
	await page.route("**/api/rpc/portraitPacks/open", async (route) => {
		expect(Object.keys(route.request().postDataJSON().json)).toEqual(["requestId"]);
		opened++;
		await route.fulfill({
			json: {
				json: {
					state: opened === 2 ? "guestUsed" : "guestTrial",
					remaining: 2 - opened,
					cards: opened === 2 ? nextPack : firstPack,
					opened: true,
				},
			},
		});
	});
	await page.goto("/portrait-packs");
	await expect(page.getByRole("heading", { name: "Portrait Packs" })).toBeVisible();
	await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/portrait-packs$/);
	await page.locator('[data-test="portrait-pack-open"]').click();
	const cards = page.locator('[data-test="portrait-pack-cards"]');
	await expect(cards.getByRole("button")).toHaveCount(5);
	await expect
		.poll(() =>
			cards
				.locator("img")
				.evaluateAll((images) =>
					images.every((image) => (image as HTMLImageElement).naturalWidth === 339),
				),
		)
		.toBe(true);
	await cards.getByRole("button", { name: "Sunhat" }).click();
	await expect(page.getByRole("link", { name: "Save image" })).toHaveAttribute(
		"download",
		"sunhat.webp",
	);
	await page.getByRole("button", { name: "Back to cards" }).click();
	await expect(page.getByText("1 free guest pack left")).toBeVisible();
	await page.getByRole("button", { name: "Open another pack" }).click();
	await page.locator('[data-test="portrait-pack-open"]').click();
	await expect(page.getByRole("link", { name: "Sign in for 2 free packs" })).toHaveAttribute(
		"href",
		"/login?redirectTo=%2Fportrait-packs",
	);
	await page.reload();
	await expect(cards.getByRole("button")).toHaveCount(5);
	await expect(page.locator('[data-test="portrait-pack-open"]')).toHaveCount(0);
});

async function mockUnlimitedPacks(page: Page) {
	await page.route("**/api/rpc/portraitPacks/status", (route) =>
		route.fulfill({ json: { json: { state: "unlocked", remaining: null, cards: null } } }),
	);
	const requests: string[] = [];
	await page.route("**/api/rpc/portraitPacks/open", (route) => {
		requests.push(route.request().postDataJSON().json.requestId);
		return route.fulfill({
			json: {
				json: {
					state: "unlocked",
					remaining: null,
					cards: requests.length === 1 ? firstPack : nextPack,
					opened: true,
				},
			},
		});
	});
	return requests;
}

test.describe("390px touch opening", () => {
	test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

	test("lets the page scroll, previews a reversible tear and deals five legible cards", async ({
		page,
	}, testInfo) => {
		const requests = await mockUnlimitedPacks(page);
		await page.goto("/portrait-packs");
		const experience = page.locator('[data-test="portrait-pack-experience"]');
		const pack = page.locator('[data-test="portrait-pack-foil"]');
		await expect(pack).toBeEnabled();
		await pack.scrollIntoViewIfNeeded();
		await experience.screenshot({
			path: testInfo.outputPath("portrait-foil-mobile-ready.png"),
			animations: "disabled",
		});
		const cdp = await page.context().newCDPSession(page);
		const box = (await pack.boundingBox())!;
		const x = Math.round(box.x + box.width * 0.09);
		const y = Math.round(box.y + box.height * 0.29);
		const send = (type: "touchStart" | "touchMove" | "touchEnd", x?: number, y?: number) =>
			cdp.send("Input.dispatchTouchEvent", {
				type,
				touchPoints: x === undefined ? [] : [{ x, y: y! }],
			});
		const progress = () =>
			pack.evaluate((element) => Number(element.style.getPropertyValue("--tear-progress")));

		const scroll = await page.evaluate(() => window.scrollY);
		await send("touchStart", x + 30, y + 90);
		for (const step of [15, 32, 50, 75, 95]) await send("touchMove", x + 30, y + 90 - step);
		await send("touchEnd");
		await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scroll);
		expect(requests).toHaveLength(0);

		await pack.scrollIntoViewIfNeeded();
		const updated = (await pack.boundingBox())!;
		const left = Math.round(updated.x + updated.width * 0.09);
		const seam = Math.round(updated.y + updated.height * 0.29);
		await send("touchStart", left, seam);
		for (const step of [0.08, 0.17, 0.29])
			await send("touchMove", left + Math.round(updated.width * step), seam);
		await expect.poll(progress).toBeGreaterThan(0.2);
		await experience.screenshot({
			path: testInfo.outputPath("portrait-foil-mobile-partial-tear.png"),
			animations: "disabled",
		});
		await send("touchEnd");
		await expect.poll(progress).toBe(0);
		expect(requests).toHaveLength(0);

		await send("touchStart", left, seam);
		for (const step of [0.1, 0.25, 0.42, 0.58, 0.76])
			await send("touchMove", left + Math.round(updated.width * step), seam);
		await send("touchEnd");
		const cards = page.locator('[data-test="portrait-pack-cards"]');
		await expect(cards.getByRole("button")).toHaveCount(5);
		await expect(cards.locator('[data-featured="true"]')).toHaveCount(1);
		expect(requests).toHaveLength(1);
		await expect
			.poll(() =>
				cards
					.locator("img")
					.evaluateAll((images) =>
						images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
					),
			)
			.toBe(true);
		await experience.screenshot({
			path: testInfo.outputPath("portrait-foil-mobile-reveal.png"),
			animations: "disabled",
		});
		expect(
			await cards.locator('[data-test="portrait-pack-card-label"]').evaluateAll((labels) => {
				const boxes = labels.map((label) => label.getBoundingClientRect());
				return labels.every((label, index) => {
					const box = boxes[index]!;
					const next = boxes[index + 1];
					return (
						box.left >= 0 &&
						box.right <= window.innerWidth &&
						(!next || box.right <= next.left + 1) &&
						label.scrollWidth <= label.clientWidth
					);
				});
			}),
		).toBe(true);
		expect(
			await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth),
		).toBe(true);
	});
});

test("desktop keyboard opens once and the card light follows the pointer", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 1280, height: 940 });
	const requests = await mockUnlimitedPacks(page);
	await page.goto("/portrait-packs");
	const experience = page.locator('[data-test="portrait-pack-experience"]');
	const pack = page.locator('[data-test="portrait-pack-foil"]');
	await expect(pack).toBeEnabled();
	await experience.screenshot({
		path: testInfo.outputPath("portrait-foil-desktop-ready.png"),
		animations: "disabled",
	});
	await pack.press("Enter");
	const cards = page.locator('[data-test="portrait-pack-cards"]');
	const first = cards.getByRole("button").first();
	await expect(cards.getByRole("button")).toHaveCount(5);
	await expect(first).toBeFocused();
	expect(requests).toHaveLength(1);
	await expect
		.poll(() =>
			cards
				.locator("img")
				.evaluateAll((images) =>
					images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
				),
		)
		.toBe(true);
	await experience.screenshot({
		path: testInfo.outputPath("portrait-foil-desktop-reveal.png"),
		animations: "disabled",
	});
	await first.hover({ position: { x: 32, y: 40 } });
	await expect
		.poll(() => first.evaluate((element) => element.style.getPropertyValue("--foil-x")))
		.toMatch(/%$/);
	await page.mouse.move(2, 2);
	await expect
		.poll(() => first.evaluate((element) => element.style.getPropertyValue("--foil-x")))
		.toBe("");
});

test("reduced motion reveals without a flourish and allows a second pack", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	const requests = await mockUnlimitedPacks(page);
	await page.goto("/portrait-packs");
	await page.locator('[data-test="portrait-pack-open"]').click();
	const cards = page.locator('[data-test="portrait-pack-cards"]');
	await expect(cards.getByRole("button")).toHaveCount(5);
	await expect(cards).not.toHaveAttribute("data-animate", "true");
	await page.getByRole("button", { name: "Open another pack" }).click();
	await page.locator('[data-test="portrait-pack-open"]').click();
	await expect(page.getByRole("button", { name: "Poolside", exact: true })).toBeVisible();
	expect(new Set(requests).size).toBe(2);
});
