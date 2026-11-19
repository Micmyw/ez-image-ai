import { expect, test, type Page } from "@playwright/test";

async function fixtures(
	page: Page,
	policy: boolean | null | Promise<boolean>,
	privacySignal = false,
) {
	const vendors: string[] = [];
	const traffic: { body: unknown; cookie: string | undefined }[] = [];
	await page.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (url.hostname === "www.clarity.ms" || url.hostname === "www.googletagmanager.com") {
			vendors.push(url.hostname);
			return route.fulfill({
				contentType: "application/javascript",
				body: "/* isolated vendor fixture; no external collection */",
			});
		}
		if (!["localhost", "127.0.0.1"].includes(url.hostname)) return route.abort();
		if (!url.pathname.startsWith("/api/")) return route.continue();
		if (url.pathname === "/api/analytics/policy") {
			const requiresOptIn = await policy;
			if (requiresOptIn === null) return route.fulfill({ status: 503 });
			return route.fulfill({
				json: { requiresOptIn, privacySignal, analyticsAllowed: !requiresOptIn && !privacySignal },
			});
		}
		if (url.pathname.endsWith("get-session")) return route.fulfill({ json: null });
		if (url.pathname === "/api/analytics/traffic") {
			traffic.push({
				body: route.request().postDataJSON(),
				cookie: route.request().headers().cookie,
			});
			return route.fulfill({ json: { accepted: true } });
		}
		if (url.pathname === "/api/analytics/events")
			return route.fulfill({ json: { accepted: true } });
		return route.fulfill({ json: { json: [] } });
	});
	return { vendors, traffic };
}

test("opt-in keeps aggregate counts separate, then withdraws consent without stopping Clarity", async ({
	page,
	context,
}) => {
	test.setTimeout(120_000);
	const observed = await fixtures(page, true);
	await page.goto("/pricing?utm_source=chatgpt.com");
	await expect(page.getByRole("button", { name: "Accept all", exact: true })).toBeVisible();
	await expect.poll(() => observed.traffic.length).toBe(1);
	expect(observed.traffic[0]).toEqual({
		body: { path: "/pricing", source: "chatgpt.com" },
		cookie: undefined,
	});
	expect(observed.vendors).toEqual([]);
	await page.getByRole("button", { name: "Accept all", exact: true }).click();
	await expect.poll(() => observed.vendors.length).toBe(2);
	await expect
		.poll(async () => (await context.cookies()).find((c) => c.name === "consent_version")?.value)
		.toBe("2");
	await expect
		.poll(async () => (await context.cookies()).some((c) => c.name === "ezimage_first_touch"))
		.toBe(true);
	const firstTouch = (await context.cookies()).find((c) => c.name === "ezimage_first_touch")!.value;
	await page.goto("/pricing");
	await expect.poll(() => observed.vendors.length).toBe(4);
	expect((await context.cookies()).find((c) => c.name === "ezimage_first_touch")?.value).toBe(
		firstTouch,
	);
	await context.addCookies(
		["_ga", "_ga_TEST123456", "_clck", "_clsk"].map((name) => ({
			name,
			value: "fixture",
			url: page.url(),
		})),
	);
	await page.getByRole("button", { name: "Privacy settings", exact: true }).click();
	await page.getByRole("button", { name: "Reject non-essential", exact: true }).click();
	await expect
		.poll(async () =>
			page.evaluate(() => {
				const clarity = (window as Window & { clarity?: { q?: unknown[][] } }).clarity;
				return clarity?.q?.at(-1);
			}),
		)
		.toEqual(["consentv2", { analytics_Storage: "denied", ad_Storage: "denied" }]);
	expect(
		await page.evaluate(() =>
			(window as Window & { clarity?: { q?: unknown[][] } }).clarity?.q?.some(
				(command) => command[0] === "stop",
			),
		),
	).toBe(false);
	expect((await context.cookies()).some((c) => c.name === "ezpic_analytics_session")).toBe(false);
	expect((await context.cookies()).some((c) => c.name === "ezimage_first_touch")).toBe(false);
	expect(
		(await context.cookies()).filter(
			(c) => /^_ga(?:_|$)/.test(c.name) || ["_clck", "_clsk"].includes(c.name),
		),
	).toEqual([]);
	expect((await context.cookies()).find((c) => c.name === "consent")?.value).toBe("false");
	const trafficCount = observed.traffic.length;
	await page.reload();
	await expect(page.getByRole("button", { name: "Privacy settings", exact: true })).toBeVisible();
	await expect(page.locator("[data-consent-banner]")).toHaveCount(0);
	expect(observed.traffic.length).toBe(trafficCount);
	await page.screenshot({
		path: test.info().outputPath("privacy-choice.png"),
		animations: "disabled",
	});
});

test("trusted opt-out region skips the banner while preserving a privacy choice", async ({
	page,
	context,
}) => {
	test.setTimeout(120_000);
	const observed = await fixtures(page, false);
	await page.goto("/pricing");
	await expect.poll(() => observed.vendors.length).toBe(2);
	await expect(page.locator("[data-consent-banner]")).toHaveCount(0);
	expect((await context.cookies()).find((c) => c.name === "consent")?.value).toBe("regional");
	const settings = page.getByRole("button", { name: "Privacy settings", exact: true });
	await settings.focus();
	await page.keyboard.press("Enter");
	const notice = page.getByRole("region", { name: "We value your privacy" });
	await expect(notice).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(notice.getByRole("link", { name: "Privacy Policy", exact: true })).toBeFocused();
	await expect(
		page.getByRole("button", { name: "Reject non-essential", exact: true }),
	).toBeVisible();
	await notice.getByRole("button", { name: "Close", exact: true }).click();
	await expect(settings).toBeFocused();
	await expect(notice).toHaveCount(0);
	expect((await context.cookies()).find((c) => c.name === "consent")?.value).toBe("regional");
});

test("unavailable policy requires opt-in and keeps only the credentialless counter", async ({
	page,
	context,
}) => {
	const observed = await fixtures(page, null);
	await page.goto("/pricing");
	await expect(page.getByRole("button", { name: "Accept all", exact: true })).toBeVisible();
	await expect
		.poll(() => observed.traffic)
		.toEqual([{ body: { path: "/pricing", source: "direct" }, cookie: undefined }]);
	expect(observed.vendors).toEqual([]);
	expect((await context.cookies()).some((cookie) => cookie.name === "consent")).toBe(false);
});

test("privacy signal blocks aggregate traffic and recording even in opt-out regions", async ({
	page,
}) => {
	test.setTimeout(120_000);
	const observed = await fixtures(page, false, true);
	await page.goto("/pricing");
	await page.getByRole("button", { name: "Privacy settings", exact: true }).click();
	await expect(
		page.getByText("Your browser privacy signal disables analytics and recording."),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Accept all", exact: true })).toBeDisabled();
	expect(observed.vendors).toEqual([]);
	expect(observed.traffic).toEqual([]);
});

for (const choice of [
	{ button: "Accept all", cookie: "true", width: 320, height: 640 },
	{ button: "Reject non-essential", cookie: "false", width: 844, height: 390 },
]) {
	test(`late privacy controls can ${choice.cookie === "true" ? "accept" : "reject"} inside the automatic preview`, async ({
		page,
		context,
	}) => {
		const policy = Promise.withResolvers<boolean>();
		await fixtures(page, policy.promise);
		await page.setViewportSize({ width: choice.width, height: choice.height });
		await page.emulateMedia({ reducedMotion: "reduce" });
		try {
			await page.goto("/");
			const preview = page.getByRole("dialog");
			const title = preview.getByRole("heading");
			const notice = preview.getByRole("region", { name: "We value your privacy" });
			const choiceButton = notice.getByRole("button", { name: choice.button, exact: true });
			await expect(title).toBeFocused();
			await expect(notice).toHaveCount(0);
			const initialTop = (await preview.boundingBox())!.y;
			policy.resolve(true);
			await expect(choiceButton).toBeEnabled();
			await expect(page.getByRole("region", { name: "We value your privacy" })).toHaveCount(1);
			expect((await preview.boundingBox())!.y).toBe(initialTop);
			await expect(title).toBeFocused();
			if (choice.cookie === "true") {
				await choiceButton.click();
			} else {
				for (
					let count = 0;
					count < 12 &&
					!(await choiceButton.evaluate((button) => button === document.activeElement));
					count++
				) {
					await page.keyboard.press("Tab");
				}
				await expect(choiceButton).toBeFocused();
				await page.keyboard.press("Enter");
			}
			await expect(title).toBeFocused();
			await expect(notice).toHaveCount(0);
			await expect
				.poll(
					async () => (await context.cookies()).find((cookie) => cookie.name === "consent")?.value,
				)
				.toBe(choice.cookie);
			await page.keyboard.press("Escape");
			await expect(preview).toHaveCount(0);
			await expect(page.locator("button.homepage-showcase-trigger")).toBeFocused();
		} finally {
			policy.resolve(true);
		}
	});
}

test("late notices keep the translated editor in place at a narrow and a landscape viewport", async ({
	page,
	context,
}) => {
	const offer = Promise.withResolvers<boolean>();
	const policy = Promise.withResolvers<boolean>();
	await fixtures(page, policy.promise);
	await page.route("**/api/rpc/payments/getImagePassOffer**", async (route) =>
		route.fulfill({ json: { json: { available: await offer.promise } } }),
	);
	const banner = page.locator('[data-test="image-pass-banner"]');
	const notice = page.locator("[data-consent-banner]");
	const measure = () =>
		page.evaluate(() =>
			["[data-studio-shell]", ".studio-home", "#image-editor h1", "[data-generation-mode]"].map(
				(selector) => {
					const { x, y, width } = document.querySelector(selector)!.getBoundingClientRect();
					return { x, y, width };
				},
			),
		);
	try {
		await page.setViewportSize({ width: 320, height: 640 });
		await page.goto("/create?lang=fr");
		await expect(banner).toHaveCount(0);
		await expect(notice).toHaveCount(0);
		await page.evaluate(() => document.fonts.ready.then(() => undefined));
		const initialLayout = await measure();
		offer.resolve(true);
		await expect(banner.getByRole("link", { name: "Acheter le pack" })).toHaveAttribute(
			"href",
			"/image-pass",
		);
		expect(await measure()).toEqual(initialLayout);
		policy.resolve(true);
		await expect(notice).toBeVisible();
		expect(await measure()).toEqual(initialLayout);

		for (const viewport of [
			{ width: 320, height: 640 },
			{ width: 844, height: 390 },
		]) {
			await page.setViewportSize(viewport);
			const box = (await banner.boundingBox())!;
			const link = (await banner.getByRole("link").boundingBox())!;
			expect(link.y).toBeGreaterThanOrEqual(box.y);
			expect(link.y + link.height).toBeLessThanOrEqual(box.y + box.height);
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
		}
		const landscapeLayout = await measure();
		await banner.getByRole("button", { name: "Fermer l’offre du pack d’images" }).click();
		await expect(banner).toHaveCount(0);
		expect(await measure()).toEqual(landscapeLayout);
		await page.reload();
		await expect(notice).toBeVisible();
		await expect(banner).toHaveCount(0);
		expect((await context.cookies()).find((cookie) => cookie.name === "consent")).toBeUndefined();
	} finally {
		offer.resolve(false);
		policy.resolve(true);
	}
});
