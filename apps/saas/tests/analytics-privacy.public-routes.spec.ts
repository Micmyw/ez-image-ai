import { expect, test, type Page } from "@playwright/test";

async function fixtures(page: Page, requiresOptIn: boolean, privacySignal = false) {
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
		if (url.pathname === "/api/analytics/policy")
			return route.fulfill({
				json: { requiresOptIn, privacySignal, analyticsAllowed: !requiresOptIn && !privacySignal },
			});
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
	await expect(page.getByRole("button", { name: "Allow analytics", exact: true })).toBeVisible();
	await expect.poll(() => observed.traffic.length).toBe(1);
	expect(observed.traffic[0]).toEqual({
		body: { path: "/pricing", source: "chatgpt.com" },
		cookie: undefined,
	});
	expect(observed.vendors).toEqual([]);
	await page.getByRole("button", { name: "Allow analytics", exact: true }).click();
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
	await page.getByRole("button", { name: "Decline analytics", exact: true }).click();
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
	await page.getByRole("button", { name: "Privacy settings", exact: true }).click();
	await expect(page.getByRole("button", { name: "Decline analytics", exact: true })).toBeVisible();
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
	await expect(page.getByRole("button", { name: "Allow analytics", exact: true })).toBeDisabled();
	expect(observed.vendors).toEqual([]);
	expect(observed.traffic).toEqual([]);
});
