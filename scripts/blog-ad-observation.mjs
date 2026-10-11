import { mkdir, writeFile } from "node:fs/promises";
// Passive evidence only: fresh Chromium contexts, no ad clicks, no account data.
// Uses the repository's already-installed Playwright; does not install software.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const dependencyRoot = process.argv[2];
if (!dependencyRoot) throw new Error("Pass the existing repository dependency root");
const require = createRequire(path.join(dependencyRoot, "package.json"));
const { chromium } = require("./node_modules/.pnpm/playwright@1.62.1/node_modules/playwright");
const evidenceDir = path.resolve("docs/operations/evidence/blog-ads");
await mkdir(evidenceDir, { recursive: true });

const bannerUrl = "https://www.highrevenueformat.com/2266a6811e407f9b362831f885d09d1e/invoke.js";
const nativeUrl =
	"https://pl31768149.profitableratecpmnetwork.com/0a9986f36ff843c117e0f20e732a1e08/invoke.js";
const bannerDocument = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0}</style><script>atOptions={key:'2266a6811e407f9b362831f885d09d1e',format:'iframe',height:90,width:728,params:{}};</script><script src="${bannerUrl}"></script>`;
const nativeDocument = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0}</style><script async="async" data-cfasync="false" src="${nativeUrl}"></script><div id="container-0a9986f36ff843c117e0f20e732a1e08"></div>`;
const csp = [
	"default-src 'self'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
	"object-src 'none'",
	"script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://www.clarity.ms https://scripts.clarity.ms https://static.cloudflareinsights.com https://challenges.cloudflare.com",
	"frame-src https://challenges.cloudflare.com",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' blob: data: https:",
	"media-src 'self' blob: https:",
	"font-src 'self' data:",
	"connect-src 'self' https:",
	"worker-src 'self' blob:",
].join("; ");
const escapeAttribute = (value) =>
	value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Passive Blog Ad Observation</title><style>*{box-sizing:border-box}body{margin:0;font:16px system-ui;padding:20px}main{max-width:900px;margin:auto}section{margin:24px 0}iframe{display:block;border:0;max-width:100%}.banner{width:728px;height:90px}.native{width:100%;height:500px;background:#f5f5f5}@media(max-width:767px){.banner-section{display:none}}</style><main><h1>Passive Blog Ad Observation</h1><p>This fixture contains no product account, upload, prompt, or resource URL.</p><section class="banner-section"><p>Advertisement — supplied 728 × 90 banner</p><iframe title="Banner evidence" class="banner" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeAttribute(bannerDocument)}"></iframe></section><section><p>Advertisement — supplied widget, actual format unverified</p><iframe title="Widget evidence" class="native" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeAttribute(nativeDocument)}"></iframe></section></main></html>`;
await writeFile(path.join(evidenceDir, "sandbox-fixture.html"), html);

const server = createServer((request, response) => {
	const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
	response.setHeader("Content-Type", "text/html; charset=utf-8");
	response.setHeader("Cache-Control", "no-store");
	response.setHeader("Referrer-Policy", "no-referrer");
	response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
	if (pathname === "/csp") response.setHeader("Content-Security-Policy", csp);
	response.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
let browser;
const all = [];
try {
	browser = await chromium.launch({
		headless: true,
		chromiumSandbox: true,
		executablePath: chromium.executablePath(),
		ignoreDefaultArgs: true,
		args: ["--headless=new", "--remote-debugging-pipe", "--no-first-run", "--no-startup-window"],
	});
	for (const width of [1280, 390]) {
		for (const policy of ["sandbox", "csp"]) {
			const context = await browser.newContext({
				viewport: { width, height: 900 },
				acceptDownloads: false,
				permissions: [],
			});
			const observation = {
				name: `${policy}-${width}`,
				utc: new Date().toISOString(),
				viewport: { width, height: 900 },
				policy,
				requests: [],
				responses: [],
				failures: [],
				console: [],
				errors: [],
				navigations: [],
				popups: [],
				cookies: [],
				frames: [],
			};
			await context.addInitScript(() => {
				const observations = { eventListeners: [], openCalls: [], notifications: [], timers: [] };
				Object.defineProperty(window, "__adObservation", { value: observations });
				// oxlint-disable-next-line typescript/unbound-method -- Original receiver is restored with .call below.
				const originalAdd = EventTarget.prototype.addEventListener;
				EventTarget.prototype.addEventListener = function (type, listener, options) {
					observations.eventListeners.push({
						type,
						target:
							this === window ? "window" : this === document ? "document" : this.constructor?.name,
					});
					return originalAdd.call(this, type, listener, options);
				};
				const originalOpen = window.open;
				window.open = function (...args) {
					observations.openCalls.push({ args: args.map(String) });
					return originalOpen.apply(this, args);
				};
				if (window.Notification) {
					// oxlint-disable-next-line typescript/unbound-method -- Original receiver is restored with .apply below.
					const originalRequestPermission = Notification.requestPermission;
					Notification.requestPermission = function (...args) {
						observations.notifications.push("requestPermission");
						return originalRequestPermission.apply(this, args);
					};
				}
				for (const name of ["setTimeout", "setInterval"]) {
					const original = window[name];
					window[name] = function (...args) {
						observations.timers.push({ name, delay: args[1] ?? 0 });
						return original.apply(this, args);
					};
				}
			});
			const page = await context.newPage();
			context.on("page", async (popup) => {
				observation.popups.push(popup.url());
				await popup.close();
			});
			context.on("request", (request) =>
				observation.requests.push({
					url: request.url(),
					method: request.method(),
					type: request.resourceType(),
					frame: request.frame().url(),
				}),
			);
			context.on("response", async (response) => {
				const item = {
					url: response.url(),
					status: response.status(),
					headers: await response.allHeaders(),
				};
				if ([bannerUrl, nativeUrl].includes(response.url())) {
					try {
						const body = await response.body();
						item.bytes = body.length;
						await writeFile(
							path.join(
								evidenceDir,
								`${observation.name}-${response.url() === bannerUrl ? "banner" : "widget"}.response.txt`,
							),
							body,
						);
					} catch (error) {
						item.bodyError = String(error);
					}
				}
				observation.responses.push(item);
			});
			context.on("requestfailed", (request) =>
				observation.failures.push({ url: request.url(), failure: request.failure() }),
			);
			page.on("console", (message) =>
				observation.console.push({ type: message.type(), text: message.text() }),
			);
			page.on("pageerror", (error) => observation.errors.push(String(error)));
			page.on("framenavigated", (frame) =>
				observation.navigations.push({ url: frame.url(), main: frame === page.mainFrame() }),
			);
			await page.goto(`${baseUrl}/${policy === "csp" ? "csp" : "sandbox"}`, { waitUntil: "load" });
			// Passive observation interval, not an assertion that a supplier ad loaded.
			await page.waitForTimeout(8000);
			observation.layout = await page.evaluate(() => ({
				documentWidth: document.documentElement.scrollWidth,
				viewportWidth: innerWidth,
				frames: [...document.querySelectorAll("iframe")].map((frame) => ({
					title: frame.title,
					sandbox: frame.getAttribute("sandbox"),
					referrerPolicy: frame.referrerPolicy,
					bounds: {
						width: frame.getBoundingClientRect().width,
						height: frame.getBoundingClientRect().height,
					},
					visible: !!frame.getClientRects().length,
				})),
			}));
			for (const frame of page.frames()) {
				try {
					observation.frames.push(
						await frame.evaluate(() => {
							let cookies;
							try {
								cookies = document.cookie;
							} catch (error) {
								cookies = String(error);
							}
							return {
								url: location.href,
								origin: location.origin,
								bodyText: document.body?.innerText,
								dom: document.documentElement.outerHTML,
								cookies,
								observations: window.__adObservation,
								resources: performance.getEntriesByType("resource").map((entry) => ({
									name: entry.name,
									initiatorType: entry.initiatorType,
									duration: entry.duration,
									transferSize: entry.transferSize,
									responseStatus: entry.responseStatus,
								})),
								bannerOptions: window.atOptions,
								elements: [...document.querySelectorAll("iframe, img, a")].map((element) => ({
									tag: element.tagName,
									src: element.getAttribute("src"),
									href: element.getAttribute("href"),
									width: element.getBoundingClientRect().width,
									height: element.getBoundingClientRect().height,
								})),
							};
						}),
					);
				} catch (error) {
					observation.frames.push({ url: frame.url(), error: String(error) });
				}
			}
			observation.cookies = await context.cookies();
			await page.screenshot({
				path: path.join(evidenceDir, `${observation.name}.png`),
				fullPage: true,
			});
			await writeFile(
				path.join(evidenceDir, `${observation.name}.json`),
				JSON.stringify(observation, null, 2),
			);
			all.push({
				name: observation.name,
				adRequests: observation.requests.filter((item) =>
					/highrevenueformat|profitableratecpmnetwork/.test(item.url),
				),
				adResponses: observation.responses.filter((item) =>
					/highrevenueformat|profitableratecpmnetwork/.test(item.url),
				),
				frameResources: observation.frames.flatMap((frame) => frame.resources ?? []),
				failures: observation.failures,
				console: observation.console,
				errors: observation.errors,
				popups: observation.popups,
				cookies: observation.cookies,
				layout: observation.layout,
			});
			await context.close();
		}
	}
	const staticContext = await browser.newContext();
	const staticFetch = [];
	for (const [name, url] of [
		["banner", bannerUrl],
		["widget", nativeUrl],
	]) {
		try {
			const response = await staticContext.request.get(url, { timeout: 20000 });
			const body = await response.body();
			const item = {
				name,
				url,
				utc: new Date().toISOString(),
				status: response.status(),
				headers: response.headers(),
				bytes: body.length,
			};
			await writeFile(path.join(evidenceDir, `browser-api-${name}.response.txt`), body);
			staticFetch.push(item);
		} catch (error) {
			staticFetch.push({ name, url, error: String(error) });
		}
	}
	await writeFile(
		path.join(evidenceDir, "browser-api-fetch.json"),
		JSON.stringify(staticFetch, null, 2),
	);
	await staticContext.close();
} finally {
	await browser?.close();
	await new Promise((resolve) => server.close(resolve));
}
await writeFile(
	path.join(evidenceDir, "browser-summary.json"),
	JSON.stringify(
		{
			utc: new Date().toISOString(),
			playwrightVersion: "1.62.1",
			browserSandbox: true,
			hostData: "none",
			clicks: 0,
			requestCaptureLimit:
				"Opaque srcdoc subresources did not appear in request/response event capture; per-frame performance resources retain URL evidence. Their cross-origin responseStatus=0 does not establish an HTTP status.",
			observations: all,
		},
		null,
		2,
	),
);
console.log(
	JSON.stringify(
		all.map(({ name, adResponses, failures, layout, cookies, popups }) => ({
			name,
			adResponses: adResponses.map(({ url, status, bytes }) => ({ url, status, bytes })),
			failures,
			layout,
			cookies,
			popups,
		})),
		null,
		2,
	),
);
