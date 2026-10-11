import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";

import { buildStaticAds, readSourceDocument } from "../apps/blog-ads/generate.ts";
import {
	BLOG_AD_NATIVE_HEIGHT,
	getBlogAdDocument,
} from "../apps/saas/modules/public-content/lib/blog-ads.ts";

// This is an offline browser fixture, not an advertising integration observation.
// Every request is fulfilled locally or aborted; no route.fetch/continue exists.
// Original invoke URLs return only the inert heartbeat below. Never report their
// fixture success as supplier compatibility, fill, responsiveness or revenue.
const { values } = parseArgs({
	options: {
		"dependency-root": { type: "string", default: process.cwd() },
		"output-dir": { type: "string" },
		help: { type: "boolean", default: false },
	},
});
if (values.help) {
	console.log(
		"node --import <existing-tsx-loader> scripts/blog-ad-document-lifecycle.mjs [--dependency-root EXISTING_REPO] [--output-dir output/playwright/blog-ads/document-lifecycle-UNIQUE]",
	);
	process.exit(0);
}

const dependencyRoot = path.resolve(values["dependency-root"]);
const require = createRequire(path.join(dependencyRoot, "apps/saas/package.json"));
const { chromium } = require("@playwright/test");
await access(chromium.executablePath()); // No browser download or user Chrome.
const outputDir = path.resolve(
	values["output-dir"] ??
		`output/playwright/blog-ads/document-lifecycle-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
const relativeOutput = path.relative(process.cwd(), outputDir);
if (
	!relativeOutput.startsWith(`output${path.sep}playwright${path.sep}blog-ads${path.sep}`) ||
	path.isAbsolute(relativeOutput) ||
	relativeOutput.startsWith("..")
) {
	throw new Error("Use a fresh ignored output/playwright/blog-ads directory in this worktree.");
}
await mkdir(path.dirname(outputDir), { recursive: true });
await mkdir(outputDir); // Never overwrite earlier evidence.

const mainOrigin = "https://ezimageai.com";
const adOrigin = "https://ads.ezimageai.com";
const testUntil = "2026-10-11T13:00:00Z";
const deadline = Date.parse(testUntil);
const initialTime = deadline - 2000;
const build = buildStaticAds(testUntil, initialTime);
const sources = Object.fromEntries(
	["banner", "native"].map((format) => {
		const document = readSourceDocument(format, getBlogAdDocument(format));
		return [
			format,
			{
				...document,
				loader: document.externalScript.match(/src="([^"]+)"/)[1],
				height:
					format === "banner"
						? Number(document.config.match(/'height':(\d+)/)[1])
						: BLOG_AD_NATIVE_HEIGHT,
			},
		];
	}),
);
const fixtureStyle = "body{margin:16px}iframe{border:0;display:block}";
const fixtureStyleHash = `'sha256-${createHash("sha256").update(fixtureStyle).digest("base64")}'`;
const parentCsp = [
	"default-src 'none'",
	"script-src 'none'",
	`style-src ${fixtureStyleHash}`,
	"style-src-attr 'none'",
	`frame-src https://challenges.cloudflare.com ${adOrigin}`,
	"connect-src 'none'",
	"img-src 'none'",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
].join("; ");
const sandboxedServiceWorkerHarnessError =
	"Failed to read the 'serviceWorker' property from 'Navigator': Service worker is disabled because the context is sandboxed and lacks the 'allow-same-origin' flag.";

function assetHeaders(format) {
	const block = build.files._headers
		.split("\n\n")
		.find((value) => value.startsWith(`/${format}.html\n`));
	assert.ok(block, "Generated response header block must exist.");
	return Object.fromEntries(
		block
			.split("\n")
			.slice(1)
			.filter(Boolean)
			.map((line) => {
				const separator = line.indexOf(":");
				return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
			}),
	);
}

function fixtureHtml(format) {
	return `<!doctype html><html><head><meta charset="utf-8"><title>Inert ${format} document lifecycle fixture</title><style>${fixtureStyle}</style></head><body><h1>Inert ${format} lifecycle fixture</h1><iframe data-blog-ad-frame title="Inert static ${format} fixture" credentialless sandbox="allow-scripts" referrerpolicy="no-referrer" width="728" height="${sources[format].height}" src="${adOrigin}/${format}.html"></iframe></body></html>`;
}

function inertLoader(format) {
	return `(()=>{const state={format:${JSON.stringify(format)},heartbeats:0};globalThis.__blogAdInertFixture=state;console.info("BLOG_AD_INERT|${format}|start");setInterval(()=>{state.heartbeats++;console.info("BLOG_AD_INERT|${format}|heartbeat");},100);})();`;
}

const evidence = {
	startedAt: new Date().toISOString(),
	kind: "offline-generated-document-lifecycle",
	supplierPayloads: "inert local heartbeat only; no actual vendor script or creative",
	actualSupplierNetworkRequests: 0,
	productionRequests: 0,
	userChromeUsed: false,
	deploymentPerformed: false,
	harnessWarningSource: {
		package: "playwright-core@1.62.1",
		file: "lib/coreBundle.js",
		lines: [51294, 51295, 51296],
		initScript:
			"if (navigator.serviceWorker) navigator.serviceWorker.register = async () => { console.warn('Service Worker registration blocked by Playwright'); };",
		note: "The serviceWorkers:block init script reads this forbidden opaque-origin property without a guard. Only its exact SecurityError is recorded separately; all other page errors fail. No document policy is relaxed.",
	},
	clock: { initial: new Date(initialTime).toISOString(), deadline: testUntil },
	parentCsp,
	assets: Object.fromEntries(
		["banner", "native"].map((format) => [
			format,
			{
				htmlSha256: createHash("sha256").update(build.files[`${format}.html`]).digest("hex"),
				headers: assetHeaders(format),
				originalExactLoader: sources[format].loader,
			},
		]),
	),
	scenarios: [],
	checks: [],
};
function check(name, passed) {
	evidence.checks.push({ name, passed: Boolean(passed) });
	assert.ok(passed, name);
}

let browser;
let activeContext;
let timedOut = false;
const watchdog = setTimeout(() => {
	timedOut = true;
	void browser?.close().catch(() => {});
}, 60_000);

async function scenario(format, embedded) {
	const result = {
		format,
		mode: embedded ? "embedded" : "top-level",
		requests: [],
		blockedRequests: [],
		cspViolations: [],
		pageErrors: [],
		harnessPageErrors: [],
		heartbeatConsoleMessages: 0,
		exactLoaderRequests: 0,
		passed: false,
	};
	evidence.scenarios.push(result);
	const context = await browser.newContext({
		viewport: { width: 1280, height: 720 },
		serviceWorkers: "block",
	});
	activeContext = context;
	context.setDefaultTimeout(5000);
	await context.setOffline(true); // Route fulfilment is the only response source.
	await context.addInitScript(() => {
		document.addEventListener("securitypolicyviolation", (event) => {
			console.info(
				`BLOG_AD_FIXTURE_CSP|${JSON.stringify({
					directive: event.effectiveDirective,
					blockedUri: event.blockedURI,
					disposition: event.disposition,
				})}`,
			);
		});
	});
	await context.routeWebSocket("**/*", (socket) => {
		result.blockedRequests.push({ url: socket.url(), kind: "websocket" });
		socket.close({ code: 1000, reason: "offline-fixture-only" });
	});
	const mainUrl = `${mainOrigin}/__blog-ad-document-fixture/${format}`;
	const adUrl = `${adOrigin}/${format}.html`;
	await context.route("**/*", async (route) => {
		const request = route.request();
		const url = request.url();
		const method = request.method();
		if (method === "GET" && url === mainUrl && embedded) {
			result.requests.push({ url, method, kind: "parent-fixture", handling: "local-fulfill" });
			await route.fulfill({
				status: 200,
				contentType: "text/html; charset=utf-8",
				headers: { "Content-Security-Policy": parentCsp, "Referrer-Policy": "no-referrer" },
				body: fixtureHtml(format),
			});
		} else if (method === "GET" && url === adUrl) {
			result.requests.push({
				url,
				method,
				kind: "generated-static-document",
				handling: "local-fulfill",
			});
			await route.fulfill({
				status: 200,
				contentType: "text/html; charset=utf-8",
				headers: assetHeaders(format),
				body: build.files[`${format}.html`],
			});
		} else if (method === "GET" && url === sources[format].loader && embedded) {
			result.exactLoaderRequests++;
			result.requests.push({
				url,
				method,
				kind: "inert-original-url-loader",
				handling: "local-fulfill",
			});
			await route.fulfill({
				status: 200,
				contentType: "application/javascript; charset=utf-8",
				headers: { "Cache-Control": "no-store" },
				body: inertLoader(format),
			});
		} else {
			result.blockedRequests.push({ url, method, kind: request.resourceType() });
			await route.abort("blockedbyclient");
		}
	});
	const page = await context.newPage();
	page.on("console", (message) => {
		const text = message.text();
		if (text === `BLOG_AD_INERT|${format}|heartbeat`) result.heartbeatConsoleMessages++;
		if (text.startsWith("BLOG_AD_FIXTURE_CSP|")) {
			result.cspViolations.push(JSON.parse(text.slice("BLOG_AD_FIXTURE_CSP|".length)));
		}
	});
	page.on("pageerror", (error) => {
		if (error.message === sandboxedServiceWorkerHarnessError) {
			result.harnessPageErrors.push(error.message);
		} else {
			result.pageErrors.push(error.message);
		}
	});
	page.on("popup", (popup) => {
		result.blockedRequests.push({ kind: "popup" });
		void popup.close().catch(() => {});
	});
	try {
		await page.clock.install({ time: new Date(initialTime - 1000) });
		await page.clock.pauseAt(new Date(initialTime));
		const response = await page.goto(embedded ? mainUrl : adUrl, {
			waitUntil: "load",
			timeout: 10_000,
		});
		check(`${format}/${result.mode}: fixture HTTP 200`, response?.status() === 200);
		let frame = page.mainFrame();
		if (embedded) {
			const iframe = page.locator("iframe[data-blog-ad-frame]");
			result.geometry = await iframe.boundingBox();
			const attributes = await iframe.evaluate((element) => ({
				sandbox: element.getAttribute("sandbox"),
				credentialless: element.hasAttribute("credentialless"),
				referrerPolicy: element.referrerPolicy,
				allow: element.getAttribute("allow"),
			}));
			result.iframeAttributes = attributes;
			check(
				`${format}/embedded: only sandbox allow-scripts`,
				attributes.sandbox === "allow-scripts",
			);
			check(
				`${format}/embedded: credentialless and no-referrer`,
				attributes.credentialless && attributes.referrerPolicy === "no-referrer",
			);
			check(`${format}/embedded: no extra iframe capability`, attributes.allow === null);
			frame = await (await iframe.elementHandle()).contentFrame();
			assert.ok(frame);
		}
		result.initial = await frame.evaluate(
			({ loader, native }) => {
				const inaccessible = (read) => {
					try {
						read();
						return false;
					} catch (error) {
						return error.name === "SecurityError";
					}
				};
				return {
					now: Date.now(),
					url: document.URL,
					baseUri: document.baseURI,
					referrerEmpty: document.referrer === "",
					opaqueOrigin: globalThis.origin === "null",
					cookieAccessDenied: inaccessible(() => document.cookie),
					storageAccessDenied: inaccessible(() => localStorage.length),
					serviceWorkerAccessDenied: inaccessible(() => navigator.serviceWorker),
					fixtureRealmPresent: typeof globalThis.__blogAdInertFixture === "object",
					fixtureHeartbeats: globalThis.__blogAdInertFixture?.heartbeats ?? 0,
					configPresent: typeof globalThis.atOptions === "object",
					bannerConfigExact: native
						? typeof globalThis.atOptions === "undefined"
						: globalThis.atOptions?.key === new URL(loader).pathname.split("/")[1] &&
							globalThis.atOptions.format === "iframe" &&
							globalThis.atOptions.height === 90 &&
							globalThis.atOptions.width === 728 &&
							Object.keys(globalThis.atOptions.params).length === 0,
					bodyMargin: getComputedStyle(document.body).margin,
					viewport: { width: innerWidth, height: innerHeight },
				};
			},
			{ loader: sources[format].loader, native: format === "native" },
		);
		check(`${format}/${result.mode}: paused exact deadline-2s`, result.initial.now === initialTime);
		check(
			`${format}/${result.mode}: own static URL and base URI`,
			result.initial.url === adUrl && result.initial.baseUri === adUrl,
		);
		check(
			`${format}/${result.mode}: opaque sandbox and blocked storage/cookies`,
			result.initial.opaqueOrigin &&
				result.initial.cookieAccessDenied &&
				result.initial.storageAccessDenied &&
				result.initial.serviceWorkerAccessDenied,
		);
		check(`${format}/${result.mode}: empty referrer`, result.initial.referrerEmpty);
		check(
			`${format}/${result.mode}: hash-approved stylesheet applies`,
			result.initial.bodyMargin === "0px",
		);
		if (!embedded) {
			check(
				`${format}/top-level: no fixture loader or configuration`,
				result.exactLoaderRequests === 0 &&
					!result.initial.fixtureRealmPresent &&
					!result.initial.configPresent,
			);
			await page.clock.runFor(3000);
			check(
				`${format}/top-level: still no heartbeat or loader after expiry`,
				result.heartbeatConsoleMessages === 0 && result.exactLoaderRequests === 0,
			);
		} else {
			check(`${format}/embedded: exact original loader once`, result.exactLoaderRequests === 1);
			check(
				`${format}/embedded: hashed bootstrap executes inert fixture`,
				result.initial.fixtureRealmPresent && result.initial.bannerConfigExact,
			);
			await page.clock.runFor(500);
			result.beforeExpiry = await frame.evaluate(() => ({
				now: Date.now(),
				heartbeats: globalThis.__blogAdInertFixture?.heartbeats ?? 0,
			}));
			check(
				`${format}/embedded: inert heartbeat runs before expiry`,
				result.beforeExpiry.heartbeats >= 4,
			);
			await page.screenshot({
				path: path.join(outputDir, `${format}-embedded-before-expiry.png`),
				timeout: 5000,
			});
			await page.clock.runFor(1600);
			await frame.waitForURL("about:blank", { waitUntil: "load", timeout: 5000 });
			result.afterExpiry = await frame.evaluate(() => ({
				url: document.URL,
				fixtureRealmPresent: typeof globalThis.__blogAdInertFixture !== "undefined",
				configPresent: typeof globalThis.atOptions !== "undefined",
				childElements: document.body?.childElementCount ?? 0,
			}));
			check(
				`${format}/embedded: child navigates to about:blank`,
				result.afterExpiry.url === "about:blank",
			);
			check(
				`${format}/embedded: old realm/config/DOM destroyed`,
				!result.afterExpiry.fixtureRealmPresent &&
					!result.afterExpiry.configPresent &&
					result.afterExpiry.childElements === 0,
			);
			const heartbeatCount = result.heartbeatConsoleMessages;
			await page.clock.runFor(2000);
			result.heartbeatMessagesAtBlank = heartbeatCount;
			result.heartbeatMessagesAfterAdditional2s = result.heartbeatConsoleMessages;
			check(
				`${format}/embedded: old heartbeat stops after navigation`,
				result.heartbeatConsoleMessages === heartbeatCount,
			);
			check(`${format}/embedded: parent URL unchanged`, page.url() === mainUrl);
			check(
				`${format}/embedded: no supplier reload after expiry`,
				result.exactLoaderRequests === 1,
			);
		}
		check(`${format}/${result.mode}: no CSP violations`, result.cspViolations.length === 0);
		check(
			`${format}/${result.mode}: no document errors or popup (exact harness error retained)`,
			result.pageErrors.length === 0 && context.pages().length === 1,
		);
		check(
			`${format}/${result.mode}: only approved local fixture requests`,
			result.blockedRequests.length === 0,
		);
		result.passed = true;
	} finally {
		await context.close();
		activeContext = undefined;
	}
}

try {
	browser = await chromium.launch({
		headless: true,
		args: ["--disable-background-networking", "--disable-component-update"],
	});
	evidence.browserVersion = browser.version();
	for (const format of ["banner", "native"]) {
		await scenario(format, false);
		await scenario(format, true);
	}
	evidence.passed = !timedOut && evidence.scenarios.every((result) => result.passed);
} catch (error) {
	evidence.passed = false;
	evidence.error = error instanceof Error ? error.message : "Lifecycle fixture failed.";
	process.exitCode = 1;
} finally {
	await activeContext?.close().catch(() => {});
	await browser?.close().catch(() => {});
	clearTimeout(watchdog);
	evidence.completedAt = new Date().toISOString();
	evidence.timedOut = timedOut;
	await writeFile(
		path.join(outputDir, "lifecycle-evidence.json"),
		`${JSON.stringify(evidence, null, 2)}\n`,
	);
	const passed = evidence.checks.filter((entry) => entry.passed).length;
	const harnessErrors = evidence.scenarios.reduce(
		(count, result) => count + result.harnessPageErrors.length,
		0,
	);
	const report = `# Generated document lifecycle fixture\n\nResult: ${evidence.passed ? "PASS" : "FAIL"} (${passed}/${evidence.checks.length} browser assertions).\n\nAll HTTPS documents and original supplier URLs were fulfilled locally in fresh offline Chromium contexts. Supplier URLs returned an inert heartbeat fixture only. No actual supplier or production request, advertisement click, user Chrome, deployment or Next build occurred.\n\nThe checks cover exact hashed inline execution and stylesheet application, opaque sandbox/cookie/storage/service-worker boundaries, top-level zero startup, embedded pre-expiry fixture startup, self-navigation to about:blank, old realm destruction and stopped heartbeat. Parent CSP permits only Cloudflare challenges and the exact static ad origin for frames. Child response CSP is copied unchanged from the final generator.\n\nRecorded ${harnessErrors} exact harness SecurityErrors: Playwright 1.62.1 serviceWorkers:block injects an unguarded navigator.serviceWorker read that the opaque sandbox forbids (local lib/coreBundle.js lines 51294-51296). These messages remain in harnessPageErrors; all other page errors still fail. The initial failed evidence is preserved separately. No security policy or iframe capability was changed to avoid the warning.\n\nThis result does not establish actual advertising compatibility, native adaptation, fill or revenue.\n\n${evidence.error ? `Failure: ${evidence.error}\n` : ""}`;
	await writeFile(path.join(outputDir, "REPORT.md"), report);
	console.log(
		JSON.stringify({
			passed: evidence.passed,
			assertionsPassed: passed,
			assertionsTotal: evidence.checks.length,
			evidence: path.relative(process.cwd(), outputDir),
			error: evidence.error ?? null,
		}),
	);
}
