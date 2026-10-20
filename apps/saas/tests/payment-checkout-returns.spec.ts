import { expect, test as base, type Page } from "@playwright/test";

import { captureConsentedGrowthEvents } from "./growth-events";

type Provider = "paypal" | "waffo";
type CreditStatus = "PENDING" | "COMPLETED" | "REVIEW" | "EXPIRED" | "CANCELED";
type SubscriptionStatus = "PENDING" | "ACTIVE" | "PAST_DUE" | "REVIEW" | "EXPIRED" | "CANCELED";
type PaymentMock = {
	provider: Provider;
	creditStatus: CreditStatus;
	creditReadError: boolean;
	subscriptionStatus: SubscriptionStatus;
	subscriptionReadError: boolean;
	pendingVisible: boolean;
	creditReads: number;
	subscriptionReads: number;
	pendingReads: number;
	creates: Array<{ provider: Provider; packKey: string }>;
	captures: Array<{ intentId: string; providerOrderId: string }>;
	recoveries: Array<{ checkoutIntentId: string; retryReview?: boolean; stateReads: number }>;
	expectedCreates: number;
	expectedCaptures: number;
	expectedRecoveries: number;
	blocked: string[];
};

// These exact RPCs read local state. In particular availability is not a write;
// no other videoV1 procedure is exempted from the payment/media write guard.
const localReads = new Set([
	"/api/rpc/videoV1/availability",
	"/api/rpc/media/getPublicCatalog",
	"/api/rpc/media/getCreditAccount",
	"/api/rpc/media/getImagePassBalance",
	"/api/rpc/media/listJobs",
	"/api/rpc/media/listAssets",
	"/api/rpc/media/listEditSessions",
	"/api/rpc/media/getJob",
	"/api/rpc/media/getEditSession",
	"/api/rpc/media/getAssetAccessUrl",
]);

// Authentication uses the existing deterministic local funded fixture. Every
// checkout/capture/recovery write is mocked; neither a provider nor an outbox
// job receives these requests. Unexpected payment/media procedures fail closed.
const test = base.extend<{ paymentMock: PaymentMock }>({
	paymentMock: async ({ context, baseURL }, use, testInfo) => {
		const origin = new URL(baseURL ?? "http://unsafe.invalid");
		if (
			origin.protocol !== "http:" ||
			!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
		)
			throw new Error("PAYMENT_RETURN_TEST_REQUIRES_LOOPBACK_HTTP");
		const mock: PaymentMock = {
			provider: "paypal",
			creditStatus: "PENDING",
			creditReadError: false,
			subscriptionStatus: "PENDING",
			subscriptionReadError: false,
			pendingVisible: false,
			creditReads: 0,
			subscriptionReads: 0,
			pendingReads: 0,
			creates: [],
			captures: [],
			recoveries: [],
			expectedCreates: 0,
			expectedCaptures: 0,
			expectedRecoveries: 0,
			blocked: [],
		};
		await context.route("**/*", async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			if (url.origin !== origin.origin) {
				if (/paypal|waffo|stripe|kie|openrouter|replicate|wavespeed/i.test(url.hostname))
					mock.blocked.push(`external:${url.hostname}`);
				await route.abort("blockedbyclient");
				return;
			}
			const path = url.pathname;
			if (path === "/__e2e__/provider/mock") {
				await route.fulfill({
					contentType: "text/html",
					body: "<!doctype html><html lang='en'><title>Mock checkout</title><h1>Mock provider checkout</h1><p>No payment is created.</p></html>",
				});
				return;
			}
			if (path === "/api/rpc/payments/getCreditPackCheckoutState") {
				mock.creditReads++;
				await route.fulfill(
					mock.creditReadError
						? { status: 503, json: rpcError() }
						: {
								json: {
									json: {
										status: mock.creditStatus,
										provider: mock.provider,
										amount: "59.00",
										currency: "USD",
									},
								},
							},
				);
				return;
			}
			if (path === "/api/rpc/payments/getCheckoutReturnState") {
				mock.subscriptionReads++;
				await route.fulfill(
					mock.subscriptionReadError
						? { status: 503, json: rpcError() }
						: {
								json: {
									json: {
										status: mock.subscriptionStatus,
										planId: ["ACTIVE", "PAST_DUE"].includes(mock.subscriptionStatus)
											? "creator"
											: null,
										paidThrough: null,
									},
								},
							},
				);
				return;
			}
			if (path === "/api/rpc/payments/getPendingSubscriptionCheckout") {
				mock.pendingReads++;
				await route.fulfill({
					json: { json: mock.pendingVisible ? pendingView(mock.provider) : null },
				});
				return;
			}
			if (path === "/api/rpc/payments/capturePayPalCreditPackCheckout") {
				mock.captures.push(request.postDataJSON().json);
				await route.fulfill({ json: { json: { accepted: true, replayed: false } } });
				return;
			}
			if (path === "/api/rpc/payments/refreshPendingSubscriptionCheckout") {
				mock.recoveries.push({
					...request.postDataJSON().json,
					stateReads: mock.subscriptionReads,
				});
				// A successful recovery response is not proof of a paid entitlement.
				await route.fulfill({ json: { json: { ...pendingView(mock.provider), status: "PAID" } } });
				return;
			}
			if (path === "/api/rpc/payments/createCreditPackCheckout") {
				const input = request.postDataJSON().json;
				mock.creates.push({ provider: input.provider, packKey: input.packKey });
				await route.fulfill({
					json: {
						json: {
							intentId: "credit-mock",
							checkoutLink: `${origin.origin}/__e2e__/provider/mock`,
						},
					},
				});
				return;
			}
			if (
				path === "/api/rpc/payments/getCreditPackProviderAvailability" ||
				path === "/api/rpc/payments/getProviderAvailability"
			) {
				await route.fulfill({
					json: {
						json: {
							providers: ["paypal", "waffo"].map((name) => ({
								name,
								capabilities: {
									checkout: true,
									portal: false,
									cancellation: false,
									seatUpdates: false,
									webhooks: true,
								},
							})),
						},
					},
				});
				return;
			}
			if (path === "/api/rpc/payments/listPurchases") {
				await route.fulfill({ json: { json: [] } });
				return;
			}
			if (path === "/api/rpc/payments/getImagePassOffer") {
				await route.fulfill({ json: { json: { available: false } } });
				return;
			}
			if (localReads.has(path)) {
				await route.continue();
				return;
			}
			if (
				/^\/api\/rpc\/(?:payments|media|videoV1)\//.test(path) ||
				(request.method() !== "GET" && /^\/api\/(?:payments|media|video)(?:\/|$)/.test(path))
			) {
				mock.blocked.push(path);
				await route.abort("blockedbyclient");
				return;
			}
			await route.continue();
		});
		await use(mock);
		await testInfo.attach("payment-return-route-audit", {
			body: JSON.stringify(mock, null, 2),
			contentType: "application/json",
		});
		expect(mock.creates).toHaveLength(mock.expectedCreates);
		expect(mock.captures).toHaveLength(mock.expectedCaptures);
		expect(mock.recoveries).toHaveLength(mock.expectedRecoveries);
		expect(mock.blocked, "unexpected payment/media requests were blocked").toEqual([]);
	},
});

test.use({ serviceWorkers: "block" });

for (const viewport of [
	{ name: "desktop", width: 1280, height: 900 },
	{ name: "mobile", width: 390, height: 844 },
]) {
	test.describe(`payment checkout returns (${viewport.name})`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } });
		test.describe.configure({ timeout: 120_000 });

		test("credit cancellation ignores approval, token and status URL and shows server outcomes", async ({
			page,
			paymentMock,
		}, testInfo) => {
			await page.goto(
				"/credit-pack-checkout-return?intentId=credit-mock&canceled=1&approved=1&token=fake&status=COMPLETED",
			);
			const status = page.getByTestId("credit-pack-checkout-status");
			await expect(status).toHaveAttribute("data-status", "PENDING");
			await expect(status).not.toContainText("Payment confirmed");
			await expect(page.getByTestId("credit-pack-confirm-payment")).toHaveCount(0);
			await wakeBrowser(page);
			await page.getByTestId("credit-pack-check-status").click();
			await page.reload();
			await expect(status).toHaveAttribute("data-status", "PENDING");
			for (const serverStatus of ["REVIEW", "EXPIRED", "CANCELED"] as const) {
				paymentMock.creditStatus = serverStatus;
				await page.getByTestId("credit-pack-check-status").click();
				await expect(status).toHaveAttribute("data-status", serverStatus);
				await expect(status).not.toContainText("Payment confirmed");
			}
			paymentMock.creditReadError = true;
			await page.getByTestId("credit-pack-check-status").click();
			await expect(status).toHaveAttribute("data-status", "error");
			await expect(status).not.toContainText("Payment confirmed");
			await expectFitsViewport(page);
			await status.screenshot({ path: testInfo.outputPath("credit-cancel-read-error.png") });
			paymentMock.creditReadError = false;
			paymentMock.creditStatus = "COMPLETED";
			await page.getByTestId("credit-pack-check-status").click();
			await expect(page).toHaveURL(/\/create\?credits=purchased$/);
		});

		test("legacy credit confirmation uses server USD 59 and captures only after explicit consent", async ({
			page,
			paymentMock,
		}, testInfo) => {
			const path =
				"/credit-pack-checkout-return?intentId=credit-mock&token=credit-order&amount=1.00&currency=EUR";
			await page.goto(path);
			const status = page.getByTestId("credit-pack-checkout-status");
			const confirm = page.getByTestId("credit-pack-confirm-payment");
			await expect(confirm).toHaveText("Confirm USD 59.00 payment");
			await wakeBrowser(page);
			await page.getByTestId("credit-pack-check-status").click();
			await page.reload();
			await expect(confirm).toBeVisible();
			await expectFitsViewport(page);
			await status.screenshot({ path: testInfo.outputPath("credit-legacy-confirm-usd59.png") });
			expect(paymentMock.captures).toEqual([]);
			paymentMock.expectedCaptures = 1;
			await confirm.click();
			await expect.poll(() => paymentMock.captures.length).toBe(1);
			expect(paymentMock.captures[0]).toEqual({
				intentId: "credit-mock",
				providerOrderId: "credit-order",
			});
			await expect(status).toHaveAttribute("data-status", "PENDING");
			await expect(status).not.toContainText("Payment confirmed");
			await wakeBrowser(page);
			await page.getByTestId("credit-pack-check-status").click();
			await expect(status).toHaveAttribute("data-status", "PENDING");
			await expectFitsViewport(page);
			await page.reload();
			await expect(confirm).toHaveText("Confirm USD 59.00 payment");
			expect(paymentMock.captures).toHaveLength(1);
		});

		test("Waffo credit return never captures a forged PayPal token", async ({
			page,
			paymentMock,
		}) => {
			paymentMock.provider = "waffo";
			await page.goto(
				"/credit-pack-checkout-return?intentId=credit-mock&approved=1&token=forged-paypal-token&status=COMPLETED",
			);
			const status = page.getByTestId("credit-pack-checkout-status");
			await expect(status).toHaveAttribute("data-status", "PENDING");
			await expect(page.getByTestId("credit-pack-confirm-payment")).toHaveCount(0);
			await expect(status).not.toContainText("Payment confirmed");
			await wakeBrowser(page);
			await page.getByTestId("credit-pack-check-status").click();
			await page.reload();
			await expect(status).toHaveAttribute("data-status", "PENDING");
			paymentMock.creditStatus = "COMPLETED";
			await page.getByTestId("credit-pack-check-status").click();
			await expect(page).toHaveURL(/\/create\?credits=purchased$/);
		});

		for (const provider of ["paypal", "waffo"] as const) {
			test(`restores ${provider} credit purchase after Back and refresh without capture`, async ({
				page,
				paymentMock,
			}, testInfo) => {
				paymentMock.provider = provider;
				paymentMock.expectedCreates = 1;
				await page.goto("/pricing");
				await openCreditPacks(page);
				await page
					.locator(`[data-test="public-pricing-credit-packs"] input[value="${provider}"]`)
					.check();
				const buy = page.getByTestId("credit-pack-buy-credits-1500");
				await expect(buy).toBeEnabled();
				await buy.click();
				await expect(page.getByRole("heading", { name: "Mock provider checkout" })).toBeVisible();
				await page.goBack();
				await expect(page).toHaveURL(/\/pricing$/);
				await openCreditPacks(page);
				const recovery = page.getByTestId("credit-pack-recovery-credits-1500");
				await expect(recovery).toBeVisible();
				await expect(buy).toBeEnabled();
				await page.reload();
				await openCreditPacks(page);
				await expect(recovery).toBeVisible();
				await expectFitsViewport(page);
				await recovery.screenshot({ path: testInfo.outputPath(`${provider}-credit-back.png`) });
				await recovery
					.locator('a[href="/credit-pack-checkout-return?intentId=credit-mock"]')
					.click();
				await expect(page.getByTestId("credit-pack-checkout-status")).toHaveAttribute(
					"data-status",
					"PENDING",
				);
				await expect(page.getByTestId("credit-pack-confirm-payment")).toHaveCount(0);
				expect(paymentMock.creates).toEqual([{ provider, packKey: "credits-1500" }]);
			});
		}

		test("canceled and legacy subscriptions stay read-only across lifecycle events and refresh", async ({
			page,
			paymentMock,
		}) => {
			for (const suffix of [
				"&canceled=1&approved=1&token=fake&status=ACTIVE",
				"&token=fake&status=ACTIVE",
			]) {
				await page.goto(subscriptionPath(suffix));
				const status = page.getByTestId("subscription-checkout-status");
				await expect(status).toHaveAttribute("data-status", "PENDING");
				await expect(status).not.toContainText("Your subscription is confirmed");
				await wakeBrowser(page);
				const before = paymentMock.subscriptionReads;
				await page.getByTestId("subscription-check-status").click();
				await expect.poll(() => paymentMock.subscriptionReads).toBeGreaterThan(before);
				await page.reload();
				await expect(status).toHaveAttribute("data-status", "PENDING");
				expect(paymentMock.recoveries).toEqual([]);
			}
			await expect(page.getByTestId("subscription-confirm-payment")).toBeVisible();
			await expectFitsViewport(page);
		});

		for (const provider of ["paypal", "waffo"] as const) {
			test(`approved ${provider} subscription recovers once after a state read and waits for paid evidence`, async ({
				page,
				paymentMock,
			}, testInfo) => {
				paymentMock.provider = provider;
				paymentMock.expectedRecoveries = 1;
				paymentMock.subscriptionReadError = true;
				await page.goto(subscriptionPath("&approved=1&status=ACTIVE"));
				const status = page.getByTestId("subscription-checkout-status");
				await expect(status).toHaveAttribute("data-status", "error");
				expect(paymentMock.recoveries).toEqual([]);
				paymentMock.subscriptionReadError = false;
				await page.getByTestId("subscription-check-status").click();
				await expect.poll(() => paymentMock.recoveries.length).toBe(1);
				expect(paymentMock.recoveries[0]).toMatchObject({ checkoutIntentId: "subscription-mock" });
				expect(paymentMock.recoveries[0]!.stateReads).toBeGreaterThan(0);
				await expect(status).toHaveAttribute("data-status", "PENDING");
				await expect(status).not.toContainText("Your subscription is confirmed");
				await status.screenshot({
					path: testInfo.outputPath(`${provider}-subscription-unconfirmed.png`),
				});
				await wakeBrowser(page);
				await page.getByTestId("subscription-check-status").click();
				await expect(status).toHaveAttribute("data-status", "PENDING");
				expect(paymentMock.recoveries).toHaveLength(1);
				paymentMock.subscriptionStatus = "ACTIVE";
				await page.getByTestId("subscription-check-status").click();
				await expect(status).toHaveAttribute("data-status", "ACTIVE");
				await expect(status).toContainText("Your subscription is confirmed");
				await expect(page.getByTestId("subscription-continue")).toHaveAttribute("href", "/create");
				await page.reload();
				await expect(status).toHaveAttribute("data-status", "ACTIVE");
				expect(paymentMock.recoveries).toHaveLength(1);
				await expectFitsViewport(page);
			});
		}

		test("subscription review, failed reads and paid grace follow server state", async ({
			page,
			paymentMock,
		}, testInfo) => {
			const growthEvents = await captureConsentedGrowthEvents(page);
			await page.goto(subscriptionPath("&status=ACTIVE"));
			const status = page.getByTestId("subscription-checkout-status");
			await expect(status).toHaveAttribute("data-status", "PENDING");
			for (const serverStatus of ["REVIEW", "EXPIRED", "CANCELED"] as const) {
				paymentMock.subscriptionStatus = serverStatus;
				await page.getByTestId("subscription-check-status").click();
				await expect(status).toHaveAttribute("data-status", serverStatus);
				await expect(status).not.toContainText("Your subscription is confirmed");
			}
			paymentMock.subscriptionReadError = true;
			await page.getByTestId("subscription-check-status").click();
			await expect(status).toHaveAttribute("data-status", "error");
			await expect(status).not.toContainText("Your subscription is confirmed");
			paymentMock.subscriptionReadError = false;
			paymentMock.subscriptionStatus = "PAST_DUE";
			await page.getByTestId("subscription-check-status").click();
			await expect(status).toHaveAttribute("data-status", "PAST_DUE");
			await expect(status).toContainText("renewal payment is pending");
			await expect(status).not.toContainText("Your subscription is confirmed");
			await expectFitsViewport(page);
			await status.screenshot({ path: testInfo.outputPath("subscription-paid-grace.png") });
			expect(growthEvents.map(({ name }) => name)).not.toContain("subscription_activated");
			await page.getByTestId("subscription-continue").click();
			await expect(page).toHaveURL(/\/create$/);
		});

		test("choose-plan pending checkout only reads until an explicit finish action", async ({
			page,
			paymentMock,
		}, testInfo) => {
			paymentMock.pendingVisible = true;
			paymentMock.provider = "waffo";
			await page.goto("/choose-plan?returnTo=%2Fcreate");
			const pending = page.getByTestId("pending-subscription-checkout");
			await expect(pending).toBeVisible();
			await wakeBrowser(page);
			const before = paymentMock.pendingReads;
			await pending.getByTestId("pending-subscription-check-status").click();
			await expect.poll(() => paymentMock.pendingReads).toBeGreaterThan(before);
			await page.goto("/__e2e__/provider/mock");
			await page.goBack();
			await expect(pending).toBeVisible();
			await page.reload();
			await expect(pending).toBeVisible();
			expect(paymentMock.recoveries).toEqual([]);
			await expectFitsViewport(page);
			await pending.screenshot({ path: testInfo.outputPath("pending-subscription-read-only.png") });
			paymentMock.expectedRecoveries = 1;
			await pending.getByTestId("pending-subscription-confirm-payment").click();
			await expect.poll(() => paymentMock.recoveries.length).toBe(1);
			expect(paymentMock.recoveries[0]).toMatchObject({
				checkoutIntentId: "subscription-mock",
				retryReview: true,
			});
			await page.reload();
			await expect(pending).toBeVisible();
			await wakeBrowser(page);
			expect(paymentMock.recoveries).toHaveLength(1);
		});
	});
}

function subscriptionPath(suffix = "") {
	return `/checkout-return?expectedPlanId=creator&returnTo=%2Fcreate&checkoutIntentId=subscription-mock${suffix}`;
}

function pendingView(provider: Provider) {
	return {
		id: "subscription-mock",
		provider,
		planId: "creator",
		interval: "month",
		status: "PENDING",
		canResume: false,
		canChange: false,
		waitUntil: null,
		checkedAt: null,
	};
}

async function wakeBrowser(page: Page) {
	await page.evaluate(() => {
		window.dispatchEvent(new Event("focus"));
		window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
	});
}

async function openCreditPacks(page: Page) {
	const tab = page.locator('[data-test="public-pricing-credit-packs-tab"]');
	await expect(tab).toBeVisible();
	if ((await tab.getAttribute("aria-pressed")) !== "true") await tab.click();
	await expect(page.locator('[data-test="public-pricing-credit-packs"]')).toBeVisible();
}

async function expectFitsViewport(page: Page) {
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
		"the page must fit its viewport",
	).toBe(true);
}

function rpcError() {
	return {
		json: {
			defined: false,
			code: "SERVICE_UNAVAILABLE",
			status: 503,
			message: "MOCK_CHECKOUT_READ_FAILED",
		},
	};
}
