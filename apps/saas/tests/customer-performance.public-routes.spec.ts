import { gzipSync } from "node:zlib";

import { expect, type Page, test } from "@playwright/test";

// Browser-only fixtures: no account writes, checkout or provider requests leave this boundary.
async function mockCustomerReads(page: Page, signedIn = false) {
	const reads: string[] = [];
	await page.context().route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
		const reply = (json: unknown) => route.fulfill({ json: { json } });
		if (!url.pathname.startsWith("/api/")) return route.continue();
		reads.push(url.pathname);
		if (url.pathname === "/api/auth/get-session")
			return route.fulfill({
				json: signedIn
					? {
							session: {
								id: "performance-session",
								userId: "performance-owner",
								token: "browser-fixture-only",
								expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
							},
							user: {
								id: "performance-owner",
								name: "Performance Reviewer",
								email: "performance@example.test",
								emailVerified: true,
								isAnonymous: false,
								onboardingComplete: true,
								role: "user",
								image: null,
							},
						}
					: null,
			});
		if (url.pathname === "/api/media/guest-capability")
			return route.fulfill({
				json: {
					version: "performance-fixture",
					enabled: false,
					reason: "disabled",
					products: [],
					upload: { mimeTypes: ["image/png"], maximumBytes: 10_485_760 },
					queueEstimate: { kind: "capacity" },
				},
			});
		if (url.pathname === "/api/rpc/media/getPublicCatalog")
			return reply({ catalogVersion: "fixture", pricingVersion: "fixture", products: [] });
		if (url.pathname === "/api/rpc/notifications/unreadCount") return reply({ count: 0 });
		if (url.pathname === "/api/rpc/notifications/getPreferences") return reply({ disabled: [] });
		if (url.pathname === "/api/rpc/payments/listPurchases") return reply([]);
		if (url.pathname === "/api/rpc/media/listJobs" || url.pathname === "/api/rpc/media/listAssets")
			return reply({ items: [], nextCursor: null });
		if (url.pathname === "/api/rpc/media/getCreditAccount")
			return reply({ spendableCredits: "0", reservedCredits: "0" });
		if (
			url.pathname === "/api/auth/list-accounts" ||
			url.pathname === "/api/auth/list-sessions" ||
			url.pathname === "/api/auth/passkey/list-user-passkeys"
		)
			return route.fulfill({ json: [] });
		return route.fulfill({ status: 503 });
	});
	return reads;
}

function captureScripts(page: Page) {
	const scripts = new Map<string, { gzipBytes: number; source: string }>();
	const pending = new Set<Promise<void>>();
	page.on("response", (response) => {
		if (
			!response.url().includes("/_next/static/") ||
			!response.url().split("?")[0]?.endsWith(".js")
		)
			return;
		const request = response.body().then((body) => {
			scripts.set(new URL(response.url()).pathname, {
				gzipBytes: gzipSync(body).byteLength,
				source: body.toString(),
			});
		});
		pending.add(request);
		void request.finally(() => pending.delete(request)).catch(() => {});
	});
	return {
		scripts,
		async settle() {
			await Promise.all([...pending]);
		},
	};
}

test("history panel production resources and editor continuity", async ({ page }, testInfo) => {
	test.skip(process.env.E2E_USE_PRODUCTION_BUILD !== "true", "Checks actual production chunks");
	await page.setViewportSize({ width: 1440, height: 1000 });
	await mockCustomerReads(page, true);
	const capture = captureScripts(page);
	await page.goto("/create");
	const historyLink = page.locator('.studio-sidebar a[href="/history"]');
	await expect(historyLink).toBeVisible();
	await expect(page.getByRole("button", { name: "Image", exact: true })).toBeVisible();
	await capture.settle();
	const initial = new Set(capture.scripts.keys());
	await historyLink.click();
	const panel = page.getByRole("region", { name: "Your history", exact: true });
	await expect(panel).toBeVisible();
	await expect(panel.getByText("No creations match this filter.")).toBeVisible();
	await capture.settle();
	const additional = [...capture.scripts].filter(([url]) => !initial.has(url));
	const summary = {
		panel: "history",
		addedScriptCount: additional.length,
		addedJavaScriptGzipBytes: additional.reduce((total, [, value]) => total + value.gzipBytes, 0),
		scripts: additional.map(([url, { gzipBytes }]) => ({ url, gzipBytes })),
	};
	console.log("Customer panel resources:", JSON.stringify(summary));
	await testInfo.attach("history-panel-resources.json", {
		body: JSON.stringify(summary, null, 2),
		contentType: "application/json",
	});
	expect(
		summary.addedJavaScriptGzipBytes,
		"A history list must not download every account panel",
	).toBeLessThan(32 * 1024);
	const addedSource = additional.map(([, value]) => value.source).join("\n");
	expect(addedSource).not.toContain("createCreditPackCheckout");
	expect(addedSource).not.toContain("startRegistration");
	await panel.getByRole("button", { name: /close/i }).click();
	await expect(panel).toBeHidden();
	await expect(page.getByRole("button", { name: "Image", exact: true })).toBeVisible();
	await expect(page).toHaveURL(/\/create$/);
});

for (const route of ["/login", "/pricing"]) {
	test(`${route} initial production resources`, async ({ page }, testInfo) => {
		test.skip(process.env.E2E_USE_PRODUCTION_BUILD !== "true", "Checks actual production chunks");
		await mockCustomerReads(page);
		const capture = captureScripts(page);
		await page.goto(route);
		if (route === "/login") await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
		else await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
		await capture.settle();
		const summary = {
			route,
			scriptCount: capture.scripts.size,
			javaScriptGzipBytes: [...capture.scripts.values()].reduce(
				(total, value) => total + value.gzipBytes,
				0,
			),
			scripts: [...capture.scripts].map(([url, { gzipBytes }]) => ({ url, gzipBytes })),
		};
		console.log("Customer page resources:", JSON.stringify(summary));
		await testInfo.attach(`${route.slice(1)}-resources.json`, {
			body: JSON.stringify(summary, null, 2),
			contentType: "application/json",
		});
		if (route === "/login") {
			const initialSource = [...capture.scripts.values()].map(({ source }) => source).join("\n");
			expect(initialSource, "WebAuthn should load on authentication intent").not.toContain(
				"WebAuthn",
			);
		}
	});
}

test("panel intent preloads code without reading private history", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	const reads = await mockCustomerReads(page, true);
	const capture = captureScripts(page);
	await page.goto("/create");
	const historyLink = page.locator('.studio-sidebar a[href="/history"]');
	await expect(historyLink).toBeVisible();
	await capture.settle();
	const scriptCount = capture.scripts.size;
	await historyLink.focus();
	// Wait for intent-triggered static chunks, without activating a private view.
	await expect.poll(() => capture.scripts.size).toBeGreaterThan(scriptCount);
	await capture.settle();
	const historyCalls = () => reads.filter((url) => url === "/api/rpc/media/listJobs");
	await expect.poll(async () => page.locator(".studio-panel").count()).toBe(0);
	expect(historyCalls()).toHaveLength(0);
	await historyLink.press("Enter");
	await expect(page.getByText("No creations match this filter.")).toBeVisible();
	expect(historyCalls()).toHaveLength(1);
});

test("slow panel code can be closed without losing the draft or reopening later", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await mockCustomerReads(page, true);
	await page.goto("/create");
	await page.getByRole("textbox", { name: "Image prompt", exact: true }).fill("Keep this draft");
	const historyLink = page.locator('.studio-sidebar a[href="/history"]');
	await expect(historyLink).toBeVisible();
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	let delayed = 0;
	await page.route("**/_next/static/chunks/*.js", async (route) => {
		delayed++;
		await pending;
		await route.continue();
	});
	try {
		await historyLink.click();
		const panel = page.getByRole("region", { name: "Your history", exact: true });
		await expect(panel.getByRole("status")).toBeVisible();
		await expect.poll(() => delayed).toBeGreaterThan(0);
		await panel.getByRole("button", { name: /close/i }).click();
		await expect(panel).toBeHidden();
		await expect(page.getByRole("textbox", { name: "Image prompt", exact: true })).toHaveValue(
			"Keep this draft",
		);
		release();
		await page.locator('.studio-sidebar a[href="/assets"]').click();
		const assets = page.getByRole("region", { name: "Your assets", exact: true });
		await expect(assets.getByText("No image assets yet.")).toBeVisible();
		await expect(panel).toHaveCount(0);
	} finally {
		release();
	}
});

test("failed panel code has an explicit retry and keeps the editor usable", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await mockCustomerReads(page, true);
	await page.goto("/create");
	const historyLink = page.locator('.studio-sidebar a[href="/history"]');
	await expect(historyLink).toBeVisible();
	let fail = true;
	await page.route("**/_next/static/chunks/*.js", (route) =>
		fail ? route.abort("failed") : route.continue(),
	);
	await historyLink.click();
	const panel = page.getByRole("region", { name: "Your history", exact: true });
	await expect(panel.getByRole("alert")).toBeVisible();
	fail = false;
	await panel.getByRole("button", { name: /retry|try again/i }).click();
	await expect(panel.getByText("No creations match this filter.")).toBeVisible();
	await panel.getByRole("button", { name: /close/i }).click();
	await expect(page.getByRole("textbox", { name: "Image prompt", exact: true })).toBeEditable();
});

test("feedback code loading can be canceled and the dialog can open afterwards", async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await mockCustomerReads(page);
	await page.goto("/create");
	const trigger = page
		.locator('[data-test="feedback-reward-entry"]')
		.getByRole("button", { name: /^Feedback rewards/ });
	await expect(trigger).toBeVisible();
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/_next/static/chunks/*.js", async (route) => {
		await pending;
		await route.continue();
	});
	try {
		await trigger.click();
		await expect(trigger).toHaveAttribute("aria-busy", "true");
		await expect(page.getByRole("button", { name: "Close panel", exact: true })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(trigger).toHaveAttribute("aria-expanded", "false");
		await expect(page.getByRole("dialog")).toHaveCount(0);
		release();
		await trigger.click();
		await expect(page.getByRole("dialog")).toBeVisible();
	} finally {
		release();
	}
});

test("account panels switch independently while the editor draft stays mounted", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await mockCustomerReads(page, true);
	await page.goto("/create");
	const prompt = page.getByRole("textbox", { name: "Image prompt", exact: true });
	await prompt.fill("Keep the account panel draft");
	await page.locator(".studio-sidebar").getByRole("button", { name: "User menu" }).click();
	await page.getByRole("menuitem", { name: "Account settings" }).click();
	let panel = page.getByRole("region", { name: "Account settings", exact: true });
	await expect(panel.getByText("Your name", { exact: true })).toBeVisible();
	await panel.getByRole("button", { name: "Login & security", exact: true }).click();
	panel = page.getByRole("region", { name: "Login & security", exact: true });
	await expect(panel.getByText("Active sessions", { exact: true })).toBeVisible();
	await panel.getByRole("button", { name: "Notifications", exact: true }).click();
	panel = page.getByRole("region", { name: "Notifications", exact: true });
	await expect(panel.getByRole("table").first()).toBeVisible();
	await page.locator(".studio-credit-link").click();
	panel = page.getByRole("region", { name: "Credits & billing", exact: true });
	await expect(panel.getByText("Change your plan", { exact: true })).toBeVisible();
	await panel.getByRole("button", { name: /close/i }).click();
	await expect(prompt).toHaveValue("Keep the account panel draft");
	await expect(page).toHaveURL(/\/create$/);
});
