import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
	await page.route("**/api/media/guest-capability", async (route) => {
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				version: "landing-e2e-v1",
				enabled: true,
				reason: null,
				upload: {
					mimeTypes: ["image/jpeg", "image/png", "image/webp"],
					maximumBytes: 10 * 1024 * 1024,
				},
				product: { key: "image-fast", label: "Standard Edit", credits: "4" },
				queueEstimate: { kind: "capacity" },
			}),
		});
	});
});

test("the public root exposes the image editor before authentication", async ({ page }) => {
	const separateServiceRequests: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (["localhost", "127.0.0.1"].includes(url.hostname) && url.port === "3001") {
			separateServiceRequests.push(request.url());
		}
	});

	await page.goto("/");

	await expect(page).toHaveURL(/\/$/);
	await expect(page).toHaveTitle(/EzPic AI Image Editor/i);
	const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
	expect(canonical).not.toBeNull();
	expect(new URL(canonical!).origin).toBe(new URL(page.url()).origin);
	await expect(
		page.getByRole("heading", {
			level: 1,
			name: /ai image editor with prompts/i,
		}),
	).toBeVisible();
	await expect(page.getByLabel(/source image/i)).toBeAttached();
	await expect(
		page.getByRole("button", { name: /drop an image here or choose a file/i }),
	).toBeVisible();
	await expect(page.getByLabel(/describe your edit/i)).toBeVisible();
	await expect(page.getByRole("button", { name: /try one standard edit free/i })).toBeVisible();
	await expect(page.getByRole("banner").getByRole("link", { name: /sign in/i })).toHaveAttribute(
		"href",
		"/login",
	);
	expect(
		await page
			.locator("main section[id]")
			.evaluateAll((sections) => sections.map((section) => section.id)),
	).toEqual(["image-editor", "before-after", "examples", "how-it-works", "pricing", "faq"]);
	await expect(page.locator("body")).not.toContainText(
		/raphael|providerModelId|providerCostMicros/i,
	);
	expect(separateServiceRequests).toEqual([]);
});

test("the landing page proves edits with an interactive comparison and visual examples", async ({
	page,
}) => {
	await page.goto("/");

	const comparison = page.getByRole("slider", {
		name: /compare original and edited illustration/i,
	});
	await expect(comparison).toBeVisible();
	await expect(comparison).toHaveValue("52");

	await page.getByRole("button", { name: /show original/i }).click();
	await expect(comparison).toHaveValue("0");
	await page.getByRole("button", { name: /show edit direction/i }).click();
	await expect(comparison).toHaveValue("100");
	await comparison.fill("36");
	await expect(comparison).toHaveValue("36");

	const examples = page.locator("#examples article");
	await expect(examples).toHaveCount(6);
	await expect(page.locator("#examples img")).toHaveCount(6);
	expect(
		await page
			.locator("#examples img")
			.evaluateAll((images) =>
				images.every((image) => image instanceof HTMLImageElement && image.naturalWidth > 0),
			),
	).toBe(true);

	const prompt = page.getByLabel(/describe your edit/i);
	await page.getByRole("button", { name: /use the mediterranean quiet prompt/i }).click();
	await expect(prompt).toHaveValue(/sunlit mediterranean retreat/i);
	await expect(prompt).toBeFocused();
});

test("the landing tool stays usable at desktop and narrow mobile widths", async ({
	page,
}, testInfo) => {
	for (const viewport of [
		{ width: 1440, height: 1000 },
		{ width: 390, height: 844 },
		{ width: 320, height: 800 },
	]) {
		await page.setViewportSize(viewport);
		await page.goto("/");
		await expect(page.getByLabel(/describe your edit/i)).toBeVisible();
		await expect(
			page.getByRole("button", { name: /drop an image here or choose a file/i }),
		).toBeVisible();
		await expect(page.getByRole("button", { name: /try one standard edit free/i })).toBeVisible();
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
			`${viewport.width}px horizontal overflow`,
		).toBe(true);
		await testInfo.attach(`landing-${viewport.width}`, {
			body: await page.screenshot({ fullPage: true }),
			contentType: "image/png",
		});
	}
});
