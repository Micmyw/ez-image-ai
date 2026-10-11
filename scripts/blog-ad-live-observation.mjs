import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";

// Explicit, bounded integration observation. Never run this from CI or the
// ordinary isolation suite: those cases use harmless intercepted documents.
// This script does not install a browser, click an advertisement, retry a
// loader, create an account/order/generation, or loosen a response policy.
const { values } = parseArgs({
	options: {
		"app-origin": { type: "string" },
		"dependency-root": { type: "string", default: process.cwd() },
		"output-dir": { type: "string" },
		help: { type: "boolean", default: false },
	},
});
if (values.help) {
	console.log(
		"node scripts/blog-ad-live-observation.mjs --app-origin https://ezimageai.com --output-dir output/playwright/blog-ads/live-UNIQUE [--dependency-root EXISTING_REPO]",
	);
	process.exit(0);
}
if (!values["app-origin"]) throw new Error("An explicit --app-origin is required");
const appUrl = new URL(values["app-origin"]);
if (
	appUrl.username ||
	appUrl.password ||
	appUrl.search ||
	appUrl.hash ||
	appUrl.pathname !== "/" ||
	!(appUrl.origin === "https://ezimageai.com" || appUrl.origin === "http://127.0.0.1:3018")
)
	throw new Error("Use the approved production origin or the isolated local test origin");
const expiresAt = Date.parse("2026-10-11T13:00:00Z");
if (Date.now() >= expiresAt - 30_000) throw new Error("The approved preview window has ended");
const runDeadline = Math.min(Date.now() + 120_000, expiresAt);
const activeDeadline = runDeadline - 5_000;
const dependencyRoot = path.resolve(values["dependency-root"]);
const require = createRequire(path.join(dependencyRoot, "apps/saas/package.json"));
const { chromium, devices } = require("@playwright/test");
const outputDir = path.resolve(
	values["output-dir"] ??
		`output/playwright/blog-ads/live-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
const relativeOutput = path.relative(process.cwd(), outputDir);
if (!relativeOutput || relativeOutput.startsWith("..") || path.isAbsolute(relativeOutput))
	throw new Error("Evidence must use a fresh directory inside the current worktree");
await mkdir(path.dirname(outputDir), { recursive: true });
await mkdir(outputDir); // Existing evidence is never overwritten.

const adOrigin = "https://ads.ezimageai.com";
const articlePath = "/blog/tesco-ai-meal-planning-assistant";
const loaders = {
	banner: "https://www.highrevenueformat.com/2266a6811e407f9b362831f885d09d1e/invoke.js",
	native:
		"https://pl31768149.profitableratecpmnetwork.com/0a9986f36ff843c117e0f20e732a1e08/invoke.js",
};
const approvedOrigins = new Set(Object.values(loaders).map((url) => new URL(url).origin));
const optionalParentHosts = new Set([
	"www.googletagmanager.com",
	"www.google-analytics.com",
	"region1.google-analytics.com",
	"www.clarity.ms",
	"scripts.clarity.ms",
	"static.cloudflareinsights.com",
	"challenges.cloudflare.com",
]);
const adFrameSelector = "iframe[data-blog-ad-frame]";
const readonlyApiMethods = new Map([
	["/api/auth/get-session", new Set(["GET", "HEAD"])],
	["/api/rpc/media/getPublicCatalog", new Set(["GET", "POST"])],
	["/api/media/catalog", new Set(["GET", "HEAD"])],
]);
const forbiddenBusinessPath =
	/createCheckout|createCreditPack|createQuote|createGeneration|submitGeneration|upload.?intent|upload-intents|guest-drafts|handoff|sign-in|sign-up|sign-out|forgot-password|reset-password/i;
const MAX_LOADER_BYTES = 2 * 1024 * 1024;
const MAX_AD_REQUESTS_PER_RUN = 30;
const observationMs = 10_000;
const opaqueServiceWorkerHarnessError =
	"Failed to read the 'serviceWorker' property from 'Navigator': Service worker is disabled because the context is sandboxed and lacks the 'allow-same-origin' flag.";
const evidence = {
	startedAt: new Date().toISOString(),
	appOrigin: appUrl.origin,
	adOrigin,
	expiresAt: new Date(expiresAt).toISOString(),
	limits: {
		contexts: 2,
		exactLoaderRequests: { banner: 1, native: 1 },
		observationMs,
		maxAdRequestsPerRun: MAX_AD_REQUESTS_PER_RUN,
		stopAfterObservedLoaderBytes: MAX_LOADER_BYTES,
		activeDeadline: new Date(activeDeadline).toISOString(),
		runDeadline: new Date(runDeadline).toISOString(),
		cleanupBudgetMs: 5_000,
		clicks: 0,
		retries: 0,
		apiLoaderFetches: 0,
	},
	cases: [],
	stopReasons: [],
	notes: [
		"Only the exact invoke.js responses may be saved as bodies; cookie and authorization values are never recorded.",
		"Unknown advertising hosts are blocked and terminate observation. A blocked, empty or inaccessible creative is not usable-advertising evidence.",
		"Viewport screenshots and passive snapshots do not certify all possible future creative rotations or physical mobile devices.",
		"Account and checkout-return checks are anonymous route/login boundaries, not authenticated account or payment acceptance.",
		"Optional existing parent tracking is intercepted separately and does not establish supplier behavior.",
		"The loader byte guard stops on observed streaming data over 2MiB; transport chunking and scheduling can overshoot that threshold. It does not rewrite the supplier response.",
		"The known Cloudflare edge beacon remains disallowed. Enforced rejection on the direct static advertising document is classified separately from supplier-origin discovery.",
	],
};
let browser;
let browserServer;
let activeContext;
let stopped = false;
const pending = new Set();
const loaderCounts = { banner: 0, native: 0 };
const allowedLoaderCounts = { banner: 0, native: 0 };
const documentCounts = { banner: 0, native: 0 };
let adRequestCount = 0;

function safeUrl(value) {
	try {
		const url = new URL(value);
		if (!["http:", "https:"].includes(url.protocol)) return url.protocol;
		return {
			origin: url.origin,
			pathname: url.pathname,
			queryKeys: [...new Set(url.searchParams.keys())],
			hasHash: Boolean(url.hash),
		};
	} catch {
		return "unparseable";
	}
}
function safeLocation(value, base) {
	try {
		return safeUrl(new URL(value, base).href);
	} catch {
		return "unparseable";
	}
}
function knownBlockedEdgeTracker(blockedUrl, documentUrl) {
	try {
		const blocked = new URL(blockedUrl);
		const document = new URL(documentUrl);
		return (
			blocked.origin === "https://static.cloudflareinsights.com" &&
			/^\/beacon\.min\.js(?:\/|$)/.test(blocked.pathname) &&
			document.origin === adOrigin &&
			["/banner.html", "/native.html"].includes(document.pathname)
		);
	} catch {
		return false;
	}
}
function cookieMetadata(cookie) {
	return {
		name: cookie.name,
		domain: cookie.domain,
		httpOnly: cookie.httpOnly,
		secure: cookie.secure,
		sameSite: cookie.sameSite,
	};
}
function belongsToAdTree(frame) {
	for (let cursor = frame; cursor; cursor = cursor.parentFrame()) {
		try {
			const url = new URL(cursor.url());
			if (url.origin === adOrigin || approvedOrigins.has(url.origin)) return true;
		} catch {
			// An initial about:blank can have an already-identified parent frame.
		}
	}
	return false;
}
function track(promise) {
	pending.add(promise);
	void promise.finally(() => pending.delete(promise)).catch(() => {});
}
async function stop(reason, detail) {
	evidence.stopReasons.push({ at: new Date().toISOString(), reason, detail });
	stopped = true;
	await closeOwnedBrowser();
}
async function closeOwnedBrowser() {
	let forceTimer;
	const graceful = Promise.allSettled([
		activeContext?.close(),
		browser?.close(),
		browserServer?.close(),
	]);
	const forced = new Promise((resolve) => {
		forceTimer = setTimeout(
			() => {
				void Promise.race([
					browserServer?.kill().catch(() => {}),
					new Promise((finish) =>
						setTimeout(finish, Math.max(0, Math.min(1_000, runDeadline - Date.now()))),
					),
				]).finally(resolve);
			},
			Math.max(0, Math.min(3_000, runDeadline - Date.now())),
		);
	});
	await Promise.race([graceful, forced]);
	clearTimeout(forceTimer);
}
function ensureRunning() {
	if (stopped) throw new Error("Observation stopped by its safety guard");
	if (Date.now() >= activeDeadline) throw new Error("Observation deadline reached");
}
async function observeFor(ms) {
	// A declared passive observation budget, not a page-readiness sleep.
	const until = Math.min(Date.now() + ms, activeDeadline);
	while (Date.now() < until && !stopped)
		await new Promise((resolve) => setTimeout(resolve, Math.min(200, until - Date.now())));
	ensureRunning();
}
async function capture(page, item, phase) {
	ensureRunning();
	const snapshot = await page.evaluate(() => {
		const frames = [...document.querySelectorAll("iframe[data-blog-ad-frame]")].map((element) => {
			const rectangle = element.getBoundingClientRect();
			return {
				format: element.getAttribute("data-blog-ad-frame"),
				source: element.getAttribute("src"),
				sandbox: element.getAttribute("sandbox"),
				referrerPolicy: element.getAttribute("referrerpolicy"),
				credentialless: element.hasAttribute("credentialless"),
				width: rectangle.width,
				height: rectangle.height,
			};
		});
		return {
			timeOrigin: performance.timeOrigin,
			viewport: { width: innerWidth, height: innerHeight },
			bodyScrollWidth: document.body.scrollWidth,
			documentScrollWidth: document.documentElement.scrollWidth,
			frames,
			childFrameCount: window.frames.length,
			parentSupplierScripts: [...document.scripts].filter((script) =>
				/highrevenueformat|profitableratecpmnetwork/.test(script.src),
			).length,
			parentAtOptions: Object.hasOwn(window, "atOptions"),
			lifecycle: window.__blogAdPassiveEvidence,
		};
	});
	const adChildFrames = page
		.frames()
		.filter((frame) => belongsToAdTree(frame))
		.map((frame) => safeUrl(frame.url()));
	const openPopupCount = page
		.context()
		.pages()
		.filter((candidate) => candidate !== page && !candidate.isClosed()).length;
	item.checkpoints.push({
		phase,
		url: safeUrl(page.url()),
		...snapshot,
		adChildFrames,
		openPopupCount,
	});
	if (
		snapshot.parentSupplierScripts ||
		snapshot.parentAtOptions ||
		snapshot.documentScrollWidth > snapshot.viewport.width ||
		snapshot.bodyScrollWidth > snapshot.viewport.width
	)
		await stop("host-pollution-or-horizontal-overflow", { phase, snapshot });
	return { ...snapshot, adChildFrames, openPopupCount };
}

async function attachNativeSession(context, target, item, owner) {
	try {
		const session = await context.newCDPSession(target);
		const loaderRequestIds = new Set();
		const transferredBytes = new Map();
		session.on("Network.requestWillBeSent", ({ requestId, request }) => {
			if (Object.values(loaders).includes(request.url)) loaderRequestIds.add(requestId);
		});
		session.on("Network.dataReceived", ({ requestId, dataLength }) => {
			if (!loaderRequestIds.has(requestId)) return;
			const bytes = (transferredBytes.get(requestId) ?? 0) + dataLength;
			transferredBytes.set(requestId, bytes);
			if (bytes > MAX_LOADER_BYTES)
				track(stop("observed-loader-stream-byte-budget", { owner, bytes }));
		});
		session.on("Fetch.requestPaused", (event) => {
			track(
				(async () => {
					if (Object.values(loaders).includes(event.request.url) && event.networkId)
						loaderRequestIds.add(event.networkId);
					const location = event.responseHeaders?.find(
						(header) => header.name.toLowerCase() === "location",
					)?.value;
					if (
						stopped ||
						Date.now() >= activeDeadline ||
						(event.responseStatusCode >= 300 && event.responseStatusCode < 400 && location)
					) {
						await session
							.send("Fetch.failRequest", {
								requestId: event.requestId,
								errorReason: "BlockedByClient",
							})
							.catch(() => {});
						await stop("supplier-response-redirect-or-deadline", {
							owner,
							status: event.responseStatusCode,
							location: location ? safeLocation(location, event.request.url) : null,
						});
					} else {
						try {
							await session.send("Fetch.continueResponse", { requestId: event.requestId });
						} catch (error) {
							await stop("native-response-guard-unavailable", {
								owner,
								message: String(error).slice(0, 200),
							});
						}
					}
				})(),
			);
		});
		session.on("Audits.issueAdded", ({ issue }) => {
			const details = issue.details.contentSecurityPolicyIssueDetails;
			if (!details) return;
			const record = {
				owner,
				blockedUrl: safeUrl(details.blockedURL ?? ""),
				directive: details.violatedDirective,
				isReportOnly: details.isReportOnly,
				violationType: details.contentSecurityPolicyViolationType,
				frameAncestor: details.frameAncestor,
				violatingNodeId: details.violatingNodeId,
				source: safeUrl(details.sourceCodeLocation?.url ?? ""),
			};
			item.cspIssues.push(record);
			if (knownBlockedEdgeTracker(details.blockedURL, target.url()) && !details.isReportOnly) {
				record.classification = "known-static-source-edge-tracker-enforce-blocked";
				return;
			}
			try {
				const blocked = new URL(details.blockedURL);
				if (
					owner !== "parent" &&
					!details.isReportOnly &&
					["http:", "https:"].includes(blocked.protocol) &&
					blocked.origin !== adOrigin &&
					!approvedOrigins.has(blocked.origin)
				)
					track(stop("child-CSP-blocked-unapproved-host", record));
			} catch {
				// Redacted CSP URLs remain observations, never a success assertion.
			}
		});
		session.on("Network.requestWillBeSentExtraInfo", (event) => {
			item.requestCookieMetadata.push({
				owner,
				requestId: event.requestId,
				cookies: (event.associatedCookies ?? []).map(({ cookie, blockedReasons }) => ({
					...cookieMetadata(cookie),
					blockedReasons,
				})),
			});
		});
		await Promise.all([session.send("Audits.enable"), session.send("Network.enable")]);
		await session.send("Fetch.enable", {
			patterns: [adOrigin, ...approvedOrigins].map((origin) => ({
				urlPattern: `${origin}/*`,
				requestStage: "Response",
			})),
		});
		return session;
	} catch (error) {
		item.nativeSessionLimits.push({ owner, message: String(error).slice(0, 250) });
		return undefined;
	}
}

async function runCase(format) {
	ensureRunning();
	const isMobile = format === "native";
	const item = {
		format,
		startedAt: new Date().toISOString(),
		status: "not-validated",
		requests: [],
		responses: [],
		failures: [],
		intercepts: [],
		console: [],
		pageErrors: [],
		harnessWarnings: [],
		cspIssues: [],
		requestCookieMetadata: [],
		nativeSessionLimits: [],
		frameDocuments: [],
		checkpoints: [],
		popups: [],
		dialogs: [],
		navigations: [],
		cookies: [],
	};
	evidence.cases.push(item);
	const context = await browser.newContext({
		...(isMobile ? devices["Pixel 7"] : {}),
		viewport: isMobile ? { width: 390, height: 844 } : { width: 1600, height: 1000 },
		storageState: { cookies: [], origins: [] },
		serviceWorkers: "block",
		acceptDownloads: false,
	});
	activeContext = context;
	ensureRunning();
	await context.routeWebSocket("**/*", (socket) => {
		socket.close();
		track(stop("unexpected-websocket", { format, url: safeUrl(socket.url()) }));
	});
	await context.addCookies([{ name: "consent", value: "true", url: appUrl.origin }]);
	await context.exposeBinding("__captureBlogAdCsp", ({ frame }, event) => {
		if (!event || typeof event.blockedURI !== "string" || event.blockedURI.length > 4096) return;
		const child = belongsToAdTree(frame);
		const record = {
			owner: child ? "child-init-listener" : "parent-init-listener",
			blockedUrl: safeUrl(event.blockedURI),
			directive: String(event.directive).slice(0, 120),
			disposition: event.disposition === "enforce" ? "enforce" : "report",
		};
		item.cspIssues.push(record);
		if (
			knownBlockedEdgeTracker(event.blockedURI, frame.url()) &&
			record.disposition === "enforce"
		) {
			record.classification = "known-static-source-edge-tracker-enforce-blocked";
			return;
		}
		try {
			const blocked = new URL(event.blockedURI);
			if (
				child &&
				record.disposition === "enforce" &&
				["http:", "https:"].includes(blocked.protocol) &&
				blocked.origin !== adOrigin &&
				!approvedOrigins.has(blocked.origin)
			)
				track(stop("child-init-CSP-blocked-unapproved-origin", record));
		} catch {
			// 'inline' and redacted values are recorded without inventing origins.
		}
	});
	await context.addInitScript(() => {
		const state = { events: [] };
		Object.defineProperty(window, "__blogAdPassiveEvidence", { value: state });
		window.addEventListener("securitypolicyviolation", (event) => {
			void window
				.__captureBlogAdCsp({
					blockedURI: event.blockedURI,
					directive: event.effectiveDirective,
					disposition: event.disposition,
				})
				.catch(() => {});
		});
		for (const type of ["pagehide", "pageshow"])
			window.addEventListener(type, (event) => {
				const entry = { type, persisted: event.persisted, framesAfterDispatch: null };
				state.events.push(entry);
				queueMicrotask(() => {
					entry.framesAfterDispatch = document.querySelectorAll(
						"iframe[data-blog-ad-frame]",
					).length;
				});
			});
	});
	const page = await context.newPage();
	let expectedPaths = new Set([articlePath]);
	let shown = false;
	let ended = false;
	const requestIds = new WeakMap();
	let nextId = 0;
	const idFor = (request) => {
		if (!requestIds.has(request)) requestIds.set(request, ++nextId);
		return requestIds.get(request);
	};
	context.on("page", (popup) => {
		if (popup === page) return;
		item.popups.push({ url: safeUrl(popup.url()) });
		track(stop("unexpected-popup", { format }));
	});
	page.on("download", (download) => {
		track(download.cancel());
		track(stop("unexpected-download", { format, suggestedFilename: download.suggestedFilename() }));
	});
	page.on("dialog", (dialog) => {
		item.dialogs.push({ type: dialog.type() });
		track(dialog.dismiss().catch(() => {}));
		track(stop("unexpected-dialog", { format }));
	});
	page.on("console", (message) => {
		const text = message.text();
		const trigger = text.match(
			/blocked opening|notification|permission.*denied|popunder|social.?bar|unsafe attempt.*navigation|sandbox.*(?:navigation|popup|download)/i,
		)?.[0];
		item.console.push({
			type: message.type(),
			length: text.length,
			sha256: createHash("sha256").update(text).digest("hex"),
			csp: /content security policy|violates.*directive/i.test(text),
			prohibitedBehavior: trigger ?? null,
		});
		if (trigger) track(stop("prohibited-or-blocked-behavior", { format, trigger }));
	});
	page.on("pageerror", (error) => {
		const text = error.message;
		if (text === opaqueServiceWorkerHarnessError) {
			item.harnessWarnings.push({
				classification: "playwright-1.62.1-serviceWorkers-block-opaque-getter",
				exactMessage: text,
				source: "Installed playwright-core/lib/coreBundle.js serviceWorkers:block initScript",
			});
			return;
		}
		const trigger = text.match(
			/blocked opening|notification|permission.*denied|popunder|social.?bar|unsafe attempt.*navigation|sandbox.*(?:navigation|popup|download)/i,
		)?.[0];
		item.pageErrors.push({
			length: text.length,
			sha256: createHash("sha256").update(text).digest("hex"),
			prohibitedBehavior: trigger ?? null,
		});
		track(stop("unexpected-page-error", { format, trigger: trigger ?? null }));
	});
	const attachedFrames = new WeakMap();
	const navigatedAdFrames = new WeakSet();
	const nativeSessions = new WeakMap();
	async function ensureNativeSession(target) {
		if (target === page.mainFrame()) target = page;
		if (!nativeSessions.has(target))
			nativeSessions.set(
				target,
				attachNativeSession(
					context,
					target,
					item,
					target === page ? "parent" : JSON.stringify(safeUrl(target.url())),
				),
			);
		const session = await nativeSessions.get(target);
		if (!session) nativeSessions.delete(target);
		return session;
	}
	async function ensureAdResponseGuard(frame) {
		for (let cursor = frame; cursor; cursor = cursor.parentFrame()) {
			const session = await ensureNativeSession(cursor);
			if (session) return session;
		}
		return ensureNativeSession(page);
	}
	page.on("framenavigated", (frame) => {
		item.navigations.push({ isMainFrame: frame === page.mainFrame(), url: safeUrl(frame.url()) });
		if (frame === page.mainFrame()) {
			try {
				const url = new URL(frame.url());
				if (url.origin !== appUrl.origin || !expectedPaths.has(url.pathname))
					track(stop("forced-main-navigation", { format, url: safeUrl(frame.url()) }));
			} catch {
				track(stop("unexpected-main-document", { format }));
			}
		} else if (belongsToAdTree(frame) && attachedFrames.get(frame) !== frame.url()) {
			attachedFrames.set(frame, frame.url());
			track(ensureNativeSession(frame));
		}
	});
	if (!(await ensureNativeSession(page)))
		throw new Error("Native response/CSP observer is unavailable");
	context.on("request", (request) => {
		item.requests.push({
			at: new Date().toISOString(),
			id: idFor(request),
			url: safeUrl(request.url()),
			method: request.method(),
			type: request.resourceType(),
			phase: ended ? "after-removal" : shown ? "shown" : "before-show",
		});
		track(
			request
				.allHeaders()
				.then((headers) => {
					item.requests.find((record) => record.id === idFor(request)).headers = {
						cookiePresent: Boolean(headers.cookie),
						authorizationPresent: Boolean(headers.authorization),
						referer: headers.referer ? safeUrl(headers.referer) : "",
					};
				})
				.catch(() => {}),
		);
	});
	context.on("requestfailed", (request) => {
		item.failures.push({
			id: idFor(request),
			url: safeUrl(request.url()),
			error: request.failure()?.errorText,
		});
	});
	context.on("response", (response) =>
		track(
			(async () => {
				const headers = await response.allHeaders();
				const record = {
					requestId: idFor(response.request()),
					url: safeUrl(response.url()),
					status: response.status(),
					contentType: headers["content-type"],
					contentLength: headers["content-length"],
					csp: headers["content-security-policy"],
					referrerPolicy: headers["referrer-policy"],
					location: headers.location ? safeLocation(headers.location, response.url()) : null,
					setCookiePresent: Boolean(headers["set-cookie"]),
				};
				item.responses.push(record);
				if (
					(new URL(response.url()).origin === adOrigin ||
						approvedOrigins.has(new URL(response.url()).origin)) &&
					response.status() >= 300 &&
					response.status() < 400 &&
					headers.location
				)
					await stop("supplier-redirect-observed", {
						status: response.status(),
						location: record.location,
					});
				if (!Object.values(loaders).includes(response.url())) return;
				if (Number(headers["content-length"]) > MAX_LOADER_BYTES) {
					await stop("loader-byte-budget", { format });
					return;
				}
				try {
					const body = await response.body();
					record.bytes = body.length;
					record.sha256 = createHash("sha256").update(body).digest("hex");
					if (body.length > MAX_LOADER_BYTES) await stop("loader-byte-budget", { format });
					else await writeFile(path.join(outputDir, `${format}-invoke.response.js`), body);
				} catch (error) {
					record.bodyLimit = String(error).slice(0, 200);
				}
			})().catch((error) => item.failures.push({ observationError: String(error).slice(0, 200) })),
		),
	);
	await context.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (stopped || Date.now() >= activeDeadline) {
			await route.abort().catch(() => {});
			await stop("request-after-stop-or-deadline", { url: safeUrl(url.href) });
			return;
		}
		const continueAllowed = async () => {
			if (stopped || Date.now() >= activeDeadline) {
				await route.abort().catch(() => {});
				await stop("request-after-stop-or-deadline", { url: safeUrl(url.href) });
			} else {
				await route.continue();
				return true;
			}
			return false;
		};
		let frame;
		try {
			frame = request.frame();
		} catch {
			// Service workers are blocked; unresolved ownership is not silently trusted.
		}
		const child = frame ? belongsToAdTree(frame) : false;
		const intercept = (reason) =>
			item.intercepts.push({ id: idFor(request), reason, url: safeUrl(url.href), child });
		if (url.origin === adOrigin || approvedOrigins.has(url.origin)) {
			if (++adRequestCount > MAX_AD_REQUESTS_PER_RUN) {
				intercept("ad-request-budget");
				await route.abort();
				await stop("ad-request-budget", { format });
				return;
			}
		}
		if (url.origin === appUrl.origin && !child) {
			if (
				forbiddenBusinessPath.test(url.pathname) ||
				(url.pathname.startsWith("/api/")
					? !readonlyApiMethods.get(url.pathname)?.has(request.method())
					: !["GET", "HEAD"].includes(request.method()))
			) {
				intercept("forbidden-main-write");
				await route.abort();
				await stop("forbidden-main-write", { format, url: safeUrl(url.href) });
			} else if (
				request.isNavigationRequest() &&
				frame === page.mainFrame() &&
				!expectedPaths.has(url.pathname)
			) {
				intercept("forced-main-navigation");
				await route.abort();
				await stop("forced-main-navigation", { format, url: safeUrl(url.href) });
			} else await continueAllowed();
			return;
		}
		if (!child && optionalParentHosts.has(url.hostname)) {
			intercept("known-parent-thirdparty-intercept");
			await route.abort();
			return;
		}
		if (
			url.origin === adOrigin &&
			url.href === `${adOrigin}/${format}.html` &&
			["GET", "HEAD"].includes(request.method()) &&
			shown &&
			!ended
		) {
			if (++documentCounts[format] > 1) {
				intercept("repeated-ad-document");
				await route.abort();
				await stop("repeated-ad-document", { format });
				return;
			}
			if (frame) navigatedAdFrames.add(frame);
			if (!(await ensureAdResponseGuard(frame))) {
				intercept("native-response-guard-unavailable");
				await route.abort();
				await stop("native-response-guard-unavailable", { format });
			} else await continueAllowed();
			return;
		}
		if (approvedOrigins.has(url.origin) && child && shown && !ended) {
			const loaderFormat = Object.keys(loaders).find(
				(key) => new URL(loaders[key]).pathname === url.pathname,
			);
			if (
				loaderFormat &&
				(loaders[loaderFormat] !== url.href ||
					loaderFormat !== format ||
					++loaderCounts[loaderFormat] > 1)
			) {
				intercept("unexpected-or-repeated-loader");
				await route.abort();
				await stop("unexpected-or-repeated-loader", { format, loaderFormat });
			} else if (
				request.isNavigationRequest() &&
				frame &&
				!request.redirectedFrom() &&
				navigatedAdFrames.has(frame)
			) {
				intercept("ad-document-refresh-or-redirect");
				await route.abort();
				await stop("ad-document-refresh-or-redirect", { format });
			} else {
				if (request.isNavigationRequest() && frame) navigatedAdFrames.add(frame);
				if (!(await ensureAdResponseGuard(frame))) {
					intercept("native-response-guard-unavailable");
					await route.abort();
					await stop("native-response-guard-unavailable", { format });
				} else if (await continueAllowed()) {
					if (loaderFormat) allowedLoaderCounts[loaderFormat] += 1;
				}
			}
			return;
		}
		intercept(ended ? "request-after-removal" : "unapproved-source");
		await route.abort();
		await stop(ended ? "ad-request-after-removal" : "unapproved-source", {
			format,
			url: safeUrl(url.href),
			child,
		});
	});

	try {
		const previewUrl = new URL(`${articlePath}?blogAdTest=${format}`, appUrl.origin);
		await page.goto(previewUrl.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
		await page.getByRole("button", { name: "Show blog ads", exact: true }).waitFor();
		const before = await capture(page, item, "fresh-consent-before-show");
		if (before.frames.length)
			throw new Error("An advertising context appeared before explicit Show");
		if (!(await page.evaluate(() => "credentialless" in HTMLIFrameElement.prototype)))
			throw new Error("Chromium does not support the required credentialless frame boundary");
		ensureRunning();
		shown = true;
		await page.getByRole("button", { name: "Show blog ads", exact: true }).click();
		await page.locator(`[data-blog-ad="${format}"]`).scrollIntoViewIfNeeded();
		await page.locator(`iframe[data-blog-ad-frame="${format}"]`).waitFor();
		await observeFor(observationMs);
		const after = await capture(page, item, "passive-inventory");
		if (
			after.frames.length !== 1 ||
			after.frames[0].format !== format ||
			after.frames[0].source !== `${adOrigin}/${format}.html` ||
			after.frames[0].sandbox !== "allow-scripts" ||
			after.frames[0].referrerPolicy !== "no-referrer" ||
			!after.frames[0].credentialless
		)
			throw new Error("The owned frame does not match the approved isolation boundary");
		for (const frame of page.frames().filter((candidate) => belongsToAdTree(candidate))) {
			try {
				const document = await frame.evaluate(() => ({
					url: location.href,
					baseURI: document.baseURI,
					referrer: document.referrer,
					bodyScrollWidth: document.body?.scrollWidth,
					bodyScrollHeight: document.body?.scrollHeight,
					clientWidth: document.documentElement.clientWidth,
					clientHeight: document.documentElement.clientHeight,
					images: document.images.length,
					frames: document.querySelectorAll("iframe").length,
					textLength: document.body?.innerText.length ?? 0,
					fixedElements: [...document.querySelectorAll("body *")].filter((element) =>
						["fixed", "sticky"].includes(getComputedStyle(element).position),
					).length,
					notificationLikeLanguage:
						/allow notifications|enable notifications|click allow|virus detected|social.?bar/i.test(
							document.body?.innerText ?? "",
						),
				}));
				item.frameDocuments.push({
					...document,
					url: safeUrl(document.url),
					baseURI: safeUrl(document.baseURI),
					referrer: document.referrer ? safeUrl(document.referrer) : "",
				});
				if (document.fixedElements || document.notificationLikeLanguage)
					await stop("unsupported-overlay-or-notification-like-content", {
						format,
						fixedElements: document.fixedElements,
						notificationLikeLanguage: document.notificationLikeLanguage,
					});
			} catch (error) {
				item.nativeSessionLimits.push({ documentSnapshot: String(error).slice(0, 200) });
			}
		}
		await page.screenshot({ path: path.join(outputDir, `${format}-viewport.png`) });
		if (isMobile) {
			const originalElement = await page
				.locator('iframe[data-blog-ad-frame="native"]')
				.elementHandle();
			const originalFrame = await originalElement.contentFrame();
			const originalTimeOrigin = await originalFrame.evaluate(() => performance.timeOrigin);
			const initialRequests = { document: documentCounts.native, loader: loaderCounts.native };
			async function assertSameNativeContext(phase) {
				const sameElement = await originalElement.evaluate(
					(element) =>
						element.isConnected &&
						element === document.querySelector('iframe[data-blog-ad-frame="native"]'),
				);
				const sameFrame = (await originalElement.contentFrame()) === originalFrame;
				const sameTimeOrigin =
					(await originalFrame.evaluate(() => performance.timeOrigin)) === originalTimeOrigin;
				const sameRequests =
					documentCounts.native === initialRequests.document &&
					loaderCounts.native === initialRequests.loader;
				item.checkpoints.at(-1).nativeIdentity = {
					phase,
					sameElement,
					sameFrame,
					sameTimeOrigin,
					sameRequests,
					originalTimeOrigin,
				};
				if (!sameElement || !sameFrame || !sameTimeOrigin || !sameRequests)
					throw new Error("Resizing reloaded or replaced the native advertising context");
			}
			await page.setViewportSize({ width: 320, height: 844 });
			await capture(page, item, "same-native-context-at-320");
			await assertSameNativeContext("320");
			await page.screenshot({ path: path.join(outputDir, "native-320-viewport.png") });
			await page.setViewportSize({ width: 1280, height: 1000 });
			const resized = await capture(page, item, "same-native-context-at-1280");
			if (resized.frames.length !== 1 || resized.frames[0].format !== "native")
				throw new Error("Native preview resize created an extra advertising context");
			await assertSameNativeContext("1280");
			await page.screenshot({ path: path.join(outputDir, "native-1280-viewport.png") });
		}
		item.cookies = (await context.cookies()).map(cookieMetadata);
		ended = true;
		if (!isMobile) {
			await page.getByRole("button", { name: "Hide blog ads", exact: true }).click();
			await page.locator(adFrameSelector).waitFor({ state: "detached" });
			await observeFor(500);
			const hidden = await capture(page, item, "hide-removes-entire-context");
			if (hidden.frames.length || hidden.adChildFrames.length || hidden.openPopupCount)
				throw new Error("Hide retained an advertising context or popup");
		} else {
			const articleTimeOrigin = after.timeOrigin;
			expectedPaths = new Set(["/"]);
			await page.locator('.blog-breadcrumb a[href="/"]:visible').click();
			await page.waitForURL(new URL("/", appUrl.origin).href, { waitUntil: "domcontentloaded" });
			const home = await capture(page, item, "article-ui-link-to-product");
			if (
				home.frames.length ||
				home.adChildFrames.length ||
				home.openPopupCount ||
				home.timeOrigin === articleTimeOrigin
			)
				throw new Error("Article exit did not clear frames and create a product document");
			expectedPaths = new Set([articlePath]);
			await page.goBack({ waitUntil: "domcontentloaded" });
			const back = await capture(page, item, "back-article-without-another-show");
			if (back.frames.length || back.adChildFrames.length || back.openPopupCount)
				throw new Error("History restored an opted-in advertising context or popup");
			expectedPaths = new Set(["/"]);
			await page.goForward({ waitUntil: "domcontentloaded" });
			await capture(page, item, "forward-product");
			for (const pathname of [
				"/create",
				"/pricing",
				"/login",
				"/dashboard",
				"/settings/billing",
				"/checkout-return",
			]) {
				expectedPaths = new Set([pathname, "/login"]);
				const response = await page.goto(new URL(pathname, appUrl.origin).href, {
					waitUntil: "domcontentloaded",
					timeout: 30_000,
				});
				const checkpoint = await capture(page, item, `anonymous-direct-${pathname}`);
				const csp = response?.headers()["content-security-policy"];
				const protectedRoute = ["/dashboard", "/settings/billing", "/checkout-return"].includes(
					pathname,
				);
				item.checkpoints.at(-1).routeOutcome = {
					status: response?.status(),
					requestedPath: pathname,
					actualPath: new URL(page.url()).pathname,
					protectedRoute,
				};
				if (
					response?.status() !== 200 ||
					(protectedRoute && new URL(page.url()).pathname !== "/login")
				)
					throw new Error(
						"Public route failed or the anonymous account/checkout-return did not reach its login boundary",
					);
				if (
					checkpoint.frames.length ||
					checkpoint.adChildFrames.length ||
					checkpoint.openPopupCount ||
					!csp ||
					/frame-src[^;]*ads\.ezimageai\.com/.test(csp)
				)
					throw new Error(
						"A product/account/checkout-return response retained advertising permission",
					);
			}
			await observeFor(500);
		}
		await Promise.allSettled([...pending]);
		const loader = item.responses.find(
			(response) => response.url.pathname === new URL(loaders[format]).pathname,
		);
		if (allowedLoaderCounts[format] !== 1)
			throw new Error("The exact approved loader did not execute one permitted HTTP request");
		item.status =
			loader?.status === 200 && loader.bytes > 0
				? "nonempty-loader-observed-creative-review-required"
				: "inventory-not-established";
		item.loaderRequestAttempts = loaderCounts[format];
		item.permittedLoaderRequests = allowedLoaderCounts[format];
		item.endedAt = new Date().toISOString();
	} finally {
		await Promise.race([
			context.close().catch(() => {}),
			new Promise((resolve) =>
				setTimeout(resolve, Math.max(0, Math.min(2_000, runDeadline - Date.now()))),
			),
		]);
		activeContext = undefined;
	}
}

const signal = () => void stop("operator-interrupt", {});
process.once("SIGINT", signal);
process.once("SIGTERM", signal);
const deadlineTimer = setTimeout(() => void stop("preview-deadline", {}), expiresAt - Date.now());
const watchdog = setTimeout(
	() => void stop("whole-run-time-budget", {}),
	activeDeadline - Date.now(),
);
try {
	ensureRunning();
	browserServer = await chromium.launchServer({
		headless: true,
		chromiumSandbox: true,
		timeout: Math.max(1, Math.min(30_000, activeDeadline - Date.now())),
	});
	ensureRunning();
	browser = await chromium.connect(browserServer.wsEndpoint(), {
		timeout: Math.max(1, Math.min(30_000, activeDeadline - Date.now())),
	});
	ensureRunning();
	evidence.browserVersion = browser.version();
	await runCase("banner");
	await runCase("native");
} catch (error) {
	evidence.error = String(error).slice(0, 700);
	process.exitCode = 1;
} finally {
	await closeOwnedBrowser();
	await Promise.race([
		Promise.allSettled([...pending]),
		new Promise((resolve) =>
			setTimeout(resolve, Math.max(0, Math.min(2_000, runDeadline - Date.now()))),
		),
	]);
	clearTimeout(deadlineTimer);
	clearTimeout(watchdog);
	evidence.endedAt = new Date().toISOString();
	evidence.loaderRequestAttempts = loaderCounts;
	evidence.permittedLoaderRequests = allowedLoaderCounts;
	evidence.adDocumentRequestAttempts = documentCounts;
	evidence.totalAdRequests = adRequestCount;
	evidence.completedWithoutSafetyStop = !stopped && !evidence.error;
	await writeFile(
		path.join(outputDir, "observation.json"),
		`${JSON.stringify(evidence, null, 2)}\n`,
	);
	console.log(
		JSON.stringify({
			outputDir,
			permittedLoaderRequests: allowedLoaderCounts,
			cases: evidence.cases.map(({ format, status }) => ({ format, status })),
			stopReasons: evidence.stopReasons,
			error: evidence.error,
		}),
	);
}
