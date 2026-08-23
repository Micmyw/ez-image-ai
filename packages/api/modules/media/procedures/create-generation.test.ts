import { describe, expect, it, vi } from "vitest";

import { buildMediaQuote } from "../lib/quote";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/jobs", () => ({ resolveDatabaseDispatchRoute: vi.fn() }));
vi.mock("@repo/logs", () => ({ logger: { warn: vi.fn() } }));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: vi.fn() } }));

import { createGenerationForUser } from "./create-generation";

describe("createGenerationForUser", () => {
	it("requires a requote before reserving credits when the frozen route graph is no longer executable", async () => {
		const quote = buildMediaQuote(
			{
				productKey: "image-fast",
				input: { kind: "text-to-image", prompt: "A studio product photo" },
			},
			{ enabledProviders: new Set(["replicate"]), generationEnabled: true },
		);
		const createGenerationJob = vi.fn();

		await expect(
			createGenerationForUser(
				"user-1",
				{ quoteId: "quote-1", idempotencyKey: "idempotency-key-1" },
				{
					now: () => new Date("2026-08-23T00:00:00.000Z"),
					findQuote: async () => ({
						id: "quote-1",
						productKey: quote.productKey,
						catalogVersion: quote.catalogVersion,
						pricingVersion: quote.pricingVersion,
						expiresAt: new Date("2026-08-23T00:10:00.000Z"),
						credits: quote.credits,
						costMicros: quote.costMicros,
						inputSnapshot: { kind: "text-to-image", prompt: "A studio product photo" },
						pricingSnapshot: quote.pricingSnapshot,
					}),
					getRouteGraphOptions: async () => ({
						enabledProviders: new Set(["fal"]),
						generationEnabled: true,
					}),
					assertAllowed: vi.fn(async () => undefined),
					createGenerationJob,
				},
			),
		).rejects.toThrow("PRICE_CHANGED");

		expect(createGenerationJob).not.toHaveBeenCalled();
	});

	it("requires a requote before reserving credits for the former quality-image reference capability", async () => {
		const quote = buildMediaQuote(
			{
				productKey: "image-quality",
				input: { kind: "text-to-image", prompt: "A studio product photo" },
			},
			{ enabledProviders: new Set(["gemini"]), generationEnabled: true },
		);
		const createGenerationJob = vi.fn();

		await expect(
			createGenerationForUser(
				"user-1",
				{ quoteId: "quote-1", idempotencyKey: "idempotency-key-1" },
				{
					now: () => new Date("2026-08-24T00:00:00.000Z"),
					findQuote: async () => ({
						id: "quote-1",
						productKey: quote.productKey,
						catalogVersion: "2026-08-13.1",
						pricingVersion: quote.pricingVersion,
						expiresAt: new Date("2026-08-24T00:10:00.000Z"),
						credits: quote.credits,
						costMicros: quote.costMicros,
						inputSnapshot: {
							kind: "image-to-image",
							prompt: "A studio product photo",
							sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
						},
						pricingSnapshot: quote.pricingSnapshot,
					}),
					getRouteGraphOptions: async () => ({
						enabledProviders: new Set(["gemini"]),
						generationEnabled: true,
					}),
					assertAllowed: vi.fn(async () => undefined),
					createGenerationJob,
				},
			),
		).rejects.toThrow("PRICE_CHANGED");

		expect(createGenerationJob).not.toHaveBeenCalled();
	});
});
