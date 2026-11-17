import { createRequire } from "node:module";
import path from "node:path";

// Exercise actual name state, result publication and canvas export with local media.
export async function buildGtaResultPreview(app, intent = "loading-art") {
	const require = createRequire(path.join(app, "package.json"));
	const viteRequire = createRequire(
		createRequire(require.resolve("vitest/package.json")).resolve("vite/package.json"),
	);
	const { build, stop } = viteRequire("esbuild");
	const mocks = {
		"fixture-state": `
import { useSyncExternalStore } from "react";
let state = { owner: null, anonymous: false, asset: null }; const listeners = new Set();
export const read = () => state;
export const useFixture = () => useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb); }, read);
window.gtaFixture = { set(next) { state = { ...state, ...next }; listeners.forEach(cb => cb()); } };`,
		"@auth/hooks/use-session": `import { useFixture } from "fixture-state"; export const useSession = () => { const s = useFixture(); return { user: s.owner ? { id: s.owner, isAnonymous: s.anonymous } : null }; };`,
		"@shared/lib/orpc-client": `export const orpcClient = { media: { getAssetAccessUrl: async () => ({ url: "/images/gta/loading-neon-right.webp" }), getGuestAssetAccessUrl: async () => ({ url: "/images/gta/loading-neon-right.webp" }) } };`,
		"@repo/ui/components/button": `export function Button({ loading, children, ...props }) { return <button {...props}>{children}</button>; }`,
		"@media/components/editor/use-private-asset-preview": `export const usePrivateAssetPreview = () => ({ data: undefined, isError: false });`,
	};
	try {
		const result = await build({
			stdin: {
				contents: `
import { createRoot } from "react-dom/client";
import { useFixture } from "fixture-state";
import { NextIntlClientProvider } from "next-intl";
import { LoadingArtPreview } from "./modules/gta/components/LoadingArtPreview";
import { WallpaperScreenPreview } from "./modules/christmas/components/WallpaperScreenPreview";
import { WallpaperResultProvider, WallpaperResultPublisher } from "./modules/christmas/lib/wallpaper-result-context";
import { buildGtaPrompt, defaultGtaSettings } from "./modules/gta/lib/config";
import marketing from "../../packages/i18n/translations/en/marketing.json";
const intent = ${JSON.stringify(intent)};
function Fixture() { const s = useFixture(); return <NextIntlClientProvider locale="en" messages={marketing}><WallpaperResultProvider>
 {s.asset && <WallpaperResultPublisher assetId={s.asset} jobId={s.asset} prompt={buildGtaPrompt(intent, defaultGtaSettings(intent))} imageUrl="/images/gta/loading-neon-right.webp" guest={s.anonymous} watermarked={s.anonymous} />}
 {intent === "wallpaper" ? <WallpaperScreenPreview settings={{ screen: "desktop" }} styleName="Neon Boulevard" exportPrefix="gta-wallpaper" examplePlaceholder={<p>Composition guide</p>} /> : <LoadingArtPreview example={{ src: "/images/gta/loading-neon-right.webp", alt: "Neon portrait", width: 1672, height: 941 }} position="right" format="desktop" />}
 </WallpaperResultProvider></NextIntlClientProvider>; }
createRoot(document.getElementById("gta-fixture")).render(<Fixture />);`,
				resolveDir: app,
				loader: "tsx",
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
					name: "gta-local-boundaries",
					setup(plugin) {
						plugin.onResolve({ filter: /.*/ }, ({ path: name }) =>
							Object.hasOwn(mocks, name) ? { path: name, namespace: "gta-mock" } : undefined,
						);
						plugin.onLoad({ filter: /.*/, namespace: "gta-mock" }, ({ path: name }) => ({
							contents: mocks[name],
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
