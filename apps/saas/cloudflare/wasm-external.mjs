import { createRequire } from "node:module";
import path from "node:path";

/**
 * Keep compiled modules for OpenNext/Wrangler rather than Webpack's runtime loader.
 * @param {{context?: string, request?: string}} input
 * @returns {string | undefined}
 */
export function resolvePrecompiledWasmExternal({ context, request }) {
	if (!context || !request) return undefined;
	if (request.startsWith(".") && /\.wasm\?module$/.test(request))
		return path.resolve(context, request);
	if (request === "@resvg/resvg-wasm/index_bg.wasm") {
		const require = createRequire(path.join(context, "package.json"));
		return `${require.resolve(request)}?module`;
	}
	return undefined;
}
