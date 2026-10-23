/** Actual pricing/result components and experiment hook in fresh Chromium; loopback fixtures only. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const app = path.join(repo, "apps/saas");
const require = createRequire(path.join(app, "package.json"));
const vite = createRequire(
	createRequire(require.resolve("vitest/package.json")).resolve("vite/package.json"),
);
const { build, stop } = vite("esbuild");
const { chromium, expect } = require("@playwright/test");
const out = path.join(repo, ".cache/conversion-experiments");
await mkdir(out, { recursive: true });
const messages = require(path.join(repo, "packages/i18n/translations/en/shared.json"));
const stubs = {
	"next-intl": `const messages=${JSON.stringify(messages)}; export const useLocale=()=>"en"; export const useTranslations=(ns="")=>(key,values={})=>{let value=(ns?ns+".":"")+key;let found=value.split('.').reduce((v,k)=>v?.[k],messages);return typeof found==='string'?found.replace(/\\{([^}]+)\\}/g,(_,k)=>values[k]??k):value;};`,
	"next/link": `export default function Link(props){return <a {...props} />;}`,
	"next/dynamic": `export default ()=>()=>null;`,
	CreditPackCheckoutActions: `export const CreditPackPaymentOptions=()=>null;export const CreditPackCheckoutActions=()=>null;`,
	"@repo/ui/components/button": `export const Button=({children,render,variant,...props})=>render?render({children,...props}):<button {...props}>{children}</button>;`,
	"cookie-consent": `import {useSyncExternalStore} from 'react';const subscribe=fn=>{window.addEventListener('consent-fixture',fn);return()=>window.removeEventListener('consent-fixture',fn)};export const useCookieConsent=()=>({analyticsAllowed:useSyncExternalStore(subscribe,()=>window.__allowed,()=>false)});`,
};
const bundle = await build({
	stdin: {
		resolveDir: app,
		loader: "tsx",
		contents: `
import {useState} from 'react';import {createRoot} from 'react-dom/client';
import {PublicPricingPlans} from './modules/payments/components/PublicPricingPlans';
import {ResultPurchaseGuide} from './modules/payments/components/ResultPurchaseGuide';
import {UpgradeContext} from './modules/payments/components/upgrade-context';
import {growthExperimentVariant} from '@repo/config/growth-experiments';
import {invalidatePendingBrowserGrowthAnalytics} from '@repo/utils/lib/growth-analytics-browser';
window.__variant=growthExperimentVariant;
window.__setConsent=allowed=>{window.__allowed=allowed;document.cookie='consent='+allowed+'; Path=/';document.cookie='consent_version=2; Path=/';if(!allowed)invalidatePendingBrowserGrowthAnalytics();window.dispatchEvent(new Event('consent-fixture'));};
function Fixture(){const [shown,setShown]=useState(false);const q=new URLSearchParams(location.search);return <>
<button onClick={()=>setShown(true)}>Show loaded result</button>
{q.get('hidden')&&<div style={{height:2000}} />}
<UpgradeContext.Provider value={selection=>window.__selection=selection}>
<PublicPricingPlans locale="en" initialView={q.get('explicit')||undefined} />
</UpgradeContext.Provider>
{shown&&<ResultPurchaseGuide />}</>;}
createRoot(document.getElementById('root')).render(<Fixture />);`,
	},
	bundle: true,
	write: false,
	platform: "browser",
	format: "esm",
	jsx: "automatic",
	define: { "process.env.NODE_ENV": '"production"' },
	nodePaths: [path.join(app, "node_modules"), path.join(repo, "node_modules")],
	plugins: [
		{
			name: "local-boundaries",
			setup(plugin) {
				plugin.onResolve({ filter: /.*/ }, (args) => {
					const key = Object.hasOwn(stubs, args.path)
						? args.path
						: Object.hasOwn(stubs, args.path.split("/").at(-1))
							? args.path.split("/").at(-1)
							: null;
					return key ? { path: key, namespace: "fixture" } : undefined;
				});
				plugin.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
					contents: stubs[args.path],
					loader: "tsx",
					resolveDir: app,
				}));
			},
		},
	],
});
let browserServer, browser, server;
const report = {
	scope:
		"Actual React pricing/result guide, assignment, consent and event transport; mocked HTTP acceptance. No production/payment/provider calls.",
	harnessPid: process.pid,
	cases: [],
	completed: false,
};
try {
	server = createServer(async (req, res) => {
		if (req.url === "/app.js")
			return res
				.writeHead(200, { "Content-Type": "text/javascript" })
				.end(bundle.outputFiles[0].text);
		if (req.url === "/api/analytics/events") {
			let raw = "";
			for await (const part of req) raw += part;
			JSON.parse(raw);
			return res.writeHead(200, { "Content-Type": "application/json" }).end('{"accepted":true}');
		}
		res
			.writeHead(200, { "Content-Type": "text/html" })
			.end(
				`<!doctype html><html><meta charset="utf-8"><style>body{font:16px system-ui;margin:20px}button,a{margin:6px} .h-px{height:1px} [hidden]{display:none} [data-test=public-pricing-plans]{max-width:900px} article{border:1px solid #ddd;padding:12px;margin:12px}</style><div id="root"></div><script>window.__allowed=false;window.__events=[];window.addEventListener('ezpic:growth-event',e=>window.__events.push(e.detail));</script><script type="module" src="/app.js"></script></html>`,
			);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	browserServer = await chromium.launchServer({ headless: true });
	report.browserRootPid = browserServer.process().pid;
	await writeFile(
		path.join(out, "processes.json"),
		JSON.stringify(
			{ harnessPid: process.pid, browserRootPid: report.browserRootPid, origin },
			null,
			2,
		),
	);
	browser = await chromium.connect(browserServer.wsEndpoint());
	const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto(origin);
	const pricing = page.locator('[data-test="public-pricing-plans"]');
	await pricing.waitFor();
	await page.evaluate(() => window.__setConsent(false));
	await expect(page.locator('[data-test="public-pricing-interval-year"]')).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	assert.equal(await page.evaluate(() => window.__events.length), 0);
	assert.ok(!(await context.cookies()).some((c) => c.name === "ezpic_analytics_session"));
	report.cases.push("no consent: original annual UI, no tracking identity or exposure");
	const hashes = await page.evaluate(() => {
		const found = {};
		for (let i = 0; i < 100; i++) {
			const hash = "sha256:" + i.toString(16).padStart(64, "0");
			const a = window.__variant("pricing-default-v1", hash);
			const b = window.__variant("result-purchase-v1", hash);
			found[a] ??= hash;
			found[b] ??= hash;
		}
		return found;
	});
	async function load(hash, query = "", allowed = true) {
		await context.clearCookies();
		await context.addCookies([
			{ name: "ezpic_analytics_session", value: hash, url: origin },
			{ name: "consent", value: String(allowed), url: origin },
			{ name: "consent_version", value: "2", url: origin },
		]);
		await page.goto(origin + query);
		await pricing.waitFor();
		await page.evaluate((allow) => window.__setConsent(allow), allowed);
	}
	for (const arm of ["annual", "monthly"]) {
		await load(hashes[arm]);
		await expect(
			page.locator(`[data-test="public-pricing-interval-${arm === "monthly" ? "month" : "year"}"]`),
		).toHaveAttribute("aria-pressed", "true");
		await expect
			.poll(() => page.evaluate(() => window.__events.some((e) => e.name === "experiment_exposed")))
			.toBe(true);
		const choose = pricing.getByRole("link", { name: "Choose Pro", exact: true });
		await choose.click();
		await expect
			.poll(() => page.evaluate(() => window.__selection?.interval))
			.toBe(arm === "monthly" ? "month" : "year");
		await expect
			.poll(() => page.evaluate(() => window.__events.some((e) => e.name === "experiment_clicked")))
			.toBe(true);
		await page.reload();
		await pricing.waitFor();
		await page.evaluate(() => window.__setConsent(true));
		await expect(
			page.locator(`[data-test="public-pricing-interval-${arm === "monthly" ? "month" : "year"}"]`),
		).toHaveAttribute("aria-pressed", "true");
	}
	report.cases.push(
		"stable annual/monthly variants; chosen interval passed into upgrade; repeat visit stable",
	);
	await load(hashes.monthly, "?explicit=year");
	await expect(page.locator('[data-test="public-pricing-interval-year"]')).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	assert.equal(
		await page.evaluate(() => window.__events.filter((e) => e.properties.experiment).length),
		0,
	);
	await load(hashes.monthly, "", false);
	await page.locator('[data-test="public-pricing-interval-year"]').click();
	await page.evaluate(() => window.__setConsent(true));
	await expect(page.locator('[data-test="public-pricing-interval-year"]')).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	assert.equal(
		await page.evaluate(() => window.__events.filter((e) => e.properties.experiment).length),
		0,
	);
	report.cases.push(
		"explicit URL interval and interaction before assignment override the experiment",
	);
	await load(hashes.monthly, "?hidden=1");
	await expect(page.locator('[data-test="public-pricing-interval-month"]')).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	assert.equal(
		await page.evaluate(
			() => window.__events.filter((e) => e.name === "experiment_exposed").length,
		),
		0,
	);
	await pricing.scrollIntoViewIfNeeded();
	await expect
		.poll(() =>
			page.evaluate(() => window.__events.filter((e) => e.name === "experiment_exposed").length),
		)
		.toBe(1);
	await page.evaluate(() => window.__setConsent(false));
	const before = await page.evaluate(() => window.__events.length);
	await pricing.getByRole("link", { name: "Choose Pro", exact: true }).click();
	assert.equal(await page.evaluate(() => window.__events.length), before);
	report.cases.push(
		"hidden pricing has no exposure; visibility records it; withdrawal stops observations without disabling purchase",
	);
	for (const arm of ["control", "guide"]) {
		await load(hashes[arm]);
		assert.equal(await page.locator('[data-test="result-purchase-experiment"]').count(), 0);
		await page.getByRole("button", { name: "Show loaded result" }).click();
		const result = page.locator('[data-test="result-purchase-experiment"]');
		await result.scrollIntoViewIfNeeded();
		await expect
			.poll(() =>
				page.evaluate(() =>
					window.__events.some(
						(e) =>
							e.name === "experiment_exposed" &&
							e.properties.experiment?.experimentId === "result-purchase-v1",
					),
				),
			)
			.toBe(true);
		const link = result.getByRole("link", { name: "Compare plans and credits" });
		await expect(link).toHaveCount(arm === "guide" ? 1 : 0);
		if (arm === "guide") {
			await expect(link).toHaveAttribute("href", "/pricing");
			await link.click({ modifiers: ["Control"] });
		}
	}
	report.cases.push(
		"result control/guide both record eligible visible exposure, guide opens pricing without claiming paid model rights",
	);
	await page.screenshot({ path: path.join(out, "result-guide.png"), fullPage: true });
	assert.deepEqual(errors, []);
	report.completed = true;
	await context.close();
} catch (error) {
	report.failure = error.stack;
	process.exitCode = 1;
	console.error(error);
} finally {
	let tree = [];
	if (browserServer && process.platform === "win32") {
		const script = `$items=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId);$owned=@(${browserServer.process().pid});for($i=0;$i -lt $owned.Count;$i++){$owned+=@($items|Where-Object{$_.ParentProcessId -eq $owned[$i]}|ForEach-Object{[int]$_.ProcessId})};ConvertTo-Json -InputObject $owned -Compress`;
		tree = JSON.parse(
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
	const alive = tree.filter((pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	});
	report.cleanup = { browserProcesses: tree, stillAlive: alive, serverClosed: !server?.listening };
	if (alive.length) {
		report.completed = false;
		process.exitCode = 1;
	}
	await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report));
}
