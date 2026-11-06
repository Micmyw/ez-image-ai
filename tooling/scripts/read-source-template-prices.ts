import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const models = new Set([
	"seedance-2-mini",
	"seedance-2-fast",
	"seedance-2",
	"seedance-2-5",
	"hotel-lobby-ai",
	"nsfw-filter-2",
	"video-nsfw-filter",
]);

/** Read-only provider price discovery. No generation, quote, moderation or account mutation. */
export async function readSourceTemplatePrices(apiKey: string, request: typeof fetch = fetch) {
	if (!apiKey.trim()) throw new Error("SOURCE_TEMPLATE_PRICE_READ_KEY_REQUIRED");
	const prices: unknown[] = [];
	let cursor: string | undefined;
	const seen = new Set<string>();
	for (let page = 0; page < 20; page++) {
		const url = new URL("https://api.seeapi.com/v1/prices");
		url.searchParams.set("provider", "seeapi");
		url.searchParams.set("limit", "200");
		if (cursor) url.searchParams.set("cursor", cursor);
		const response = await request(url, {
			method: "GET",
			redirect: "error",
			signal: AbortSignal.timeout(20_000),
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (!response.ok) throw new Error(`SOURCE_TEMPLATE_PRICE_READ_HTTP_${response.status}`);
		const body = (await response.json()) as {
			data?: Array<{
				model?: string;
				model_name?: string;
				endpoint?: string;
				provider?: { id?: string };
				pricing?: unknown;
			}>;
			next_cursor?: string | null;
		};
		if (!Array.isArray(body.data)) throw new Error("SOURCE_TEMPLATE_PRICE_RESPONSE_INVALID");
		for (const entry of body.data)
			if (entry.model && models.has(entry.model) && entry.provider?.id === "seeapi") {
				prices.push({
					model: entry.model,
					endpoint: entry.endpoint,
					provider: "seeapi",
					pricing: entry.pricing,
				});
			}
		if (body.next_cursor === null)
			return {
				observedAt: new Date().toISOString(),
				source: "https://api.seeapi.com/v1/prices",
				prices,
			};
		if (!body.next_cursor || seen.has(body.next_cursor))
			throw new Error("SOURCE_TEMPLATE_PRICE_PAGINATION_INVALID");
		seen.add(body.next_cursor);
		cursor = body.next_cursor;
	}
	throw new Error("SOURCE_TEMPLATE_PRICE_PAGINATION_LIMIT");
}

async function main() {
	const path = process.argv[2] ?? ".env.local";
	try {
		const environment = parseEnv(await readFile(resolve(path), "utf8"));
		const result = await readSourceTemplatePrices(
			environment.SEEAPI_API_KEY ?? environment.seeapi_api_key ?? "",
		);
		// Only public model identities and numeric pricing rules, never credentials or response headers.
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} catch (error) {
		const message =
			error instanceof Error && /^SOURCE_TEMPLATE_PRICE_[A-Z_0-9]+$/.test(error.message)
				? error.message
				: "SOURCE_TEMPLATE_PRICE_READ_FAILED";
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	}
}

if (/[\\/]read-source-template-prices\.[cm]?[jt]s$/.test(process.argv[1] ?? "")) void main();
