import { createRequire } from "node:module";

// Next is a direct, pinned dependency. Use its JavaScript parser/printer rather
// than replacing Unicode in source text (which would corrupt tagged templates).
const { minify } = createRequire(import.meta.url)("next/dist/compiled/terser");

export function assertCompactWorker(source) {
	if (/[^\p{ASCII}]/u.test(source)) throw new Error("WORKER_SOURCE_MUST_BE_ASCII");
	if (Buffer.byteLength(source) > 34 * 1024 * 1024)
		throw new Error("WORKER_SOURCE_MEMORY_BUDGET_EXCEEDED");
}

export async function compactWorker(source, sourceMap) {
	const result = await minify(
		{ "cloudflare-worker.js": source },
		{
			module: true,
			compress: false,
			mangle: false,
			format: { ascii_only: true, comments: false },
			sourceMap: {
				...(sourceMap ? { content: sourceMap } : {}),
				filename: "cloudflare-worker.js",
				url: "cloudflare-worker.js.map",
			},
		},
	);
	if (!result.code || !result.map) throw new Error("WORKER_COMPACTION_OUTPUT_MISSING");
	assertCompactWorker(result.code);
	return { code: result.code, map: result.map };
}
