import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
	aggregate,
	analyze,
	groupRows,
	isBrand,
	markdownReport,
	queryCache,
	report,
} from "../src/analyze.mjs";
import { cachedDays, dayPath, loadRange, siteDir, syncSite } from "../src/collect.mjs";
import {
	assertDate,
	assertInspectionUrl,
	pacificDate,
	shiftDate,
	validateProperty,
	writeJson,
} from "../src/config.mjs";
import { GscClient, queryAll, READONLY_SCOPE } from "../src/google.mjs";
import { authorize, validState } from "../src/oauth.mjs";

void test("OAuth callback rejects mismatched state and closes its loopback listener on timeout", async (t) => {
	assert.equal(validState("random-secret-state", "random-secret-state"), true);
	assert.equal(validState("random-secret-state", "wrong"), false);
	assert.equal(validState("random-secret-state", null), false);
	const config = await fixture(t);
	const clientFile = join(config.dataDir, "client.json");
	await writeJson(clientFile, {
		installed: {
			client_id: "test.apps.googleusercontent.com",
			client_secret: "test-only",
			auth_uri: "https://accounts.google.com/o/oauth2/auth",
			token_uri: "https://oauth2.googleapis.com/token",
		},
	});
	let ready;
	const flow = authorize({
		clientFile,
		credentialsFile: config.credentialsFile,
		timeoutMs: 80,
		onReady: (value) => {
			ready = value;
		},
	});
	await assert.rejects(flow, /timed out/);
	const url = new URL(ready.authorizationUrl);
	assert.equal(url.searchParams.get("scope"), READONLY_SCOPE);
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.equal(url.searchParams.get("include_granted_scopes"), "false");
	await assert.rejects(fetch(`${ready.callbackOrigin}/oauth2callback`));
});

const site = { name: "example", property: "sc-domain:example.com", brandTerms: ["example"] };
const row = (keys, clicks = 1, impressions = 100, position = 8) => ({
	keys,
	clicks,
	impressions,
	ctr: clicks / impressions,
	position,
});
const day = (date, queries = [], pages = [], totals = [row([], 10, 1000)]) => ({
	version: 1,
	property: site.property,
	date,
	type: "web",
	dataState: "final",
	queries: { rows: queries, hitRowCap: false },
	pages: { rows: pages, hitRowCap: false },
	totals: { rows: totals },
});
const fixture = async (t) => {
	const path = await mkdtemp(join(tmpdir(), "gsc-seo-test-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return {
		version: 1,
		dataDir: join(path, "data"),
		credentialsFile: join(path, "missing-key.json"),
		sites: [site],
	};
};

void test("uses readonly scope and handles PT dates across UTC boundaries and DST", () => {
	assert.equal(READONLY_SCOPE, "https://www.googleapis.com/auth/webmasters.readonly");
	assert.equal(pacificDate(new Date("2026-11-13T03:00:00Z")), "2026-11-12");
	assert.equal(shiftDate("2026-03-08", 1), "2026-03-09");
	assert.throws(() => assertDate("2026-02-30"));
	assert.throws(() => assertDate("../../key"));
});

void test("rejects URL property escapes and preserves locale URLs", () => {
	assert.equal(validateProperty(site.property), site.property);
	assert.throws(() => validateProperty("https://example.com"));
	assert.throws(() => validateProperty("https://user:secret@example.com/"));
	assert.equal(
		assertInspectionUrl(site.property, "https://example.com/?lang=fr"),
		"https://example.com/?lang=fr",
	);
	assert.equal(
		assertInspectionUrl(site.property, "https://sub.example.com/a"),
		"https://sub.example.com/a",
	);
	assert.throws(() => assertInspectionUrl(site.property, "https://example.com.evil.test/a"));
	assert.throws(() =>
		assertInspectionUrl("https://example.com/docs/", "https://example.com/docsevil/"),
	);
});

void test("weights CTR and average position by impressions, never averages daily CTR", () => {
	assert.deepEqual(aggregate([row([], 1, 10, 2), row([], 9, 90, 12)]), {
		clicks: 10,
		impressions: 100,
		ctr: 0.1,
		position: 11,
	});
	assert.equal(aggregate([]).position, null);
	assert.equal(
		groupRows([
			row(["q", "https://example.com/"], 1),
			row(["q", "https://example.com/?lang=fr"], 2),
		]).length,
		2,
	);
});

void test("pagination advances offsets and flags the documented cap", async () => {
	const offsets = [];
	const client = {
		query: async (_property, body) => {
			offsets.push(body.startRow);
			return { rows: Array.from({ length: body.startRow < 4 ? 2 : 0 }, () => row(["q", "p"])) };
		},
	};
	assert.equal(
		(
			await queryAll(
				client,
				site.property,
				{ dimensions: ["query", "page"] },
				{ pageSize: 2, maxRows: 6 },
			)
		).rows.length,
		4,
	);
	assert.deepEqual(offsets, [0, 2, 4]);
	assert.equal(
		(await queryAll(client, site.property, {}, { pageSize: 2, maxRows: 4 })).hitRowCap,
		true,
	);
});

void test("permission errors are not retried or leaked, transient quota errors are bounded", async () => {
	let attempts = 0;
	const auth = {
		getRequestHeaders: async () => new Headers({ authorization: "Bearer private-token" }),
	};
	const denied = new GscClient(auth, {
		fetchImpl: async () => {
			attempts++;
			return new Response("private response", { status: 403 });
		},
	});
	await assert.rejects(denied.sites(), /GSC HTTP 403/);
	assert.equal(attempts, 1);
	const waits = [];
	attempts = 0;
	const retry = new GscClient(auth, {
		fetchImpl: async () =>
			++attempts < 3 ? new Response("", { status: 429 }) : Response.json({ siteEntry: [] }),
		sleep: async (ms) => waits.push(ms),
	});
	assert.deepEqual(await retry.sites(), { siteEntry: [] });
	assert.deepEqual(waits, [1000, 2000]);
	const broken = new GscClient({
		getRequestHeaders: async () => {
			throw new Error("private-token");
		},
	});
	await assert.rejects(broken.sites(), (error) => !error.message.includes("private-token"));
	await assert.rejects(retry.request("https://evil.test/"), /Only read-only/);
});

void test("sync is resumable, totals are separate, and interrupted days are not committed", async (t) => {
	const config = await fixture(t);
	const today = pacificDate();
	const end = shiftDate(today, -3);
	let calls = 0;
	const client = {
		query: async (_property, body) => {
			calls++;
			if (body.dimensions[0] === "date") return { rows: [row([end])] };
			if (body.dimensions.length === 0) return { rows: [row([], 20, 2000)] };
			return {
				rows: [
					row(
						body.dimensions.length === 1
							? ["https://example.com/"]
							: ["keyword", "https://example.com/"],
					),
				],
			};
		},
	};
	const first = await syncSite(config, site, client, { days: 2, refreshDays: 0 });
	assert.equal(first.saved, 2);
	assert.equal(calls, 7);
	const second = await syncSite(config, site, client, { days: 2, refreshDays: 0 });
	assert.equal(second.skipped, 2);
	assert.equal(calls, 8);
	const cached = JSON.parse(await readFile(dayPath(config, site, "web", end), "utf8"));
	assert.equal(cached.totals.rows[0].clicks, 20);
	assert.equal(cached.queries.rows[0].clicks, 1);
	const original = await readFile(dayPath(config, site, "web", end), "utf8");
	const failing = {
		query: async (property, body) => {
			if (body.dimensions[0] === "query") throw new Error("Failed page");
			return client.query(property, body);
		},
	};
	await assert.rejects(syncSite(config, site, failing, { days: 1 }), /Failed page/);
	assert.equal(await readFile(dayPath(config, site, "web", end), "utf8"), original);
	assert.equal((await cachedDays(config, site, "web")).length, 2);
});

void test("existing lock is not removed by another invocation", async (t) => {
	const config = await fixture(t);
	const lock = join(siteDir(config, site, "web"), "sync.lock");
	await mkdir(lock, { recursive: true });
	await writeFile(join(lock, "owner.json"), "owner");
	await assert.rejects(syncSite(config, site, {}, { days: 1 }), /sync lock exists/);
	assert.equal(await readFile(join(lock, "owner.json"), "utf8"), "owner");
});

void test("no finalized data or a future end cannot create false daily zeros", async (t) => {
	const config = await fixture(t);
	await assert.rejects(
		syncSite(config, site, { query: async () => ({}) }, { days: 1 }),
		/No finalized/,
	);
	await assert.rejects(
		syncSite(
			config,
			site,
			{ query: async () => ({ rows: [row([shiftDate(pacificDate(), -3)])] }) },
			{ days: 1, end: pacificDate() },
		),
		/newer/,
	);
	assert.deepEqual(await cachedDays(config, site, "web"), []);
});

void test("brand exclusion is literal and reports do not sum query rows into site totals", () => {
	assert.equal(isBrand("EXAMPLE image", ["example"]), true);
	assert.equal(isBrand("other", ["."]), false);
	const current = day(
		"2026-10-02",
		[row(["example", "home"], 30), row(["editor", "a"], 1, 500), row(["editor", "b"], 2, 400)],
		[row(["a"], 5)],
		[row([], 100, 3000)],
	);
	const previous = day("2026-10-01", [], [row(["a"], 20)]);
	const result = analyze([current], [previous], { brandTerms: ["example"] });
	assert.equal(result.totals.current.clicks, 100);
	assert.equal(result.opportunities.length, 2);
	assert.equal(result.overlap.length, 1);
	assert.equal(result.pageDeclines[0].clicksChange, -15);
});

void test("missing dates suppress misleading period comparisons and exact URL filtering preserves languages", async (t) => {
	const config = await fixture(t);
	const end = shiftDate(pacificDate(), -3);
	await writeJson(
		dayPath(config, site, "web", end),
		day(end, [
			row(["editor", "https://example.com/?lang=fr"]),
			row(["editor", "https://example.com/"]),
		]),
	);
	const result = await report(config, site, { days: 2, end });
	assert.equal(result.comparisonComplete, false);
	assert.equal(result.totals.comparisonSuppressed, true);
	assert.deepEqual(result.pageDeclines, []);
	assert.equal(result.previous.missingDates.length, 2);
	assert.match(markdownReport(result), /停止计算/);
	const queried = await queryCache(config, site, {
		start: end,
		end,
		page: "https://example.com/?lang=fr",
	});
	assert.equal(queried.rows.length, 1);
	await writeJson(dayPath(config, site, "web", end), {
		...day(end),
		property: "sc-domain:other.com",
	});
	await assert.rejects(loadRange(config, site, "web", end, end), /identity mismatch/);
});

void test("real MCP stdio handshake, tool schema and cached report work without credentials", async (t) => {
	const config = await fixture(t);
	const path = join(config.dataDir, "config.json");
	await writeJson(path, config);
	const end = shiftDate(pacificDate(), -3);
	await writeJson(dayPath(config, site, "web", end), day(end));
	await writeJson(dayPath(config, site, "web", shiftDate(end, -1)), day(shiftDate(end, -1)));
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [fileURLToPath(new URL("../src/mcp.mjs", import.meta.url))],
		env: { ...process.env, GSC_CONFIG: path },
		stderr: "pipe",
	});
	const client = new Client({ name: "gsc-regression", version: "1.0" });
	t.after(async () => {
		await client.close();
	});
	await client.connect(transport);
	const tools = await client.listTools();
	assert.equal(tools.tools.length, 6);
	assert.equal(
		tools.tools.find((tool) => tool.name === "gsc_sync").annotations.readOnlyHint,
		false,
	);
	const status = await client.callTool({ name: "gsc_status", arguments: {} });
	assert.equal(JSON.parse(status.content[0].text).sites[0].property, site.property);
	const result = await client.callTool({ name: "gsc_report", arguments: { days: 1, end } });
	assert.equal(JSON.parse(result.content[0].text).comparisonComplete, true);
	const denied = await client.callTool({
		name: "gsc_report",
		arguments: { site: "not-configured" },
	});
	assert.equal(denied.isError, true);
});

void test("CLI rejects unknown options and displays help without needing secrets", async () => {
	const run = (args) =>
		new Promise((resolve) => {
			const child = spawn(
				process.execPath,
				[fileURLToPath(new URL("../src/cli.mjs", import.meta.url)), ...args],
				{ windowsHide: true },
			);
			let output = "";
			child.stdout.on("data", (data) => (output += data));
			child.stderr.on("data", (data) => (output += data));
			child.on("close", (code) => resolve({ code, output }));
		});
	assert.match((await run(["help"])).output, /Read-only/);
	assert.equal((await run(["sync", "--typo", "1"])).code, 1);
});
