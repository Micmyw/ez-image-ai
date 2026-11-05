import { createRequire } from "node:module";
import path from "node:path";

// Render the actual account result/history components inside the loaded public
// page's CSS, with local data, network and Next navigation boundaries.
export async function buildChristmasResultPreview(app) {
	const appRequire = createRequire(path.join(app, "package.json"));
	const vitestRequire = createRequire(appRequire.resolve("vitest/package.json"));
	const viteRequire = createRequire(vitestRequire.resolve("vite/package.json"));
	const { build, stop } = viteRequire("esbuild");
	const job = {
		id: "local-visual-check",
		productKey: "image-nano-banana-2-lite",
		skuKey: "nano-banana-2-lite-1k",
		aspectRatio: "9:16",
		status: "RESERVED",
		inputReferenceState: "VERIFYING",
		input: { kind: "image-to-image" },
		inputAssets: [],
		assets: [],
		outputCount: 0,
		creditsReserved: "5",
		creditsCharged: "0",
		creditsReleased: "0",
		canCancel: true,
		canRetry: false,
		createdAt: "2026-11-05T00:00:00Z",
		updatedAt: "2026-11-05T00:00:00Z",
	};
	const jobs = [
		job,
		{
			...job,
			id: "local-history-check",
			status: "SUCCEEDED",
			inputReferenceState: null,
			outputCount: 1,
		},
	];
	const mocks = {
		"use-job": `export const useJob = () => ({ data: ${JSON.stringify(job)}, refetch: async () => {} });`,
		"use-job-history": `export const useJobHistory = () => ({ data: { pages: [{ items: ${JSON.stringify(jobs)} }] } });`,
		"@shared/lib/orpc-client": `export const orpcClient = { media: { cancelGeneration: async () => {} } };`,
		"@shared/lib/growth-analytics": `export const saasGrowthFunnel = { generationSucceeded: async () => {}, generationFailed: async () => {} };`,
		"next/link": `export default function Link({ children, href, ...props }) { return <a href={href} {...props}>{children}</a>; }`,
		"next/navigation": `export const useRouter = () => ({ push() {}, replace() {}, prefetch() {} }); export const usePathname = () => "/christmas-wallpaper"; export const useSearchParams = () => new URLSearchParams();`,
		"next/dynamic": `export default function dynamic() { return () => null; }`,
	};
	try {
		const result = await build({
			stdin: {
				contents: `
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { EditorResultPanel } from "./modules/media/components/editor/EditorResultPanel";
import { RecentJobQueue } from "./modules/media/components/RecentJobQueue";
import marketing from "../../packages/i18n/translations/en/marketing.json";
import saas from "../../packages/i18n/translations/en/saas.json";
createRoot(document.getElementById("christmas-account-fixture")).render(
  <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ ...marketing, ...saas }}>
    <div id="current-editor-result"><EditorResultPanel jobId="local-visual-check" onNew={() => {}} /></div>
    <div className="mt-5"><RecentJobQueue selectedJobId="local-visual-check" onSelect={() => {}} /></div>
  </NextIntlClientProvider>
);`,
				loader: "tsx",
				resolveDir: app,
			},
			bundle: true,
			write: false,
			format: "iife",
			platform: "browser",
			jsx: "automatic",
			loader: { ".css": "empty" },
			define: { "process.env.NODE_ENV": '"production"' },
			nodePaths: [path.join(app, "node_modules")],
			plugins: [
				{
					name: "christmas-preview-data",
					setup(plugin) {
						plugin.onResolve({ filter: /.*/ }, ({ path: importPath }) => {
							const key = Object.hasOwn(mocks, importPath)
								? importPath
								: importPath.split("/").at(-1);
							return Object.hasOwn(mocks, key)
								? { path: key, namespace: "visual-fixture" }
								: undefined;
						});
						plugin.onLoad({ filter: /.*/, namespace: "visual-fixture" }, ({ path: mock }) => ({
							contents: mocks[mock],
							loader: "tsx",
							resolveDir: app,
						}));
					},
				},
			],
		});
		return result.outputFiles[0].text;
	} finally {
		stop();
	}
}
