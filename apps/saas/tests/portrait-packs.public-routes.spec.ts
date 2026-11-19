import { expect, test } from "@playwright/test";

const firstPack = ["red-carpet", "sunhat", "lobby", "surf-club", "disco-silver"];
const nextPack = ["poolside", "cobalt-gallery", "raspberry-satin", "cyan-rain", "golden-coast"];

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

test("a permanent member can swipe to tear a pack and open a second pack on mobile", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.emulateMedia({ reducedMotion: "reduce" });
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
	await page.goto("/portrait-packs");
	const pack = page.getByRole("button", { name: "Open pack", exact: true }).first();
	await expect(pack).toBeEnabled();
	const box = (await pack.boundingBox())!;
	await page.mouse.move(box.x + 10, box.y + box.height / 5);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width - 5, box.y + box.height / 5, { steps: 8 });
	await page.mouse.up();
	await expect(page.getByRole("button", { name: "Red Carpet", exact: true })).toBeVisible();
	expect(await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(
		true,
	);
	await page.getByRole("button", { name: "Open another pack" }).click();
	await page.locator('[data-test="portrait-pack-open"]').click();
	await expect(page.getByRole("button", { name: "Poolside", exact: true })).toBeVisible();
	expect(new Set(requests).size).toBe(2);
});
