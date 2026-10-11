import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { getBlogAdDocument } from "../saas/modules/public-content/lib/blog-ads.ts";
import {
	buildStaticAds,
	MAX_TEST_WINDOW_MS,
	parseArguments,
	parseTestUntil,
	readSourceDocument,
} from "./generate.ts";

const NOW = Date.parse("2026-10-11T11:00:00Z");
const TEST_UNTIL = "2026-10-11T13:00:00Z";
const DEADLINE = Date.parse(TEST_UNTIL);
const EXPECTED_URLS = {
	banner: "https://www.highrevenueformat.com/2266a6811e407f9b362831f885d09d1e/invoke.js",
	native:
		"https://pl31768149.profitableratecpmnetwork.com/0a9986f36ff843c117e0f20e732a1e08/invoke.js",
};

function inlineScripts(html: string): string[] {
	return Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), (match) => match[1]);
}

function executeBootstrap(html: string, now: number, embedded = true) {
	const writes: string[] = [];
	const navigations: string[] = [];
	const timers: { callback: () => void; delay: number }[] = [];
	const self = {};
	const context: {
		Date: { now: () => number };
		document: { write: (value: string) => void };
		window: { self: object; top: object; location: { replace: (value: string) => void } };
		setTimeout: (callback: () => void, delay: number) => number;
		atOptions?: unknown;
	} = {
		Date: { now: () => now },
		document: { write: (value) => writes.push(value) },
		window: {
			self,
			top: embedded ? {} : self,
			location: { replace: (value) => navigations.push(value) },
		},
		setTimeout: (callback, delay) => {
			assert.equal(typeof callback, "function");
			assert.ok(delay > 0 && delay <= MAX_TEST_WINDOW_MS);
			timers.push({ callback, delay });
			return timers.length;
		},
	};
	for (const script of inlineScripts(html)) {
		runInNewContext(script, context, { timeout: 100 });
	}
	return { writes, options: context.atOptions, navigations, timers };
}

function headerFor(headers: string, path: string, name: string): string {
	const block = headers.split("\n\n").find((value) => value.startsWith(`${path}\n`));
	assert.ok(block);
	const value = block.split("\n").find((line) => line.startsWith(`  ${name}: `));
	assert.ok(value);
	return value.slice(`  ${name}: `.length);
}

void test("default off produces exactly two vendor-free empty documents with restrictive headers", () => {
	const build = buildStaticAds(undefined, NOW);
	assert.equal(build.enabled, false);
	assert.equal(build.testUntil, undefined);
	assert.deepEqual(Object.keys(build.files), ["banner.html", "native.html", "_headers"]);
	for (const format of ["banner", "native"] as const) {
		const html = build.files[`${format}.html`];
		assert.match(html, /<body><\/body>/);
		assert.doesNotMatch(html, /<script|<iframe|atOptions|container-|https?:|invoke\.js/);
		const csp = headerFor(build.files._headers, `/${format}.html`, "Content-Security-Policy");
		assert.match(csp, /script-src 'none'/);
		assert.match(csp, /img-src 'none'; frame-src 'none'; connect-src 'none'/);
		assert.doesNotMatch(csp, /highrevenueformat|profitableratecpmnetwork/);
	}
});

void test("test deadline requires a valid future explicit UTC timestamp within two hours", () => {
	assert.equal(parseTestUntil(TEST_UNTIL, NOW), NOW + MAX_TEST_WINDOW_MS);
	for (const timestamp of [
		"2026-10-11T11:00:00Z",
		"2026-10-11T10:59:59Z",
		"2026-10-11T13:00:01Z",
		"2026-10-11T12:00:00",
		"2026-10-11T12:00:00+00:00",
		"2026-10-11T12:00:00.000Z",
		"2026-02-30T12:00:00Z",
		"2026-10-11T24:00:00Z",
		"never",
		"Infinity",
	]) {
		assert.throws(() => buildStaticAds(timestamp, NOW));
	}
	assert.throws(() => parseTestUntil(TEST_UNTIL, Number.NaN));
});

void test("CLI defaults off and rejects implicit activation, extra flags and duplicate arguments", () => {
	assert.equal(parseArguments([]), undefined);
	assert.equal(parseArguments(["--test-until", TEST_UNTIL]), TEST_UNTIL);
	for (const args of [
		["--enable"],
		["--test-until"],
		["--test-until", TEST_UNTIL, "--test-until", TEST_UNTIL],
		["--output", "elsewhere"],
		["--test-until=2026-10-11T13:00:00Z"],
	]) {
		assert.throws(() => parseArguments(args));
	}
});

for (const format of ["banner", "native"] as const) {
	void test(`${format} preserves only the exact supplied unit and source attributes before expiry`, () => {
		const build = buildStaticAds(TEST_UNTIL, NOW);
		const html = build.files[`${format}.html`];
		const source = readSourceDocument(format, getBlogAdDocument(format));
		assert.ok(source.externalScript.includes(EXPECTED_URLS[format]));
		assert.doesNotMatch(html, /<script[^>]+src=/);
		const result = executeBootstrap(html, DEADLINE - 1);
		assert.deepEqual(result.writes, [source.externalScript]);
		if (format === "banner") {
			const options = JSON.parse(JSON.stringify(result.options));
			assert.deepEqual(options, {
				key: new URL(EXPECTED_URLS.banner).pathname.split("/")[1],
				format: "iframe",
				height: 90,
				width: 728,
				params: {},
			});
			assert.equal(source.container, "");
		} else {
			assert.equal(result.options, undefined);
			assert.ok(html.includes(source.container));
			assert.ok(html.indexOf(source.container) < html.indexOf("<script>"));
			assert.match(source.externalScript, /async="async" data-cfasync="false"/);
		}
	});

	void test(`${format} executes neither config nor supplier insertion at or after expiry`, () => {
		const html = buildStaticAds(TEST_UNTIL, NOW).files[`${format}.html`];
		for (const now of [DEADLINE, DEADLINE + 1, DEADLINE + 86_400_000]) {
			assert.deepEqual(executeBootstrap(html, now), {
				writes: [],
				options: undefined,
				navigations: ["about:blank"],
				timers: [],
			});
		}
	});

	void test(`${format} direct top-level visits start no supplier, config or timer`, () => {
		const html = buildStaticAds(TEST_UNTIL, NOW).files[`${format}.html`];
		for (const now of [NOW, DEADLINE - 1, DEADLINE, DEADLINE + 1]) {
			assert.deepEqual(executeBootstrap(html, now, false), {
				writes: [],
				options: undefined,
				navigations: [],
				timers: [],
			});
		}
	});

	void test(`${format} embedded expiry callback navigates only its own document to blank`, () => {
		const html = buildStaticAds(TEST_UNTIL, NOW).files[`${format}.html`];
		const result = executeBootstrap(html, NOW);
		assert.equal(result.timers.length, 1);
		assert.equal(result.timers[0].delay, MAX_TEST_WINDOW_MS);
		assert.deepEqual(result.navigations, []);
		result.timers[0].callback();
		assert.deepEqual(result.navigations, ["about:blank"]);
		assert.match(html, /window\.location\.replace\("about:blank"\)/);
		assert.doesNotMatch(
			html,
			/window\.top\.|window\.parent|window\.open|top\.location|parent\.location/,
		);
	});

	void test(`${format} CSP exactly hashes all inline bytes and permits only its original host`, () => {
		const build = buildStaticAds(TEST_UNTIL, NOW);
		const html = build.files[`${format}.html`];
		const csp = headerFor(build.files._headers, `/${format}.html`, "Content-Security-Policy");
		const scripts = inlineScripts(html);
		const style = html.match(/<style>([^<]*)<\/style>/)?.[1];
		assert.ok(style);
		const hashes = [...scripts, style].map(
			(content) => `'sha256-${createHash("sha256").update(content).digest("base64")}'`,
		);
		assert.deepEqual(
			Array.from(csp.matchAll(/'sha256-[^']+'/g), (match) => match[0]),
			hashes,
		);
		const supplier = new URL(EXPECTED_URLS[format]).origin;
		assert.equal(new Set(csp.match(/https:\/\/[^ ;]+/g)).size, 2);
		for (const directive of ["script-src", "img-src", "frame-src", "connect-src"]) {
			const value = csp.split("; ").find((part) => part.startsWith(`${directive} `));
			assert.ok(value?.includes(supplier));
		}
		assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|strict-dynamic|https:(?:[ ;]|$)|\*/);
		assert.doesNotMatch(
			csp,
			/allow-same-origin|allow-popups|allow-forms|allow-top-navigation|data:|blob:/,
		);
		assert.doesNotMatch(
			html,
			/parent\.|top\.|document\.referrer|document\.cookie|localStorage|sessionStorage|postMessage|fetch\(|XMLHttpRequest|setInterval|window\.open/,
		);
	});
}

void test("all served documents deny capabilities, tracking metadata and caching without XFO DENY", () => {
	for (const until of [undefined, TEST_UNTIL]) {
		const headers = buildStaticAds(until, NOW).files._headers;
		assert.equal(headers.split("\n\n").length, 2);
		assert.ok(headers.split("\n").every((line) => line.length <= 2000));
		assert.doesNotMatch(headers, /X-Frame-Options|Access-Control-Allow-Origin/);
		for (const format of ["banner", "native"] as const) {
			const path = `/${format}.html`;
			assert.equal(headerFor(headers, path, "Referrer-Policy"), "no-referrer");
			assert.equal(headerFor(headers, path, "X-Content-Type-Options"), "nosniff");
			assert.equal(headerFor(headers, path, "Cache-Control"), "no-store");
			assert.match(headerFor(headers, path, "X-Robots-Tag"), /noindex/);
			const csp = headerFor(headers, path, "Content-Security-Policy");
			assert.match(csp, /frame-ancestors https:\/\/ezimageai\.com(?:;|$)/);
			assert.match(csp, /sandbox allow-scripts(?:;|$)/);
			assert.match(csp, /base-uri 'none'; form-action 'none'/);
			assert.ok(
				headerFor(headers, path, "Permissions-Policy")
					.split(", ")
					.every((feature) => /^[a-z-]+=\(\)$/.test(feature)),
			);
		}
	}
});

void test("shared source rejects new hosts, capabilities, sensitive parameters and active elements", () => {
	for (const format of ["banner", "native"] as const) {
		const source = getBlogAdDocument(format);
		const mutations = [
			source.replaceAll(new URL(EXPECTED_URLS[format]).pathname.split("/")[1], "a".repeat(32)),
			source.replace(new URL(EXPECTED_URLS[format]).origin, "https://unknown.example"),
			source.replace('referrerpolicy="no-referrer" src=', 'onload="alert(1)" src='),
			source.replace("</body>", '<iframe src="https://unknown.example"></iframe></body>'),
			source.replace("</body>", "<script>fetch(location.href)</script></body>"),
			source.replace("<style>", "<style>@import 'https://unknown.example/style.css';"),
			source.replace("<style>", "<style>body{background:u\\72l('https://unknown.example/a')}"),
			source.replace("<style>", "<style>@\\69mport 'https://unknown.example/style.css';"),
			source.replace("html,body{", "html,body{color:red;"),
			source.replace("</head>", '<base href="https://ezimageai.com"></head>'),
			source.replace(
				"</head>",
				'<meta http-equiv="Content-Security-Policy" content="default-src https:"></head>',
			),
		];
		if (format === "banner") {
			mutations.push(source.replace("'params':{}", "'params':{'prompt':'sensitive'}"));
		} else {
			mutations.push(source.replace('data-cfasync="false"', 'data-cfasync="true"'));
		}
		for (const changed of mutations) {
			assert.throws(() => readSourceDocument(format, changed));
		}
	}
});

void test("Wrangler config has only static assets and the single approved custom domain", async () => {
	const config = JSON.parse(await readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8"));
	assert.deepEqual(config, {
		name: "ezimageai-blog-ads-production",
		compatibility_date: "2026-10-11",
		workers_dev: false,
		preview_urls: false,
		routes: [{ pattern: "ads.ezimageai.com", custom_domain: true }],
		assets: {
			directory: "./dist",
			html_handling: "none",
			not_found_handling: "none",
			run_worker_first: false,
		},
	});
	const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
	assert.equal(pkg.dependencies, undefined);
	assert.equal(pkg.devDependencies, undefined);
	assert.ok(Object.values(pkg.scripts).every((value) => !String(value).includes("deploy")));
});
