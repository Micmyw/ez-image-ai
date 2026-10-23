/**
 * Browser/component-boundary benchmark. This does not start Next, read .env,
 * connect to PostgreSQL/R2 or call a provider. It bundles the actual result panel,
 * useJob and TanStack Query against fixed-delay loopback HTTP boundaries.
 *
 * node tooling/e2e/src/generation-preview-benchmark.mjs --mode before
 * node tooling/e2e/src/generation-preview-benchmark.mjs --mode after
 * Add --downstream for the separate mock Kie-complete -> mock SeeAPI ->
 * actual useJob polling -> visible measurements; this preserves before.json.
 * Add --slow-first-image-only for a 3.3-second image transfer across real polling,
 * or --persistent-only for repeated storage failure. Both use dedicated reports.
 * --timing-only-check verifies newly added Resource Timing fields in one sample.
 * --comparison-stability-only exercises delayed/failed original lookup and
 * image identity with the current production components. Optional
 * GENERATION_PREVIEW_SOURCE_ROOT substitutes only the two preview components
 * from a saved exact baseline; it does not rewind the checkout.
 *
 * "before" replaces module sources with the saved timing-only snapshot;
 * it never rewinds or writes the checkout. All timings are actual wall-clock
 * browser timings, not virtual timers or predictions of production latency.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const mode = process.argv.includes("after") ? "after" : "before";
const downstreamMode = process.argv.includes("--downstream");
const persistentOnly = process.argv.includes("--persistent-only");
const slowFirstImageOnly = process.argv.includes("--slow-first-image-only");
const timingOnlyCheck = process.argv.includes("--timing-only-check");
const comparisonStabilityOnly = process.argv.includes("--comparison-stability-only");
const previewSourceRoot = process.env.GENERATION_PREVIEW_SOURCE_ROOT;
if (comparisonStabilityOnly || previewSourceRoot) assert.equal(mode, "after");
const reportPrefix = `${mode}${comparisonStabilityOnly ? "-comparison-stability" : downstreamMode ? "-downstream" : persistentOnly ? "-persistent" : slowFirstImageOnly ? "-slow-first-image" : timingOnlyCheck ? "-timing-check" : ""}`;
const outputDirectory = path.resolve(
	repo,
	process.env.GENERATION_PREVIEW_OUTPUT_DIR ?? ".cache/generation-batch1/browser",
);
if (mode === "before" && existsSync(path.join(outputDirectory, `${reportPrefix}.json`)))
	throw new Error("Baseline evidence already exists; use a fresh GENERATION_PREVIEW_OUTPUT_DIR");
const appRequire = createRequire(path.join(repo, "apps/saas/package.json"));
const vitestRequire = createRequire(appRequire.resolve("vitest/package.json"));
const viteRequire = createRequire(vitestRequire.resolve("vite/package.json"));
const { build, stop } = viteRequire("esbuild");
const { chromium } = appRequire("@playwright/test");
const delays = Object.freeze({ status: 160, accessOutput: 180, accessInput: 1400, image: 120 });
const downstreamDelays = Object.freeze({
	kieCompletion: 80,
	privateWrite: 150,
	seeapiSubmit: 80,
	seeapiQuery: 65,
	pendingPoll: 2200,
});
const snapshotModules = [
	"apps/saas/modules/media/hooks/use-job.ts",
	"apps/saas/modules/media/components/editor/EditorResultPanel.tsx",
	"apps/saas/modules/media/components/editor/BeforeAfterSlider.tsx",
	"apps/saas/modules/media/lib/preview-timing.ts",
	...(mode === "after"
		? ["apps/saas/modules/media/components/editor/use-private-asset-preview.ts"]
		: []),
];
const previewModules = [
	"apps/saas/modules/media/components/editor/InlineOutputPreview.tsx",
	"apps/saas/modules/media/components/editor/BeforeAfterSlider.tsx",
];
const sourceHashes = {};
const mocks = {
	"@auth/hooks/use-session": `
    import { useSyncExternalStore } from "react";
    const subscribe = (listener) => { window.addEventListener("preview-owner-changed", listener); return () => window.removeEventListener("preview-owner-changed", listener); };
    export const useSession = () => {
      const owner = useSyncExternalStore(subscribe, () => window.__previewOwner ?? null, () => null);
      return { user: owner ? { id: owner, isAnonymous: true } : null, session: null, loaded: true };
    };`,
	"@shared/lib/orpc-client": `
    async function request(path, options) {
      const response = await fetch(path, { signal: options?.signal, cache: "no-store" });
      if (!response.ok) { const error = new Error("Local benchmark access denied"); error.status = response.status; error.code = response.status === 403 ? "FORBIDDEN" : "NOT_FOUND"; throw error; }
      return response.json();
    }
    export const orpcClient = { media: {
      getJob: (input, options) => request("/api/job", options),
      getAssetAccessUrl: (input, options) => request("/api/access?asset=" + encodeURIComponent(input.assetId), options),
      cancelGeneration: () => Promise.resolve({}),
    }};`,
	"@shared/lib/growth-analytics": `export const saasGrowthFunnel = new Proxy({}, { get: () => () => Promise.resolve() });`,
	"next-intl": `export const useTranslations = () => (key) => key; export const useLocale = () => "en";`,
	"next/link": `import React from "react"; export default function Link(props) { return <a {...props} />; }`,
	"@repo/ui/components/alert": `export const Alert = ({children}) => <div role="alert">{children}</div>; export const AlertDescription = ({children}) => <p>{children}</p>;`,
	"@repo/ui/components/badge": `export const Badge = ({children}) => <span>{children}</span>;`,
	"@repo/ui/components/button": `export const Button = ({children,render,loading,variant,...rest}) => render ? render({children,...rest}) : <button {...rest}>{children}</button>;`,
	"@repo/ui/components/progress": `export const Progress = () => <progress />;`,
	GenerationFailureNotice: `export const GenerationFailureNotice = () => null;`,
	ModerationNotice: `export const ModerationNotice = () => null;`,
	RetryGenerationButton: `export const RetryGenerationButton = () => null;`,
};

async function bundle() {
	const substitutions = new Map();
	for (const relative of snapshotModules) {
		const selected = path.join(
			repo,
			mode === "before" ? "tooling/e2e/fixtures/generation-batch1/timing-only" : "",
			mode === "before" ? `${relative}.txt` : relative,
		);
		assert.ok(existsSync(selected), `Missing ${mode} source: ${relative}`);
		const source = await readFile(selected, "utf8");
		sourceHashes[relative] = createHash("sha256").update(source).digest("hex");
		substitutions.set(path.normalize(path.join(repo, relative)), source);
	}
	if (mode === "after") {
		for (const relative of previewModules) {
			const source = await readFile(path.resolve(repo, previewSourceRoot ?? "", relative), "utf8");
			sourceHashes[relative] = createHash("sha256").update(source).digest("hex");
			substitutions.set(path.normalize(path.join(repo, relative)), source);
		}
	}
	const result = await build({
		stdin: {
			contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
        import { EditorResultPanel } from "./modules/media/components/editor/EditorResultPanel";
        import { recordOutputReceived, recordOutputLoaded } from "./modules/media/lib/preview-timing";
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const queryKey = () => ${mode === "after" ? '["media-job", "benchmark-job", window.__previewOwner ?? null]' : '["media-job", "benchmark-job"]'};
        window.__benchmark = {
          refresh: () => client.refetchQueries({ queryKey: queryKey(), exact: true }),
          invalidate: () => client.invalidateQueries({ queryKey: queryKey(), exact: true }),
          read: () => client.getQueryData(queryKey()),
          refreshOriginal: () => client.refetchQueries({ queryKey: ["media-asset-preview", "asset-input"], type: "active" }),
          refreshOutput: () => client.refetchQueries({ queryKey: ["media-asset-preview", "asset-output"], type: "active" }),
          readOriginalStatus: () => client.getQueryCache().findAll({ queryKey: ["media-asset-preview", "asset-input"] }).find((query) => query.getObserversCount() > 0)?.state.status,
          setOwner: (owner) => { window.__previewOwner = owner; window.dispatchEvent(new Event("preview-owner-changed")); },
          probeTimingVisibility: (kind) => new Promise((resolve) => {
            const img = document.createElement("img");
            img.style.cssText = "position:fixed;left:10px;top:10px;width:40px;height:40px";
            const jobId = "timing-probe-" + kind;
            img.onload = () => {
              recordOutputReceived(jobId, "probe-asset");
              recordOutputLoaded(jobId, "probe-asset", img);
              if (kind === "hidden") img.style.display = "none";
              if (kind === "detached") img.remove();
              if (kind === "offscreen") img.style.top = "2000px";
              requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
                const events = window.__timings.filter((event) => event.jobId === jobId).map((event) => event.stage);
                img.remove();
                resolve(events);
              })));
            };
            document.body.appendChild(img);
            img.src = "/image/asset-output?probe=" + kind;
          }),
        };
        createRoot(document.getElementById("root")).render(
          <QueryClientProvider client={client}><EditorResultPanel jobId="benchmark-job" onNew={() => {}} /></QueryClientProvider>
        );`,
			loader: "tsx",
			resolveDir: path.join(repo, "apps/saas"),
			sourcefile: "generation-preview-benchmark-entry.tsx",
		},
		bundle: true,
		write: false,
		format: "esm",
		platform: "browser",
		jsx: "automatic",
		define: { "process.env.NODE_ENV": '"production"' },
		nodePaths: [path.join(repo, "apps/saas/node_modules"), path.join(repo, "node_modules")],
		plugins: [
			{
				name: "isolated-preview-boundaries",
				setup(plugin) {
					plugin.onResolve({ filter: /.*/ }, (args) => {
						const component = args.path.split("/").at(-1);
						const key = Object.hasOwn(mocks, args.path)
							? args.path
							: Object.hasOwn(mocks, component)
								? component
								: null;
						return key ? { path: key, namespace: "preview-mock" } : undefined;
					});
					plugin.onLoad({ filter: /.*/, namespace: "preview-mock" }, (args) => ({
						contents: mocks[args.path],
						loader: "tsx",
						resolveDir: path.join(repo, "apps/saas"),
					}));
					plugin.onLoad({ filter: /\.[tj]sx?$/ }, async (args) => {
						const source = substitutions.get(path.normalize(args.path));
						return source === undefined
							? undefined
							: {
									contents: source,
									loader: args.path.endsWith("tsx") ? "tsx" : "ts",
									resolveDir: path.dirname(args.path),
								};
					});
				},
			},
		],
	});
	return result.outputFiles[0].text;
}

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local preview boundary benchmark</title>
<style>body{font:16px system-ui;background:#f4f5fa;color:#1f2233;padding:24px}main{max-width:780px;margin:auto;background:white;padding:24px;border-radius:16px}img{display:block;width:640px;max-width:100%;height:400px;object-fit:contain}button,a{margin-right:12px}button{padding:8px}section>div{margin-top:10px}.relative{position:relative}.absolute{position:absolute}.inset-0{inset:0}.aspect-square{height:420px}.overflow-hidden{overflow:hidden}.size-full{height:100%;width:100%}.opacity-0{opacity:0}</style></head><body>
<main><h1>Fixed-delay local preview benchmark</h1><p>Actual React panel + useJob; mocked API/storage boundaries. No production requests.</p><div id="root"></div></main>
<script>window.__timings=[];window.__imageEvents=[];const original=console.info;console.info=(...args)=>{if(args[0]==="media.preview.timing")window.__timings.push({...args[1],browserAt:performance.now()});original.apply(console,args)};document.addEventListener("load",event=>{if(event.target instanceof HTMLImageElement)window.__imageEvents.push({type:"load",asset:event.target.currentSrc.includes("asset-output")?"asset-output":"asset-input",at:performance.now()})},true);</script>
<script type="module" src="/app.js"></script></body></html>`;
const imageBytes = Buffer.from(
	`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#d8e1ff"/><circle cx="320" cy="180" r="95" fill="#8e9fff"/><text x="320" y="330" font-family="sans-serif" font-size="22" text-anchor="middle" fill="#182653">Fixed-delay local output</text></svg>`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let scenario;
let origin;
let appBundle;
let browserServer;
let browser;
let server;
const report = {
	mode,
	createdAt: new Date().toISOString(),
	scope:
		"real Chromium and actual React result panel/useJob; fixed-delay mocked HTTP API/storage; no Next, database or providers",
	delaysMs: delays,
	...(downstreamMode
		? {
				downstreamDelaysMs: downstreamDelays,
				downstreamScope:
					"fixed-delay loopback Kie completion, private-write and SeeAPI HTTP fixtures; actual hook polling; status endpoint is a mock, not real API/DB",
			}
		: {}),
	sourceHashes,
	samples: [],
	regressions: [],
	unmeasured: [
		"SQL server execution",
		"database connection wait",
		"real provider completion",
		"CDN/R2 latency",
		"compositor paint; visibility uses two animation frames after load",
	],
};

function freshScenario(name, overrides = {}) {
	return {
		name,
		startedAt: performance.now(),
		operations: [],
		status: "FINALIZING",
		revision: 1,
		epoch: Date.now(),
		generation: 1,
		revoked: false,
		staleResponse: false,
		expiredTokenOnce: false,
		accessDenied: false,
		visibleForMs: 86_400_000,
		contentVersion: "immutable-output-1",
		...overrides,
	};
}

function jobResponse(state) {
	const observedAt = state.epoch + (state.staleResponse ? 0 : state.revision * 100);
	const outputAssetId = state.outputAssetId ?? "asset-output";
	const visible =
		(state.staleResponse || !state.revoked) && (!state.downstream || state.outputReady);
	return {
		id: "benchmark-job",
		version: 5,
		requestId: `request-${state.revision}`,
		observedAt,
		displayVersion: visible ? "display-visible" : "display-revoked",
		productKey: "image-gpt-image-2",
		skuKey: "gpt-image-2-4k",
		aspectRatio: "16:9",
		status: state.status,
		progress: null,
		createdAt: new Date(state.epoch - 1000).toISOString(),
		updatedAt: new Date(state.epoch).toISOString(),
		creditsReserved: "4",
		creditsCharged: state.status === "SUCCEEDED" ? "4" : "0",
		creditsReleased: "0",
		failureReason: null,
		canCancel: false,
		canRetry: false,
		input: { kind: state.textOnly ? "text-to-image" : "image-to-image" },
		inputReferenceState: "READY",
		inputAssets: state.textOnly ? [] : [{ id: "asset-input", mimeType: "image/png" }],
		assets: visible
			? [
					{
						id: outputAssetId,
						mimeType: "image/png",
						contentVersion: state.contentVersion,
						visibleUntil: new Date(state.epoch + state.visibleForMs).toISOString(),
						...(mode === "after" && !state.legacyResponse
							? {
									preview: {
										url: `${origin}/image/${outputAssetId}?credential=${state.generation}`,
										expiresAt: new Date(state.epoch + 300_000).toISOString(),
									},
								}
							: {}),
					},
				]
			: [],
	};
}

async function serve(request, response) {
	const url = new URL(request.url, origin);
	if (url.pathname === "/") {
		response.setHeader("content-type", "text/html");
		response.end(html);
		return;
	}
	if (url.pathname === "/app.js") {
		response.setHeader("content-type", "text/javascript");
		response.end(appBundle);
		return;
	}
	if (url.pathname === "/favicon.ico") {
		response.writeHead(204).end();
		return;
	}
	const state = scenario;
	if (url.pathname.startsWith("/fixture/")) {
		await serveDownstreamFixture(url, state, response);
		return;
	}
	const event = {
		operation:
			url.pathname === "/api/job" ? "status" : url.pathname === "/api/access" ? "access" : "image",
		assetId:
			url.searchParams.get("asset") ||
			(url.pathname.startsWith("/image/") ? url.pathname.slice("/image/".length) : undefined),
		startedMs: performance.now() - state.startedAt,
	};
	state.operations.push(event);
	response.setHeader("cache-control", "no-store");
	if (url.pathname === "/api/job") {
		if (state.rotateCredentialEachStatus) {
			state.generation++;
			state.revision++;
		}
		if (state.downstream && !state.downstreamStarted) {
			state.downstreamStarted = true;
			state.downstreamRun = progressDownstream(state);
		}
		const payload = jobResponse(state);
		event.outputReady = payload.assets.length > 0;
		const delay = state.delayedNextStatus ?? delays.status;
		state.delayedNextStatus = undefined;
		await sleep(delay);
		if (state.accessDenied) response.writeHead(403).end("Denied");
		else {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify(payload));
		}
	} else if (url.pathname === "/api/access") {
		await sleep(event.assetId === "asset-input" ? delays.accessInput : delays.accessOutput);
		if (
			(state.originalAccessDenied && event.assetId === "asset-input") ||
			(state.outputAccessDenied && event.assetId === "asset-output")
		) {
			response.writeHead(403).end("Denied fixture asset");
		} else {
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({
					url: `${origin}/image/${event.assetId}?credential=${state.generation}`,
					expiresAt: new Date(state.epoch + 300_000).toISOString(),
				}),
			);
		}
	} else if (url.pathname.startsWith("/image/")) {
		await sleep(state.imageDelayMs ?? delays.image);
		if (state.originalImageDenied && event.assetId === "asset-input") {
			response.writeHead(403).end("Denied fixture original image");
		} else if (
			(state.expiredTokenOnce || state.persistentOutputError) &&
			event.assetId === "asset-output"
		) {
			state.expiredTokenOnce = false;
			state.generation++;
			state.revision++;
			event.failedCredential = true;
			response.writeHead(403).end("Expired fixture credential");
		} else {
			response.setHeader("content-type", "image/svg+xml");
			response.end(imageBytes);
		}
	} else response.writeHead(404).end();
	event.finishedMs = performance.now() - state.startedAt;
}

async function serveDownstreamFixture(url, state, response) {
	const fixture = url.pathname.split("/").at(-1);
	const delay = {
		"kie-complete": downstreamDelays.kieCompletion,
		"private-write": downstreamDelays.privateWrite,
		"seeapi-submit": downstreamDelays.seeapiSubmit,
		"seeapi-query": downstreamDelays.seeapiQuery,
	}[fixture];
	assert.notEqual(delay, undefined);
	const event = {
		operation: fixture,
		assetId: "asset-output",
		startedMs: performance.now() - state.startedAt,
	};
	state.operations.push(event);
	await sleep(delay);
	let result = {};
	if (fixture === "kie-complete") {
		state.kieCompletedAtEpochMs = Date.now();
		result = { taskId: "fixed-kie-1", status: "SUCCESS" };
	} else if (fixture === "private-write") {
		state.privateWrites = (state.privateWrites ?? 0) + 1;
		result = { assetId: "asset-output", contentVersion: "immutable-output-1" };
	} else if (fixture === "seeapi-submit") {
		result = { taskId: "fixed-audit-1" };
	} else {
		state.auditQueries = (state.auditQueries ?? 0) + 1;
		result = {
			taskId: "fixed-audit-1",
			status: state.auditSequence[Math.min(state.auditQueries - 1, state.auditSequence.length - 1)],
		};
		event.status = result.status;
	}
	event.finishedMs = performance.now() - state.startedAt;
	response.setHeader("content-type", "application/json");
	response.end(JSON.stringify(result));
}

async function progressDownstream(state) {
	const request = async (fixture) => {
		const response = await fetch(`${origin}/fixture/${fixture}`, { method: "POST" });
		assert.ok(response.ok);
		return response.json();
	};
	try {
		await request("kie-complete");
		state.status = "FINALIZING";
		state.revision++;
		await request("private-write");
		const submission = await request("seeapi-submit");
		for (;;) {
			const audit = await request("seeapi-query");
			assert.equal(
				audit.taskId,
				submission.taskId,
				"PENDING must query the original audit rather than submit again",
			);
			if (audit.status === "ALLOW") break;
			assert.equal(
				audit.status,
				"REVIEW",
				"Only the configured pending outcome enters normal polling",
			);
			await sleep(downstreamDelays.pendingPoll);
		}
		state.outputReady = true;
		state.outputReadyAtEpochMs = Date.now();
		state.revision++;
	} catch (error) {
		state.downstreamFailure = error.message;
	}
}

async function newPage() {
	const context = await browser.newContext({ viewport: { width: 1050, height: 900 } });
	await context.route("**/*", (route) =>
		new URL(route.request().url()).origin === origin
			? route.continue()
			: route.abort("blockedbyclient"),
	);
	const page = await context.newPage();
	page.setDefaultTimeout(8000);
	page.on("pageerror", (error) => {
		scenario.pageErrors ??= [];
		scenario.pageErrors.push(error.message);
	});
	await page.goto(origin, { waitUntil: "domcontentloaded" });
	return { page, context };
}

function outputImage(page) {
	return page.getByRole("img", { name: /^(generatedAlt|compare.afterAlt)$/ });
}

async function visibleOutput(page) {
	await page.waitForFunction(
		() => window.__timings.some((event) => event.stage === "visible"),
		undefined,
		{ timeout: 8000 },
	);
	const output = outputImage(page);
	await output.waitFor({ state: "visible" });
	assert.equal(await output.evaluate((img) => img.complete && img.naturalWidth > 0), true);
	assert.equal(
		(await page.evaluate(() => window.__benchmark.read())).status,
		"FINALIZING",
		"READY output must render before job settlement",
	);
}

async function measure(name, overrides = {}) {
	scenario = freshScenario(name, overrides);
	const { page, context } = await newPage();
	try {
		await visibleOutput(page);
		const metrics = await page.evaluate(() => ({
			browserTimeOrigin: performance.timeOrigin,
			timings: window.__timings,
			imageEvents: window.__imageEvents,
			resources: performance
				.getEntriesByType("resource")
				.filter((item) => item.name.includes("/image/asset-output"))
				.map((item) => ({ requestStartMs: item.startTime, responseEndMs: item.responseEnd })),
		}));
		const outputReceived = metrics.timings.find((event) => event.stage === "received");
		const outputLoaded = metrics.timings.find((event) => event.stage === "loaded");
		const outputVisible = metrics.timings.find((event) => event.stage === "visible");
		assert.ok(
			outputReceived && outputLoaded && outputVisible,
			"Actual application timing events must all be emitted",
		);
		if (timingOnlyCheck) {
			assert.equal(outputLoaded.requestStartSource, "resource-timing");
			assert.equal(typeof outputLoaded.requestStartMs, "number");
			assert.ok(
				Math.abs(
					outputLoaded.requestStartMs -
						(metrics.resources[0].requestStartMs - outputReceived.browserAt),
				) < 5,
				"Application request offset must agree with Chromium Resource Timing",
			);
			assert.equal(
				JSON.stringify(metrics.timings).includes(origin),
				false,
				"Timing logs must not contain signed or unsigned resource URLs",
			);
		}
		const outputRequests = scenario.operations.filter(
			(event) => event.operation === "access" && event.assetId === "asset-output",
		).length;
		assert.equal(
			outputRequests,
			mode === "before" ? 1 : 0,
			"Inline previews must remove the serial output access request",
		);
		assert.equal(
			scenario.operations.filter(
				(event) =>
					event.operation === "access" && event.assetId === "asset-input" && event.finishedMs,
			).length,
			0,
			"Slow original access must not block output",
		);
		await page.screenshot({
			path: path.join(outputDirectory, `${reportPrefix}-${name}.png`),
			fullPage: true,
		});
		const result = {
			name,
			outputReceivedToImageStartMs: metrics.resources[0].requestStartMs - outputReceived.browserAt,
			outputReceivedToLoadMs: outputLoaded.elapsedMs,
			outputReceivedToVisibleMs: outputVisible.elapsedMs,
			navigationToVisibleMs: outputVisible.browserAt,
			requestCounts: {
				status: scenario.operations.filter((event) => event.operation === "status").length,
				outputAccess: outputRequests,
				inputAccess: scenario.operations.filter(
					(event) => event.operation === "access" && event.assetId === "asset-input",
				).length,
				outputImage: metrics.resources.length,
			},
			metrics,
			operations: scenario.operations.slice(),
			pageErrors: scenario.pageErrors ?? [],
		};
		assert.deepEqual(result.pageErrors, []);
		if (scenario.downstream) {
			await scenario.downstreamRun;
			assert.equal(scenario.downstreamFailure, undefined);
			assert.equal(scenario.privateWrites, 1);
			assert.equal(
				scenario.operations.filter((event) => event.operation === "seeapi-submit").length,
				1,
			);
			assert.equal(scenario.auditQueries, scenario.auditSequence.length);
			assert.equal(
				result.requestCounts.status,
				scenario.auditSequence.length + 1,
				"Use the actual two-second hook interval; no accelerated polling",
			);
			Object.assign(result, {
				auditSequence: scenario.auditSequence,
				kieCompleteToVisibleMs:
					metrics.browserTimeOrigin + outputVisible.browserAt - scenario.kieCompletedAtEpochMs,
				kieCompleteToOutputReadyMs: scenario.outputReadyAtEpochMs - scenario.kieCompletedAtEpochMs,
				outputReadyToReceivedMs:
					metrics.browserTimeOrigin + outputReceived.browserAt - scenario.outputReadyAtEpochMs,
				privateWrites: scenario.privateWrites,
				moderationSubmissions: 1,
				moderationQueries: scenario.auditQueries,
				clock:
					"Node completion Date.now and browser performance.timeOrigin + event time on the same host; wall-clock, no virtual timers",
			});
			console.log(
				`${mode} ${name}: Kie-complete→visible ${result.kieCompleteToVisibleMs.toFixed(1)} ms; status requests ${result.requestCounts.status}`,
			);
		}
		report.samples.push(result);
		console.log(
			`${mode} ${name}: received→visible ${result.outputReceivedToVisibleMs.toFixed(1)} ms; output-access requests ${outputRequests}`,
		);
	} finally {
		await context.close();
	}
}

async function comparisonStability() {
	await originalAuthorizationRegressions();
	for (const { name, overrides } of [
		{ name: "original-image-load-denied", overrides: { originalImageDenied: true } },
		{ name: "original-arrives-after-output", overrides: {} },
		{ name: "original-arrives-during-download", overrides: { imageDelayMs: 2300 } },
		{ name: "original-added-after-output", overrides: { textOnly: true } },
		{ name: "original-access-denied", overrides: { originalAccessDenied: true } },
	]) {
		scenario = freshScenario(name, overrides);
		const { page, context } = await newPage();
		let observation;
		try {
			await outputImage(page).waitFor({ state: "attached" });
			const firstOutput = await outputImage(page).elementHandle();
			const firstSrc = await firstOutput.getAttribute("src");
			const inputResponse = page.waitForResponse((response) => {
				const url = new URL(response.url());
				return url.pathname === "/api/access" && url.searchParams.get("asset") === "asset-input";
			});
			const originalImageResponse = overrides.originalImageDenied
				? page.waitForResponse(
						(response) => new URL(response.url()).pathname === "/image/asset-input",
					)
				: null;
			if (!overrides.imageDelayMs) {
				await visibleOutput(page);
				assert.equal(await page.getByRole("slider").count(), 0);
				assert.equal(
					scenario.operations.some(
						(event) =>
							event.operation === "access" && event.assetId === "asset-input" && event.finishedMs,
					),
					false,
					"Output must be visible before original access completes",
				);
			}
			if (overrides.textOnly) {
				assert.equal(
					scenario.operations.some((event) => event.operation === "access"),
					false,
				);
				scenario.textOnly = false;
				scenario.revision++;
				await page.evaluate(() => window.__benchmark.refresh());
			}
			const response = await inputResponse;
			if (originalImageResponse) {
				assert.equal((await originalImageResponse).status(), 403);
				await page.getByRole("slider").waitFor({ state: "detached" });
				assert.equal(await page.getByAltText("compare.beforeAlt").count(), 0);
			} else if (overrides.originalAccessDenied) {
				assert.equal(response.status(), 403);
				await page.waitForFunction(() => window.__benchmark.readOriginalStatus() === "error");
				assert.equal(await page.getByRole("slider").count(), 0);
			} else {
				await page.getByRole("slider", { name: "compare.control" }).waitFor({ state: "visible" });
				await page.getByRole("button", { name: "compare.showOriginal", exact: true }).click();
				assert.equal(await page.getByRole("slider").inputValue(), "100");
				await page.getByRole("button", { name: "compare.showResult", exact: true }).click();
				assert.equal(await page.getByRole("slider").inputValue(), "0");
			}
			await visibleOutput(page);
			assert.equal(
				await page.getByRole("button", { name: "download", exact: true }).isEnabled(),
				true,
			);
			for (let index = 0; index < 2; index++) {
				scenario.generation++;
				scenario.revision++;
				await page.evaluate(() => window.__benchmark.refresh());
			}
			observation = {
				name,
				passed: false,
				sameOutputNode: await outputImage(page).evaluate(
					(current, first) => current === first,
					firstOutput,
				),
				firstNodeConnected: await firstOutput.evaluate((img) => img.isConnected),
				sameOutputSrc: (await outputImage(page).getAttribute("src")) === firstSrc,
				outputRequests: scenario.operations.filter(
					(event) => event.operation === "image" && event.assetId === "asset-output",
				).length,
				outputLoads: await page.evaluate(
					() => window.__imageEvents.filter((event) => event.asset === "asset-output").length,
				),
				timings: await page.evaluate(() => window.__timings),
				operations: scenario.operations,
			};
			report.regressions.push(observation);
			assert.equal(
				observation.sameOutputNode,
				true,
				"Original lookup must not replace the output DOM node",
			);
			assert.equal(observation.firstNodeConnected, true);
			assert.equal(observation.sameOutputSrc, true);
			assert.equal(
				observation.outputRequests,
				1,
				"Original lookup and re-signing must not restart the output transfer",
			);
			assert.equal(
				observation.outputLoads,
				1,
				"Comparison controls must not reload the output image",
			);
			assert.deepEqual(scenario.pageErrors ?? [], []);
			observation.passed = true;
			console.log(`${name}: stable output node, one output request and one load`);
			if (name === "original-arrives-after-output") {
				scenario.contentVersion = "immutable-output-2";
				scenario.generation++;
				scenario.revision++;
				await page.evaluate(() => window.__benchmark.refresh());
				await page.waitForFunction(() => {
					const img = document.querySelector('img[alt="compare.afterAlt"]');
					return img?.complete && img.naturalWidth > 0 && img.src.includes("credential=4");
				});
				assert.equal(await firstOutput.evaluate((img) => img.isConnected), false);
				assert.equal(
					scenario.operations.filter(
						(event) => event.operation === "image" && event.assetId === "asset-output",
					).length,
					2,
				);
				report.regressions.push({
					name: "changed contentVersion replaces the old image once",
					passed: true,
				});
				const previousOutput = await outputImage(page).elementHandle();
				scenario.outputAssetId = "asset-output-2";
				scenario.generation++;
				scenario.revision++;
				await page.evaluate(() => window.__benchmark.refresh());
				await page.waitForFunction(() => {
					const img = document.querySelector('img[alt="compare.afterAlt"]');
					return (
						img?.complete && img.naturalWidth > 0 && img.src.includes("/image/asset-output-2?")
					);
				});
				assert.equal(await previousOutput.evaluate((img) => img.isConnected), false);
				assert.equal(
					scenario.operations.filter(
						(event) => event.operation === "image" && event.assetId === "asset-output-2",
					).length,
					1,
				);
				report.regressions.push({
					name: "changed asset identity replaces the old image once despite unchanged contentVersion",
					passed: true,
				});
			}
		} finally {
			if (observation) {
				await page.screenshot({
					path: path.join(outputDirectory, `${reportPrefix}-${name}.png`),
					fullPage: true,
				});
			}
			await context.close();
		}
	}
}

async function originalAuthorizationRegressions() {
	for (const [legacyResponse, changeOwner] of [
		[false, false],
		[false, true],
		[true, false],
		[true, true],
	]) {
		scenario = freshScenario(
			`${legacyResponse ? "legacy-" : ""}${changeOwner ? "original-owner-switch" : "original-access-revoked"}`,
			{ legacyResponse },
		);
		const { page, context } = await newPage();
		try {
			await page.getByRole("slider", { name: "compare.control" }).waitFor({ state: "visible" });
			const firstOutput = await outputImage(page).elementHandle();
			const firstSrc = await firstOutput.getAttribute("src");
			scenario.originalAccessDenied = true;
			if (changeOwner) {
				await page.evaluate(() => window.__benchmark.setOwner("another-owner"));
				await outputImage(page).waitFor({ state: "visible" });
				assert.equal(
					await page.getByRole("slider").count(),
					0,
					"A new account must not consume the previous account's cached original URL",
				);
			} else {
				await page.evaluate(() => window.__benchmark.refreshOriginal());
			}
			await page.waitForFunction(() => window.__benchmark.readOriginalStatus() === "error");
			assert.equal(
				await page.getByRole("slider").count(),
				0,
				"An explicit original authorization error must remove cached comparison controls",
			);
			assert.equal(await page.getByAltText("compare.beforeAlt").count(), 0);
			assert.equal(await outputImage(page).getAttribute("src"), firstSrc);
			if (!changeOwner) {
				assert.equal(
					await outputImage(page).evaluate((current, first) => current === first, firstOutput),
					true,
				);
				assert.equal(
					scenario.operations.filter(
						(event) => event.operation === "image" && event.assetId === "asset-output",
					).length,
					1,
				);
			}
			report.regressions.push({
				name: scenario.name,
				passed: true,
				operations: scenario.operations,
			});
			console.log(`${scenario.name}: cached original removed; authorized output retained`);
		} finally {
			await context.close();
		}
	}
	for (const textOnly of [false, true]) {
		scenario = freshScenario(
			textOnly ? "legacy-output-only-revoked" : "legacy-comparison-output-revoked",
			{
				legacyResponse: true,
				textOnly,
			},
		);
		const { page, context } = await newPage();
		try {
			await visibleOutput(page);
			if (!textOnly) {
				await page.getByRole("slider", { name: "compare.control" }).waitFor({ state: "visible" });
			}
			scenario.outputAccessDenied = true;
			await page.evaluate(() => window.__benchmark.refreshOutput());
			await outputImage(page).waitFor({ state: "detached" });
			assert.equal(await page.getByAltText("compare.beforeAlt").count(), 0);
			await page.getByText("comparisonUnavailable").waitFor({ state: "visible" });
			report.regressions.push({
				name: scenario.name,
				passed: true,
				operations: scenario.operations,
			});
			console.log(`${scenario.name}: revoked cached output removed`);
		} finally {
			await context.close();
		}
	}
}

async function regressions() {
	scenario = freshScenario("resign-revoke-stale");
	const { page, context } = await newPage();
	try {
		await visibleOutput(page);
		const countOutput = () =>
			scenario.operations.filter(
				(event) => event.operation === "image" && event.assetId === "asset-output",
			).length;
		const initialCount = countOutput();
		for (let index = 0; index < 3; index++) {
			scenario.generation++;
			scenario.revision++;
			await page.evaluate(() => window.__benchmark.refresh());
		}
		assert.equal(
			countOutput(),
			initialCount,
			"Re-signing the same immutable visible image must not download it repeatedly",
		);
		report.regressions.push({
			name: "re-sign without repeat image download",
			passed: true,
			statusRequests: scenario.operations.filter((event) => event.operation === "status").length,
			outputImageRequests: countOutput(),
		});
		scenario.revoked = true;
		scenario.revision++;
		await page.evaluate(() => window.__benchmark.refresh());
		await outputImage(page).waitFor({ state: "detached" });
		assert.equal((await page.evaluate(() => window.__benchmark.read())).assets.length, 0);
		report.regressions.push({
			name: "true revocation removes already visible image despite unchanged job.version",
			passed: true,
		});
		scenario.staleResponse = true;
		await page.evaluate(() => window.__benchmark.refresh());
		assert.equal(
			await outputImage(page).count(),
			0,
			"An older visible response must not restore a revoked output",
		);
		assert.equal((await page.evaluate(() => window.__benchmark.read())).assets.length, 0);
		report.regressions.push({ name: "older response cannot restore revoked output", passed: true });
	} finally {
		await context.close();
	}

	scenario = freshScenario("credential-refresh", { expiredTokenOnce: true });
	const refreshPage = await newPage();
	try {
		await visibleOutput(refreshPage.page);
		assert.equal(scenario.operations.filter((event) => event.operation === "status").length, 2);
		assert.equal(
			scenario.operations.filter(
				(event) => event.operation === "access" && event.assetId === "asset-output",
			).length,
			0,
		);
		assert.equal(
			scenario.operations.filter(
				(event) => event.operation === "image" && event.assetId === "asset-output",
			).length,
			2,
		);
		report.regressions.push({
			name: "expired image credential revalidates authorized job response and displays replacement",
			passed: true,
			operations: scenario.operations,
		});
	} finally {
		await refreshPage.context.close();
	}

	scenario = freshScenario("authorization-revocation");
	const deniedPage = await newPage();
	try {
		await visibleOutput(deniedPage.page);
		scenario.accessDenied = true;
		await deniedPage.page.evaluate(() => window.__benchmark.refresh());
		await outputImage(deniedPage.page).waitFor({ state: "detached" });
		await deniedPage.page.getByText("unavailableTitle").waitFor({ state: "visible" });
		report.regressions.push({
			name: "authorization error removes cached visible output",
			passed: true,
		});
	} finally {
		await deniedPage.context.close();
	}

	scenario = freshScenario("visibility-expiry", { visibleForMs: 1200 });
	const expiryPage = await newPage();
	try {
		await visibleOutput(expiryPage.page);
		await outputImage(expiryPage.page).waitFor({ state: "detached" });
		await expiryPage.page.getByText("comparisonUnavailable").waitFor({ state: "visible" });
		report.regressions.push({
			name: "asset visibility deadline removes output without waiting for the next poll",
			passed: true,
		});
	} finally {
		await expiryPage.context.close();
	}

	scenario = freshScenario("cancel-stale-inflight");
	const racePage = await newPage();
	try {
		await visibleOutput(racePage.page);
		scenario.delayedNextStatus = 700;
		scenario.revision++;
		const firstRequestPromise = racePage.page.waitForRequest(
			(request) => new URL(request.url()).pathname === "/api/job",
		);
		await racePage.page.evaluate(() => {
			void window.__benchmark.refresh();
		});
		const firstRequest = await firstRequestPromise;
		const failedRequestPromise = racePage.page.waitForEvent(
			"requestfailed",
			(request) => request === firstRequest,
		);
		scenario.revoked = true;
		scenario.revision++;
		await racePage.page.evaluate(() => window.__benchmark.refresh());
		await failedRequestPromise;
		await outputImage(racePage.page).waitFor({ state: "detached" });
		assert.equal((await racePage.page.evaluate(() => window.__benchmark.read())).assets.length, 0);
		report.regressions.push({
			name: "new refetch aborts older in-flight status response using the actual hook signal",
			passed: true,
			oldRequestFailure: firstRequest.failure()?.errorText,
		});
	} finally {
		await racePage.context.close();
	}
	await persistentOutputFailure();
	scenario = freshScenario("visibility-instrumentation");
	const timingPage = await newPage();
	try {
		await visibleOutput(timingPage.page);
		const observations = {};
		for (const kind of ["visible", "hidden", "detached", "offscreen"]) {
			observations[kind] = await timingPage.page.evaluate(
				(state) => window.__benchmark.probeTimingVisibility(state),
				kind,
			);
			assert.deepEqual(
				observations[kind],
				kind === "visible" ? ["received", "loaded", "visible"] : ["received", "loaded"],
			);
		}
		report.regressions.push({
			name: "visibility timing checks the real image after frames: visible, hidden, detached and outside viewport",
			passed: true,
			observations,
		});
	} finally {
		await timingPage.context.close();
	}
}

async function persistentOutputFailure() {
	scenario = freshScenario("persistent-output-error", { persistentOutputError: true });
	const failurePage = await newPage();
	try {
		await failurePage.page
			.getByText("comparisonUnavailable")
			.waitFor({ state: "visible", timeout: 3000 });
		const outputAttempts = scenario.operations.filter(
			(event) => event.operation === "image" && event.assetId === "asset-output",
		).length;
		const statusRequests = scenario.operations.filter(
			(event) => event.operation === "status",
		).length;
		assert.equal(
			outputAttempts,
			2,
			"Persistent image failure must stop after one automatic credential refresh",
		);
		assert.equal(
			statusRequests,
			2,
			"Persistent image failure must make at most one immediate status refresh",
		);
		assert.equal(
			scenario.operations.filter(
				(event) => event.operation === "access" && event.assetId === "asset-output",
			).length,
			0,
		);
		report.regressions.push({
			name: "persistent image failure stops after one credential refresh and shows failure UI",
			passed: true,
			outputAttempts,
			statusRequests,
		});
		scenario.persistentOutputError = false;
		scenario.generation++;
		scenario.revision++;
		await failurePage.page.getByRole("button", { name: "retry", exact: true }).click();
		await visibleOutput(failurePage.page);
		assert.equal(
			scenario.operations.filter(
				(event) => event.operation === "image" && event.assetId === "asset-output",
			).length,
			outputAttempts + 1,
		);
		assert.equal(
			scenario.operations.filter((event) => event.operation === "status").length,
			statusRequests + 1,
		);
		report.regressions.push({
			name: "explicit retry reauthorizes and displays recovered output with one new transfer",
			passed: true,
		});
	} catch (error) {
		report.regressions.push({
			name: "persistent image failure stops after one credential refresh and shows failure UI",
			passed: false,
			operations: scenario.operations,
		});
		throw error;
	} finally {
		await failurePage.context.close();
	}
}

async function slowFirstImage() {
	scenario = freshScenario("slow-first-image", {
		textOnly: true,
		imageDelayMs: 3300,
		rotateCredentialEachStatus: true,
	});
	const fixture = await newPage();
	const failedDownloads = [];
	fixture.page.on("requestfailed", (request) => {
		if (new URL(request.url()).pathname === "/image/asset-output")
			failedDownloads.push(request.failure()?.errorText);
	});
	let passed = false;
	try {
		await visibleOutput(fixture.page);
		const outputAttempts = scenario.operations.filter(
			(event) => event.operation === "image" && event.assetId === "asset-output",
		).length;
		assert.equal(
			outputAttempts,
			1,
			"A routine poll must not replace the src of the first image while it is still downloading",
		);
		assert.ok(
			scenario.operations.filter((event) => event.operation === "status").length >= 2,
			"The actual two-second polling interval must run during the 3.3-second transfer",
		);
		passed = true;
	} finally {
		const timings = await fixture.page.evaluate(() => window.__timings);
		const observation = {
			name: "first output download outlives actual two-second polling without being restarted by re-signing",
			passed,
			imageDelayMs: scenario.imageDelayMs,
			outputAttempts: scenario.operations.filter(
				(event) => event.operation === "image" && event.assetId === "asset-output",
			).length,
			statusRequests: scenario.operations.filter((event) => event.operation === "status").length,
			failedDownloads,
			timings,
			operations: scenario.operations,
		};
		report.regressions.push(observation);
		await fixture.page.screenshot({
			path: path.join(outputDirectory, `${reportPrefix}-${passed ? "green" : "red"}.png`),
			fullPage: true,
		});
		await fixture.context.close();
	}
}

try {
	await mkdir(outputDirectory, { recursive: true });
	appBundle = await bundle();
	report.bundleSha256 = createHash("sha256").update(appBundle).digest("hex");
	await writeFile(path.join(outputDirectory, `${reportPrefix}-bundle.js`), appBundle);
	server = createServer((request, response) => {
		void serve(request, response).catch((error) => {
			console.error(error);
			response.writeHead(500).end();
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
	browserServer = await chromium.launchServer({ headless: true });
	report.ownedProcesses = {
		harnessPid: process.pid,
		browserRootPid: browserServer.process().pid,
		listenAddress: origin,
	};
	await writeFile(
		path.join(outputDirectory, `${reportPrefix}-processes.json`),
		JSON.stringify(report.ownedProcesses, null, 2),
	);
	browser = await chromium.connect(browserServer.wsEndpoint());
	if (comparisonStabilityOnly) {
		await comparisonStability();
		await regressions();
		await slowFirstImage();
	} else if (timingOnlyCheck) await measure("resource-timing");
	else if (slowFirstImageOnly) await slowFirstImage();
	else if (persistentOnly) await persistentOutputFailure();
	else if (downstreamMode) {
		for (let index = 1; index <= 3; index++) {
			await measure(`allow-${index}`, {
				downstream: true,
				status: "PROVIDER_RUNNING",
				outputReady: false,
				auditSequence: ["ALLOW"],
			});
			await measure(`pending-${index}`, {
				downstream: true,
				status: "PROVIDER_RUNNING",
				outputReady: false,
				auditSequence: ["REVIEW", "ALLOW"],
			});
		}
	} else {
		for (let index = 1; index <= 3; index++) await measure(`sample-${index}`);
		if (mode === "after") await regressions();
	}
	const baselinePath = path.join(
		outputDirectory,
		downstreamMode ? "before-downstream.json" : "before.json",
	);
	if (
		mode === "after" &&
		!persistentOnly &&
		!slowFirstImageOnly &&
		!timingOnlyCheck &&
		!comparisonStabilityOnly &&
		existsSync(baselinePath)
	) {
		const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
		assert.deepEqual(
			baseline.delaysMs,
			report.delaysMs,
			"Before/after fixture delays must be identical",
		);
		const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
		if (downstreamMode) {
			assert.deepEqual(baseline.downstreamDelaysMs, report.downstreamDelaysMs);
			report.downstreamComparison = Object.fromEntries(
				["allow", "pending"].map((sequence) => {
					const before = median(
						baseline.samples
							.filter((sample) => sample.name.startsWith(sequence))
							.map((sample) => sample.kieCompleteToVisibleMs),
					);
					const after = median(
						report.samples
							.filter((sample) => sample.name.startsWith(sequence))
							.map((sample) => sample.kieCompleteToVisibleMs),
					);
					return [
						sequence,
						{ beforeMedianMs: before, afterMedianMs: after, reductionMs: before - after },
					];
				}),
			);
		}
		report.comparison = Object.fromEntries(
			[
				"outputReceivedToImageStartMs",
				"outputReceivedToLoadMs",
				"outputReceivedToVisibleMs",
				"navigationToVisibleMs",
			].map((metric) => {
				const before = median(baseline.samples.map((sample) => sample[metric]));
				const after = median(report.samples.map((sample) => sample[metric]));
				return [metric, { beforeMedian: before, afterMedian: after, reduction: before - after }];
			}),
		);
	}
	report.completed = true;
} catch (error) {
	report.completed = false;
	report.failure = error.stack;
	process.exitCode = 1;
	console.error(error);
} finally {
	if (browserServer && process.platform === "win32") {
		const rootPid = browserServer.process().pid;
		const script = `$items = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId); $owned = @(${rootPid}); for ($i = 0; $i -lt $owned.Count; $i++) { $owned += @($items | Where-Object { $_.ParentProcessId -eq $owned[$i] } | ForEach-Object { [int]$_.ProcessId }) }; ConvertTo-Json -InputObject $owned -Compress`;
		report.ownedProcesses.browserProcessTree = JSON.parse(
			execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
				encoding: "utf8",
				windowsHide: true,
			}),
		);
	}
	await browser?.close();
	await browserServer?.close();
	if (server) {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
	stop();
	const stillAlive = (report.ownedProcesses?.browserProcessTree ?? []).filter((pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	});
	report.cleanup = {
		browserClosed: !browserServer || browserServer.process().exitCode !== null,
		serverClosed: !server?.listening,
		trackedBrowserProcessesStillAlive: stillAlive,
	};
	if (stillAlive.length > 0) {
		report.completed = false;
		process.exitCode = 1;
	}
	await writeFile(
		path.join(outputDirectory, `${reportPrefix}.json`),
		JSON.stringify(report, null, 2),
	);
}
