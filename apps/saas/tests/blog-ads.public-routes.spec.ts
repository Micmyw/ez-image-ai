import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type BrowserContext, type Page, type Request } from "@playwright/test";

import {
	BLOG_AD_BANNER_WIDTH,
	BLOG_AD_NATIVE_HEIGHT,
	BLOG_AD_SANDBOX,
	getBlogAdDocumentUrl,
	type BlogAdFormat,
} from "../modules/public-content/lib/blog-ads";

const articlePath = "/blog/tesco-ai-meal-planning-assistant";
const adsEnabled = process.env.BLOG_ADS_ENABLED === "true";
const nativeEnabled = adsEnabled && process.env.BLOG_NATIVE_ADS_ENABLED === "true";
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
type FailedDataFrame = {
	frameId: string;
	url: string;
	unreachableUrl: string;
	ownerNodeName?: string;
	ownerAdFormat?: string;
	ownerSource?: string;
	ownerLookupError?: string;
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
		adRequests: [] as { id: number; url: string }[],
		adNetworkAttempts: [] as string[],
		adRequestFailures: [] as { requestId: number; url: string; error: string }[],
		cspConsole: [] as string[],
		cspAudits: [] as CspAudit[],
		failedDataFrames: [] as FailedDataFrame[],
		dataDocumentsReachingSafetyInterceptor: [] as string[],
		frameObservations: [] as AdFrameObservation[],
		mainFrameNavigations: [] as string[],
		clearanceChecks: [] as { path: string; adFrameCount: number; observedPopupCount: number }[],
		popups: 0,
	};
	// Chromium can redact data URLs to an empty blockedURI in page CSP events.
	// Its native audit stream is a separate source from our network safety guard.
	const devtools = await context.newCDPSession(page);
	devtools.on("Audits.issueAdded", ({ issue }) => {
		if (issue.code !== "ContentSecurityPolicyIssue") return;
		const detail = issue.details.contentSecurityPolicyIssueDetails;
		if (!detail) return;
		const audit: CspAudit = {
			blockedURL: detail.blockedURL ?? null,
			directive: detail.violatedDirective,
			isReportOnly: detail.isReportOnly,
			violationType: detail.contentSecurityPolicyViolationType,
		};
		evidence.cspAudits.push(audit);
	});
	await devtools.send("Audits.enable");
	devtools.on("Page.frameNavigated", ({ frame }) => {
		if (frame.url !== "chrome-error://chromewebdata/") return;
		const failure: FailedDataFrame = {
			frameId: frame.id,
			url: frame.url,
			unreachableUrl: frame.unreachableUrl ?? "",
		};
		evidence.failedDataFrames.push(failure);
		void devtools
			.send("DOM.getFrameOwner", { frameId: frame.id })
			.then(({ backendNodeId }) => devtools.send("DOM.describeNode", { backendNodeId }))
			.then(
				({ node }) => {
					failure.ownerNodeName = node.nodeName;
					const attributes = new Map<string, string>();
					const nodeAttributes = node.attributes ?? [];
					for (let index = 0; index < nodeAttributes.length; index += 2)
						attributes.set(nodeAttributes[index], nodeAttributes[index + 1]);
					failure.ownerAdFormat = attributes.get("data-blog-ad-frame");
					failure.ownerSource = attributes.get("src");
				},
				(error) => {
					failure.ownerLookupError = String(error);
				},
			);
	});
	await devtools.send("Page.enable");
	const requestIds = new WeakMap<Request, number>();
	let nextRequestId = 0;
	const requestId = (request: Request) => {
		const existing = requestIds.get(request);
		if (existing !== undefined) return existing;
		const id = ++nextRequestId;
		requestIds.set(request, id);
		return id;
	};
	context.on("request", (request) => {
		if (isAdUrl(request.url()))
			evidence.adRequests.push({ id: requestId(request), url: request.url() });
	});
	context.on("requestfailed", (request) => {
		if (isAdUrl(request.url()))
			evidence.adRequestFailures.push({
				requestId: requestId(request),
				url: request.url(),
				error: request.failure()?.errorText ?? "unknown",
			});
	});
	page.on("console", (message) => {
		const value = message.text();
		if (
			/content security policy|violates.*directive/i.test(value) &&
			/data:|highrevenueformat|profitableratecpmnetwork/.test(value)
		)
			evidence.cspConsole.push(value);
	});
	context.on("page", () => evidence.popups++);
	page.on("framenavigated", (frame) => {
		if (frame === page.mainFrame() && frame.url().startsWith(new URL(baseUrl).origin))
			evidence.mainFrameNavigations.push(new URL(frame.url()).pathname);
	});
	await page.addInitScript(() => {
		const violations: CspViolation[] = [];
		Object.defineProperty(window, "__blogAdCspViolations", { value: violations });
		document.addEventListener("securitypolicyviolation", (event) => {
			violations.push({
				blockedURI: event.blockedURI,
				directive: event.effectiveDirective,
				disposition: event.disposition,
				originalPolicy: event.originalPolicy,
			});
		});
	});
	// These public UI checks never send optional tracking or invoke a provider/business action.
	// A CSP failure can emit a request event without reaching the network interceptor. Record
	// both separately; our safety abort must never be mistaken for evidence of CSP blocking.
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.protocol === "data:") evidence.dataDocumentsReachingSafetyInterceptor.push(url.href);
		if (isAdUrl(url.href)) evidence.adNetworkAttempts.push(url.href);
		if (url.origin !== new URL(baseUrl).origin) return route.abort();
		if (/createCheckout|createCreditPack|createGeneration/.test(url.pathname))
			throw new Error("Blog ad isolation checks must not create business actions");
		return route.continue();
	});
	return evidence;
}

async function acceptExistingConsent(context: BrowserContext) {
	await context.addCookies([{ name: "consent", value: "true", url: new URL(baseUrl).origin }]);
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

async function expectNoAds(page: Page, evidence: Awaited<ReturnType<typeof watchApp>>) {
	await expect(page.locator(adFrames)).toHaveCount(0);
	await expectNoHostAdCode(page);
	await expectNoAdNetwork(evidence);
	expect(evidence.popups).toBe(0);
	evidence.clearanceChecks.push({
		path: new URL(page.url()).pathname,
		adFrameCount: await page.locator(adFrames).count(),
		observedPopupCount: evidence.popups,
	});
}

async function expectNoAdNetwork(evidence: Awaited<ReturnType<typeof watchApp>>) {
	expect(evidence.adNetworkAttempts).toEqual([]);
	await expect
		.poll(() =>
			evidence.adRequests.filter(
				(request) =>
					!evidence.adRequestFailures.some(
						(failure) => failure.requestId === request.id && /CSP/i.test(failure.error),
					),
			),
		)
		.toEqual([]);
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
				observationBoundary:
					"Request interception is a safety guard; opaque frame network events may be incomplete. Parent and child CSP rejection, document addresses and frame resource telemetry are recorded separately. The unchanged app CSP rejects the static data document before supplier execution. A blank browser error document is not a rendered advertisement. Resource entries establish observed URLs, not transfer success or absence. No live creative behavior is established.",
			},
			null,
			2,
		),
		contentType: "application/json",
	});
}

async function observeAdFrames(
	page: Page,
	evidence: Awaited<ReturnType<typeof watchApp>>,
	phase = "after-mount",
) {
	for (const frame of page.frames()) {
		if (frame === page.mainFrame()) continue;
		const element = await frame.frameElement();
		const format = await element.getAttribute("data-blog-ad-frame");
		if (!format) continue;
		const box = await element.boundingBox();
		const geometry = box ? { width: box.width, height: box.height } : null;
		await frame.waitForLoadState("domcontentloaded");
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
		evidence.frameObservations.push({ format, phase, geometry, ...observation });
	}
}

function isKnownFailedAdFrame(frame: FailedDataFrame) {
	return (
		frame.url === "chrome-error://chromewebdata/" &&
		frame.ownerNodeName === "IFRAME" &&
		(["banner", "native"] as const).some(
			(format) =>
				frame.ownerAdFormat === format &&
				frame.ownerSource === getBlogAdDocumentUrl(format) &&
				frame.unreachableUrl === frame.ownerSource,
		)
	);
}

async function showAds(page: Page, evidence: Awaited<ReturnType<typeof watchApp>>) {
	await page.getByRole("button", { name: "Show blog ads", exact: true }).click();
	const banner = page.locator('[data-blog-ad="banner"]:visible');
	await banner.scrollIntoViewIfNeeded();
	await expect(page.locator('iframe[data-blog-ad-frame="banner"]')).toHaveCount(1);
	if (nativeEnabled) {
		await page.locator('[data-blog-ad="native"]:visible').scrollIntoViewIfNeeded();
		await expect(page.locator('iframe[data-blog-ad-frame="native"]')).toHaveCount(1);
	}
	await observeAdFrames(page, evidence);
}

test.describe("real app blog ad isolation (unchanged response CSP)", () => {
	for (const route of [
		"/",
		"/create",
		"/login",
		"/pricing",
		"/blog",
		"/blog/1980s-ai-photo",
		"/blog/raindance-ai-trend",
	]) {
		test(`direct ${route} never creates ad contexts or requests`, async ({ page, context }) => {
			test.setTimeout(90_000);
			await acceptExistingConsent(context);
			const evidence = await watchApp(page, context);
			const response = await page.goto(route);
			expect(response?.status()).toBe(200);
			await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
			await expect(page.locator("[data-blog-ads]")).toHaveCount(0);
			await expectNoAds(page, evidence);
			expect(evidence.adRequests).toEqual([]);
			await attachAppEvidence(page, evidence);
		});
	}

	test("the server kill switch leaves the article free of ad containers", async ({
		page,
		context,
	}) => {
		test.skip(adsEnabled, "Run without BLOG_ADS_ENABLED to exercise the default-off switch.");
		await acceptExistingConsent(context);
		const evidence = await watchApp(page, context);
		const response = await page.goto(articlePath);
		expect(response?.status()).toBe(200);
		await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
		await expect(page.locator("[data-blog-ads]")).toHaveCount(0);
		await expectNoAds(page, evidence);
		expect(evidence.adRequests).toEqual([]);
		await attachAppEvidence(page, evidence);
	});

	test("consent alone does not load ads and explicit opt-in remains blocked by the app CSP", async ({
		page,
		context,
	}) => {
		test.skip(!adsEnabled, "Run with BLOG_ADS_ENABLED=true to exercise the opt-in path.");
		test.setTimeout(90_000);
		await page.setViewportSize({ width: 1600, height: 1000 });
		const evidence = await watchApp(page, context);
		const response = await page.goto(articlePath);
		expect(response?.status()).toBe(200);
		const csp = response?.headers()["content-security-policy"] ?? "";
		expect(csp).toContain("frame-src https://challenges.cloudflare.com");
		expect(csp).not.toMatch(/highrevenueformat|profitableratecpmnetwork/);
		await expect(page.locator("[data-blog-ads]")).toHaveCount(1);
		await expect(page.getByRole("button", { name: "Show blog ads", exact: true })).toHaveCount(0);
		await expectNoAds(page, evidence);
		await page.getByRole("button", { name: "Allow optional", exact: true }).click();
		await expect(page.getByRole("button", { name: "Show blog ads", exact: true })).toBeVisible();
		await expectNoAds(page, evidence);
		await expect(page.locator("iframe")).toHaveCount(0);
		const expectedFormats: BlogAdFormat[] = nativeEnabled ? ["banner", "native"] : ["banner"];
		const hostViolationBaseline = await page.evaluate(
			() =>
				(window as Window & { __blogAdCspViolations?: CspViolation[] }).__blogAdCspViolations
					?.length ?? 0,
		);
		const auditBaseline = evidence.cspAudits.length;
		const failedFrameBaseline = evidence.failedDataFrames.length;
		await showAds(page, evidence);
		await expect(page.locator("iframe")).toHaveCount(expectedFormats.length);
		for (const frame of await page.locator(adFrames).all()) {
			await expect(frame).toHaveAttribute("sandbox", BLOG_AD_SANDBOX);
			await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
			const format = await frame.getAttribute("data-blog-ad-frame");
			expect(format === "banner" || format === "native").toBe(true);
			await expect(frame).toHaveAttribute("src", getBlogAdDocumentUrl(format as BlogAdFormat));
			await expect(frame).not.toHaveAttribute("srcdoc");
		}
		try {
			await expect
				.poll(async () => {
					const violations = await page.evaluate(
						() =>
							(window as Window & { __blogAdCspViolations?: CspViolation[] })
								.__blogAdCspViolations ?? [],
					);
					const policyViolations = violations
						.slice(hostViolationBaseline)
						.filter(
							(violation) =>
								violation.disposition === "enforce" &&
								violation.directive === "frame-src" &&
								violation.originalPolicy === csp,
						);
					const nativeIssues = evidence.cspAudits
						.slice(auditBaseline)
						.filter(
							(audit) =>
								!audit.isReportOnly &&
								audit.violationType === "kURLViolation" &&
								audit.directive === "frame-src",
						);
					const rejectedFormats = [
						...new Set(
							evidence.failedDataFrames
								.slice(failedFrameBaseline)
								.filter(isKnownFailedAdFrame)
								.map((frame) => frame.ownerAdFormat),
						),
					].sort((left, right) => (left ?? "").localeCompare(right ?? ""));
					return {
						responsePolicyEnforced: policyViolations.length >= expectedFormats.length,
						nativeFrameRejections: nativeIssues.length >= expectedFormats.length,
						rejectedFormats,
					};
				})
				.toEqual({
					responsePolicyEnforced: true,
					nativeFrameRejections: true,
					rejectedFormats: expectedFormats,
				});
			expect(evidence.dataDocumentsReachingSafetyInterceptor).toEqual([]);
			for (const failedFrame of evidence.failedDataFrames.slice(failedFrameBaseline)) {
				expect(isKnownFailedAdFrame({ ...failedFrame, ownerAdFormat: "unrelated-frame" })).toBe(
					false,
				);
				expect(
					isKnownFailedAdFrame({ ...failedFrame, unreachableUrl: "data:text/html,unrelated" }),
				).toBe(false);
			}
		} finally {
			await attachAppEvidence(page, evidence, "app-csp-verification-diagnostic");
		}
		await observeAdFrames(page, evidence, "after-parent-csp-confirmed");
		expect(evidence.frameObservations.length).toBeGreaterThan(0);
		for (const frame of evidence.frameObservations) {
			expect(frame.document.url).not.toMatch(/^data:/);
			expect(frame.resources).toEqual([]);
		}
		await expectNoHostAdCode(page);
		await expectNoAdNetwork(evidence);
		expect(evidence.popups).toBe(0);
		await page.getByRole("button", { name: "Hide blog ads", exact: true }).click();
		await expectNoAds(page, evidence);
		await attachAppEvidence(page, evidence);
	});

	test("article to product SPA navigation, back, forward and repeated opt-ins leave no ad contexts", async ({
		page,
		context,
	}) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 1600, height: 1000 });
		await acceptExistingConsent(context);
		const evidence = await watchApp(page, context);
		await page.goto(articlePath);
		await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
		await expectNoAds(page, evidence);
		const documentToken = await page.evaluate(() => {
			const token = crypto.randomUUID();
			Object.defineProperty(window, "__blogAdDocumentToken", { value: token });
			return token;
		});
		if (adsEnabled) await showAds(page, evidence);
		await page.locator('.blog-breadcrumb a[href="/"]:visible').click();
		await expectAppUrl(page, "/");
		await expect(page.locator("[data-blog-ads]:visible")).toHaveCount(0);
		await expectNoAds(page, evidence);
		expect(
			await page.evaluate(
				() => (window as Window & { __blogAdDocumentToken?: string }).__blogAdDocumentToken,
			),
		).toBe(documentToken);
		await page.goBack();
		await expectAppUrl(page, articlePath);
		await expectNoAds(page, evidence);
		if (adsEnabled) {
			await showAds(page, evidence);
			await page.getByRole("button", { name: "Hide blog ads", exact: true }).click();
			await expectNoAds(page, evidence);
			await showAds(page, evidence);
			await expect(page.locator('iframe[data-blog-ad-frame="banner"]')).toHaveCount(1);
		}
		await page.goForward();
		await expectAppUrl(page, "/");
		await expectNoAds(page, evidence);
		await page.goBack();
		await expectAppUrl(page, articlePath);
		await expectNoAds(page, evidence);
		if (adsEnabled) await showAds(page, evidence);
		await page.reload();
		await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
		if (adsEnabled)
			await expect(page.getByRole("button", { name: "Show blog ads", exact: true })).toBeVisible();
		await expectNoAds(page, evidence);

		// Next's route cache can preserve article component state when returning through the
		// directory or history. Every restored article must require a fresh display opt-in.
		if (adsEnabled) await showAds(page, evidence);
		await page.locator('.blog-breadcrumb a[href="/blog"]:visible').click();
		await expectAppUrl(page, "/blog");
		await expectNoAds(page, evidence);
		await page.getByRole("searchbox").fill("Private AI Image Editing");
		const secondArticlePath = "/blog/private-image-editing-workflow";
		await page.locator(`.blog-grid h2 a[href="${secondArticlePath}"]`).click();
		await expectAppUrl(page, secondArticlePath);
		await expectNoAds(page, evidence);
		if (adsEnabled) await showAds(page, evidence);
		await page.goBack();
		await expectAppUrl(page, "/blog");
		await expectNoAds(page, evidence);
		await page.goBack();
		await expectAppUrl(page, articlePath);
		await expectNoAds(page, evidence);
		await page.goForward();
		await expectAppUrl(page, "/blog");
		await expectNoAds(page, evidence);
		await page.goForward();
		await expectAppUrl(page, secondArticlePath);
		await expectNoAds(page, evidence);
		if (adsEnabled) await showAds(page, evidence);
		await page.goto("/");
		await expectAppUrl(page, "/");
		await expectNoAds(page, evidence);
		await page.goBack();
		await expectAppUrl(page, secondArticlePath);
		await expectNoAds(page, evidence);
		if (adsEnabled)
			await expect(page.getByRole("button", { name: "Show blog ads", exact: true })).toBeVisible();
		await attachAppEvidence(page, evidence);
	});

	for (const width of [390, 320]) {
		test(`the 728px banner never mounts or overflows at ${width}px`, async ({ page, context }) => {
			test.skip(!adsEnabled, "Run with BLOG_ADS_ENABLED=true to exercise mobile slot gating.");
			await page.setViewportSize({ width, height: 900 });
			await acceptExistingConsent(context);
			const evidence = await watchApp(page, context);
			await page.goto(articlePath);
			await page.getByRole("button", { name: "Show blog ads", exact: true }).click();
			await expect(page.locator('[data-blog-ad="banner"]')).toBeHidden();
			await expect(page.locator('iframe[data-blog-ad-frame="banner"]')).toHaveCount(0);
			if (nativeEnabled) {
				await page.locator('[data-blog-ad="native"]').scrollIntoViewIfNeeded();
				const frame = page.locator('iframe[data-blog-ad-frame="native"]');
				await expect(frame).toHaveCount(1);
				const box = await frame.boundingBox();
				expect(box?.width).toBeLessThanOrEqual(width);
				expect(box?.height).toBe(BLOG_AD_NATIVE_HEIGHT);
				await observeAdFrames(page, evidence);
			}
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
				true,
			);
			await expectNoAdNetwork(evidence);
			await attachAppEvidence(page, evidence);
		});
	}
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

// This intentionally separate fixture has no app CSP. It exercises the shipped data document
// transport and sandbox using harmless inline replacement scripts. It is not evidence that production
// inventory loads, that a supplier is safe, or that its native cards are responsive.
async function installCanaryFixture(page: Page) {
	// Keep all host addresses out of the child's static code. The synthetic private route
	// tests fallback-base leakage without placing private information in an ad parameter.
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
				parent.postMessage({ kind: "blog-ad-canary-probe", id: window.name, probe, document: documentAddress }, "*");
				setInterval(() => parent.postMessage({ kind: "blog-ad-canary-tick", id: window.name }, "*"), 10);
				const card = document.createElement("div");
				card.style.cssText = "width:100%;display:grid;grid-template-columns:minmax(0,1fr);padding:12px;overflow-wrap:anywhere";
				card.textContent = "Local display card fixture; no real advertisement or click target.";
				document.body.appendChild(card);
			})();`;
	await page.route("https://ad-canary.invalid/**", (route) => route.abort());
	const canaryDocumentUrl = (format: BlogAdFormat) => {
		const shippedUrl = getBlogAdDocumentUrl(format);
		const prefix = "data:text/html;charset=utf-8,";
		expect(shippedUrl.startsWith(prefix)).toBe(true);
		const document = decodeURIComponent(shippedUrl.slice(prefix.length)).replace(
			/<script\b[^>]*\bsrc="https:[^"]+\/invoke\.js"[^>]*><\/script>/,
			`<script>${canaryScript}</script>`,
		);
		// Opaque-frame request interception is incomplete: remove every real script URL
		// before creating a frame instead of relying on a route abort to prevent execution.
		expect(document).not.toMatch(/<script\b[^>]*\bsrc=/i);
		expect(document).toContain(canaryScript);
		return prefix + encodeURIComponent(document);
	};
	const documents = JSON.stringify({
		banner: canaryDocumentUrl("banner"),
		native: canaryDocumentUrl("native"),
	}).replace(/</g, "\\u003c");
	const styles = readFileSync(
		path.resolve(__dirname, "../modules/public-content/components/blog-ads.css"),
		"utf8",
	);
	const fixtureRequestUrl = new URL(fixtureUrl);
	fixtureRequestUrl.hash = "";
	await page.route(fixtureRequestUrl.href, (route) =>
		route.fulfill({
			contentType: "text/html",
			body: `<!doctype html><html><head><meta charset="utf-8"><style>
				body { margin: 0; padding: 16px; } ${styles}
			</style></head><body><h1>Isolated canary fixture</h1>
			<button data-test="mount-banner">Mount banner</button>
			<button data-test="mount-native">Mount native</button>
			<button data-test="destroy-ad-frames">Destroy ad frames</button>
			<section class="blog-ads" data-blog-ads>
				<div class="blog-ad blog-ad-banner" data-blog-ad="banner"><div class="blog-ad-content"></div></div>
				<div class="blog-ad blog-ad-native" data-blog-ad="native"><div class="blog-ad-content"></div></div>
			</section><script>
				const documents = ${documents};
				window.canaryEvidence = { probes: [], ticks: {}, mountCount: { banner: 0, native: 0 } };
				window.addEventListener("message", event => {
					if (event.data?.kind === "blog-ad-canary-probe") window.canaryEvidence.probes.push(event.data);
					if (event.data?.kind === "blog-ad-canary-tick") window.canaryEvidence.ticks[event.data.id] = (window.canaryEvidence.ticks[event.data.id] || 0) + 1;
				});
				for (const format of ["banner", "native"]) {
					document.querySelector('[data-test="mount-' + format + '"]').addEventListener("click", () => {
						const slot = document.querySelector('[data-blog-ad="' + format + '"] .blog-ad-content');
						if (slot.querySelector("iframe")) return;
						const frame = document.createElement("iframe");
						frame.dataset.blogAdFrame = format;
						frame.name = format + ":" + ++window.canaryEvidence.mountCount[format];
						frame.title = format + " canary";
						frame.setAttribute("sandbox", ${JSON.stringify(BLOG_AD_SANDBOX)});
						frame.referrerPolicy = "no-referrer";
						frame.width = format === "banner" ? "${BLOG_AD_BANNER_WIDTH}" : "100%";
						frame.height = format === "banner" ? "90" : "${BLOG_AD_NATIVE_HEIGHT}";
						frame.src = documents[format];
						slot.appendChild(frame);
					});
				}
				document.querySelector('[data-test="destroy-ad-frames"]').addEventListener("click", () => {
					for (const frame of document.querySelectorAll("iframe")) frame.remove();
				});
			</script></body></html>`,
		}),
	);
	await page.goto(fixtureUrl);
	await page.evaluate(() => {
		document.cookie = "blog-ad-parent-secret=parent-only;path=/";
		localStorage.setItem("blog-ad-parent-secret", "parent-only");
		sessionStorage.setItem("blog-ad-parent-secret", "parent-only");
	});
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

test.describe("standalone data document sandbox canaries (not production inventory)", () => {
	test("both supplied script documents cannot read host addresses, DOM, cookies, storage or navigate", async ({
		page,
		context,
	}) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await installCanaryFixture(page);
		await page.locator('[data-test="mount-banner"]').click();
		await page.locator('[data-test="mount-native"]').click();
		await expect.poll(async () => (await canaryEvidence(page)).probes.length).toBe(2);
		const evidence = await canaryEvidence(page);
		for (const { probe, document } of evidence.probes) {
			expect(probe).toEqual({
				parentDomDenied: true,
				parentListenerDenied: true,
				cookieDenied: true,
				localStorageDenied: true,
				sessionStorageDenied: true,
				popupDenied: true,
				topNavigationDenied: true,
			});
			expect(document.url).toMatch(/^data:text\/html;charset=utf-8,/);
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
		await test.info().attach("standalone-sandbox-probes", {
			body: JSON.stringify(evidence, null, 2),
			contentType: "application/json",
		});
	});

	test("destroying a context stops its timer and repeated mounts keep one mobile native card", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 900 });
		await installCanaryFixture(page);
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
		await test.info().attach("standalone-context-lifecycle", {
			body: JSON.stringify(await canaryEvidence(page), null, 2),
			contentType: "application/json",
		});
	});
});
