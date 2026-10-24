import { EZPIC_PRODUCT_KEYS, IMAGE_SKU_KEYS_BY_PRODUCT } from "@repo/config";
import { describe, expect, it, vi } from "vitest";

const production = vi.hoisted(() => ({
	budget: vi.fn(),
	freeCredits: vi.fn(),
	planAccess: vi.fn(),
	rateLimit: vi.fn(),
	db: {
		runtimeConfigOverride: { findFirst: vi.fn() },
		creditAccount: { findUnique: vi.fn() },
		creditLot: { aggregate: vi.fn() },
		generationQuote: { aggregate: vi.fn() },
		storageUsageReservation: { aggregate: vi.fn() },
	},
}));
vi.mock("@repo/database/client", () => ({ db: production.db }));
// All DB calls below already use production.db; retain the real pure storage filter
// without loading the generated-client barrel in this unit test.
vi.mock("@repo/database", async () => ({
	unexpiredStorageReservations: (
		await import("../../../../database/prisma/queries/media/temporary-references")
	).unexpiredStorageReservations,
	effectiveMediaStorageLimit: async (_owner: unknown, maximum: bigint) => maximum,
}));
vi.mock("@repo/config/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/config/server")>()),
	mediaDailyProviderCostBudgetMicros: production.budget,
}));
vi.mock("./free-plan-credits", () => ({
	ensureFreePlanCreditsForGeneration: production.freeCredits,
}));
vi.mock("./plan-entitlement", () => ({ loadUserPlanAccess: production.planAccess }));
vi.mock("./rate-limit", () => ({ enforceMediaRateLimit: production.rateLimit }));

import {
	assertGenerationAllowed,
	createGenerationRateLimitReceipt,
	isCatalogModelEnabled,
	isUsableGenerationSourceAsset,
	type GenerationAccessSnapshot,
} from "./generation-authorization";
import { buildMediaQuote } from "./quote";

const IMAGE_EDIT_INPUT = {
	kind: "image-to-image" as const,
	prompt: "x",
	sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
};

const FREE_IMAGE_PRODUCT = "image-nano-banana-2-lite" as const;
const PAID_IMAGE_PRODUCT = "image-nano-banana-2" as const;
const KIE_IMAGE_ROUTE_GRAPH = {
	enabledProviders: new Set(["kie" as const]),
	generationEnabled: true,
};

const BASE_SNAPSHOT = {
	generationEnabled: true,
	modelDisabled: false,
	spendableCredits: 100n,
	creditDebt: 0n,
	dailyCostMicros: 0n,
	storageUsageBytes: 0n,
	maximumStorageBytes: 2n * 1024n * 1024n * 1024n,
	planId: "studio",
	sourceAssetReady: true,
	sourceAssetBytes: 1n,
} satisfies GenerationAccessSnapshot;

describe("generation authorization", () => {
	it.each(
		EZPIC_PRODUCT_KEYS.flatMap((productKey) =>
			IMAGE_SKU_KEYS_BY_PRODUCT[productKey].map((skuKey) => ({ productKey, skuKey })),
		),
	)(
		"enforces subscription model access for $productKey / $skuKey despite a funded balance",
		async ({ productKey, skuKey }) => {
			const input = {
				kind: "text-to-image" as const,
				prompt: "A ceramic vase in a sunlit room",
				skuKey,
				aspectRatio: skuKey === "gpt-image-2-4k" ? ("3:2" as const) : ("1:1" as const),
			};
			const quote = buildMediaQuote({ productKey, input }, KIE_IMAGE_ROUTE_GRAPH);
			const authorization = assertGenerationAllowed(
				{
					userId: "credit-owner",
					productKey,
					input,
					credits: quote.credits,
					costMicros: quote.costMicros,
					routeGraphOptions: KIE_IMAGE_ROUTE_GRAPH,
				},
				{
					enforceRateLimit: async () => {},
					isEnvironmentGenerationEnabled: () => true,
					loadAccess: async () => ({ ...BASE_SNAPSHOT, planId: "free", spendableCredits: 377n }),
				},
			);
			if (productKey === FREE_IMAGE_PRODUCT) await expect(authorization).resolves.toBeUndefined();
			else await expect(authorization).rejects.toThrow("ENTITLEMENT_REQUIRED");
			await expect(
				assertGenerationAllowed(
					{
						userId: "credit-owner",
						productKey,
						input,
						credits: quote.credits,
						costMicros: quote.costMicros,
						routeGraphOptions: KIE_IMAGE_ROUTE_GRAPH,
					},
					{
						enforceRateLimit: async () => {},
						isEnvironmentGenerationEnabled: () => true,
						loadAccess: async () => ({
							...BASE_SNAPSHOT,
							planId: "creator",
							spendableCredits: 377n,
						}),
					},
				),
			).resolves.toBeUndefined();
		},
	);
	it.each(["text-to-image", "image-to-image"] as const)(
		"allows subscriber shared credits for the unchanged Sunburst 1K %s quote",
		async (kind) => {
			const input = {
				kind,
				prompt: "A ceramic vase in a sunlit room",
				skuKey: "gpt-image-2-5-sunburst-1k" as const,
				aspectRatio: "1:1" as const,
				...(kind === "image-to-image" ? { sourceAssetId: IMAGE_EDIT_INPUT.sourceAssetId } : {}),
			} as Parameters<typeof buildMediaQuote>[0]["input"];
			const productKey = "image-gpt-image-2-5-sunburst" as const;
			const quote = buildMediaQuote({ productKey, input }, KIE_IMAGE_ROUTE_GRAPH);
			expect(quote).toMatchObject({ credits: 7n, costMicros: 30_000n });
			const request = {
				userId: "credit-owner",
				productKey,
				input,
				credits: quote.credits,
				costMicros: quote.costMicros,
				routeGraphOptions: KIE_IMAGE_ROUTE_GRAPH,
			};
			const dependencies = {
				enforceRateLimit: async () => {},
				isEnvironmentGenerationEnabled: () => true,
				loadAccess: async () => ({
					...BASE_SNAPSHOT,
					planId: "creator" as const,
					spendableCredits: 7n,
				}),
			};
			await expect(assertGenerationAllowed(request, dependencies)).resolves.toBeUndefined();
			await expect(
				assertGenerationAllowed(request, {
					...dependencies,
					loadAccess: async () => ({ ...BASE_SNAPSHOT, planId: "creator", spendableCredits: 6n }),
				}),
			).rejects.toThrow("INSUFFICIENT_CREDITS");
		},
	);
	it("does not let an available image pass unlock a premium model for a free owner", async () => {
		await expect(
			assertGenerationAllowed(
				{
					userId: "pass-owner",
					productKey: "image-nano-banana-pro",
					credits: 25n,
					costMicros: 120000n,
					fundingSource: "IMAGE_PASS",
					input: {
						kind: "text-to-image",
						prompt: "A vase",
						skuKey: "nano-banana-pro-4k",
						aspectRatio: "1:1",
					},
					routeGraphOptions: KIE_IMAGE_ROUTE_GRAPH,
				},
				{
					enforceRateLimit: async () => {},
					isEnvironmentGenerationEnabled: () => true,
					loadAccess: async () => ({
						...BASE_SNAPSHOT,
						planId: "free",
						spendableCredits: 0n,
						imagePassAvailable: true,
					}),
				},
			),
		).rejects.toThrow("ENTITLEMENT_REQUIRED");
	});
	it("allows a subscribed owner to use an image pass without ordinary credits", async () => {
		await expect(
			assertGenerationAllowed(
				{
					userId: "pass-owner",
					productKey: "image-nano-banana-pro",
					credits: 25n,
					costMicros: 120_000n,
					fundingSource: "IMAGE_PASS",
					input: {
						kind: "text-to-image",
						prompt: "A vase",
						skuKey: "nano-banana-pro-4k",
						aspectRatio: "1:1",
					},
					routeGraphOptions: KIE_IMAGE_ROUTE_GRAPH,
				},
				{
					enforceRateLimit: async () => {},
					isEnvironmentGenerationEnabled: () => true,
					loadAccess: async () => ({
						...BASE_SNAPSHOT,
						planId: "creator",
						spendableCredits: 0n,
						imagePassAvailable: true,
					}),
				},
			),
		).resolves.toBeUndefined();
	});
	it("does not switch to plentiful ordinary credits when the selected pass is empty", async () => {
		await expect(
			assertGenerationAllowed(
				{
					userId: "pass-owner",
					productKey: "image-nano-banana-pro",
					credits: 25n,
					costMicros: 120000n,
					fundingSource: "IMAGE_PASS",
					input: {
						kind: "text-to-image",
						prompt: "A vase",
						skuKey: "nano-banana-pro-4k",
						aspectRatio: "1:1",
					},
					routeGraphOptions: KIE_IMAGE_ROUTE_GRAPH,
				},
				{
					enforceRateLimit: async () => {},
					isEnvironmentGenerationEnabled: () => true,
					loadAccess: async () => ({
						...BASE_SNAPSHOT,
						planId: "free",
						spendableCredits: 1000n,
						imagePassAvailable: false,
					}),
				},
			),
		).rejects.toThrow("IMAGE_PASS_INSUFFICIENT");
	});
	it("does not reject an authoritative unlimited aggregate quota at high usage", async () => {
		await expect(
			assertGenerationAllowed(
				{
					userId: "user-1",
					productKey: PAID_IMAGE_PRODUCT,
					credits: 9n,
					costMicros: 40_000n,
					input: IMAGE_EDIT_INPUT,
					routeGraphOptions: KIE_IMAGE_ROUTE_GRAPH,
				},
				{
					enforceRateLimit: vi.fn(),
					isEnvironmentGenerationEnabled: () => true,
					loadAccess: async () => ({
						...BASE_SNAPSHOT,
						storageUsageBytes: 100_000_000_000n,
						maximumStorageBytes: null,
					}),
				},
			),
		).resolves.toBeUndefined();
	});
	it.each([undefined, 0n, 100_000n])(
		"only aggregates global costs for a configured budget (%s)",
		async (budget) => {
			vi.clearAllMocks();
			production.budget.mockReturnValue(budget);
			production.db.creditAccount.findUnique.mockResolvedValue({ creditDebt: 0n });
			production.db.creditLot.aggregate.mockResolvedValue({ _sum: { remainingAmount: 100n } });
			production.db.generationQuote.aggregate.mockResolvedValue({ _sum: { costMicros: 0n } });
			production.db.storageUsageReservation.aggregate.mockResolvedValue({ _sum: { bytes: 0n } });
			production.planAccess.mockResolvedValue({
				entitlement: { id: "free" },
				hasEffectivePaidSubscription: false,
			});
			const check = assertGenerationAllowed({
				userId: "user-1",
				productKey: FREE_IMAGE_PRODUCT,
				credits: 5n,
				costMicros: 20_000n,
				input: {
					kind: "text-to-image",
					prompt: "A vase",
					skuKey: "nano-banana-2-lite-1k",
					aspectRatio: "1:1",
				},
				routeGraphOptions: KIE_IMAGE_ROUTE_GRAPH,
			});
			if (budget === 0n) await expect(check).rejects.toThrow("BUDGET_EXCEEDED");
			else await expect(check).resolves.toBeUndefined();
			expect(production.freeCredits).toHaveBeenCalledWith("user-1");
			expect(production.db.generationQuote.aggregate).toHaveBeenCalledTimes(
				budget === undefined ? 1 : 2,
			);
			const globalCalls = production.db.generationQuote.aggregate.mock.calls.filter(
				([input]) => input.where.ownerId === undefined,
			);
			expect(globalCalls).toHaveLength(budget === undefined ? 0 : 1);
		},
	);
	it("requires the same account credit checks for a source-free request", async () => {
		const input = {
			kind: "text-to-image" as const,
			prompt: "A ceramic vase",
			skuKey: "nano-banana-2-lite-1k" as const,
			aspectRatio: "1:1" as const,
		};
		expect(isUsableGenerationSourceAsset(input, null)).toBe(true);
		const request = {
			userId: "user-1",
			productKey: FREE_IMAGE_PRODUCT,
			credits: 5n,
			costMicros: 20_000n,
			input,
			routeGraphOptions: KIE_IMAGE_ROUTE_GRAPH,
		};
		const dependencies = {
			enforceRateLimit: vi.fn(),
			isEnvironmentGenerationEnabled: () => true,
			loadAccess: vi.fn(async () => ({
				...BASE_SNAPSHOT,
				sourceAssetBytes: null,
				planId: "free" as const,
			})),
		};
		await expect(assertGenerationAllowed(request, dependencies)).resolves.toBeUndefined();
		dependencies.loadAccess.mockResolvedValue({
			...BASE_SNAPSHOT,
			sourceAssetBytes: null,
			planId: "free",
			spendableCredits: 0n,
		});
		await expect(assertGenerationAllowed(request, dependencies)).rejects.toThrow(
			"INSUFFICIENT_CREDITS",
		);
		expect(dependencies.enforceRateLimit).toHaveBeenCalled();
	});
	it.each(["image-nano-banana", "image-gpt-image-1-5"] as const)(
		"enforces %s's 10 MB provider input limit even on a 20 MB plan",
		async (productKey) => {
			const input = {
				userId: "user-1",
				productKey,
				credits: 5n,
				costMicros: 20_000n,
				input: IMAGE_EDIT_INPUT,
				routeGraphOptions: KIE_IMAGE_ROUTE_GRAPH,
			};
			const dependencies = {
				enforceRateLimit: vi.fn(),
				isEnvironmentGenerationEnabled: () => true,
				loadAccess: vi.fn(async () => ({ ...BASE_SNAPSHOT, sourceAssetBytes: 10_000_001n })),
			};
			await expect(assertGenerationAllowed(input, dependencies)).rejects.toThrow("INPUT_TOO_LARGE");
			dependencies.loadAccess.mockResolvedValue({
				...BASE_SNAPSHOT,
				sourceAssetBytes: 10_000_000n,
			});
			await expect(assertGenerationAllowed(input, dependencies)).resolves.toBeUndefined();
		},
	);

	it("initializes the server-side Free grant before reading generation access", async () => {
		const callOrder: string[] = [];
		const ensureFreeCredits = vi.fn(async () => {
			callOrder.push("grant");
		});
		const loadAccess = vi.fn(async () => {
			callOrder.push("access");
			return BASE_SNAPSHOT;
		});

		await assertGenerationAllowed(
			{
				userId: "user-1",
				productKey: FREE_IMAGE_PRODUCT,
				credits: 5n,
				costMicros: 20_000n,
				input: IMAGE_EDIT_INPUT,
			},
			{
				enforceRateLimit: vi.fn(),
				isEnvironmentGenerationEnabled: () => true,
				ensureFreeCredits,
				loadAccess,
			},
		);

		expect(ensureFreeCredits).toHaveBeenCalledWith("user-1");
		expect(callOrder).toEqual(["grant", "access"]);
	});

	it("requires an owned READY image asset for image-to-image input", () => {
		expect(isUsableGenerationSourceAsset(IMAGE_EDIT_INPUT, { mimeType: "image/png" })).toBe(true);
		expect(isUsableGenerationSourceAsset(IMAGE_EDIT_INPUT, { mimeType: "video/mp4" })).toBe(false);
		expect(isUsableGenerationSourceAsset(IMAGE_EDIT_INPUT, null)).toBe(false);
	});

	it.each([
		["free", 10 * 1024 * 1024, true],
		["free", 10 * 1024 * 1024 + 1, false],
		["creator", 20 * 1024 * 1024, true],
		["creator", 20 * 1024 * 1024 + 1, false],
		["studio", 20 * 1024 * 1024, true],
		["studio", 20 * 1024 * 1024 + 1, false],
	] as const)(
		"enforces the %s image input boundary at %s bytes",
		async (planId, sourceAssetBytes, allowed) => {
			const assertion = assertGenerationAllowed(
				{
					userId: "user-1",
					productKey: FREE_IMAGE_PRODUCT,
					credits: 5n,
					costMicros: 20_000n,
					input: IMAGE_EDIT_INPUT,
				},
				{
					enforceRateLimit: vi.fn(),
					isEnvironmentGenerationEnabled: () => true,
					loadAccess: vi.fn(async () => ({
						...BASE_SNAPSHOT,
						planId,
						sourceAssetBytes: BigInt(sourceAssetBytes),
					})),
				},
			);

			if (allowed) await expect(assertion).resolves.toBeUndefined();
			else await expect(assertion).rejects.toThrow("INPUT_TOO_LARGE");
		},
	);

	it("authorizes the implemented Kie quality-video product when no runtime override disables it", () => {
		expect(isCatalogModelEnabled("video-quality", false)).toBe(true);
		expect(isCatalogModelEnabled("video-quality", true)).toBe(false);
	});

	it.each([
		["kill switch", { generationEnabled: false }, "MODEL_DISABLED"],
		["disabled model", { modelDisabled: true }, "MODEL_DISABLED"],
		["daily budget", { dailyCostMicros: 25_000_000n }, "BUDGET_EXCEEDED"],
		[
			"global daily Provider budget",
			{ globalDailyCostMicros: 249_999_000n, maximumGlobalDailyCostMicros: 250_000_000n },
			"BUDGET_EXCEEDED",
		],
		[
			"storage quota",
			{ storageUsageBytes: 100n, maximumStorageBytes: 100n },
			"STORAGE_QUOTA_EXCEEDED",
		],
		["source asset", { sourceAssetReady: false }, "ASSET_NOT_READY"],
		["credits", { spendableCredits: 1n }, "INSUFFICIENT_CREDITS"],
	] as const)("rejects %s before a generation write", async (_case, override, code) => {
		await expect(
			assertGenerationAllowed(
				{
					userId: "user-1",
					productKey: PAID_IMAGE_PRODUCT,
					credits: 9n,
					costMicros: 40_000n,
					input: IMAGE_EDIT_INPUT,
				},
				{
					enforceRateLimit: vi.fn(),
					isEnvironmentGenerationEnabled: () => true,
					loadAccess: vi.fn(async () => ({ ...BASE_SNAPSHOT, ...override })),
				},
			),
		).rejects.toThrow(code);
	});

	it("uses the route graph supplied by quote/create admission instead of recomputing local process routing", async () => {
		const input = {
			userId: "user-1",
			productKey: FREE_IMAGE_PRODUCT,
			credits: 5n,
			costMicros: 20_000n,
			input: IMAGE_EDIT_INPUT,
		};
		const dependencies = {
			enforceRateLimit: vi.fn(),
			isEnvironmentGenerationEnabled: () => true,
			loadAccess: vi.fn(async () => BASE_SNAPSHOT),
		};

		await expect(
			assertGenerationAllowed(
				{
					...input,
					routeGraphOptions: KIE_IMAGE_ROUTE_GRAPH,
				},
				dependencies,
			),
		).resolves.toBeUndefined();
		await expect(
			assertGenerationAllowed(
				{
					...input,
					routeGraphOptions: { enabledProviders: new Set(), generationEnabled: true },
				},
				dependencies,
			),
		).rejects.toThrow("MODEL_DISABLED");
	});

	it("preserves a stable rate-limit code", async () => {
		await expect(
			assertGenerationAllowed(
				{
					userId: "user-1",
					productKey: FREE_IMAGE_PRODUCT,
					credits: 5n,
					costMicros: 20_000n,
					input: IMAGE_EDIT_INPUT,
				},
				{
					enforceRateLimit: vi.fn(async () => {
						throw new Error("RATE_LIMITED");
					}),
					isEnvironmentGenerationEnabled: () => true,
					loadAccess: vi.fn(),
				},
			),
		).rejects.toThrow("RATE_LIMITED");
	});

	it("rejects a positive credit debt before a generation write", async () => {
		await expect(
			assertGenerationAllowed(
				{
					userId: "user-1",
					productKey: FREE_IMAGE_PRODUCT,
					credits: 5n,
					costMicros: 20_000n,
					input: IMAGE_EDIT_INPUT,
				},
				{
					enforceRateLimit: vi.fn(),
					isEnvironmentGenerationEnabled: () => true,
					loadAccess: vi.fn(async () => ({ ...BASE_SNAPSHOT, creditDebt: 1n })),
				},
			),
		).rejects.toThrow("CREDIT_DEBT_OUTSTANDING");
	});

	it("rejects quote and job authorization when the environment generation gate is disabled", async () => {
		const loadAccess = vi.fn(async () => BASE_SNAPSHOT);
		await expect(
			assertGenerationAllowed(
				{
					userId: "user-1",
					productKey: FREE_IMAGE_PRODUCT,
					credits: 5n,
					costMicros: 20_000n,
					input: IMAGE_EDIT_INPUT,
				},
				{
					enforceRateLimit: vi.fn(),
					isEnvironmentGenerationEnabled: () => false,
					loadAccess,
				},
			),
		).rejects.toThrow("MODEL_DISABLED");
		expect(loadAccess).not.toHaveBeenCalled();
	});

	it("rejects stale catalog and pricing versions", async () => {
		await expect(
			assertGenerationAllowed(
				{
					userId: "user-1",
					productKey: FREE_IMAGE_PRODUCT,
					credits: 5n,
					costMicros: 20_000n,
					input: IMAGE_EDIT_INPUT,
					catalogVersion: "2025-01-01.1",
					pricingVersion: "2025-01-01.1",
				},
				{
					enforceRateLimit: vi.fn(),
					isEnvironmentGenerationEnabled: () => true,
					loadAccess: vi.fn(async () => BASE_SNAPSHOT),
				},
			),
		).rejects.toThrow("PRICE_CHANGED");
	});

	it("keeps quote checks prospective but leaves create daily-budget admission to its transaction", async () => {
		const input = {
			userId: "user-1",
			productKey: FREE_IMAGE_PRODUCT,
			credits: 5n,
			costMicros: 20_000n,
			input: IMAGE_EDIT_INPUT,
		};
		const dependencies = {
			enforceRateLimit: vi.fn(),
			isEnvironmentGenerationEnabled: () => true,
			loadAccess: vi.fn(async () => ({ ...BASE_SNAPSHOT, dailyCostMicros: 25_000_000n })),
		};
		await expect(assertGenerationAllowed(input, dependencies)).rejects.toThrow("BUDGET_EXCEEDED");
		await expect(
			assertGenerationAllowed({ ...input, enforceProspectiveDailyBudget: false }, dependencies),
		).resolves.toBeUndefined();
	});
});

describe("server generation flood receipt", () => {
	const input = {
		userId: "owner",
		productKey: FREE_IMAGE_PRODUCT,
		credits: 5n,
		costMicros: 20_000n,
		input: IMAGE_EDIT_INPUT,
		routeGraphOptions: KIE_IMAGE_ROUTE_GRAPH,
	};
	function dependencies(snapshot: Partial<GenerationAccessSnapshot> = {}) {
		return {
			enforceRateLimit: vi.fn(async () => undefined),
			isEnvironmentGenerationEnabled: () => true,
			loadAccess: vi.fn(async () => ({ ...BASE_SNAPSHOT, ...snapshot })),
		};
	}
	it("issues only after the guard succeeds and rechecks mutable eligibility on every use", async () => {
		const deps = dependencies();
		const receipt = await createGenerationRateLimitReceipt("owner", deps.enforceRateLimit);
		expect(Object.isFrozen(receipt)).toBe(true);
		await assertGenerationAllowed({ ...input, rateLimitReceipt: receipt }, deps);
		await assertGenerationAllowed({ ...input, rateLimitReceipt: receipt }, deps);
		expect(deps.enforceRateLimit).toHaveBeenCalledExactlyOnceWith("owner", "media:generation");
		expect(deps.loadAccess).toHaveBeenCalledTimes(2);
	});
	it("keeps a pass independent of credits while rechecking its balance and debt after a valid flood receipt", async () => {
		const snapshot = {
			...BASE_SNAPSHOT,
			planId: "creator" as const,
			spendableCredits: 0n,
			imagePassAvailable: true,
			storageUsageBytes: 100_000_000_000n,
			maximumStorageBytes: null,
		};
		const deps = dependencies(snapshot);
		const receipt = await createGenerationRateLimitReceipt("owner", deps.enforceRateLimit);
		const request = {
			...input,
			productKey: "image-nano-banana-pro" as const,
			credits: 25n,
			fundingSource: "IMAGE_PASS" as const,
			input: {
				kind: "text-to-image" as const,
				prompt: "A vase",
				skuKey: "nano-banana-pro-4k" as const,
			},
			rateLimitReceipt: receipt,
		};
		await expect(assertGenerationAllowed(request, deps)).resolves.toBeUndefined();
		deps.loadAccess.mockResolvedValueOnce({
			...snapshot,
			imagePassAvailable: false,
			spendableCredits: 1000n,
		});
		await expect(assertGenerationAllowed(request, deps)).rejects.toThrow("IMAGE_PASS_INSUFFICIENT");
		deps.loadAccess.mockResolvedValueOnce({ ...snapshot, creditDebt: 1n });
		await expect(assertGenerationAllowed(request, deps)).rejects.toThrow("CREDIT_DEBT_OUTSTANDING");
		expect(deps.enforceRateLimit).toHaveBeenCalledExactlyOnceWith("owner", "media:generation");
		expect(deps.loadAccess).toHaveBeenCalledTimes(3);
	});
	it("never issues a receipt when the real flood guard denies the request", async () => {
		const enforce = vi.fn(async () => {
			throw new Error("RATE_LIMITED");
		});
		await expect(createGenerationRateLimitReceipt("owner", enforce)).rejects.toThrow(
			"RATE_LIMITED",
		);
		expect(enforce).toHaveBeenCalledExactlyOnceWith("owner", "media:generation");
	});
	it("rejects JSON copies, symbol copies and another owner's receipt before loading eligibility", async () => {
		const deps = dependencies();
		const receipt = await createGenerationRateLimitReceipt("other-owner", deps.enforceRateLimit);
		const ownerReceipt = await createGenerationRateLimitReceipt("owner", deps.enforceRateLimit);
		for (const invalid of [
			receipt,
			JSON.parse(JSON.stringify(ownerReceipt)),
			{ ...ownerReceipt },
		]) {
			await expect(
				assertGenerationAllowed({ ...input, rateLimitReceipt: invalid }, deps),
			).rejects.toThrow("NOT_FOUND");
		}
		expect(deps.loadAccess).not.toHaveBeenCalled();
		expect(deps.enforceRateLimit).toHaveBeenCalledTimes(2);
	});
	it("does not reuse a generation receipt to bypass the independent quote flood guard", async () => {
		const deps = dependencies();
		const receipt = await createGenerationRateLimitReceipt("owner", deps.enforceRateLimit);
		await expect(
			assertGenerationAllowed(
				{ ...input, rateLimitAction: "media:quote", rateLimitReceipt: receipt },
				deps,
			),
		).rejects.toThrow("NOT_FOUND");
		expect(deps.loadAccess).not.toHaveBeenCalled();
	});
	it.each([
		[{ creditDebt: 1n }, "CREDIT_DEBT_OUTSTANDING"],
		[{ spendableCredits: 4n }, "INSUFFICIENT_CREDITS"],
		[{ sourceAssetReady: false }, "ASSET_NOT_READY"],
		[{ modelDisabled: true }, "MODEL_DISABLED"],
		[{ storageUsageBytes: BASE_SNAPSHOT.maximumStorageBytes }, "STORAGE_QUOTA_EXCEEDED"],
	] as const)("keeps the %s eligibility check after a valid receipt", async (snapshot, code) => {
		const deps = dependencies(snapshot);
		const receipt = await createGenerationRateLimitReceipt("owner", deps.enforceRateLimit);
		await expect(
			assertGenerationAllowed({ ...input, rateLimitReceipt: receipt }, deps),
		).rejects.toThrow(code);
		expect(deps.loadAccess).toHaveBeenCalledOnce();
		expect(deps.enforceRateLimit).toHaveBeenCalledOnce();
	});
	it("keeps the normal generation and retry guard when no server receipt is present", async () => {
		const deps = dependencies();
		await assertGenerationAllowed(input, deps);
		expect(deps.enforceRateLimit).toHaveBeenCalledExactlyOnceWith("owner", "media:generation");
	});
});
