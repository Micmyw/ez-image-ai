/** Actual React components with local API/storage fixtures; no database or provider calls. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const app = path.join(repo, "apps/saas");
const appRequire = createRequire(path.join(app, "package.json"));
const viteRequire = createRequire(
	createRequire(appRequire.resolve("vitest/package.json")).resolve("vite/package.json"),
);
const { build, stop } = viteRequire("esbuild");
const { chromium, expect } = appRequire("@playwright/test");
const directory = path.join(repo, ".cache/video-template-workspace-regression");
await mkdir(directory, { recursive: true });
await writeFile(
	path.join(directory, "process.json"),
	JSON.stringify({
		rootPid: process.pid,
		launcherPid: process.ppid,
		startedAt: new Date().toISOString(),
	}),
);
const messages = JSON.parse(
	await readFile(path.join(repo, "packages/i18n/translations/en/video.json"), "utf8"),
).videoTemplates;
const mocks = {
	"@auth/hooks/use-session":
		'export const useSession = () => ({ user: { id: "fixture-owner", isAnonymous: false } });',
	"@payments/components/upgrade-context": "export const useUpgrade = () => null;",
	"@payments/lib/upgrade-selection":
		'export const defaultUpgradeSelection = {}; export const upgradeHref = () => "/unused";',
	"@shared/lib/orpc-client": "export const orpcClient = { videoTemplates: window.fixture.api };",
	"payment-return": "export const saveVideoEffectPaymentReturn = () => {};",
	"next-intl": `const messages = ${JSON.stringify(messages)}; export const useTranslations = () => (key, values = {}) => { const text = key.split('.').reduce((value, part) => value?.[part], messages) ?? key; return Object.entries(values).reduce((text, [key, value]) => text.replaceAll("{" + key + "}", String(value)), text); };`,
	"next/link": "export default function Link(props) { return <a {...props} />; }",
	"next/image":
		"export default function Image({fill,priority,unoptimized,...props}) { return <img {...props} />; }",
	TemplatePreview:
		"export const TemplatePreviewProvider = ({children}) => children; export const TemplatePreview = () => null;",
	TemplateJob:
		"export const TemplateJob = () => <div>Fixture job accepted</div>; export const TemplateHistory = () => null;",
};
let browser;
let server;
try {
	const bundle = await build({
		stdin: {
			contents: `
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TemplateWorkspace } from "./modules/video-templates/components/TemplateWorkspace";
import { getVideoTemplate, sourceTemplateDefaults } from "@repo/config/video-template-library";
import { sourceTemplatePriceKey } from "@repo/config/video-template-display-pricing";
const choices = sourceTemplateDefaults("58th-floor");
window.fixture.prices = { [sourceTemplatePriceKey(choices)]: "123", [sourceTemplatePriceKey({...choices, resolution: "2K"})]: "246" };
createRoot(document.getElementById("root")).render(<QueryClientProvider client={new QueryClient()}><TemplateWorkspace template={getVideoTemplate("58th-floor")} /></QueryClientProvider>);
`,
			loader: "tsx",
			resolveDir: app,
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
				name: "local-fixtures",
				setup(plugin) {
					plugin.onResolve({ filter: /.*/ }, ({ path: imported }) => {
						const key = Object.hasOwn(mocks, imported) ? imported : imported.split("/").at(-1);
						return Object.hasOwn(mocks, key) ? { path: key, namespace: "fixture" } : undefined;
					});
					plugin.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path: key }) => ({
						contents: mocks[key],
						loader: "tsx",
						resolveDir: app,
					}));
				},
			},
		],
	});
	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
		"base64",
	);
	const css = await readFile(path.join(app, "modules/video-templates/video-templates.css"), "utf8");
	server = createServer((request, response) => {
		if (request.url === "/app.js") {
			response.setHeader("Content-Type", "text/javascript");
			response.end(bundle.outputFiles[0].text);
		} else if (request.url === "/photo.png") {
			response.setHeader("Content-Type", "image/png");
			response.end(png);
		} else if (request.method === "PUT") {
			request.resume();
			request.on("end", () => response.end());
		} else {
			response.setHeader("Content-Type", "text/html");
			response.end(
				`<html><head><style>:root{--foreground:white;--background:#17131f;--primary:#8855dd;--muted-foreground:#c7bfd4}body{background:#17131f;color:white;font:16px system-ui;margin:24px}${css}</style></head><body><main class="vt-page"><div id="root"></div></main><script type="module" src="/app.js"></script></body></html>`,
			);
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/*", (route) =>
		route.request().url().startsWith(origin) ? route.continue() : route.abort(),
	);
	await page.addInitScript(() => {
		const calls = { access: 0, previews: [], quotes: [], creates: [], uploads: 0 };
		const pending = {};
		window.fixture = { calls, pending, prices: {}, changedPrice: null, failCreate: false };
		window.fixture.api = {
			access: async () => {
				calls.access++;
				return {
					available: true,
					maximumInputBytes: 10000000,
					pricing: { version: 1, creditsByOptions: window.fixture.prices },
				};
			},
			uploads: {
				create: async () => {
					const sessionId = `session-${++calls.uploads}`;
					return { sessionId, uploadUrl: `/upload/${sessionId}` };
				},
				complete: ({ sessionId }) =>
					new Promise((resolve) => {
						pending[sessionId] = () => resolve({ assetId: `photo-${sessionId}` });
					}),
			},
			inputs: {
				get: async ({ assetId }) => {
					calls.previews.push(assetId);
					return {
						assetId,
						previewUrl: "/photo.png",
						previewExpiresAt: new Date(Date.now() + 300000).toISOString(),
					};
				},
			},
			quote: async (request) => {
				calls.quotes.push(request);
				return {
					quoteId: "fixture-quote",
					credits:
						window.fixture.changedPrice ?? (request.options.resolution === "2K" ? "246" : "123"),
					expiresAt: new Date(Date.now() + 600000).toISOString(),
				};
			},
			jobs: {
				create: async (input) => {
					calls.creates.push(input);
					if (window.fixture.failCreate) throw new Error("NETWORK_UNKNOWN");
					return { jobId: "fixture-job" };
				},
			},
		};
	});
	await page.goto(origin);
	await expect(page.locator(".vt-credit-price")).toHaveText("123 credits");
	await page.locator("#vt-resolution").selectOption("2K");
	await expect(page.locator(".vt-credit-price")).toHaveText("246 credits");
	await page.locator("#vt-resolution").selectOption("768P");
	assert.deepEqual(
		await page.evaluate(() => [window.fixture.calls.access, window.fixture.calls.quotes.length]),
		[1, 0],
	);
	const upload = (index) =>
		page
			.locator('input[type="file"]')
			.nth(index)
			.setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: png });
	await upload(0);
	await expect(page.locator(".vt-upload img").first()).toHaveAttribute("src", /^blob:/);
	await expect(page.locator('input[type="file"]').nth(1)).toBeEnabled();
	await upload(1);
	await page.waitForFunction(() => Object.keys(window.fixture.pending).length === 2);
	await page.evaluate(() => Object.values(window.fixture.pending).forEach((resolve) => resolve()));
	await expect(page.getByRole("button", { name: "Create for 123 credits" })).toBeEnabled();
	assert.equal(await page.locator('.vt-upload img[src^="blob:"]').count(), 2);
	assert.equal(await page.evaluate(() => window.fixture.calls.previews.length), 0);
	await page.screenshot({ path: path.join(directory, "ready.png"), fullPage: true });
	await page.getByRole("button", { name: "Create for 123 credits" }).click();
	await expect(page.getByText("Fixture job accepted")).toBeVisible();
	assert.deepEqual(
		await page.evaluate(() => [
			window.fixture.calls.quotes.length,
			window.fixture.calls.creates.length,
		]),
		[1, 1],
	);
	// Restored private originals load once; a price change requires deliberate confirmation.
	await page.reload();
	await expect(page.locator(".vt-upload img")).toHaveCount(2);
	assert.equal(await page.evaluate(() => window.fixture.calls.previews.length), 2);
	await page.evaluate(() => {
		window.fixture.changedPrice = "150";
		window.fixture.failCreate = true;
	});
	await page.getByRole("button", { name: "Create for 123 credits" }).click();
	await expect(page.getByRole("alert")).toContainText("The price has changed");
	assert.equal(await page.evaluate(() => window.fixture.calls.creates.length), 0);
	await page.getByRole("button", { name: "Create for 150 credits" }).click();
	await expect(page.getByRole("button", { name: messages.recover })).toBeEnabled();
	const firstKey = await page.evaluate(() => window.fixture.calls.creates[0].idempotencyKey);
	await page.reload();
	await page.evaluate(() => {
		window.fixture.failCreate = false;
	});
	await page.getByRole("button", { name: messages.recover }).click();
	await expect(page.getByText("Fixture job accepted")).toBeVisible();
	assert.equal(await page.evaluate(() => window.fixture.calls.creates[0].idempotencyKey), firstKey);
	assert.equal(await page.evaluate(() => window.fixture.calls.quotes.length), 0);
	assert.deepEqual(errors, []);
	const report = {
		passed: true,
		checks: [
			"instant cached price",
			"parallel upload slots",
			"local thumbnails survive upload without preview reads",
			"one-click quote and submit",
			"restored pending photo preview",
			"changed price confirmation",
			"same-key recovery after reload",
		],
		realGeneration: false,
	};
	await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report));
} finally {
	await browser?.close();
	if (server)
		await new Promise((resolve) => {
			server.close(resolve);
			server.closeAllConnections();
		});
	stop();
	await writeFile(
		path.join(directory, "process.json"),
		JSON.stringify({ rootPid: process.pid, stoppedAt: new Date().toISOString() }),
	);
}
