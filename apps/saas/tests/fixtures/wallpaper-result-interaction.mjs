import { createRequire } from "node:module";
import path from "node:path";

// Actual workbench, account/guest result publishers, access query and crop dialog.
// Only session, job data and network are local fixtures; no generation is submitted.
export async function buildWallpaperResultInteraction(app) {
	const appRequire = createRequire(path.join(app, "package.json"));
	const vitestRequire = createRequire(appRequire.resolve("vitest/package.json"));
	const viteRequire = createRequire(vitestRequire.resolve("vite/package.json"));
	const { build, stop } = viteRequire("esbuild");
	const mocks = {
		"fixture-state": `
import { useSyncExternalStore } from "react";
let state = { owner: "owner-1", asset: "street", phase: "ready", denied: false, expiresAt: "2099-01-01T00:00:00Z" };
const listeners = new Set();
export const read = () => state;
export const useFixture = () => useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, read);
window.wallpaperFixture = { set(next) { state = { ...state, ...next }; listeners.forEach(cb => cb()); } };
export function job(s) { return {
  id: s.asset, productKey: "image-nano-banana-2-lite", skuKey: "nano-banana-2-lite-1k", aspectRatio: "9:16",
  status: s.phase === "ready" ? "SUCCEEDED" : "RUNNING", input: { kind: "image-to-image" }, inputAssets: [{ id: "fireplace", mimeType: "image/webp" }],
  assets: s.phase === "ready" ? [{ id: s.asset, mimeType: "image/webp", contentVersion: "1", visibleUntil: s.expiresAt, preview: { url: "/images/christmas/" + s.asset + ".webp", expiresAt: s.expiresAt } }] : [],
  creditsReserved: "5", creditsCharged: "5", creditsReleased: "0", canCancel: false, canRetry: false,
  createdAt: "2026-11-05T00:00:00Z", updatedAt: "2026-11-05T00:00:01Z"
}; }`,
		"use-job": `import { useFixture, job } from "fixture-state"; export const useJob = () => { const s = useFixture(); return { data: s.owner ? job(s) : undefined, refetch: async () => ({ data: job(s) }) }; };`,
		"@auth/hooks/use-session": `import { useFixture } from "fixture-state"; export const useSession = () => { const s = useFixture(); return { user: s.owner ? { id: s.owner } : null }; };`,
		"@shared/lib/orpc-client": `import { read } from "fixture-state"; export const orpcClient = { media: { getAssetAccessUrl: async ({ assetId }) => { if (read().denied || read().owner !== "owner-1") throw Object.assign(new Error("Denied"), { code: "FORBIDDEN" }); return { url: "/images/christmas/" + assetId + ".webp", expiresAt: "2099-01-01T00:00:00Z" }; } } };`,
		"@shared/lib/growth-analytics": `export const saasGrowthFunnel = new Proxy({}, { get: () => async () => {} });`,
		"@repo/utils/lib/growth-analytics-browser": `export const trackBrowserGrowthEvent = async () => {};`,
		"@payments/components/ResultPurchaseGuide": `export const ResultPurchaseGuide = () => null;`,
		"next/link": `export default function Link({ children, href, ...props }) { return <a href={href} {...props}>{children}</a>; }`,
		"next/image": `export default function Image({ priority, ...props }) { return <img {...props} />; }`,
		"next/navigation": `export const useRouter = () => ({ push() {}, replace() {}, prefetch() {} }); export const usePathname = () => "/christmas-wallpaper"; export const useSearchParams = () => new URLSearchParams();`,
		"next/dynamic": `import { lazy, Suspense } from "react"; export default function dynamic(loader) { const C = lazy(async () => ({ default: await loader() })); return (props) => <Suspense fallback={null}><C {...props} /></Suspense>; }`,
	};
	try {
		const result = await build({
			stdin: {
				contents: `
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useFixture } from "fixture-state";
import { ChristmasWorkbench } from "./modules/christmas/components/ChristmasWorkbench";
import { useToolPromptBinding } from "./modules/media/lib/tool-prompt-context";
import { buildChristmasPrompt, DEFAULT_WALLPAPER_SETTINGS } from "./modules/christmas/lib/wallpaper";
import { EditorResultPanel } from "./modules/media/components/editor/EditorResultPanel";
import { GuestResultCard } from "./modules/media/components/guest/GuestResultCard";
import marketing from "../../packages/i18n/translations/en/marketing.json";
import saas from "../../packages/i18n/translations/en/saas.json";
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
window.wallpaperFixture.invalidate = () => queryClient.invalidateQueries({ queryKey: ["media-asset-preview"] });
function Results() {
 const s = useFixture();
 const [prompt, setPrompt] = useState(buildChristmasPrompt(DEFAULT_WALLPAPER_SETTINGS));
 useToolPromptBinding({ prompt, busy: false, applyPrompt: (next) => { setPrompt(next); return true; } });
 if (s.phase === "closed") return null;
 return s.owner ? <EditorResultPanel jobId={s.asset} onNew={() => {}} /> : <GuestResultCard view={{ state: s.phase === "ready" ? "ready" : "waiting", jobId: "guest", resultAssetId: s.asset, resultExpiresAt: s.expiresAt }} resultUrl={"/images/christmas/" + s.asset + ".webp"} onDownload={() => {}} />;
}
createRoot(document.getElementById("wallpaper-interaction-fixture")).render(
 <QueryClientProvider client={queryClient}><NextIntlClientProvider locale="en" timeZone="UTC" messages={{ ...marketing, ...saas }}>
  <ChristmasWorkbench><Results /></ChristmasWorkbench>
 </NextIntlClientProvider></QueryClientProvider>
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
					name: "wallpaper-local-boundaries",
					setup(plugin) {
						plugin.onResolve({ filter: /.*/ }, ({ path: importPath }) => {
							const key = Object.hasOwn(mocks, importPath)
								? importPath
								: importPath.split("/").at(-1);
							return Object.hasOwn(mocks, key)
								? { path: key, namespace: "wallpaper-fixture" }
								: undefined;
						});
						plugin.onLoad({ filter: /.*/, namespace: "wallpaper-fixture" }, ({ path: mock }) => ({
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
