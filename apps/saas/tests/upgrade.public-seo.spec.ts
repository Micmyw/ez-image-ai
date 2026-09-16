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
	let protectedLookups = 0;
	await page.route("**/api/rpc/payments/getProviderAvailability**", (route) => {
		protectedLookups++;
		return route.fulfill({
			status: 401,
			contentType: "application/json",
			body: JSON.stringify({
				json: { code: "UNAUTHORIZED", status: 401, message: "Unauthorized" },
			}),
		});
	});
	await page.goto("/pricing?plan=studio&interval=month");
	await page.getByRole("dialog").getByRole("button", { name: "Sign in to continue" }).click();
	await expect(page).toHaveURL(/\/login\?redirectTo=/);
	expect(new URL(page.url()).searchParams.get("redirectTo")).toBe(
		"/pricing?plan=studio&interval=month",
	);
	await expect(page.getByRole("dialog")).not.toBeVisible();
	await page.locator('input[name="email"]').fill("guest@example.com");
	await expect(page.locator('input[name="email"]')).toHaveValue("guest@example.com");
	expect(protectedLookups).toBe(0);
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
	const buttons = dialog.getByRole("button", { name: "Buy credits", exact: true });
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
	await page.setViewportSize({ width: 320, height: 720 });
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
	await expect(dialog.getByRole("alert")).toBeInViewport({ ratio: 1 });
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
	await expect(dialog.locator('[data-test="subscription-checkout"]')).toHaveCount(0);
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

test("Max stays fully visible and payment preferences remain selectable with an uncertain checkout", async ({
	page,
}) => {
	await mockBilling(page);
	await page.route("**/api/rpc/payments/getPendingSubscriptionCheckout**", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				json: {
					id: "pending-waffo-123",
					provider: "waffo",
					planId: "creator",
					interval: "year",
					checkoutLink: null,
				},
			}),
		}),
	);
	await page.route("**/api/rpc/payments/refreshPendingSubscriptionCheckout", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({ json: { status: "UNKNOWN" } }),
		}),
	);
	for (const viewport of [
		{ width: 1280, height: 720 },
		{ width: 390, height: 844 },
		{ width: 320, height: 720 },
	]) {
		await page.setViewportSize(viewport);
		await page.goto("/pricing?plan=studio&interval=year");
		const dialog = page.getByRole("dialog");
		const max = dialog.locator("label").filter({ has: page.locator('input[value="studio"]') });
		await expect(dialog.getByRole("button", { name: "Check payment status" })).toBeVisible();
		await expect
			.poll(() =>
				max.evaluate((card) => {
					const rect = card.getBoundingClientRect();
					const footer = document.querySelector(".studio-checkout-footer")!.getBoundingClientRect();
					const list = card.closest('[data-test="upgrade-plan-list"]')?.getBoundingClientRect();
					return (
						rect.top >= (list?.top ?? 0) - 1 &&
						rect.bottom <= Math.min(footer.top, list?.bottom ?? innerHeight) + 1
					);
				}),
			)
			.toBe(true);
		await dialog.getByRole("radio", { name: "Waffo", exact: true }).check();
		await expect(dialog.getByRole("radio", { name: "Waffo", exact: true })).toBeChecked();
		await expect(dialog.locator('[data-test="subscription-checkout"]')).toHaveCount(0);
		await dialog.getByRole("button", { name: "Check payment status" }).click();
		await expect(
			dialog.getByText(
				"We couldn't confirm this payment. Contact support with the order reference.",
			),
		).toBeVisible();
		await expect(dialog.getByRole("link", { name: "Contact support" })).toHaveAttribute(
			"href",
			/(?:mailto:|\/contact)/,
		);
		await expect(dialog).toContainText("pending-waffo-123");
		await expect(dialog).toContainText("If you were charged, do not pay again.");
		await expect(dialog.locator('[data-test="subscription-checkout"]')).toHaveCount(0);
		await page.screenshot({ path: test.info().outputPath(`pending-max-${viewport.width}.png`) });
	}
	await page.goto("/pricing?plan=studio&interval=year&lang=de");
	const localized = page.getByRole("dialog");
	await expect(localized.getByRole("link", { name: "Support kontaktieren" })).toBeVisible();
	await localized.getByText("Bestelldetails & Hilfe", { exact: true }).click();
	await expect(
		localized.getByText("Falls bereits Geld abgebucht wurde, bezahle nicht erneut."),
	).toBeVisible();
	await expect(localized.locator('[data-test="pending-checkout-reference"]')).toHaveText(
		"Bestellreferenz: pending-waffo-123",
	);
});

test("plan changes retain methods while validating the selected SKU and reject stale availability", async ({
	page,
}) => {
	await mockBilling(page);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/rpc/payments/getProviderAvailability**", async (route) => {
		const input = (
			route.request().method() === "GET"
				? JSON.parse(new URL(route.request().url()).searchParams.get("data")!)
				: route.request().postDataJSON()
		).json;
		if (input.planId !== "studio") return route.fallback();
		await gate;
		return route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({ json: { providers: [] } }),
		});
	});
	await page.goto("/pricing?plan=creator&interval=year");
	const dialog = page.getByRole("dialog");
	const waffo = dialog.getByRole("radio", { name: "Waffo", exact: true });
	await waffo.check();
	await dialog.locator('input[value="studio"]').check();
	await expect(waffo).toBeVisible();
	await expect(waffo).toBeChecked();
	await expect(dialog.locator('[data-test="subscription-checkout"]')).toBeDisabled();
	release();
	await expect(dialog.getByRole("alert")).toBeVisible();
	await expect(dialog.locator('[data-test="subscription-checkout"]')).toBeDisabled();
	await dialog.locator('input[value="ultimate"]').check();
	await expect(waffo).toBeChecked();
	await expect(dialog.locator('[data-test="subscription-checkout"]')).toBeEnabled();
});

test("credit packs share a warmed payment selector and enforce provider availability per pack", async ({
	page,
}) => {
	await mockBilling(page);
	const lookups = new Map<string, number>();
	await page.route("**/api/rpc/payments/getCreditPackProviderAvailability**", async (route) => {
		const { packKey } = (
			route.request().method() === "GET"
				? JSON.parse(new URL(route.request().url()).searchParams.get("data")!)
				: route.request().postDataJSON()
		).json;
		lookups.set(packKey, (lookups.get(packKey) ?? 0) + 1);
		const names = packKey === "credits-1500" ? ["paypal"] : ["paypal", "waffo"];
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				json: { providers: names.map((name) => ({ name, capabilities: { checkout: true } })) },
			}),
		});
	});
	let selected: { provider: string; packKey: string } | undefined;
	await page.route("**/api/rpc/payments/createCreditPackCheckout", (route) => {
		selected = route.request().postDataJSON().json;
		return route.fulfill({
			status: 503,
			contentType: "application/json",
			body: JSON.stringify({
				json: { code: "SERVICE_UNAVAILABLE", status: 503, message: "Test retry" },
			}),
		});
	});
	await page.goto("/pricing?plan=creator&interval=year");
	const dialog = page.getByRole("dialog");
	await expect(dialog.locator('[data-test="subscription-checkout"]')).toBeEnabled();
	await expect.poll(() => lookups.size).toBe(4);
	await dialog.getByRole("button", { name: "Credit Packs", exact: true }).click();
	await expect(dialog.getByRole("radio", { name: "PayPal", exact: true })).toHaveCount(1);
	await expect(dialog.getByRole("button", { name: "Buy credits", exact: true })).toHaveCount(4);
	await dialog.getByRole("radio", { name: "Waffo", exact: true }).check();
	const packs = dialog.locator('[data-test="public-credit-pack"]');
	await expect(
		packs.first().getByRole("button", { name: "Buy credits", exact: true }),
	).toBeDisabled();
	await packs.last().getByRole("button", { name: "Buy credits", exact: true }).click();
	await expect.poll(() => selected?.provider).toBe("waffo");
	expect(selected?.packKey).toBe(await packs.last().getAttribute("data-pack-key"));
	await expect(
		packs.last().getByRole("button", { name: "Buy credits", exact: true }),
	).toBeEnabled();
	await dialog.getByRole("button", { name: "Plans", exact: true }).click();
	await dialog.getByRole("button", { name: "Credit Packs", exact: true }).click();
	await expect(dialog.getByRole("radio", { name: "Waffo", exact: true })).toBeChecked();
	expect([...lookups.values()].every((count) => count === 1)).toBe(true);
});

for (const status of ["PAID", "CLOSED"] as const) {
	test(`pending checkout ${status} uses recovery without creating another payment`, async ({
		page,
	}) => {
		await mockBilling(page, { pending: true });
		let checked = false;
		let calls = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route("**/api/rpc/payments/getPendingSubscriptionCheckout**", async (route) => {
			if (!checked || status === "PAID") return route.fallback();
			return route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({ json: null }),
			});
		});
		await page.route("**/api/rpc/payments/refreshPendingSubscriptionCheckout", async (route) => {
			calls++;
			await gate;
			checked = true;
			return route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({ json: { status } }),
			});
		});
		await page.goto("/pricing?plan=studio&interval=year");
		const dialog = page.getByRole("dialog");
		const check = dialog.getByRole("button", { name: "Check payment status" });
		await check.evaluate((button: HTMLButtonElement) => {
			button.click();
			button.click();
		});
		await expect(check).toBeDisabled();
		await expect.poll(() => calls).toBe(1);
		release();
		if (status === "PAID") {
			await expect(dialog).toContainText(
				"We are confirming its payment and updating your account.",
			);
			await expect(dialog.getByRole("link", { name: "Resume checkout" })).toHaveCount(0);
			await expect(dialog.locator('[data-test="subscription-checkout"]')).toHaveCount(0);
		} else {
			await expect(check).toHaveCount(0);
			await expect(dialog.locator('[data-test="subscription-checkout"]')).toBeEnabled();
		}
	});
}

test("credit-pack methods settle together when one availability response is slow", async ({
	page,
}) => {
	await mockBilling(page);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/rpc/payments/getCreditPackProviderAvailability**", async (route) => {
		const { packKey } = route.request().postDataJSON().json;
		if (packKey === "credits-8000") await gate;
		return route.fallback();
	});
	await page.goto("/pricing?plan=studio&interval=year&view=credit-packs");
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.locator('[data-test="public-pricing-credit-packs"]').getByRole("status"),
	).toHaveText("Checking payment options…");
	await expect(dialog.getByRole("radio", { name: "PayPal", exact: true })).toHaveCount(0);
	const buttons = dialog.getByRole("button", { name: "Buy credits", exact: true });
	await expect(buttons).toHaveCount(4);
	for (const button of await buttons.all()) await expect(button).toBeDisabled();
	release();
	await expect(dialog.getByRole("radio", { name: "PayPal", exact: true })).toBeChecked();
	for (const button of await buttons.all()) await expect(button).toBeEnabled();
});
