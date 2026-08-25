import { describe, expect, it, vi } from "vitest";

import { buildMediaQuote } from "../lib/quote";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/jobs", () => ({ resolveDatabaseDispatchRoute: vi.fn() }));
vi.mock("@repo/logs", () => ({ logger: { warn: vi.fn() } }));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: vi.fn() } }));

import { createGenerationForUser } from "./create-generation";

const SOURCE_ASSET_ID = "asset_01J5ABCD1234EFGH5678JKLMNP";

describe("createGenerationForUser", () => {
	it("binds a first confirmed image edit as a root session transaction", async () => {
		const quote = buildMediaQuote(
			{
				productKey: "image-fast",
				input: {
					kind: "image-to-image",
					prompt: "A studio product photo",
					sourceAssetId: SOURCE_ASSET_ID,
				},
			},
			{ enabledProviders: new Set(["replicate"]), generationEnabled: true },
		);
		const createGenerationJob = vi.fn(async () => ({
			job: { id: "job-1", status: "RESERVED", version: 0, creditsReserved: 4n },
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
						kind: "image-to-image",
						prompt: "A studio product photo",
						sourceAssetId: SOURCE_ASSET_ID,
						editContext: { kind: "ROOT", rootAssetId: SOURCE_ASSET_ID },
					},
					pricingSnapshot: quote.pricingSnapshot,
				}),
				getRouteGraphOptions: async () => ({
					enabledProviders: new Set(["replicate"]),
					generationEnabled: true,
				}),
				assertAllowed: vi.fn(async () => undefined),
				createGenerationJob,
			},
		);

		expect(createGenerationJob).toHaveBeenCalledWith(
			expect.objectContaining({
				inputAssetIds: [SOURCE_ASSET_ID],
				edit: { kind: "ROOT", rootAssetId: SOURCE_ASSET_ID },
				maximumConcurrentJobs: 3,
			}),
		);
	});

	it("uses the child parent and session frozen in the quote when confirmation omits the echo", async () => {
		const quote = buildMediaQuote(
			{
				productKey: "image-fast",
				input: {
					kind: "image-to-image",
					prompt: "A second edit",
					sourceAssetId: SOURCE_ASSET_ID,
				},
			},
			{ enabledProviders: new Set(["replicate"]), generationEnabled: true },
		);
		const createGenerationJob = vi.fn(async () => ({
			job: { id: "job-2", status: "RESERVED", version: 0, creditsReserved: 4n },
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
						kind: "image-to-image",
						prompt: "A second edit",
						sourceAssetId: SOURCE_ASSET_ID,
						editContext: {
							kind: "CHILD",
							parentJobId: "job-parent",
							editSessionId: "session-1",
							sourceAssetId: SOURCE_ASSET_ID,
						},
					},
					pricingSnapshot: quote.pricingSnapshot,
				}),
				getRouteGraphOptions: async () => ({
					enabledProviders: new Set(["replicate"]),
					generationEnabled: true,
				}),
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
				productKey: "image-fast",
				input: {
					kind: "image-to-image",
					prompt: "A second edit",
					sourceAssetId: SOURCE_ASSET_ID,
				},
			},
			{ enabledProviders: new Set(["replicate"]), generationEnabled: true },
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
							kind: "image-to-image",
							prompt: "A second edit",
							sourceAssetId: SOURCE_ASSET_ID,
							editContext: {
								kind: "CHILD",
								parentJobId: "job-parent",
								editSessionId: "session-1",
								sourceAssetId: SOURCE_ASSET_ID,
							},
						},
						pricingSnapshot: quote.pricingSnapshot,
					}),
					getRouteGraphOptions: async () => ({
						enabledProviders: new Set(["replicate"]),
						generationEnabled: true,
					}),
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
				productKey: "image-fast",
				input: {
					kind: "image-to-image",
					prompt: "A studio product photo",
					sourceAssetId: SOURCE_ASSET_ID,
				},
			},
			{ enabledProviders: new Set(["replicate"]), generationEnabled: true },
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
							kind: "image-to-image",
							prompt: "A studio product photo",
							sourceAssetId: SOURCE_ASSET_ID,
							editContext: { kind: "ROOT", rootAssetId: SOURCE_ASSET_ID },
						},
						pricingSnapshot: quote.pricingSnapshot,
					}),
					getRouteGraphOptions: async () => ({
						enabledProviders: new Set(["replicate"]),
						generationEnabled: true,
					}),
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
				productKey: "image-fast",
				input: {
					kind: "image-to-image",
					prompt: "A studio product photo",
					sourceAssetId: SOURCE_ASSET_ID,
				},
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
							kind: "image-to-image",
							prompt: "A studio product photo",
							sourceAssetId: SOURCE_ASSET_ID,
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

	it("requires a requote before reserving credits for a stale quality-edit catalog", async () => {
		const quote = buildMediaQuote(
			{
				productKey: "image-quality",
				input: {
					kind: "image-to-image",
					prompt: "A studio product photo",
					sourceAssetId: SOURCE_ASSET_ID,
				},
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
