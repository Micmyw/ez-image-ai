import { DEFAULT_PRODUCT_CONFIG } from "@repo/config";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildMediaQuote } from "../lib/quote";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/jobs", () => ({ resolveDatabaseDispatchRoute: vi.fn() }));
vi.mock("@repo/logs", () => ({ logger: { warn: vi.fn() } }));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: vi.fn() } }));

import { createGenerationForUser } from "./create-generation";

const SOURCE_ASSET_ID = "asset_01J5ABCD1234EFGH5678JKLMNP";
const KIE_ROUTE_OPTIONS = {
	enabledProviders: new Set(["kie" as const]),
	generationEnabled: true,
	kieImageCertifiedCatalogVersions: new Set([DEFAULT_PRODUCT_CONFIG.catalogVersion]),
};

const NANO_INPUT = {
	kind: "image-to-image" as const,
	prompt: "A studio product photo",
	sourceAssetId: SOURCE_ASSET_ID,
	skuKey: "nano-banana-2-lite-1k" as const,
	aspectRatio: "auto" as const,
};

afterEach(() => vi.unstubAllEnvs());

describe("createGenerationForUser", () => {
	it("rejects a retired OpenRouter product quote before reserving credits", async () => {
		const legacyQuote = buildMediaQuote(
			{
				productKey: "image-fast",
				input: {
					kind: "image-to-image",
					prompt: "Legacy edit",
					sourceAssetId: SOURCE_ASSET_ID,
				},
			},
			{
				enabledProviders: new Set(["openrouter"]),
				generationEnabled: true,
				openRouterImageRoutesCertified: true,
			},
		);
		const createGenerationJob = vi.fn();

		await expect(
			createGenerationForUser(
				"user-1",
				{ quoteId: "quote-legacy", idempotencyKey: "idempotency-legacy" },
				{
					now: () => new Date("2026-09-07T00:00:00.000Z"),
					loadEntitlement: vi.fn(async () => ({ maximumConcurrentJobs: 3 })),
					findQuote: async () => ({
						id: "quote-legacy",
						productKey: legacyQuote.productKey,
						catalogVersion: legacyQuote.catalogVersion,
						pricingVersion: legacyQuote.pricingVersion,
						expiresAt: new Date("2026-09-07T00:10:00.000Z"),
						credits: legacyQuote.credits,
						costMicros: legacyQuote.costMicros,
						inputSnapshot: {
							kind: "image-to-image",
							prompt: "Legacy edit",
							sourceAssetId: SOURCE_ASSET_ID,
						},
						pricingSnapshot: legacyQuote.pricingSnapshot,
					}),
					getRouteGraphOptions: async () => ({
						enabledProviders: new Set(["openrouter"]),
						generationEnabled: true,
						openRouterImageRoutesCertified: true,
					}),
					assertAllowed: vi.fn(async () => undefined),
					createGenerationJob,
				},
			),
		).rejects.toThrow("PRICE_CHANGED");

		expect(createGenerationJob).not.toHaveBeenCalled();
	});

	it("binds a first confirmed image edit as a root session transaction", async () => {
		vi.stubEnv("MEDIA_DAILY_PROVIDER_COST_BUDGET_MICROS", "250000000");
		const quote = buildMediaQuote(
			{
				productKey: "image-nano-banana-2-lite",
				input: NANO_INPUT,
			},
			KIE_ROUTE_OPTIONS,
		);
		const createGenerationJob = vi.fn(async () => ({
			job: { id: "job-1", status: "RESERVED", version: 0, creditsReserved: 5n },
			replayed: false,
		}));

		await createGenerationForUser(
			"user-1",
			{ quoteId: "quote-1", idempotencyKey: "idempotency-key-1" },
			{
				now: () => new Date("2026-08-25T00:00:00.000Z"),
				loadEntitlement: vi.fn(async () => ({ maximumConcurrentJobs: 3 })),
				findQuote: async () => ({
					id: "quote-1",
					productKey: quote.productKey,
					catalogVersion: quote.catalogVersion,
					pricingVersion: quote.pricingVersion,
					expiresAt: new Date("2026-08-25T00:10:00.000Z"),
					credits: quote.credits,
					costMicros: quote.costMicros,
					inputSnapshot: {
						...NANO_INPUT,
						editContext: { kind: "ROOT", rootAssetId: SOURCE_ASSET_ID },
					},
					pricingSnapshot: quote.pricingSnapshot,
				}),
				getRouteGraphOptions: async () => KIE_ROUTE_OPTIONS,
				assertAllowed: vi.fn(async () => undefined),
				createGenerationJob,
			},
		);

		expect(createGenerationJob).toHaveBeenCalledWith(
			expect.objectContaining({
				inputAssetIds: [SOURCE_ASSET_ID],
				edit: { kind: "ROOT", rootAssetId: SOURCE_ASSET_ID },
				maximumConcurrentJobs: 3,
				maximumGlobalDailyCostMicros: 250_000_000n,
			}),
		);
	});

	it("uses the child parent and session frozen in the quote when confirmation omits the echo", async () => {
		const quote = buildMediaQuote(
			{
				productKey: "image-nano-banana-2-lite",
				input: {
					...NANO_INPUT,
					prompt: "A second edit",
				},
			},
			KIE_ROUTE_OPTIONS,
		);
		const createGenerationJob = vi.fn(async () => ({
			job: { id: "job-2", status: "RESERVED", version: 0, creditsReserved: 5n },
			replayed: false,
		}));

		await createGenerationForUser(
			"user-1",
			{ quoteId: "quote-2", idempotencyKey: "idempotency-key-2" },
			{
				now: () => new Date("2026-08-25T00:00:00.000Z"),
				loadEntitlement: vi.fn(async () => ({ maximumConcurrentJobs: 3 })),
				findQuote: async () => ({
					id: "quote-2",
					productKey: quote.productKey,
					catalogVersion: quote.catalogVersion,
					pricingVersion: quote.pricingVersion,
					expiresAt: new Date("2026-08-25T00:10:00.000Z"),
					credits: quote.credits,
					costMicros: quote.costMicros,
					inputSnapshot: {
						...NANO_INPUT,
						prompt: "A second edit",
						editContext: {
							kind: "CHILD",
							parentJobId: "job-parent",
							editSessionId: "session-1",
							sourceAssetId: SOURCE_ASSET_ID,
						},
					},
					pricingSnapshot: quote.pricingSnapshot,
				}),
				getRouteGraphOptions: async () => KIE_ROUTE_OPTIONS,
				assertAllowed: vi.fn(async () => undefined),
				createGenerationJob,
			},
		);

		expect(createGenerationJob).toHaveBeenCalledWith(
			expect.objectContaining({
				inputAssetIds: [SOURCE_ASSET_ID],
				edit: {
					kind: "CHILD",
					parentJobId: "job-parent",
					editSessionId: "session-1",
					sourceAssetId: SOURCE_ASSET_ID,
				},
			}),
		);
	});

	it("rejects a confirmation that replaces the child parent frozen in the quote", async () => {
		const quote = buildMediaQuote(
			{
				productKey: "image-nano-banana-2-lite",
				input: {
					...NANO_INPUT,
					prompt: "A second edit",
				},
			},
			KIE_ROUTE_OPTIONS,
		);
		const createGenerationJob = vi.fn();

		await expect(
			createGenerationForUser(
				"user-1",
				{
					quoteId: "quote-2",
					idempotencyKey: "idempotency-key-2",
					parentJobId: "job-replacement",
				},
				{
					now: () => new Date("2026-08-25T00:00:00.000Z"),
					loadEntitlement: vi.fn(async () => ({ maximumConcurrentJobs: 3 })),
					findQuote: async () => ({
						id: "quote-2",
						productKey: quote.productKey,
						catalogVersion: quote.catalogVersion,
						pricingVersion: quote.pricingVersion,
						expiresAt: new Date("2026-08-25T00:10:00.000Z"),
						credits: quote.credits,
						costMicros: quote.costMicros,
						inputSnapshot: {
							...NANO_INPUT,
							prompt: "A second edit",
							editContext: {
								kind: "CHILD",
								parentJobId: "job-parent",
								editSessionId: "session-1",
								sourceAssetId: SOURCE_ASSET_ID,
							},
						},
						pricingSnapshot: quote.pricingSnapshot,
					}),
					getRouteGraphOptions: async () => KIE_ROUTE_OPTIONS,
					assertAllowed: vi.fn(async () => undefined),
					createGenerationJob,
				},
			),
		).rejects.toThrow("NOT_FOUND");

		expect(createGenerationJob).not.toHaveBeenCalled();
	});

	it("rejects a parent injected while confirming a root quote", async () => {
		const quote = buildMediaQuote(
			{
				productKey: "image-nano-banana-2-lite",
				input: NANO_INPUT,
			},
			KIE_ROUTE_OPTIONS,
		);
		const createGenerationJob = vi.fn();

		await expect(
			createGenerationForUser(
				"user-1",
				{
					quoteId: "quote-1",
					idempotencyKey: "idempotency-key-1",
					parentJobId: "job-injected",
				},
				{
					now: () => new Date("2026-08-25T00:00:00.000Z"),
					loadEntitlement: vi.fn(async () => ({ maximumConcurrentJobs: 3 })),
					findQuote: async () => ({
						id: "quote-1",
						productKey: quote.productKey,
						catalogVersion: quote.catalogVersion,
						pricingVersion: quote.pricingVersion,
						expiresAt: new Date("2026-08-25T00:10:00.000Z"),
						credits: quote.credits,
						costMicros: quote.costMicros,
						inputSnapshot: {
							...NANO_INPUT,
							editContext: { kind: "ROOT", rootAssetId: SOURCE_ASSET_ID },
						},
						pricingSnapshot: quote.pricingSnapshot,
					}),
					getRouteGraphOptions: async () => KIE_ROUTE_OPTIONS,
					assertAllowed: vi.fn(async () => undefined),
					createGenerationJob,
				},
			),
		).rejects.toThrow("NOT_FOUND");

		expect(createGenerationJob).not.toHaveBeenCalled();
	});

	it("requires a requote before reserving credits when the frozen route graph is no longer executable", async () => {
		const quote = buildMediaQuote(
			{
				productKey: "image-nano-banana-2-lite",
				input: NANO_INPUT,
			},
			KIE_ROUTE_OPTIONS,
		);
		const createGenerationJob = vi.fn();

		await expect(
			createGenerationForUser(
				"user-1",
				{ quoteId: "quote-1", idempotencyKey: "idempotency-key-1" },
				{
					now: () => new Date("2026-08-23T00:00:00.000Z"),
					loadEntitlement: vi.fn(async () => ({ maximumConcurrentJobs: 3 })),
					findQuote: async () => ({
						id: "quote-1",
						productKey: quote.productKey,
						catalogVersion: quote.catalogVersion,
						pricingVersion: quote.pricingVersion,
						expiresAt: new Date("2026-08-23T00:10:00.000Z"),
						credits: quote.credits,
						costMicros: quote.costMicros,
						inputSnapshot: {
							...NANO_INPUT,
						},
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

	it("requires a requote before reserving credits for a stale GPT Image 2 catalog", async () => {
		const quote = buildMediaQuote(
			{
				productKey: "image-gpt-image-2",
				input: {
					kind: "image-to-image",
					prompt: "A studio product photo",
					sourceAssetId: SOURCE_ASSET_ID,
					skuKey: "gpt-image-2-2k",
					aspectRatio: "1:1",
				},
			},
			KIE_ROUTE_OPTIONS,
		);
		const createGenerationJob = vi.fn();

		await expect(
			createGenerationForUser(
				"user-1",
				{ quoteId: "quote-1", idempotencyKey: "idempotency-key-1" },
				{
					now: () => new Date("2026-08-24T00:00:00.000Z"),
					loadEntitlement: vi.fn(async () => ({ maximumConcurrentJobs: 3 })),
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
							sourceAssetId: SOURCE_ASSET_ID,
							skuKey: "gpt-image-2-2k",
							aspectRatio: "1:1",
						},
						pricingSnapshot: quote.pricingSnapshot,
					}),
					getRouteGraphOptions: async () => KIE_ROUTE_OPTIONS,
					assertAllowed: vi.fn(async () => undefined),
					createGenerationJob,
				},
			),
		).rejects.toThrow("PRICE_CHANGED");

		expect(createGenerationJob).not.toHaveBeenCalled();
	});
});
