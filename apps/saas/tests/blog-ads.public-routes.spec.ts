import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
	BLOG_AD_ARTICLE_PATHS,
	BLOG_AD_ORIGIN,
} from "../modules/public-content/lib/blog-ad-routing";
import {
	BLOG_AD_BANNER_WIDTH,
	BLOG_AD_NATIVE_HEIGHT,
	BLOG_AD_PREVIEW_EXPIRES_AT,
	BLOG_AD_SANDBOX,
	getBlogAdDocument,
	getBlogAdDocumentUrl,
	type BlogAdFormat,
} from "../modules/public-content/lib/blog-ads";

const articlePath = "/blog/tesco-ai-meal-planning-assistant";
const adsEnabled = process.env.BLOG_ADS_ENABLED === "true";
const nativeEnabled = adsEnabled && process.env.BLOG_NATIVE_ADS_ENABLED === "true";
const previewDeadline = Date.parse(BLOG_AD_PREVIEW_EXPIRES_AT);
const adDocumentUrls = (["banner", "native"] as const).map(getBlogAdDocumentUrl);
const emptyAdFixture =
	'<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;overflow:hidden}</style></head><body><main data-blog-ad-fixture="empty">Offline empty document fixture; no advertisement.</main></body></html>';
const adHosts = ["highrevenueformat.com", "profitableratecpmnetwork.com"];
const adFrames = "iframe[data-blog-ad-frame]";
const baseUrl = process.env.NEXT_PUBLIC_SAAS_URL ?? "http://localhost:3000";
const fixturePath = "/__blog-ad-isolation-fixture";
const privateRouteMarker = "blog-ad-private-route-canary-20261011";
const fixtureUrl = new URL(
	`${fixturePath}?private=${privateRouteMarker}#${privateRouteMarker}`,
	baseUrl,
).href;

type CspViolation = {
	blockedURI: string;
	directive: string;
	disposition: string;
	originalPolicy: string;
};
type CspAudit = {
	blockedURL: string | null;
	directive: string;
	isReportOnly: boolean;
	violationType: string;
};
type DocumentAddress = { baseURI: string; url: string; referrer: string };
type BlogAdLifecycleObservation = {
	type: string;
	time: number;
	persisted: boolean | null;
	readyState: string;
	control: string | null;
	frames: number;
};
type AdFrameObservation = {
	format: string;
	phase: string;
	geometry: { width: number; height: number } | null;
	document: DocumentAddress;
	violations: CspViolation[];
	resources: { name: string; initiatorType: string; transferSize: number; duration: number }[];
};

test.use({
	storageState: { cookies: [], origins: [] },
	launchOptions: { chromiumSandbox: true },
	serviceWorkers: "block",
});

function isAdUrl(value: string) {
	try {
		const { hostname } = new URL(value);
		return adHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
	} catch {
		return false;
	}
}

async function watchApp(page: Page, context: BrowserContext) {
	const evidence = {
		adRequests: [] as { url: string }[],
		adNetworkAttempts: [] as string[],
		adRequestFailures: [] as { url: string; error: string }[],
		fixtureDocumentRequests: [] as { url: string; referer: string; cookie: string }[],
		unexpectedAdDocumentRequests: [] as string[],
		crossOriginSafetyAborts: [] as string[],
		businessActions: [] as string[],
		cspConsole: [] as string[],
		cspAudits: [] as CspAudit[],
		frameObservations: [] as AdFrameObservation[],
		mainFrameNavigations: [] as string[],
		documentBoundaries: [] as { from: string; to: string; before: number; after: number }[],
		clearanceChecks: [] as {
			path: string;
			adFrameCount: number;
			adDocumentContextCount: number;
			observedPopupCount: number;
		}[],
		popups: 0,
	};
	const devtools = await context.newCDPSession(page);
	devtools.on("Audits.issueAdded", ({ issue }) => {
		if (issue.code !== "ContentSecurityPolicyIssue") return;
		const detail = issue.details.contentSecurityPolicyIssueDetails;
		if (!detail) return;
		evidence.cspAudits.push({
			blockedURL: detail.blockedURL ?? null,
			directive: detail.violatedDirective,
			isReportOnly: detail.isReportOnly,
			violationType: detail.contentSecurityPolicyViolationType,
		});
	});
	await devtools.send("Audits.enable");
	context.on("request", (request) => {
		if (isAdUrl(request.url())) evidence.adRequests.push({ url: request.url() });
	});
	context.on("requestfailed", (request) => {
		if (isAdUrl(request.url()) || request.url().startsWith(BLOG_AD_ORIGIN))
			evidence.adRequestFailures.push({
				url: request.url(),
				error: request.failure()?.errorText ?? "unknown",
			});
	});
	page.on("console", (message) => {
		const value = message.text();
		if (
			/content security policy|violates.*directive/i.test(value) &&
			/ads\.ezimageai|highrevenueformat|profitableratecpmnetwork/.test(value)
		)
			evidence.cspConsole.push(value);
	});
	context.on("page", (popup) => {
		evidence.popups++;
		void popup.close().catch(() => {});
	});
	page.on("framenavigated", (frame) => {
		if (frame === page.mainFrame() && frame.url().startsWith(new URL(baseUrl).origin))
			evidence.mainFrameNavigations.push(new URL(frame.url()).pathname);
	});
	await page.addInitScript(() => {
		const violations: CspViolation[] = [];
		const lifecycle: BlogAdLifecycleObservation[] = [];
		Object.defineProperty(window, "__blogAdCspViolations", { value: violations });
		Object.defineProperty(window, "__blogAdLifecycle", { value: lifecycle });
		const record = (type: string, persisted: boolean | null = null) => {
			lifecycle.push({
				type,
				time: performance.now(),
				persisted,
				readyState: document.readyState,
				control: document.querySelector("[data-blog-ads] button")?.textContent ?? null,
				frames: document.querySelectorAll("iframe[data-blog-ad-frame]").length,
			});
		};
		for (const type of ["pagehide", "pageshow"])
			window.addEventListener(type, (event) => {
				record(type, (event as PageTransitionEvent).persisted);
				queueMicrotask(() => record(`${type}-after-dispatch`));
			});
		document.addEventListener(
			"click",
			(event) => {
				if (!(event.target instanceof Element)) return;
				if (!event.target.closest("[data-blog-ads] button")) return;
				record("display-control-click");
				queueMicrotask(() => record("display-control-click-after-dispatch"));
				requestAnimationFrame(() => record("display-control-click-next-frame"));
			},
			true,
		);
		document.addEventListener("securitypolicyviolation", (event) => {
			violations.push({
				blockedURI: event.blockedURI,
				directive: event.effectiveDirective,
				disposition: event.disposition,
				originalPolicy: event.originalPolicy,
			});
		});
	});
	// Only these two child navigations are fulfilled locally. No provider script is
	// present in the fixture; all other cross-origin traffic is blocked before send.
	// Positive DOM/address checks below distinguish a loaded fixture from CSP refusal
	// or a safety abort. Historical data: rejection reports remain historical evidence.
	await context.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (adDocumentUrls.includes(url.href) && request.isNavigationRequest()) {
			// allHeaders includes Cookie; request.headers omits security-sensitive headers.
			const headers = await request.allHeaders();
			evidence.fixtureDocumentRequests.push({
				url: url.href,
				referer: headers.referer ?? "",
				cookie: headers.cookie ?? "",
			});
			return route.fulfill({
				contentType: "text/html",
				headers: { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" },
				body: emptyAdFixture,
			});
		}
		if (url.origin === BLOG_AD_ORIGIN) evidence.unexpectedAdDocumentRequests.push(url.href);
		if (isAdUrl(url.href)) evidence.adNetworkAttempts.push(url.href);
		if (url.origin !== new URL(baseUrl).origin) {
			evidence.crossOriginSafetyAborts.push(url.origin + url.pathname);
			return route.abort();
		}
		if (/createCheckout|createCreditPack|createGeneration/.test(url.pathname)) {
			evidence.businessActions.push(url.pathname);
			return route.abort();
		}
		return route.continue();
	});
	return evidence;
}

async function acceptExistingConsent(context: BrowserContext) {
	await context.addCookies([
		{ name: "consent", value: "true", url: new URL(baseUrl).origin },
		{ name: "consent_version", value: "2", url: new URL(baseUrl).origin },
	]);
}

async function expectAppUrl(page: Page, pathname: string) {
	await expect(page).toHaveURL(new URL(pathname, baseUrl).href, { timeout: 30_000 });
}

async function expectNoHostAdCode(page: Page) {
	await expect(
		page.locator('script[src*="highrevenueformat"],script[src*="profitableratecpmnetwork"]'),
	).toHaveCount(0);
	expect(await page.evaluate(() => "atOptions" in window)).toBe(false);
	await expect(page.locator('[id="container-0a9986f36ff843c117e0f20e732a1e08"]')).toHaveCount(0);
}

async function expectNoAdNetwork(evidence: Awaited<ReturnType<typeof watchApp>>) {
	expect(evidence.adRequests).toEqual([]);
	expect(evidence.adNetworkAttempts).toEqual([]);
	expect(evidence.unexpectedAdDocumentRequests).toEqual([]);
	expect(evidence.adRequestFailures).toEqual([]);
	expect(evidence.businessActions).toEqual([]);
}

async function expectNoAds(page: Page, evidence: Awaited<ReturnType<typeof watchApp>>) {
	// Count every retained DOM node, including Next Activity's hidden article DOM.
	await expect(page.locator(adFrames)).toHaveCount(0);
	await expect
		.poll(() => page.frames().filter((frame) => adDocumentUrls.includes(frame.url())).length)
		.toBe(0);
	await expectNoHostAdCode(page);
	await expectNoAdNetwork(evidence);
	expect(evidence.popups).toBe(0);
	evidence.clearanceChecks.push({
		path: new URL(page.url()).pathname,
		adFrameCount: await page.locator(adFrames).count(),
		adDocumentContextCount: page.frames().filter((frame) => adDocumentUrls.includes(frame.url()))
			.length,
		observedPopupCount: evidence.popups,
	});
}

async function attachAppEvidence(
	page: Page,
	evidence: Awaited<ReturnType<typeof watchApp>>,
	name = "app-ad-isolation-evidence",
) {
	const violations = await page.evaluate(
		() => (window as Window & { __blogAdCspViolations?: unknown }).__blogAdCspViolations ?? [],
	);
	await test.info().attach(name, {
		body: JSON.stringify(
			{
				...evidence,
				violations,
				remainingAdFrameCount: await page.locator(adFrames).count(),
				adsEnabled,
				nativeEnabled,
				previewExpiresAt: BLOG_AD_PREVIEW_EXPIRES_AT,
				observationBoundary:
					"The actual app response CSP and article navigation are exercised, but both fixed advertising URLs are fulfilled with self-authored empty HTML. Other cross-origin requests are safety-aborted. Loaded fixture DOM and exact document addresses establish transport, not live inventory, supplier behavior, native responsiveness, authenticated account behavior or checkout execution. Standalone sandbox/data-access/timer probes are separate synthetic fixtures.",
			},
			null,
			2,
		),
		contentType: "application/json",
	});
}

function previewPath(format: BlogAdFormat) {
	return `${articlePath}?blogAdTest=${format}`;
}

function requirePreviewWindow() {
	test.skip(
		Date.now() >= previewDeadline,
		`The finite article preview expired at ${BLOG_AD_PREVIEW_EXPIRES_AT}; no inventory is activated.`,
	);
}

async function requireCredentialless(page: Page) {
	const supported = await page.evaluate(() => "credentialless" in document.createElement("iframe"));
	test.skip(
		!supported,
		"This browser intentionally keeps blog ads off without credentialless support.",
	);
}

function frameSources(policy: string) {
	return (policy.split(";").find((part) => part.trim().startsWith("frame-src ")) ?? "")
		.trim()
		.split(/\s+/)
		.slice(1);
}

async function observeAdFrames(
	page: Page,
	evidence: Awaited<ReturnType<typeof watchApp>>,
	phase = "after-empty-fixture-mount",
) {
	for (const frame of page.frames()) {
		if (frame === page.mainFrame()) continue;
		const element = await frame.frameElement();
		const format = await element.getAttribute("data-blog-ad-frame");
		if (format !== "banner" && format !== "native") continue;
		await expect.poll(() => frame.url()).toBe(getBlogAdDocumentUrl(format));
		await expect(frame.locator('[data-blog-ad-fixture="empty"]')).toHaveCount(1);
		const box = await element.boundingBox();
		const observation = await frame.evaluate(() => ({
			document: { baseURI: document.baseURI, url: document.URL, referrer: document.referrer },
			violations:
				(window as Window & { __blogAdCspViolations?: CspViolation[] }).__blogAdCspViolations ?? [],
			resources: (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).map(
				(entry) => ({
					name: new URL(entry.name).origin + new URL(entry.name).pathname,
					initiatorType: entry.initiatorType,
					transferSize: entry.transferSize,
					duration: entry.duration,
				}),
			),
		}));
		expect(observation.document).toEqual({
			url: getBlogAdDocumentUrl(format),
			baseURI: getBlogAdDocumentUrl(format),
			referrer: "",
		});
		expect(observation.resources).toEqual([]);
		const owner = page.locator(`iframe[data-blog-ad-frame="${format}"]`);
		await expect(owner).toHaveAttribute("sandbox", BLOG_AD_SANDBOX);
		await expect(owner).toHaveAttribute("referrerpolicy", "no-referrer");
		await expect(owner).toHaveAttribute("src", getBlogAdDocumentUrl(format));
		await expect(owner).not.toHaveAttribute("srcdoc");
		expect(await element.evaluate((node) => Reflect.get(node, "credentialless"))).toBe(true);
		evidence.frameObservations.push({
			format,
			phase,
			geometry: box ? { width: box.width, height: box.height } : null,
			...observation,
		});
	}
}

async function showAds(
	page: Page,
	evidence: Awaited<ReturnType<typeof watchApp>>,
	format: BlogAdFormat = "banner",
) {
	await page.getByRole("button", { name: "Show blog ads", exact: true }).click();
	await page.locator(`[data-blog-ad="${format}"]:visible`).scrollIntoViewIfNeeded();
	try {
		await expect(page.locator(`iframe[data-blog-ad-frame="${format}"]`)).toHaveCount(1);
	} catch (error) {
		await test.info().attach("display-opt-in-lifecycle-diagnostic.json", {
			body: JSON.stringify(
				await page.evaluate(() => ({
					pathname: window.location.pathname,
					readyState: document.readyState,
					timeOrigin: performance.timeOrigin,
					control: document.querySelector("[data-blog-ads] button")?.textContent ?? null,
					frames: document.querySelectorAll("iframe[data-blog-ad-frame]").length,
					lifecycle:
						(window as Window & { __blogAdLifecycle?: BlogAdLifecycleObservation[] })
							.__blogAdLifecycle ?? [],
				})),
				null,
				2,
			),
			contentType: "application/json",
		});
		throw error;
	}
	await expect(page.locator(adFrames)).toHaveCount(1);
	await observeAdFrames(page, evidence);
	await expectNoHostAdCode(page);
	await expectNoAdNetwork(evidence);
	expect(evidence.popups).toBe(0);
}

async function clickArticleBoundary(
	page: Page,
	evidence: Awaited<ReturnType<typeof watchApp>>,
	selector: string,
	destination: string,
) {
	const from = page.url();
	const before = await page.evaluate(() => performance.timeOrigin);
	await page.locator(selector).click();
	await expectAppUrl(page, destination);
	const after = await page.evaluate(() => performance.timeOrigin);
	expect(after).not.toBe(before);
	evidence.documentBoundaries.push({ from, to: page.url(), before, after });
}

test.describe("real app blog ad isolation (empty document fixtures, no inventory)", () => {
	for (const route of [
		"/",
		"/create",
		"/login",
		"/pricing",
		"/blog",
		"/blog/1980s-ai-photo",
		"/blog/raindance-ai-trend",
		"/blog/vidu-q4-preview",
		"/blog/__blog_ad_unknown_article__",
	]) {
		test(`direct ${route} excludes the advertising origin and creates no ad contexts`, async ({
			page,
			context,
		}) => {
			test.setTimeout(90_000);
			await acceptExistingConsent(context);
			const evidence = await watchApp(page, context);
			const response = await page.goto(route);
			expect(response?.status()).toBe(route.includes("__blog_ad_unknown_article__") ? 404 : 200);
			expect(frameSources(response?.headers()["content-security-policy"] ?? "")).toEqual([
				"https://challenges.cloudflare.com",
			]);
			await expect(page.locator("[data-blog-ads]")).toHaveCount(0);
			await expectNoAds(page, evidence);
			expect(evidence.fixtureDocumentRequests).toEqual([]);
			await attachAppEvidence(page, evidence);
		});
	}

	test("only the three reviewed ordinary article responses allow the exact ad origin", async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		const evidence = await watchApp(page, context);
		for (const pathname of BLOG_AD_ARTICLE_PATHS) {
			const response = await page.goto(pathname);
			expect(response?.status()).toBe(200);
			const policy = response?.headers()["content-security-policy"] ?? "";
			expect(frameSources(policy)).toEqual(["https://challenges.cloudflare.com", BLOG_AD_ORIGIN]);
			expect(policy).not.toMatch(/highrevenueformat|profitableratecpmnetwork|frame-src[^;]*data:/);
			await expectNoAds(page, evidence);
		}
		expect(evidence.fixtureDocumentRequests).toEqual([]);
		await attachAppEvidence(page, evidence);
	});

	test("master off and unrelated preview parameters leave articles without ad containers", async ({
		page,
		context,
	}) => {
		test.skip(
			adsEnabled,
			"Run with the production master switch off to verify default-off rendering.",
		);
		test.setTimeout(90_000);
		await acceptExistingConsent(context);
		const evidence = await watchApp(page, context);
		for (const pathname of [
			articlePath,
			`${articlePath}?blogAdTest=unrecognized`,
			"/blog/private-image-editing-workflow?blogAdTest=banner",
			"/blog/ai-image-editing-prompts?blogAdTest=native",
		]) {
			await page.goto(pathname);
			await expect(page.locator("[data-blog-ads]")).toHaveCount(0);
			await expectNoAds(page, evidence);
		}
		expect(evidence.fixtureDocumentRequests).toEqual([]);
		await attachAppEvidence(page, evidence);
	});

	test("the finite preview requires consent and fresh opt-in, then loads only owned empty documents", async ({
		page,
		context,
	}) => {
		requirePreviewWindow();
		test.setTimeout(90_000);
		await page.setViewportSize({ width: 1600, height: 1000 });
		const evidence = await watchApp(page, context);
		const response = await page.goto(previewPath("native"));
		await requireCredentialless(page);
		expect(response?.status()).toBe(200);
		const policy = response?.headers()["content-security-policy"] ?? "";
		expect(frameSources(policy)).toEqual(["https://challenges.cloudflare.com", BLOG_AD_ORIGIN]);
		expect(response?.headers()["x-robots-tag"]).toMatch(/noindex/);
		await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
		await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
			"href",
			new URL(articlePath, baseUrl).href,
		);
		await expect(page.locator("[data-blog-ads]")).toHaveCount(1);
		await expect(page.getByRole("button", { name: "Show blog ads", exact: true })).toHaveCount(0);
		await expectNoAds(page, evidence);
		expect(evidence.fixtureDocumentRequests).toEqual([]);
		await page.getByRole("button", { name: "Allow analytics", exact: true }).click();
		await expect(page.getByRole("button", { name: "Show blog ads", exact: true })).toBeVisible();
		await expectNoAds(page, evidence);
		expect(evidence.fixtureDocumentRequests).toEqual([]);
		// A synthetic ad-origin cookie checks credentialless transport without user data.
		await context.addCookies([
			{ name: "blog-ad-cookie-canary", value: "synthetic-only", url: BLOG_AD_ORIGIN },
		]);
		await expect(page.locator('[data-blog-ad="banner"]')).toHaveCount(0);
		await showAds(page, evidence, "native");
		expect(evidence.fixtureDocumentRequests.map((entry) => entry.url).sort()).toEqual([
			getBlogAdDocumentUrl("native"),
		]);
		for (const request of evidence.fixtureDocumentRequests) {
			expect(request.referer).toBe("");
			expect(request.cookie).toBe("");
		}
		const violations = await page.evaluate(
			() =>
				(window as Window & { __blogAdCspViolations?: CspViolation[] }).__blogAdCspViolations ?? [],
		);
		expect(
			violations.filter(
				(entry) => entry.directive === "frame-src" && entry.disposition === "enforce",
			),
		).toEqual([]);
		expect(
			evidence.cspAudits.filter((entry) => entry.directive === "frame-src" && !entry.isReportOnly),
		).toEqual([]);
		await page.getByRole("button", { name: "Hide blog ads", exact: true }).click();
		await expectNoAds(page, evidence);
		await attachAppEvidence(page, evidence);
	});

	test("real article links change documents and history restores require a fresh display opt-in", async ({
		page,
		context,
	}) => {
		requirePreviewWindow();
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 1600, height: 1000 });
		await acceptExistingConsent(context);
		const evidence = await watchApp(page, context);
		await page.goto("/create");
		await requireCredentialless(page);
		await expectNoAds(page, evidence);
		await page.locator('[data-footer-navigation] a[href="/blog"]:visible').click();
		await expectAppUrl(page, "/blog");
		await expectNoAds(page, evidence);
		await clickArticleBoundary(
			page,
			evidence,
			`.blog-grid h2 a[href="${articlePath}"]:visible`,
			articlePath,
		);
		await expectNoAds(page, evidence);
		await page.goto(previewPath("banner"));
		await expectNoAds(page, evidence);
		await showAds(page, evidence);
		await clickArticleBoundary(page, evidence, '.blog-breadcrumb a[href="/"]:visible', "/");
		await expectNoAds(page, evidence);
		const requestsAfterExit = evidence.fixtureDocumentRequests.length;
		await page.goBack();
		await expectAppUrl(page, previewPath("banner"));
		await expect(page.getByRole("button", { name: "Show blog ads", exact: true })).toBeVisible();
		await expectNoAds(page, evidence);
		expect(evidence.fixtureDocumentRequests).toHaveLength(requestsAfterExit);
		await showAds(page, evidence);
		await page.getByRole("button", { name: "Hide blog ads", exact: true }).click();
		await expectNoAds(page, evidence);
		await showAds(page, evidence);
		await page.goForward();
		await expectAppUrl(page, "/");
		await expectNoAds(page, evidence);
		const requestsBeforeRestore = evidence.fixtureDocumentRequests.length;
		await page.goBack();
		await expectAppUrl(page, previewPath("banner"));
		await expectNoAds(page, evidence);
		expect(evidence.fixtureDocumentRequests).toHaveLength(requestsBeforeRestore);
		await showAds(page, evidence);
		await page.reload();
		await expect(page.getByRole("button", { name: "Show blog ads", exact: true })).toBeVisible();
		await expectNoAds(page, evidence);
		const requestsBeforeDirectory = evidence.fixtureDocumentRequests.length;
		await showAds(page, evidence);
		await clickArticleBoundary(page, evidence, '.blog-breadcrumb a[href="/blog"]:visible', "/blog");
		await expectNoAds(page, evidence);
		await page.goBack();
		await expectAppUrl(page, previewPath("banner"));
		await expectNoAds(page, evidence);
		expect(evidence.fixtureDocumentRequests).toHaveLength(requestsBeforeDirectory + 1);
		await attachAppEvidence(page, evidence);
	});

	test("mobile hides the banner before loading and one empty native fixture fits 390px, 320px and 1280px", async ({
		page,
		context,
	}) => {
		requirePreviewWindow();
		await page.setViewportSize({ width: 390, height: 900 });
		await acceptExistingConsent(context);
		const evidence = await watchApp(page, context);
		await page.goto(previewPath("banner"));
		await requireCredentialless(page);
		await page.getByRole("button", { name: "Show blog ads", exact: true }).click();
		await expect(page.locator('[data-blog-ad="banner"]')).toBeHidden();
		await expectNoAds(page, evidence);
		expect(evidence.fixtureDocumentRequests).toEqual([]);
		await page.goto(previewPath("native"));
		await page.getByRole("button", { name: "Show blog ads", exact: true }).click();
		await page.locator('[data-blog-ad="native"]:visible').scrollIntoViewIfNeeded();
		await expect(page.locator('iframe[data-blog-ad-frame="native"]')).toHaveCount(1);
		for (const width of [390, 320, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			await expect(page.locator('[data-blog-ad="banner"]')).toHaveCount(0);
			await expect(page.locator('iframe[data-blog-ad-frame="banner"]')).toHaveCount(0);
			await expect
				.poll(async () => (await page.locator(adFrames).boundingBox())?.width ?? Infinity)
				.toBeLessThanOrEqual(width);
			const box = await page.locator(adFrames).boundingBox();
			expect(box?.height).toBe(BLOG_AD_NATIVE_HEIGHT);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
				true,
			);
			await observeAdFrames(page, evidence, `empty-native-fixture-${width}px`);
		}
		expect(evidence.fixtureDocumentRequests.map((entry) => entry.url)).toEqual([
			getBlogAdDocumentUrl("native"),
		]);
		await page.getByRole("button", { name: "Hide blog ads", exact: true }).click();
		await expectNoAds(page, evidence);
		await attachAppEvidence(page, evidence);
	});

	test("native history changes across an article boundary reload its response policy", async ({
		page,
		context,
	}) => {
		const evidence = await watchApp(page, context);
		await page.goto("/blog");
		// A working React control establishes hydration before calling native history.
		const filter = page.getByRole("button", { name: "AI News", exact: true });
		await filter.click();
		await expect(filter).toHaveAttribute("aria-pressed", "true");
		const before = await page.evaluate(() => performance.timeOrigin);
		const [response] = await Promise.all([
			page.waitForResponse(
				(response) =>
					response.url() === new URL(articlePath, baseUrl).href &&
					response.request().isNavigationRequest(),
			),
			page.evaluate((destination) => window.history.pushState({}, "", destination), articlePath),
		]);
		await expectAppUrl(page, articlePath);
		await expect
			.poll(async () => {
				try {
					return await page.evaluate(() => performance.timeOrigin);
				} catch {
					return before;
				}
			})
			.not.toBe(before);
		expect(frameSources(response.headers()["content-security-policy"] ?? "")).toEqual([
			"https://challenges.cloudflare.com",
			BLOG_AD_ORIGIN,
		]);
		const articleTimeOrigin = await page.evaluate(() => performance.timeOrigin);
		await page.evaluate(() => window.history.pushState({}, "", "#synthetic-history-canary"));
		await expectAppUrl(page, `${articlePath}#synthetic-history-canary`);
		expect(await page.evaluate(() => performance.timeOrigin)).toBe(articleTimeOrigin);
		await expectNoAds(page, evidence);
		expect(evidence.fixtureDocumentRequests).toEqual([]);
		await attachAppEvidence(page, evidence, "programmatic-article-policy-boundary");
	});

	test("a browser without credentialless support keeps preview contexts unloaded", async ({
		page,
		context,
	}) => {
		requirePreviewWindow();
		await page.addInitScript(() => {
			Reflect.deleteProperty(HTMLIFrameElement.prototype, "credentialless");
		});
		await acceptExistingConsent(context);
		const evidence = await watchApp(page, context);
		await page.goto(previewPath("native"));
		expect(await page.evaluate(() => "credentialless" in document.createElement("iframe"))).toBe(
			false,
		);
		await page.getByRole("button", { name: "Show blog ads", exact: true }).click();
		await page.locator('[data-blog-ad="native"]:visible').scrollIntoViewIfNeeded();
		await settleBrowserFrames(page, 2);
		await expectNoAds(page, evidence);
		expect(evidence.fixtureDocumentRequests).toEqual([]);
		await attachAppEvidence(page, evidence, "unsupported-credentialless-preview-fixture");
	});

	test("the client deadline removes an opted-in fixture and prevents another mount", async ({
		page,
		context,
	}) => {
		requirePreviewWindow();
		await page.setViewportSize({ width: 1600, height: 1000 });
		await page.clock.install({ time: new Date(previewDeadline - 60_000) });
		await acceptExistingConsent(context);
		const evidence = await watchApp(page, context);
		await page.goto(previewPath("banner"));
		await requireCredentialless(page);
		await showAds(page, evidence);
		const requestsBeforeExpiry = evidence.fixtureDocumentRequests.length;
		await page.clock.fastForward(60_001);
		await expect(page.locator("[data-blog-ads]")).toHaveCount(0);
		await expectNoAds(page, evidence);
		expect(evidence.fixtureDocumentRequests).toHaveLength(requestsBeforeExpiry);
		await attachAppEvidence(page, evidence, "finite-preview-expiry-fixture");
	});
});

test.describe("Tesco news article and AI News discovery", () => {
	test("publishes one canonical article with metadata, factual boundaries and an official source", async ({
		page,
		context,
		request,
	}) => {
		test.setTimeout(60_000);
		const evidence = await watchApp(page, context);
		const response = await page.goto(articlePath);
		expect(response?.status()).toBe(200);
		const title = "Tesco AI Meal Planner: What the 2026 Rollout Confirms";
		const description =
			"Tesco reports a wider AI meal planner rollout from September 2026. See the confirmed timeline, access unknowns and difference from Your Clubcard Prices.";
		const canonical = new URL(articlePath, baseUrl).href;
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
		await expect(page).toHaveTitle(`${title} | EzImageAI`);
		await expect(page.locator('meta[name="description"]')).toHaveCount(1);
		await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", description);
		await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
		await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", canonical);
		await expect(page.locator('meta[property="og:type"]')).toHaveAttribute("content", "article");
		await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
			"content",
			`${title} | EzImageAI`,
		);
		const schemas = await page
			.locator('script[type="application/ld+json"]')
			.evaluateAll((scripts) =>
				scripts.flatMap((script) => {
					const data = JSON.parse(script.textContent ?? "{}");
					return data["@graph"] ?? [data];
				}),
			);
		expect(schemas).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					"@type": "BlogPosting",
					url: canonical,
					headline: title,
					description,
					datePublished: "2026-10-11",
					inLanguage: "en",
				}),
				expect.objectContaining({
					"@type": "BreadcrumbList",
					itemListElement: expect.arrayContaining([
						expect.objectContaining({ position: 3, name: title, item: canonical }),
					]),
				}),
			]),
		);
		const body = page.locator(".blog-prose");
		await expect(body).toContainText("April 2026");
		await expect(body).toContainText("September 2026");
		await expect(body).toContainText("Your Clubcard Prices");
		await expect(body).toContainText(
			"2.5 million customers; this is not a meal-assistant access count",
		);
		await expect(body).toContainText("We have not tested the feature in a live Tesco account");
		await expect(body).not.toContainText(
			/all 23 million.*(?:access|available)|every Clubcard member has access/i,
		);
		await expect(
			page.locator('.blog-sources a[href="https://www.tescoplc.com/interim-results-202627/"]'),
		).toHaveCount(1);
		await expect(body).toContainText("11 October 2026");
		const sitemap = await request.get("/sitemap.xml");
		expect(sitemap.status()).toBe(200);
		expect(await sitemap.text()).toContain(`<loc>${canonical}</loc>`);
		await expectNoAds(page, evidence);
		const screenshotPath = test.info().outputPath("tesco-ai-news-article.png");
		await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" });
		await test.info().attach("tesco-ai-news-article", {
			path: screenshotPath,
			contentType: "image/png",
		});
	});

	test("AI News filters populated articles and its query URL follows the existing noindex rule", async ({
		page,
		context,
	}) => {
		const evidence = await watchApp(page, context);
		await page.goto("/blog");
		const filter = page.getByRole("button", { name: "AI News", exact: true });
		await filter.click();
		await expect(filter).toHaveAttribute("aria-pressed", "true");
		await expect(page.locator(`.blog-grid h2 a[href="${articlePath}"]`)).toBeVisible();
		const labels = await page.locator(".blog-grid .blog-card .blog-category").allTextContents();
		expect(labels.length).toBeGreaterThan(0);
		expect(labels.every((label) => label === "AI News")).toBe(true);
		await expectNoAds(page, evidence);
		const response = await page.goto("/blog?category=ai-news");
		expect(response?.status()).toBe(200);
		await expect(page.getByRole("button", { name: "AI News", exact: true })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await expect(page.locator(`.blog-grid h2 a[href="${articlePath}"]`)).toBeVisible();
		await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
		await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
			"href",
			new URL("/blog", baseUrl).href,
		);
		await expect(page.locator("[data-blog-ads]")).toHaveCount(0);
		await expectNoAds(page, evidence);
	});
});

// This separate synthetic host fulfills the real fixed document URLs with the shipped
// helper HTML after replacing every supplier loader with a harmless inline probe.
// It tests transport/sandbox primitives, not the static deployment's response headers,
// supplier behavior, actual native cards or any advertisement impression.
async function installCanaryFixture(page: Page) {
	const canaryScript = `(() => {
		const denied = (operation) => { try { operation(); return false; } catch { return true; } };
		const probe = {
			parentDomDenied: denied(() => { parent.document.body.dataset.canaryPollution = "true"; }),
			parentListenerDenied: denied(() => { parent.addEventListener("canary", () => {}); }),
			cookieDenied: denied(() => { document.cookie = "ad-canary=bad"; void document.cookie; }),
			localStorageDenied: denied(() => { localStorage.setItem("ad-canary", "bad"); }),
			sessionStorageDenied: denied(() => { sessionStorage.setItem("ad-canary", "bad"); }),
			popupDenied: window.open("https://ad-canary.invalid/popup", "_blank") === null,
			topNavigationDenied: denied(() => { top.location.href = "https://ad-canary.invalid/escape"; }),
		};
		const documentAddress = { baseURI: document.baseURI, url: document.URL, referrer: document.referrer };
		parent.postMessage({ kind: "blog-ad-canary-probe", probe, document: documentAddress }, "*");
		setInterval(() => parent.postMessage({ kind: "blog-ad-canary-tick" }, "*"), 10);
		const card = document.createElement("div");
		card.style.cssText = "width:100%;display:grid;grid-template-columns:minmax(0,1fr);padding:12px;overflow-wrap:anywhere";
		card.textContent = "Local display card fixture; no real advertisement or click target.";
		document.body.appendChild(card);
	})();`;
	const documents = new Map<string, string>();
	for (const format of ["banner", "native"] as const) {
		const url = getBlogAdDocumentUrl(format);
		expect(url).toBe(`${BLOG_AD_ORIGIN}/${format}.html`);
		const document = getBlogAdDocument(format).replace(
			/<script\b[^>]*\bsrc="https:[^"]+\/invoke\.js"[^>]*><\/script>/,
			`<script>${canaryScript}</script>`,
		);
		// Remove supplier executable code before mounting, independently of routing.
		expect(document).not.toMatch(/<script\b[^>]*\bsrc=/i);
		expect(document).not.toMatch(/highrevenueformat|profitableratecpmnetwork/);
		expect(document).toContain(canaryScript);
		documents.set(url, document);
	}
	const urls = JSON.stringify({
		banner: getBlogAdDocumentUrl("banner"),
		native: getBlogAdDocumentUrl("native"),
	}).replace(/</g, "\\u003c");
	const styles = readFileSync(
		path.resolve(__dirname, "../modules/public-content/components/blog-ads.css"),
		"utf8",
	);
	const fixtureRequestUrl = new URL(fixtureUrl);
	fixtureRequestUrl.hash = "";
	const hostDocument = `<!doctype html><html><head><meta charset="utf-8"><style>
		body { margin: 0; padding: 16px; } ${styles}
	</style><link rel="icon" href="data:,"></head><body><h1>Isolated canary fixture</h1>
	<button data-test="mount-banner">Mount banner</button>
	<button data-test="mount-native">Mount native</button>
	<button data-test="destroy-ad-frames">Destroy ad frames</button>
	<section class="blog-ads" data-blog-ads>
		<div class="blog-ad blog-ad-banner" data-blog-ad="banner"><div class="blog-ad-content"></div></div>
		<div class="blog-ad blog-ad-native" data-blog-ad="native"><div class="blog-ad-content"></div></div>
	</section><script>
		const documents = ${urls};
		const canaryOwners = new WeakMap();
		window.canaryEvidence = { probes: [], ticks: {}, mountCount: { banner: 0, native: 0 } };
		window.addEventListener("message", event => {
			const id = canaryOwners.get(event.source);
			if (!id || event.origin !== "null") return;
			if (event.data?.kind === "blog-ad-canary-probe") window.canaryEvidence.probes.push({ ...event.data, id });
			if (event.data?.kind === "blog-ad-canary-tick") window.canaryEvidence.ticks[id] = (window.canaryEvidence.ticks[id] || 0) + 1;
		});
		for (const format of ["banner", "native"]) {
			document.querySelector('[data-test="mount-' + format + '"]').addEventListener("click", () => {
				const slot = document.querySelector('[data-blog-ad="' + format + '"] .blog-ad-content');
				if (slot.querySelector("iframe")) return;
				const frame = document.createElement("iframe");
				if (!("credentialless" in frame)) return;
				frame.credentialless = true;
				frame.dataset.blogAdFrame = format;
				frame.name = format + ":" + ++window.canaryEvidence.mountCount[format];
				frame.title = format + " canary";
				frame.setAttribute("sandbox", ${JSON.stringify(BLOG_AD_SANDBOX)});
				frame.referrerPolicy = "no-referrer";
				frame.width = format === "banner" ? "${BLOG_AD_BANNER_WIDTH}" : "100%";
				frame.height = format === "banner" ? "90" : "${BLOG_AD_NATIVE_HEIGHT}";
				frame.src = documents[format];
				slot.appendChild(frame);
				// Retain this identity after removal so orphan timer messages cannot be hidden.
				canaryOwners.set(frame.contentWindow, frame.name);
			});
		}
		document.querySelector('[data-test="destroy-ad-frames"]').addEventListener("click", () => {
			for (const frame of document.querySelectorAll("iframe")) {
				frame.src = "about:blank";
				frame.remove();
			}
		});
	</script></body></html>`;
	const networkEvidence = {
		documentRequests: [] as string[],
		providerRequests: [] as string[],
		safetyAborts: [] as string[],
	};
	const context = page.context();
	context.on("request", (request) => {
		if (isAdUrl(request.url())) networkEvidence.providerRequests.push(request.url());
	});
	await context.route("**/*", (route) => {
		const request = route.request();
		const url = request.url();
		if (url === fixtureRequestUrl.href && request.isNavigationRequest())
			return route.fulfill({ contentType: "text/html", body: hostDocument });
		const document = documents.get(url);
		if (document && request.isNavigationRequest()) {
			networkEvidence.documentRequests.push(url);
			return route.fulfill({
				contentType: "text/html",
				headers: { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" },
				body: document,
			});
		}
		networkEvidence.safetyAborts.push(url);
		return route.abort();
	});
	await page.goto(fixtureUrl);
	await requireCredentialless(page);
	await page.evaluate(() => {
		document.cookie = "blog-ad-parent-secret=parent-only;path=/";
		localStorage.setItem("blog-ad-parent-secret", "parent-only");
		sessionStorage.setItem("blog-ad-parent-secret", "parent-only");
	});
	return networkEvidence;
}

type CanaryEvidence = {
	probes: { id: string; probe: Record<string, boolean>; document: DocumentAddress }[];
	ticks: Record<string, number>;
	mountCount: Record<BlogAdFormat, number>;
};

async function canaryEvidence(page: Page) {
	return page.evaluate(() => {
		const evidence = (window as Window & { canaryEvidence?: CanaryEvidence }).canaryEvidence;
		if (!evidence) throw new Error("The canary fixture has not initialized its evidence collector");
		return evidence;
	});
}

async function settleBrowserFrames(page: Page, frames: number) {
	await page.evaluate(
		(count) =>
			new Promise<void>((resolve) => {
				const next = () => (count-- > 0 ? requestAnimationFrame(next) : resolve());
				next();
			}),
		frames,
	);
}

test.describe("standalone fixed-origin sandbox canaries (not production inventory)", () => {
	test("both supplied script documents cannot read host addresses, DOM, cookies, storage or navigate", async ({
		page,
		context,
	}) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		const transport = await installCanaryFixture(page);
		await page.locator('[data-test="mount-banner"]').click();
		await page.locator('[data-test="mount-native"]').click();
		await expect.poll(async () => (await canaryEvidence(page)).probes.length).toBe(2);
		const evidence = await canaryEvidence(page);
		for (const { id, probe, document } of evidence.probes) {
			expect(probe).toEqual({
				parentDomDenied: true,
				parentListenerDenied: true,
				cookieDenied: true,
				localStorageDenied: true,
				sessionStorageDenied: true,
				popupDenied: true,
				topNavigationDenied: true,
			});
			const format = id.split(":")[0] as BlogAdFormat;
			expect(format === "banner" || format === "native").toBe(true);
			expect(document.url).toBe(getBlogAdDocumentUrl(format));
			expect(document.baseURI).toBe(document.url);
			expect(document.referrer).toBe("");
			for (const address of Object.values(document)) {
				const decodedAddress = decodeURIComponent(address);
				for (const forbidden of [new URL(baseUrl).origin, fixturePath, privateRouteMarker]) {
					expect(address).not.toContain(forbidden);
					expect(decodedAddress).not.toContain(forbidden);
				}
			}
		}
		await expect(page).toHaveURL(fixtureUrl);
		expect(context.pages()).toHaveLength(1);
		expect(await page.locator("body").getAttribute("data-canary-pollution")).toBeNull();
		expect(await page.evaluate(() => localStorage.getItem("ad-canary"))).toBeNull();
		expect(await page.evaluate(() => sessionStorage.getItem("ad-canary"))).toBeNull();
		expect((await context.cookies()).some((cookie) => cookie.name === "ad-canary")).toBe(false);
		await expectNoHostAdCode(page);
		expect(transport.documentRequests.sort()).toEqual([...adDocumentUrls].sort());
		expect(transport.providerRequests).toEqual([]);
		expect(transport.safetyAborts).toEqual([]);
		await page.locator('[data-test="destroy-ad-frames"]').click();
		await expect(page.locator(adFrames)).toHaveCount(0);
		await test.info().attach("standalone-sandbox-probes", {
			body: JSON.stringify(
				{
					...evidence,
					transport,
					remainingAdFrameCount: 0,
					observationBoundary:
						"Harmless inline sandbox probes replacing supplier loaders in the shipped helper HTML; no actual inventory or deployed child response CSP is exercised.",
				},
				null,
				2,
			),
			contentType: "application/json",
		});
	});

	test("destroying a context stops its timer and repeated mounts keep one mobile native card", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 900 });
		const transport = await installCanaryFixture(page);
		await page.locator('[data-test="mount-native"]').click();
		await page.locator('[data-test="mount-native"]').click();
		await expect(page.locator(adFrames)).toHaveCount(1);
		await expect
			.poll(async () => (await canaryEvidence(page)).ticks["native:1"] ?? 0)
			.toBeGreaterThan(2);
		const nativeFrame = page.frameLocator('iframe[data-blog-ad-frame="native"]');
		expect(
			await nativeFrame.locator("html").evaluate((html) => html.scrollWidth <= innerWidth),
		).toBe(true);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		await page.locator('[data-test="destroy-ad-frames"]').click();
		await expect(page.locator(adFrames)).toHaveCount(0);
		// Drain queued messages, then observe multiple browser frames (> the 10ms canary period).
		await settleBrowserFrames(page, 2);
		const stoppedTicks = (await canaryEvidence(page)).ticks["native:1"];
		await settleBrowserFrames(page, 4);
		expect((await canaryEvidence(page)).ticks["native:1"]).toBe(stoppedTicks);
		await page.locator('[data-test="mount-native"]').click();
		await expect
			.poll(async () => (await canaryEvidence(page)).ticks["native:2"] ?? 0)
			.toBeGreaterThan(2);
		await expect(page.locator(adFrames)).toHaveCount(1);
		expect((await canaryEvidence(page)).mountCount.native).toBe(2);
		expect((await canaryEvidence(page)).ticks["native:1"]).toBe(stoppedTicks);
		expect(transport.documentRequests).toEqual([
			getBlogAdDocumentUrl("native"),
			getBlogAdDocumentUrl("native"),
		]);
		expect(transport.providerRequests).toEqual([]);
		expect(transport.safetyAborts).toEqual([]);
		await page.locator('[data-test="destroy-ad-frames"]').click();
		await expect(page.locator(adFrames)).toHaveCount(0);
		await test.info().attach("standalone-context-lifecycle", {
			body: JSON.stringify(
				{
					...(await canaryEvidence(page)),
					transport,
					remainingAdFrameCount: 0,
					observationBoundary:
						"Synthetic 10ms timer and local card fixture only; supplier cleanup and native card geometry require separate finite live observation.",
				},
				null,
				2,
			),
			contentType: "application/json",
		});
	});
});
