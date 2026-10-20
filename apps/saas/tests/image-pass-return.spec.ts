import { expect, test as base, type Page } from "@playwright/test";

type CheckoutStatus = "PENDING" | "COMPLETED" | "REVIEW" | "EXPIRED" | "CANCELED";
type PaymentMock = {
	available: number;
	reserved: number;
	status: CheckoutStatus;
	balanceReads: number;
	stateReads: number;
	checkouts: number;
	captures: number;
	submissions: Array<{ fundingSource?: string }>;
	blockedMutations: string[];
	blockedExternalPayments: string[];
};

// Use the existing deterministic local funded account. Only authentication,
// catalog and credit reads reach the local app; checkout and generation writes
// below are fixtures. No provider checkout, capture or media job is created.
const test = base.extend<{ paymentMock: PaymentMock }>({
	paymentMock: async ({ context, baseURL }, use, testInfo) => {
		const origin = new URL(baseURL ?? "http://unsafe.invalid");
		if (
			origin.protocol !== "http:" ||
			!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
		)
			throw new Error("IMAGE_PASS_BROWSER_TEST_REQUIRES_LOOPBACK_HTTP");
		const mock: PaymentMock = {
			available: 0,
			reserved: 0,
			status: "PENDING",
			balanceReads: 0,
			stateReads: 0,
			checkouts: 0,
			captures: 0,
			submissions: [],
			blockedMutations: [],
			blockedExternalPayments: [],
		};
		await context.route("**/*", async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			if (url.origin !== origin.origin) {
				if (/paypal|stripe|waffo|kie|openrouter|replicate|wavespeed/i.test(url.hostname))
					mock.blockedExternalPayments.push(url.hostname);
				await route.abort("blockedbyclient");
				return;
			}
			const path = url.pathname;
			if (path === "/__e2e__/paypal/mock") {
				await route.fulfill({
					contentType: "text/html",
					body: "<!doctype html><html lang='en'><title>Mock PayPal</title><h1>Mock PayPal checkout</h1><p>No payment is created.</p></html>",
				});
				return;
			}
			if (path === "/api/rpc/media/getImagePassBalance") {
				mock.balanceReads++;
				await route.fulfill({
					json: {
						json: { available: mock.available, reserved: mock.reserved, consumed: 0, revoked: 0 },
					},
				});
				return;
			}
			if (
				path === "/api/rpc/payments/getImagePassOffer" ||
				path === "/api/payments/image-pass-offer"
			) {
				await route.fulfill({
					json: path.includes("/rpc/") ? { json: { available: true } } : { available: true },
				});
				return;
			}
			if (path === "/api/rpc/payments/getImagePassCheckoutState") {
				mock.stateReads++;
				await route.fulfill({ json: { json: { status: mock.status } } });
				return;
			}
			if (path === "/api/rpc/payments/createImagePassCheckout") {
				mock.checkouts++;
				await route.fulfill({
					json: {
						json: { intentId: "mock", checkoutLink: `${origin.origin}/__e2e__/paypal/mock` },
					},
				});
				return;
			}
			if (path === "/api/rpc/payments/capturePayPalImagePassCheckout") {
				mock.captures++;
				await route.fulfill({ status: 409, json: rpcError("CAPTURE_FORBIDDEN_IN_CANCEL_TEST") });
				return;
			}
			if (path === "/api/rpc/media/submitGeneration") {
				const input = request.postDataJSON().json as { fundingSource?: string };
				mock.submissions.push({ fundingSource: input.fundingSource });
				// Model an entitlement consumed elsewhere between selection and submit.
				mock.available = 0;
				await route.fulfill({ status: 409, json: rpcError("IMAGE_PASS_INSUFFICIENT") });
				return;
			}
			if (
				/^\/api\/rpc\/(?:payments|media|videoV1)\/(?!get|list)/.test(path) ||
				(request.method() !== "GET" && /^\/api\/(?:payments|media|video)(?:\/|$)/.test(path))
			) {
				mock.blockedMutations.push(path);
				await route.abort("blockedbyclient");
				return;
			}
			await route.continue();
		});
		await use(mock);
		await testInfo.attach("payment-route-audit", {
			body: JSON.stringify(mock, null, 2),
			contentType: "application/json",
		});
		expect(mock.captures, "cancel and browser Back must never capture").toBe(0);
		expect(mock.blockedMutations, "unexpected payment/media writes were blocked").toEqual([]);
		expect(mock.blockedExternalPayments, "external paid endpoints were blocked").toEqual([]);
	},
});

test.use({ serviceWorkers: "block" });

for (const viewport of [
	{ name: "desktop", width: 1280, height: 900 },
	{ name: "mobile", width: 390, height: 844 },
]) {
	test.describe(`image-pass cancellation and funding (${viewport.name})`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } });
		test.describe.configure({ timeout: 120_000 });

		test("hides empty funding choices, preserves the banner and fits available or reserved passes", async ({
			page,
			paymentMock,
		}, testInfo) => {
			await openCreator(page);
			const selector = page.locator('[data-test="image-funding-selector"]');
			const banner = page.locator('[data-test="image-pass-banner"]');
			await expect.poll(() => paymentMock.balanceReads).toBeGreaterThan(0);
			await expect(selector).toHaveCount(0);
			await expect(banner).toBeVisible();
			await expect(banner.locator('a[href="/image-pass"]')).toBeVisible();
			await expectNoHorizontalOverflow(page);
			await page.screenshot({ path: testInfo.outputPath("empty-funding.png") });

			paymentMock.reserved = 1;
			await page.reload();
			await expect(selector).toBeVisible();
			await expect(selector).toContainText("1 in progress");
			await expect(selector.locator('input[value="CREDITS"]')).toBeChecked();
			await expect(selector.locator('input[value="IMAGE_PASS"]')).toBeDisabled();
			await expectNoHorizontalOverflow(page);

			paymentMock.available = 3;
			paymentMock.reserved = 0;
			await page.reload();
			await expect(selector).toContainText("3 available");
			await expect(selector.locator('input[value="IMAGE_PASS"]')).toBeEnabled();
			await expectNoHorizontalOverflow(page);
			await selector.screenshot({ path: testInfo.outputPath("compact-funding.png") });
			expect(paymentMock.checkouts).toBe(0);
			expect(paymentMock.submissions).toEqual([]);
		});

		test("keeps an exhausted image-pass selection and never submits a credit fallback", async ({
			page,
			paymentMock,
		}) => {
			paymentMock.available = 1;
			await openCreator(page);
			const form = page.locator('[data-test="registered-generator"]');
			const pass = form.locator('input[name="image-funding"][value="IMAGE_PASS"]');
			await pass.check();
			await form
				.getByLabel(/edit instruction|image prompt/i)
				.fill("A ceramic vase in soft daylight");
			const submit = form.locator('[data-test="generation-submit"]');
			await expect(submit).toBeEnabled();
			await submit.click();
			await expect.poll(() => paymentMock.submissions.length).toBe(1);
			await expect(pass).toBeChecked();
			await expect(pass).toBeDisabled();
			await expect(submit).toBeDisabled();
			await expect(form.locator('input[value="CREDITS"]')).not.toBeChecked();
			await expect(form).toContainText("Choose credits to continue");
			// Also exercise the submit handler directly, beyond the disabled button.
			await form.evaluate((element) => (element as HTMLFormElement).requestSubmit());
			expect(paymentMock.submissions).toEqual([{ fundingSource: "IMAGE_PASS" }]);
			await expectNoHorizontalOverflow(page);
		});

		test("uses server checkout state after cancel, refresh and repeated return without capture", async ({
			page,
			paymentMock,
		}, testInfo) => {
			const canceledPath = "/image-pass?canceled=1&intentId=mock";
			await page.goto(canceledPath);
			const status = page.getByTestId("image-pass-checkout-status");
			await expect(status).toHaveAttribute("data-status", "PENDING");
			await expect(status).not.toContainText("Payment confirmed");
			await page.goto(`${canceledPath}&status=COMPLETED`);
			await expect(status).toHaveAttribute("data-status", "PENDING");
			await expect(status).not.toContainText("Payment confirmed");
			await expectNoHorizontalOverflow(page);

			paymentMock.status = "COMPLETED";
			await page.getByTestId("image-pass-check-status").click();
			await expect(status).toHaveAttribute("data-status", "COMPLETED");
			await expect(status).toContainText("Payment confirmed");
			await page.reload();
			await expect(status).toHaveAttribute("data-status", "COMPLETED");
			await page.goto(`${canceledPath}&token=untrusted-cancel-token`);
			await expect(status).toHaveAttribute("data-status", "COMPLETED");

			paymentMock.status = "REVIEW";
			await page.reload();
			await expect(status).toHaveAttribute("data-status", "REVIEW");
			await expect(status).not.toContainText("Payment confirmed");
			paymentMock.status = "CANCELED";
			await page.reload();
			await expect(status).toHaveAttribute("data-status", "CANCELED");
			await expect(status).not.toContainText("Payment confirmed");
			await expectNoHorizontalOverflow(page);
			await status.screenshot({ path: testInfo.outputPath("canceled-checkout-state.png") });
			expect(paymentMock.stateReads).toBeGreaterThanOrEqual(6);
			expect(paymentMock.checkouts).toBe(0);
			expect(paymentMock.submissions).toEqual([]);
		});

		test("keeps legacy returns read-only and gives cancellation priority over approval flags", async ({
			page,
			paymentMock,
		}) => {
			const legacyPath = "/image-pass-checkout-return?intentId=mock&token=mock";
			await page.goto(legacyPath);
			const status = page.getByTestId("image-pass-checkout-status");
			const confirm = page.getByTestId("image-pass-confirm-payment");
			await expect(status).toHaveAttribute("data-status", "PENDING");
			await expect(confirm).toBeVisible();
			await expect(confirm).toHaveText("Confirm USD 1.00 payment");
			await expect(status).not.toContainText("Payment confirmed");
			await page.reload();
			await expect(confirm).toBeVisible();
			await page.goto(legacyPath);
			await expect(confirm).toBeVisible();
			await page.goto(`${legacyPath}&canceled=1&approved=1`);
			await expect(page).toHaveURL(/\/image-pass\?canceled=1&intentId=mock$/);
			await expect(status).toHaveAttribute("data-status", "PENDING");
			await expect(confirm).toHaveCount(0);
			await expectNoHorizontalOverflow(page);
			expect(paymentMock.checkouts).toBe(0);
			expect(paymentMock.submissions).toEqual([]);
		});

		test("restores pending purchase after browser Back and preserves the editor draft", async ({
			page,
			paymentMock,
		}, testInfo) => {
			const draft = `Image-pass browser Back draft (${viewport.name})`;
			await openCreator(page);
			await page.getByLabel(/edit instruction|image prompt/i).fill(draft);
			await page.locator('[data-test="image-pass-banner"] a[href="/image-pass"]').click();
			const buy = page.getByTestId("image-pass-buy");
			await expect(buy).toBeEnabled();
			await buy.click();
			await expect(page).toHaveURL(/\/__e2e__\/paypal\/mock$/);
			await expect(page.getByRole("heading", { name: "Mock PayPal checkout" })).toBeVisible();
			expect(paymentMock.checkouts).toBe(1);

			await page.goBack();
			await expect(page).toHaveURL(/\/image-pass$/);
			const status = page.getByTestId("image-pass-checkout-status");
			await expect(status).toHaveAttribute("data-status", "PENDING");
			await expect(status).not.toContainText("Payment confirmed");
			await expect(buy).toBeEnabled();
			await expect(buy).not.toContainText("Opening PayPal");
			await expectNoHorizontalOverflow(page);
			await status.screenshot({ path: testInfo.outputPath("browser-back-pending.png") });
			await page.reload();
			await expect(status).toHaveAttribute("data-status", "PENDING");
			await page.getByRole("link", { name: "Return to editor", exact: true }).click();
			await expect(page).toHaveURL(/\/create$/);
			await expect(page.getByLabel(/edit instruction|image prompt/i)).toHaveValue(draft);
			expect(paymentMock.checkouts).toBe(1);
			expect(paymentMock.submissions).toEqual([]);
		});
	});
}

async function openCreator(page: Page) {
	await page.goto("/create");
	await expect(page.locator('[data-test="registered-generator"]')).toBeVisible({ timeout: 60_000 });
	await expect(page.getByRole("button", { name: /^Model: / })).toBeEnabled({ timeout: 60_000 });
	await expect(page.locator('[data-test="generation-submit"]')).toContainText("credits", {
		timeout: 60_000,
	});
}

async function expectNoHorizontalOverflow(page: Page) {
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
		"the page must fit its viewport",
	).toBe(true);
}

function rpcError(message: string) {
	return { json: { defined: false, code: "CONFLICT", status: 409, message } };
}
