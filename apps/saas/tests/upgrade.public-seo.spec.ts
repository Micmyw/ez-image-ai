import { expect, test, type Page } from "@playwright/test";

type BillingFixtures = {
	registered?: boolean;
	pending?: boolean;
	unavailable?: boolean;
	subscribed?: boolean;
};

async function mockBilling(page: Page, options: BillingFixtures = {}) {
	await page.context().addCookies([
		{
			name: "consent",
			value: "false",
			url: process.env.NEXT_PUBLIC_SAAS_URL ?? "http://localhost:3000",
		},
	]);
	await page.route("**/api/auth/get-session**", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: JSON.stringify(
				options.registered === false
					? null
					: {
							session: {
								id: "checkout-ui-session",
								userId: "checkout-ui-user",
								expiresAt: "2099-01-01T00:00:00.000Z",
							},
							user: {
								id: "checkout-ui-user",
								name: "Preview Creator",
								email: "checkout-ui@example.invalid",
								role: "user",
								emailVerified: true,
								onboardingComplete: true,
								isAnonymous: false,
							},
						},
			),
		}),
	);
	await page.route("**/api/rpc/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		let json: unknown;
		if (path.endsWith("getCreditAccount"))
			json = { spendableCredits: "1250", reservedCredits: "0", creditDebt: "0", version: 1 };
		else if (
			path.endsWith("getProviderAvailability") ||
			path.endsWith("getCreditPackProviderAvailability")
		)
			json = {
				providers: options.unavailable
					? []
					: [
							{ name: "paypal", capabilities: { checkout: true } },
							{ name: "waffo", capabilities: { checkout: true } },
						],
			};
		else if (path.endsWith("listPurchases"))
			json = options.subscribed
				? [
						{
							id: "existing",
							productKind: "PLAN",
							type: "SUBSCRIPTION",
							provider: "paypal",
							status: "active",
							planId: "creator",
							planPrice: { type: "subscription", amount: 19, currency: "USD", interval: "month" },
							isEffectiveSubscription: true,
							subscription: { cancelAtPeriodEnd: false, currentPeriodEnd: null },
						},
					]
				: [];
		else if (path.endsWith("getPendingSubscriptionCheckout"))
			json = options.pending
				? {
						id: "pending-1",
						provider: "paypal",
						planId: "creator",
						interval: "year",
						checkoutLink: "https://checkout.example.invalid/pending",
					}
				: null;
		else if (path.endsWith("unreadCount")) json = { count: 0 };
		else if (path.endsWith("getPublicCatalog")) json = { products: [] };
		else if (path.endsWith("createCheckoutLink") || path.endsWith("createCreditPackCheckout"))
			throw new Error("Test must intercept checkout; never call a real payment provider");
		else
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ json: [] }),
			});
		await route.fulfill({ contentType: "application/json", body: JSON.stringify({ json }) });
	});
	await page.route("**/api/media/guest-capability", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({ enabled: false, products: [], reason: "GUEST_ENVIRONMENT_DISABLED" }),
		}),
	);
}

test("header shows real available credits and opens the upgrade picker at desktop and mobile widths", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await mockBilling(page);
	await page.goto("/");
	await expect(page.locator('[data-test="header-credits"]')).toHaveText("1,250");
	for (const viewport of [
		{ width: 1440, height: 900 },
		{ width: 1280, height: 720 },
		{ width: 1024, height: 768 },
		{ width: 768, height: 900 },
		{ width: 390, height: 844 },
		{ width: 320, height: 720 },
	]) {
		const { width } = viewport;
		await page.setViewportSize(viewport);
		await expect(page.locator('[data-test="header-upgrade"]')).toBeVisible();
		await expect(page.getByRole("button", { name: "Language", exact: true })).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		await page.screenshot({ path: test.info().outputPath(`header-${width}.png`) });
		await page.locator('[data-test="header-upgrade"]').click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog.locator('input[value="ultimate"]')).toBeChecked();
		await expect(dialog.locator('[data-test="subscription-checkout"]')).toBeEnabled();
		await expect(dialog.locator('[data-test="subscription-checkout"]')).toBeInViewport({
			ratio: 1,
		});
		await expect(dialog.locator('[data-test="checkout-selection"]')).toHaveText(
			"Ultimate$490.00/year",
		);
		await expect
			.poll(() => dialog.evaluate((element) => element.scrollWidth <= element.clientWidth))
			.toBe(true);
		await expect
			.poll(() =>
				dialog.evaluate(
					(element) =>
						element.getAnimations().filter((animation) => animation.playState === "running").length,
				),
			)
			.toBe(0);
		await page.screenshot({ path: test.info().outputPath(`upgrade-${width}.png`) });
		if (width < 480) {
			await dialog.locator('input[value="studio"]').check();
			await expect(dialog.locator('input[value="studio"]')).toBeChecked();
			await expect(dialog.locator('[data-test="checkout-selection"]')).toHaveText(
				"Max$790.00/year",
			);
			await expect(dialog.locator('[data-test="subscription-checkout"]')).toBeInViewport();
		}
		await page.keyboard.press("Escape");
		await expect(dialog).not.toBeVisible();
	}
	await page.locator('[data-test="header-credits"]').click();
	await expect(
		page.getByRole("dialog").getByRole("button", { name: "Credit Packs", exact: true }).first(),
	).toHaveAttribute("aria-pressed", "true");
	await expect
		.poll(() =>
			page
				.getByRole("dialog")
				.evaluate(
					(element) =>
						element.getAnimations().filter((animation) => animation.playState === "running").length,
				),
		)
		.toBe(0);
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 900 });
		await expect
			.poll(() =>
				page.getByRole("dialog").evaluate((element) => element.scrollWidth <= element.clientWidth),
			)
			.toBe(true);
		await page.screenshot({ path: test.info().outputPath(`credit-packs-${width}.png`) });
	}
});

test("guest sign-in preserves the selected plan and interval", async ({ page }) => {
	await mockBilling(page, { registered: false });
	await page.goto("/pricing?plan=studio&interval=month");
	await page.getByRole("dialog").getByRole("button", { name: "Sign in to continue" }).click();
	await expect(page).toHaveURL(/\/login\?redirectTo=/);
	expect(new URL(page.url()).searchParams.get("redirectTo")).toBe(
		"/pricing?plan=studio&interval=month",
	);
	await expect(page.getByRole("dialog")).not.toBeVisible();
	await page.locator('input[name="email"]').fill("guest@example.com");
	await expect(page.locator('input[name="email"]')).toHaveValue("guest@example.com");
});

test("credit-pack payment locks every pack and restores retry after failure", async ({ page }) => {
	await mockBilling(page);
	let calls = 0;
	let release!: () => void;
	const responseGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/rpc/payments/createCreditPackCheckout", async (route) => {
		calls++;
		await responseGate;
		await route.fulfill({
			status: 503,
			contentType: "application/json",
			body: JSON.stringify({
				json: { code: "SERVICE_UNAVAILABLE", message: "Temporarily unavailable", status: 503 },
			}),
		});
	});
	await page.goto("/pricing?plan=ultimate&interval=year&view=credit-packs");
	const dialog = page.getByRole("dialog");
	const buttons = dialog.getByRole("button", { name: "Buy with PayPal", exact: true });
	await expect(buttons).toHaveCount(4);
	await buttons.first().evaluate((button: HTMLButtonElement) => {
		button.click();
		button.click();
	});
	await expect(dialog.getByRole("button", { name: "Preparing checkout…" })).toBeDisabled();
	await expect(buttons.last()).toBeDisabled();
	await expect(dialog.getByRole("button", { name: "Plans", exact: true })).toBeDisabled();
	await expect.poll(() => calls).toBe(1);
	release();
	await expect(buttons.first()).toBeEnabled();
	await expect(dialog.getByRole("alert")).toBeVisible();
});

test("a monthly plan goes straight to its selected checkout and rapid clicks send exactly one request", async ({
	page,
}) => {
	await mockBilling(page);
	let requests = 0;
	let payload: { json: { planId: string; interval: string; idempotencyKey: string } } | undefined;
	let release!: () => void;
	const responseGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/rpc/payments/createCheckoutLink", async (route) => {
		requests++;
		payload = route.request().postDataJSON();
		await responseGate;
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({ json: { checkoutLink: "https://checkout.example.invalid/success" } }),
		});
	});
	await page.route("https://checkout.example.invalid/**", (route) =>
		route.fulfill({ contentType: "text/html", body: "<h1>Payment destination</h1>" }),
	);
	await page.goto("/");
	await page.locator('[data-test="public-pricing-interval-month"]').click();
	await page.locator('[data-plan-id="creator"] a').click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.locator('input[value="creator"]')).toBeChecked();
	await expect(dialog.getByRole("button", { name: "Monthly", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.locator(".studio-panel")).toHaveCount(0);
	const pay = dialog.locator('[data-test="subscription-checkout"]');
	await expect(pay).toBeEnabled();
	await expect(pay).toBeInViewport({ ratio: 1 });
	await expect
		.poll(() =>
			dialog.evaluate(
				(element) =>
					element.getAnimations().filter((animation) => animation.playState === "running").length,
			),
		)
		.toBe(0);
	await pay.evaluate((button: HTMLButtonElement) => {
		button.click();
		button.click();
		button.click();
	});
	await expect(pay).toBeDisabled();
	await expect(pay).toHaveText("Preparing checkout…");
	await expect(pay).toHaveAttribute("aria-busy", "true");
	await expect(dialog.getByRole("button", { name: "Yearly", exact: true })).toBeDisabled();
	await expect.poll(() => requests).toBe(1);
	expect(payload?.json).toMatchObject({ planId: "creator", interval: "month" });
	await page.screenshot({ path: test.info().outputPath("payment-processing.png") });
	release();
	await expect(page).toHaveURL("https://checkout.example.invalid/success");
	expect(requests).toBe(1);
});

test("failed checkout unlocks retry and reuses the same idempotency key", async ({ page }) => {
	await mockBilling(page);
	const keys: string[] = [];
	await page.route("**/api/rpc/payments/createCheckoutLink", async (route) => {
		keys.push(route.request().postDataJSON().json.idempotencyKey);
		await route.fulfill({
			status: 503,
			contentType: "application/json",
			body: JSON.stringify({
				json: { code: "SERVICE_UNAVAILABLE", message: "Temporarily unavailable", status: 503 },
			}),
		});
	});
	await page.goto("/pricing?plan=studio&interval=month");
	const dialog = page.getByRole("dialog");
	const pay = dialog.locator('[data-test="subscription-checkout"]');
	await expect(dialog.locator('input[value="studio"]')).toBeChecked();
	await pay.click();
	await expect(dialog.getByRole("alert")).toBeVisible();
	await expect(pay).toBeEnabled();
	await pay.click();
	await expect.poll(() => keys.length).toBe(2);
	expect(keys[0]).toBeTruthy();
	expect(keys[1]).toBe(keys[0]);
});

test("unfinished checkout is resumed in place and blocks a second subscription", async ({
	page,
}) => {
	await mockBilling(page, { pending: true });
	await page.goto("/pricing?plan=creator&interval=year");
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByRole("link", { name: "Resume checkout" })).toHaveAttribute(
		"href",
		"https://checkout.example.invalid/pending",
	);
	await expect(dialog.locator('[data-test="subscription-checkout"]')).toBeDisabled();
});

test("active subscribers see management and an unavailable channel never enables payment", async ({
	page,
}) => {
	await mockBilling(page, { subscribed: true });
	await page.goto("/pricing?plan=studio&interval=year");
	await expect(
		page.getByRole("dialog").getByRole("link", { name: "Credits & billing" }),
	).toBeVisible();
	await expect(page.getByRole("dialog").locator('[data-test="subscription-checkout"]')).toHaveCount(
		0,
	);
	await page.unrouteAll({ behavior: "wait" });
	await mockBilling(page, { unavailable: true });
	await page.reload();
	await expect(
		page.getByRole("dialog").locator('[data-test="subscription-checkout"]'),
	).toBeDisabled();
	await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
});

test("language selection updates public UI and preserves English canonical indexing", async ({
	page,
}) => {
	await mockBilling(page, { registered: false });
	const sessionReady = page.waitForResponse((response) =>
		new URL(response.url()).pathname.endsWith("/api/auth/get-session"),
	);
	await page.goto("/");
	await sessionReady;
	await page.getByRole("button", { name: "Language", exact: true }).click();
	await page.getByRole("menuitemradio", { name: "Deutsch", exact: true }).click();
	await expect(page.locator("html")).toHaveAttribute("lang", "de");
	await expect(page).toHaveURL(/lang=de/);
	await page.locator('[data-test="header-upgrade"]').click();
	await expect(page.getByRole("dialog")).toContainText("Mehr Raum für deine Ideen");
	await page.keyboard.press("Escape");
	const localized = await page.request.get("/?lang=de");
	expect(localized.headers()["x-robots-tag"]).toBe("noindex, follow");
	const english = await page.request.get("/");
	expect(english.headers()["x-robots-tag"]).toBeUndefined();
	expect(await english.text()).toContain('<html lang="en"');
});
