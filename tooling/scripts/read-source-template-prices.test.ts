import assert from "node:assert/strict";
import { test } from "node:test";

import { readSourceTemplatePrices } from "./read-source-template-prices";

void test("discovers only matching SeeAPI prices through bounded read-only GETs", async () => {
	const calls: Array<{ url: URL; options: RequestInit }> = [];
	const request = async (url: URL | RequestInfo, options: RequestInit = {}) => {
		calls.push({ url: new URL(url instanceof Request ? url.url : url), options });
		return Response.json(
			calls.length === 1
				? {
						data: [
							{
								model: "seedance-2-mini",
								endpoint: "reference-to-video",
								provider: { id: "seeapi" },
								pricing: { credit: 20 },
							},
							{ model: "seedance-2-mini", provider: { id: "other" }, pricing: { credit: 999 } },
						],
						next_cursor: "next",
					}
				: {
						data: [
							{
								model: "nsfw-filter-2",
								endpoint: "image-moderation",
								provider: { id: "seeapi" },
								pricing: { credit: 0.01 },
							},
						],
						next_cursor: null,
					},
		);
	};
	const result = await readSourceTemplatePrices("fixture-key", request as typeof fetch);
	assert.equal(result.prices.length, 2);
	assert.equal(calls.length, 2);
	for (const call of calls) {
		assert.equal(call.url.origin, "https://api.seeapi.com");
		assert.equal(call.url.pathname, "/v1/prices");
		assert.equal(call.url.searchParams.get("provider"), "seeapi");
		assert.equal(call.options.method, "GET");
		assert.equal(call.options.redirect, "error");
		assert.equal(call.options.body, undefined);
	}
	assert.equal(calls[1]!.url.searchParams.get("cursor"), "next");
	assert.equal(JSON.stringify(result).includes("fixture-key"), false);
});

void test("rejects absent keys, HTTP failure, malformed pages and repeated cursors", async () => {
	await assert.rejects(
		readSourceTemplatePrices("", async () => {
			throw new Error("must not call");
		}),
		/SOURCE_TEMPLATE_PRICE_READ_KEY_REQUIRED/,
	);
	await assert.rejects(
		readSourceTemplatePrices("fixture", async () => new Response("", { status: 401 })),
		/SOURCE_TEMPLATE_PRICE_READ_HTTP_401/,
	);
	await assert.rejects(
		readSourceTemplatePrices("fixture", async () => Response.json({ data: {} })),
		/SOURCE_TEMPLATE_PRICE_RESPONSE_INVALID/,
	);
	await assert.rejects(
		readSourceTemplatePrices("fixture", async () =>
			Response.json({ data: [], next_cursor: "same" }),
		),
		/SOURCE_TEMPLATE_PRICE_PAGINATION_INVALID/,
	);
});
