import { expect, type Page } from "@playwright/test";

const advertisingHosts = [
	"ads.ezimageai.com",
	"highrevenueformat.com",
	"profitableratecpmnetwork.com",
];

export function isAdvertisingUrl(value: string) {
	const { hostname } = new URL(value);
	return advertisingHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

export async function watchAdFreeBrowsing(page: Page, baseURL: string) {
	const observed = { advertisingRequests: [] as string[], clarityRequests: [] as string[] };
	page.context().on("request", (request) => {
		if (isAdvertisingUrl(request.url())) observed.advertisingRequests.push(request.url());
		if (new URL(request.url()).hostname === "www.clarity.ms")
			observed.clarityRequests.push(request.url());
	});
	await page.context().route("**/*", async (route) => {
		const url = new URL(route.request().url());
		// Observe before aborting: a blocked advertising attempt must still fail the test.
		if (isAdvertisingUrl(url.href)) return route.abort();
		if (["www.clarity.ms", "www.googletagmanager.com"].includes(url.hostname))
			return route.fulfill({
				contentType: "application/javascript",
				body: "/* browser fixture: no external analytics collection */",
			});
		if (url.origin !== new URL(baseURL).origin) return route.abort();
		if (url.pathname === "/api/analytics/policy")
			return route.fulfill({
				json: { requiresOptIn: false, privacySignal: false, analyticsAllowed: true },
			});
		if (["/api/analytics/traffic", "/api/analytics/events"].includes(url.pathname))
			return route.fulfill({ json: { accepted: true } });
		if (url.pathname === "/api/auth/get-session") return route.fulfill({ json: null });
		if (url.pathname.startsWith("/api/") && route.request().method() !== "GET")
			return route.abort();
		return route.continue();
	});
	await page.context().addCookies([
		{ name: "consent", value: "true", url: baseURL },
		{ name: "consent_version", value: "2", url: baseURL },
	]);
	return observed;
}

export async function expectNoAdvertising(
	page: Page,
	observed: Awaited<ReturnType<typeof watchAdFreeBrowsing>>,
) {
	await expect(
		page.locator("[data-blog-ads], [data-blog-ad], iframe[data-blog-ad-frame], .blog-ad"),
	).toHaveCount(0);
	await expect(
		page.locator(
			'script[src*="highrevenueformat"], script[src*="profitableratecpmnetwork"], iframe[src*="ads.ezimageai.com"]',
		),
	).toHaveCount(0);
	expect(page.frames().filter((frame) => isAdvertisingUrl(frame.url()))).toEqual([]);
	expect(observed.advertisingRequests).toEqual([]);
}
