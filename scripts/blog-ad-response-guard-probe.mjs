import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";

import { installBlogAdResponseGuard } from "./blog-ad-response-guard.mjs";

// Public-CDP transport proof only. Every HTTP endpoint belongs to these fresh
// loopback servers. No vendor payload, production URL, user Chrome or Next app.
const { values } = parseArgs({
	options: {
		"dependency-root": { type: "string", default: process.cwd() },
		"output-dir": { type: "string" },
	},
});
const require = createRequire(
	path.join(path.resolve(values["dependency-root"]), "apps/saas/package.json"),
);
const { chromium } = require("@playwright/test");
await access(chromium.executablePath());
const outputDir = path.resolve(
	values["output-dir"] ??
		`output/playwright/blog-ads/response-guard-autoattach-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
const relativeOutput = path.relative(process.cwd(), outputDir);
if (
	!relativeOutput.startsWith(`output${path.sep}playwright${path.sep}blog-ads${path.sep}`) ||
	path.isAbsolute(relativeOutput) ||
	relativeOutput.startsWith("..")
)
	throw new Error("Use a fresh ignored probe output directory.");
await mkdir(path.dirname(outputDir), { recursive: true });
await mkdir(outputDir);
const sourceSha256 = Object.fromEntries(
	await Promise.all(
		["blog-ad-response-guard.mjs", "blog-ad-response-guard-probe.mjs"].map(async (file) => [
			file,
			createHash("sha256")
				.update(await readFile(new URL(file, import.meta.url)))
				.digest("hex"),
		]),
	),
);
const scriptBody = "globalThis.__probeExecuted=1;".padEnd(32, " ");
assert.equal(Buffer.byteLength(scriptBody), 32);
const results = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function deadline(promise, ms, label) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timeout.`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
const serviceWorkerHarnessMessage =
	"Failed to read the 'serviceWorker' property from 'Navigator': Service worker is disabled because the context is sandboxed and lacks the 'allow-same-origin' flag.";

async function runCase(nested, redirect, mode = "normal") {
	const fault = ["unknown-policy", "policy-timeout", "overlapping-policy"].includes(mode);
	const expectedStop = redirect || fault;
	const name =
		mode === "normal" ? `${nested ? "nested" : "child"}-${redirect ? "302" : "200"}` : mode;
	const record = {
		name,
		nested,
		redirect,
		mode,
		fixtureOnly: true,
		scriptBytes: 32,
		traces: [],
		responseObservations: [],
		pausedInstallObservations: [],
		hits: {},
		destinationRequestEvents: 0,
		blockedExternalRequests: 0,
		failures: [],
		pageErrors: [],
		harnessWarnings: [],
		checks: {},
	};
	let sequence = 0;
	let browser;
	let browserServer;
	let guard;
	let failureResolve;
	const failed = new Promise((resolve) => {
		failureResolve = resolve;
	});
	let secondPolicyResolve;
	const secondPolicyObserved = new Promise((resolve) => {
		secondPolicyResolve = resolve;
	});
	let origins;
	const servers = [];
	function headers(csp) {
		return {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": csp,
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "no-store",
		};
	}
	const commonCsp =
		"default-src 'none'; style-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none'; img-src 'none'; script-src-attr 'none'; worker-src 'none'";
	async function server(host) {
		const instance = http.createServer((request, response) => {
			const pathname = new URL(request.url, "http://fixture.invalid").pathname;
			record.hits[pathname] = (record.hits[pathname] ?? 0) + 1;
			if (pathname === "/destination.js") {
				response.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
				response.end(scriptBody);
				return;
			}
			if (pathname === "/first.js" || pathname === "/second.js") {
				if (redirect) {
					response.writeHead(302, {
						Location: `${origins.destination}/destination.js`,
						"Cache-Control": "no-store",
					});
					response.end();
				} else {
					response.writeHead(200, {
						"Content-Type": "text/javascript",
						"Cache-Control": "no-store",
					});
					response.end(scriptBody);
				}
				return;
			}
			let body;
			let csp;
			if (pathname === "/root.html" && mode === "parent-307") {
				response.writeHead(307, {
					Location: `${origins.root}/root-final.html`,
					"Cache-Control": "no-store",
				});
				response.end();
				return;
			}
			if (pathname === "/root.html" || pathname === "/root-final.html") {
				body = `<!doctype html><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" src="${origins.child}/child.html"></iframe>`;
				csp = `${commonCsp}; script-src 'none'; frame-src ${origins.child}`;
			} else if (pathname === "/child.html") {
				body = nested
					? `<!doctype html><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" src="${origins.nested}/nested.html"></iframe>`
					: `<!doctype html><script src="${origins.child}/first.js"></script>`;
				if (mode === "overlapping-policy")
					body = `<!doctype html><script async src="${origins.child}/first.js"></script><script async src="${origins.child}/second.js"></script>`;
				csp = `${commonCsp}; sandbox allow-scripts; script-src ${origins.child} ${origins.destination}; frame-src ${nested ? origins.nested : "'none'"}`;
			} else if (pathname === "/nested.html") {
				body = `<!doctype html><script src="${origins.nested}/first.js"></script>`;
				csp = `${commonCsp}; sandbox allow-scripts; script-src ${origins.nested} ${origins.destination}; frame-src 'none'`;
			} else {
				response.writeHead(404);
				response.end();
				return;
			}
			response.writeHead(200, headers(csp));
			response.end(body);
		});
		await new Promise((resolve, reject) => {
			instance.once("error", reject);
			instance.listen(0, host, resolve);
		});
		servers.push(instance);
		return instance.address().port;
	}
	try {
		const sourcePort = await server("127.0.0.1");
		const nestedPort = await server("127.0.0.2");
		const destinationPort = await server("127.0.0.1");
		origins = {
			root: `http://127.0.0.1:${sourcePort}`,
			child: `http://localhost:${sourcePort}`,
			nested: `http://127.0.0.2:${nestedPort}`,
			destination: `http://127.0.0.1:${destinationPort}`,
		};
		browserServer = await chromium.launchServer({
			host: "127.0.0.1",
			headless: true,
			chromiumSandbox: true,
			args: [
				"--enable-automation",
				"--site-per-process",
				"--remote-debugging-port=0",
				"--remote-debugging-address=127.0.0.1",
			],
		});
		const serverEndpoint = new URL(browserServer.wsEndpoint());
		assert.equal(serverEndpoint.hostname, "127.0.0.1");
		browser = await chromium.connect(browserServer.wsEndpoint());
		record.browserVersion = browser.version();
		const context = await browser.newContext({ serviceWorkers: "block" });
		await context.route("**/*", async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			if (
				request.method() !== "GET" ||
				!Object.values(origins).includes(url.origin) ||
				![
					"/root.html",
					"/root-final.html",
					"/child.html",
					"/nested.html",
					"/first.js",
					"/second.js",
					"/destination.js",
				].includes(url.pathname)
			) {
				record.blockedExternalRequests++;
				await route.abort("blockedbyclient");
				return;
			}
			await route.continue(); // Exact self-owned HTTP endpoints only.
		});
		await context.routeWebSocket("**/*", (socket) => socket.close());
		const page = await context.newPage();
		page.on("pageerror", (error) => {
			if (error.message === serviceWorkerHarnessMessage) record.harnessWarnings.push(error.message);
			else record.pageErrors.push(error.message);
		});
		guard = await installBlogAdResponseGuard({
			browser,
			page,
			destroyOwnedBrowser: async () => {
				if (mode === "overlapping-policy") {
					await wait(400); // Deliberately slow shutdown to expose late-continue races.
					const child = page
						.frames()
						.find((frame) => frame.url() === `${origins.child}/child.html`);
					record.markerDuringStoppedShutdown = child
						? await child.evaluate(() => typeof globalThis.__probeExecuted)
						: "frame-missing";
				}
				await browserServer.close(); // Real server/process destruction, not client disconnect.
			},
			timeoutMs: mode === "policy-timeout" ? 750 : 5000,
			guardedOrigins: [origins.child, origins.nested],
			onTrace: (event) => record.traces.push({ order: ++sequence, ...event }),
			onFailure: (failure) => {
				record.failures.push(failure);
				failureResolve();
			},
			beforeTargetConfigure: async (target) => {
				if (target.owner !== "child") return;
				await wait(150); // Deliberate late installation after debugger pause.
				record.pausedInstallObservations.push({
					targetId: target.targetId,
					waitingForDebugger: target.waitingForDebugger,
					firstScriptHitsBeforeFetch: record.hits["/first.js"] ?? 0,
				});
			},
			onEvent: ({ method, params }) => {
				if (
					method === "Network.requestWillBeSent" &&
					params.request.url === `${origins.destination}/destination.js`
				)
					record.destinationRequestEvents++;
			},
			onResponse: async ({ targetId, owner, event, send }) => {
				const pathname = new URL(event.request.url).pathname;
				const observation = {
					order: ++sequence,
					targetId,
					owner,
					pathname,
					status: event.responseStatusCode,
					resourceType: event.resourceType,
				};
				if (["/first.js", "/second.js"].includes(pathname) && event.responseStatusCode === 200) {
					const evaluation = await send("Runtime.evaluate", {
						expression: "typeof globalThis.__probeExecuted",
						returnByValue: true,
					});
					observation.markerBeforeContinue = evaluation.result.value;
				}
				record.responseObservations.push(observation);
				if (mode === "overlapping-policy" && pathname === "/first.js") {
					await deadline(secondPolicyObserved, 2000, "Second overlapping policy");
					return "block";
				}
				if (mode === "overlapping-policy" && pathname === "/second.js") {
					secondPolicyResolve();
					await wait(150);
					record.latePolicyReturnedContinue = true;
					return "continue";
				}
				if (pathname === "/first.js" && mode === "unknown-policy") return "unknown";
				if (pathname === "/first.js" && mode === "policy-timeout") return new Promise(() => {});
				return event.responseStatusCode === 200 ? "continue" : "block";
			},
		});
		const navigation = page
			.goto(`${origins.root}/root.html`, { waitUntil: "load", timeout: 12_000 })
			.catch((error) => {
				record.navigationError = error.message;
			});
		if (expectedStop) {
			await deadline(
				Promise.race([failed, navigation.then(() => wait(500))]),
				13_000,
				"Expected guard stop",
			);
			await navigation;
			if (guard.stopped) await deadline(guard.waitForStop(), 5000, "Owned browser stop");
		} else {
			await navigation;
			const frame = page
				.frames()
				.find(
					(item) =>
						item.url() ===
						`${nested ? origins.nested : origins.child}/${nested ? "nested" : "child"}.html`,
				);
			record.markerAfterContinue = frame
				? await frame.evaluate(() => globalThis.__probeExecuted)
				: null;
		}
		const script = record.responseObservations.find((item) => item.pathname === "/first.js");
		const childIds = new Set(
			record.traces
				.filter((item) => item.owner === "child" && item.phase === "attached")
				.map((item) => item.targetId),
		);
		const guardedOrder = [...childIds].every((id) => {
			const events = record.traces.filter((item) => item.targetId === id);
			const fetchAck = events.find((item) => item.phase === "fetch-response-enable-ack")?.order;
			const recursiveAck = events.find((item) => item.phase === "recursive-auto-attach-ack")?.order;
			const resume = events.find((item) => item.phase === "runtime-resume-ack")?.order;
			return (
				recursiveAck < fetchAck &&
				fetchAck < resume &&
				events.find((item) => item.phase === "attached")?.waitingForDebugger === true
			);
		});
		record.checks = {
			forcedSeparateTargets: childIds.size >= (nested ? 2 : 1),
			allChildGuardsAcknowledgedBeforeResume: childIds.size > 0 && guardedOrder,
			childScriptNotRequestedDuringPausedInstallation:
				record.pausedInstallObservations.length >= (nested ? 2 : 1) &&
				record.pausedInstallObservations.every(
					(item) => item.waitingForDebugger && item.firstScriptHitsBeforeFetch === 0,
				),
			firstResponseObservedByChildGuard:
				script?.owner === "child" && script?.status === (redirect ? 302 : 200),
			firstScriptHttpHitExactlyOnce: record.hits["/first.js"] === 1,
			destinationHttpHitsZero: (record.hits["/destination.js"] ?? 0) === 0,
			destinationNetworkRequestEventsZero: record.destinationRequestEvents === 0,
			noUnexpectedPageErrors: record.pageErrors.length === 0,
			noNonFixtureRequests: record.blockedExternalRequests === 0,
			noDuplicateAttachments:
				record.traces.filter((item) => item.phase === "attached").length ===
				new Set(
					record.traces.filter((item) => item.phase === "attached").map((item) => item.targetId),
				).size,
			...(expectedStop
				? {
						ownedServerProcessExited:
							browserServer.process().exitCode !== null ||
							browserServer.process().signalCode !== null,
					}
				: {}),
			...(mode === "overlapping-policy"
				? {
						latePolicyObservedButNotExecuted:
							record.hits["/second.js"] === 1 &&
							record.latePolicyReturnedContinue === true &&
							record.markerDuringStoppedShutdown === "undefined",
					}
				: {}),
			...(mode === "parent-307"
				? {
						unguardedParent307Completed:
							page.url() === `${origins.root}/root-final.html` &&
							record.hits["/root-final.html"] === 1 &&
							!record.responseObservations.some(
								(item) => item.pathname === "/root.html" || item.pathname === "/root-final.html",
							),
					}
				: {}),
			...(fault
				? {
						first200PausedBeforeFailure: script?.markerBeforeContinue === "undefined",
						guardStoppedAndBrowserClosed: guard.stopped && !browser.isConnected(),
						onlyExpectedFailure:
							record.failures.length === 1 &&
							record.failures[0].reason ===
								(mode === "policy-timeout"
									? "Response policy timeout."
									: "Response rejected before browser follow/execute."),
						noResponseContinuedForFailedScript: !record.traces.some(
							(item) =>
								item.phase === "response-continue-ack" &&
								item.targetId === script?.targetId &&
								item.status === 200,
						),
					}
				: redirect
					? {
							first302FailAcknowledged: record.traces.some(
								(item) =>
									item.phase === "response-fail-ack" &&
									item.status === 302 &&
									item.targetId === script?.targetId,
							),
							guardStoppedAndBrowserClosed: guard.stopped && !browser.isConnected(),
							onlyExpectedRejection:
								record.failures.length === 1 &&
								record.failures[0].reason === "Response rejected before browser follow/execute.",
						}
					: {
							first200PausedBeforeScriptExecution: script?.markerBeforeContinue === "undefined",
							first200ExecutedAfterContinue: record.markerAfterContinue === 1,
							noGuardFailure: record.failures.length === 0,
						}),
		};
		record.passed = Object.values(record.checks).every(Boolean);
	} catch (error) {
		record.error = error.stack;
		record.passed = false;
	} finally {
		await guard?.close();
		await browser?.close().catch(() => {});
		await browserServer?.close().catch(() => {});
		for (const instance of servers) {
			instance.closeAllConnections();
			await new Promise((resolve) => instance.close(resolve));
		}
	}
	return record;
}

for (const nested of [false, true])
	for (const redirect of [false, true]) {
		const result = await runCase(nested, redirect);
		results.push(result);
		await writeFile(
			path.join(outputDir, `${result.name}.json`),
			`${JSON.stringify(result, null, 2)}\n`,
		);
		console.log(
			JSON.stringify({
				case: result.name,
				passed: result.passed,
				checks: result.checks,
				error: result.error,
			}),
		);
	}
for (const mode of ["unknown-policy", "policy-timeout", "overlapping-policy", "parent-307"]) {
	const result = await runCase(false, false, mode);
	results.push(result);
	await writeFile(
		path.join(outputDir, `${result.name}.json`),
		`${JSON.stringify(result, null, 2)}\n`,
	);
	console.log(
		JSON.stringify({
			case: result.name,
			passed: result.passed,
			checks: result.checks,
			error: result.error,
		}),
	);
}
const evidence = {
	generatedAt: new Date().toISOString(),
	sourceSha256,
	fixtureOnly: true,
	realSupplierRequests: 0,
	productionRequests: 0,
	userChromeUsed: false,
	browserOwnership:
		"fresh bundled Chromium BrowserServer temporary profile, sandbox enabled, public loopback Browser CDP; ownedServer.close destroys actual process",
	transport:
		"Browser Target.attachToTarget(blank root,flatten) + recursive Target.setAutoAttach(wait=true,flatten) + pre-Fetch ACK before Runtime resume",
	sandbox: "allow-scripts only; no same-origin/top-navigation/popups/forms",
	cases: results,
	passed: results.every((result) => result.passed),
};
await writeFile(path.join(outputDir, "probe.json"), `${JSON.stringify(evidence, null, 2)}\n`);
await writeFile(
	path.join(outputDir, "REPORT.md"),
	`# Public CDP first-response fixture\n\nOverall: ${evidence.passed ? "PASS" : "FAIL"}. ${results.length} fresh Chromium browsers; pure owned loopback HTTP only. Each script is exactly 32 bytes.\n\nThis proves only response interception timing, recursive target coverage, exact-origin scope and failure closure in this fixture. It does not prove vendor compatibility, creatives, consent behavior, responsive native ads or revenue. The live observer has not been integrated or run by this probe.\n\n${results.map((result) => `- ${result.name}: ${result.passed ? "PASS" : "FAIL"}, first-script HTTP ${result.hits["/first.js"] ?? 0}, destination HTTP ${result.hits["/destination.js"] ?? 0}, destination Network events ${result.destinationRequestEvents}`).join("\n")}\n`,
);
console.log(JSON.stringify({ outputDir, passed: evidence.passed }));
if (!evidence.passed) process.exitCode = 1;
