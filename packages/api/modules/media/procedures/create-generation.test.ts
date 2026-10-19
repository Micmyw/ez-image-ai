import { afterEach, describe, expect, it, vi } from "vitest";

import { buildMediaQuote } from "../lib/quote";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({
	createGenerationJobTransaction: vi.fn(),
	getInitialGenerationEventIds: vi.fn(),
	unexpiredStorageReservations: vi.fn(),
	ensureFreeMonthlyCreditGrant: vi.fn(),
	hasMatchingFreeMonthlyCreditGrant: vi.fn(),
	findEffectivePaidSubscription: vi.fn(),
}));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database", () => ({
	createGenerationJobTransaction: vi.fn(),
	getInitialGenerationEventIds: vi.fn(),
	unexpiredStorageReservations: () => ({}),
}));
vi.mock("@repo/jobs", () => ({ resolveDatabaseDispatchRoute: vi.fn() }));
vi.mock("@repo/logs", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("@repo/jobs/orchestration/client", () => ({ dispatchJob: vi.fn() }));

import { dispatchJob } from "@repo/jobs/orchestration/client";

import { createGenerationForUser, dispatchCreatedGeneration } from "./create-generation";

const SOURCE_ASSET_ID = "asset_01J5ABCD1234EFGH5678JKLMNP";
const KIE_ROUTE_OPTIONS = {
	enabledProviders: new Set(["kie" as const]),
	generationEnabled: true,
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
	it("replays an accepted pass job even after the quote expires and the pass balance is empty", async () => {
		const accepted = {
			id: "accepted-pass-job",
			quoteId: "accepted-quote",
			fundingSource: "IMAGE_PASS" as const,
			parentJobId: null,
			status: "PROVIDER_PENDING",
			version: 1,
			creditsReserved: 0n,
		};
		const assertAllowed = vi.fn(async () => {
			throw new Error("IMAGE_PASS_INSUFFICIENT");
		});
		await expect(
			createGenerationForUser(
				"user-1",
				{
					quoteId: "accepted-quote",
					idempotencyKey: "same-pass-request",
					fundingSource: "IMAGE_PASS",
				},
				{
					now: () => new Date(),
					findExistingGeneration: async () => accepted,
					findQuote: async () => null,
					getRouteGraphOptions: async () => KIE_ROUTE_OPTIONS,
					assertAllowed,
					createGenerationJob: vi.fn(),
				},
			),
		).resolves.toMatchObject({
			replayed: true,
			job: { id: accepted.id, creditsReserved: 0n, fundingSource: "IMAGE_PASS", imagePassUnits: 1 },
		});
		expect(assertAllowed).not.toHaveBeenCalled();
	});
	it.each([
		{
			quoteId: "another-quote",
			fundingSource: "IMAGE_PASS" as const,
			error: "IDEMPOTENCY_CONFLICT",
		},
		{
			quoteId: "accepted-quote",
			fundingSource: "CREDITS" as const,
			error: "GENERATION_FUNDING_CONFLICT",
		},
	])(
		"rejects a replay with changed quote or funding: $error",
		async ({ quoteId, fundingSource, error }) => {
			await expect(
				createGenerationForUser(
					"user-1",
					{ quoteId, idempotencyKey: "same-key", fundingSource },
					{
						now: () => new Date(),
						findExistingGeneration: async () => ({
							id: "job",
							quoteId: "accepted-quote",
							parentJobId: null,
							fundingSource: "IMAGE_PASS",
							status: "RESERVED",
							version: 0,
							creditsReserved: 0n,
						}),
						findQuote: vi.fn(),
						getRouteGraphOptions: async () => KIE_ROUTE_OPTIONS,
						assertAllowed: vi.fn(),
						createGenerationJob: vi.fn(),
					},
				),
			).rejects.toThrow(error);
		},
	);
	it("recovers a concurrent admission committed after the initial replay lookup", async () => {
		const findExistingGeneration = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
			id: "raced-job",
			quoteId: "accepted-quote",
			parentJobId: null,
			fundingSource: "IMAGE_PASS",
			status: "RESERVED",
			version: 0,
			creditsReserved: 0n,
		});
		await expect(
			createGenerationForUser(
				"user-1",
				{ quoteId: "accepted-quote", idempotencyKey: "raced-key", fundingSource: "IMAGE_PASS" },
				{
					now: () => new Date(),
					findExistingGeneration,
					findQuote: async () => null,
					getRouteGraphOptions: async () => KIE_ROUTE_OPTIONS,
					assertAllowed: vi.fn(),
					createGenerationJob: vi.fn(),
				},
			),
		).resolves.toMatchObject({ replayed: true, job: { id: "raced-job", imagePassUnits: 1 } });
		expect(findExistingGeneration).toHaveBeenCalledTimes(2);
	});
	it("requires the same parent echo when replaying an accepted child edit", async () => {
		await expect(
			createGenerationForUser(
				"user-1",
				{ quoteId: "child-quote", idempotencyKey: "child-key", fundingSource: "IMAGE_PASS" },
				{
					now: () => new Date(),
					findExistingGeneration: async () => ({
						id: "child-job",
						quoteId: "child-quote",
						parentJobId: "parent-job",
						fundingSource: "IMAGE_PASS",
						status: "RESERVED",
						version: 0,
						creditsReserved: 0n,
					}),
					findQuote: vi.fn(),
					getRouteGraphOptions: async () => KIE_ROUTE_OPTIONS,
					assertAllowed: vi.fn(),
					createGenerationJob: vi.fn(),
				},
			),
		).rejects.toThrow("IDEMPOTENCY_CONFLICT");
	});
	it("rejects changing the funding source of a frozen pass quote before admission", async () => {
		const quote = buildMediaQuote(
			{
				...NANO_INPUT,
				productKey: "image-nano-banana-2-lite",
				input: NANO_INPUT,
				fundingSource: "IMAGE_PASS",
			},
			KIE_ROUTE_OPTIONS,
		);
		const createGenerationJob = vi.fn();
		const assertAllowed = vi.fn();
		await expect(
			createGenerationForUser(
				"user-1",
				{ quoteId: "pass-quote", idempotencyKey: "funding-change", fundingSource: "CREDITS" },
				{
					now: () => new Date(),
					findQuote: async () => ({
						...quote,
						id: "pass-quote",
						inputSnapshot: NANO_INPUT,
						expiresAt: new Date(Date.now() + 60_000),
					}),
					getRouteGraphOptions: async () => KIE_ROUTE_OPTIONS,
					assertAllowed,
					createGenerationJob,
				},
			),
		).rejects.toThrow("GENERATION_FUNDING_CONFLICT");
		expect(createGenerationJob).not.toHaveBeenCalled();
	});
	it("wakes only committed admission events, reusing the same identity after response loss", async () => {
		const wake = vi.mocked(dispatchJob).mockReset();
		wake.mockRejectedValue(new Error("ACCEPTED_RESPONSE_LOST"));
		const result = {
			job: { id: "committed-job", status: "RESERVED", version: 0, creditsReserved: 5n },
			replayed: false,
			continuationEventIds: ["committed-input"],
		};
		await expect(dispatchCreatedGeneration(result)).resolves.toBeUndefined();
		await expect(dispatchCreatedGeneration({ ...result, replayed: true })).resolves.toBeUndefined();
		expect(wake.mock.calls).toEqual(
			Array.from({ length: 2 }, () => [
				"media-deliver-events",
				{ eventIds: ["committed-input"] },
				{ idempotencyKey: "generation-start:committed-job:0", timeoutMs: 3000 },
			]),
		);
		wake.mockClear();
		await dispatchCreatedGeneration({ ...result, continuationEventIds: [] });
		expect(wake).not.toHaveBeenCalled();
	});
	it("creates a text job through the existing reservation transaction without input assets or an edit session", async () => {
		const input = {
			kind: "text-to-image" as const,
			prompt: "A ceramic vase",
			skuKey: "gpt-image-2-1k" as const,
			aspectRatio: "1:1" as const,
		};
		const quote = buildMediaQuote({ productKey: "image-gpt-image-2", input }, KIE_ROUTE_OPTIONS);
		const createGenerationJob = vi.fn(async (_request: unknown) => ({
			job: { id: "text-job", status: "RESERVED", version: 0, creditsReserved: 7n },
			replayed: false,
		}));
		const assertAllowed = vi.fn(async () => undefined);
		const dependencies = {
			now: () => new Date("2026-09-14T00:00:00Z"),
			findQuote: async () => ({
				...quote,
				id: "text-quote",
				expiresAt: new Date("2026-09-14T00:10:00Z"),
				inputSnapshot: input,
			}),
			getRouteGraphOptions: async () => KIE_ROUTE_OPTIONS,
			assertAllowed,
			createGenerationJob,
		};
		await createGenerationForUser(
			"user-1",
			{ quoteId: "text-quote", idempotencyKey: "text-request-1" },
			dependencies,
		);
		expect(assertAllowed).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				input,
				credits: 7n,
				enforceProspectiveDailyBudget: false,
			}),
		);
		expect(createGenerationJob).toHaveBeenCalledWith(
			expect.objectContaining({
				quoteId: "text-quote",
				inputAssetIds: [],
				expectedModerationRuleVersion: expect.any(String),
			}),
		);
		expect(createGenerationJob.mock.calls[0]?.[0]).not.toHaveProperty("edit");
		expect(createGenerationJob.mock.calls[0]?.[0]).not.toHaveProperty("maximumConcurrentJobs");
		createGenerationJob.mockClear();
		await expect(
			createGenerationForUser(
				"user-1",
				{
					quoteId: "text-quote",
					idempotencyKey: "text-request-2",
					parentJobId: "unrelated-parent",
				},
				dependencies,
			),
		).rejects.toThrow("NOT_FOUND");
		expect(createGenerationJob).not.toHaveBeenCalled();
	});
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
