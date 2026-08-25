import { describe, expect, it, vi } from "vitest";

import {
	assertGenerationAllowed,
	isCatalogModelEnabled,
	isUsableGenerationSourceAsset,
	type GenerationAccessSnapshot,
} from "./generation-authorization";

const IMAGE_EDIT_INPUT = {
	kind: "image-to-image" as const,
	prompt: "x",
	sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
};

const BASE_SNAPSHOT: GenerationAccessSnapshot = {
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
};

describe("generation authorization", () => {
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
				productKey: "image-fast",
				credits: 4n,
				costMicros: 3_000n,
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
					productKey: "image-fast",
					credits: 4n,
					costMicros: 3_000n,
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
			"storage quota",
			{ storageUsageBytes: 100n, maximumStorageBytes: 100n },
			"STORAGE_QUOTA_EXCEEDED",
		],
		["plan entitlement", { planId: "free" }, "ENTITLEMENT_REQUIRED"],
		["source asset", { sourceAssetReady: false }, "ASSET_NOT_READY"],
		["credits", { spendableCredits: 1n }, "INSUFFICIENT_CREDITS"],
	] as const)("rejects %s before a generation write", async (_case, override, code) => {
		await expect(
			assertGenerationAllowed(
				{
					userId: "user-1",
					productKey: "image-quality",
					credits: 10n,
					costMicros: 8_000n,
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
			productKey: "image-fast" as const,
			credits: 4n,
			costMicros: 3_000n,
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
					routeGraphOptions: {
						enabledProviders: new Set(["replicate"]),
						generationEnabled: true,
					},
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
					productKey: "image-fast",
					credits: 4n,
					costMicros: 3_000n,
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
					productKey: "image-fast",
					credits: 4n,
					costMicros: 3_000n,
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
					productKey: "image-fast",
					credits: 4n,
					costMicros: 3_000n,
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
					productKey: "image-fast",
					credits: 4n,
					costMicros: 3_000n,
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
			productKey: "image-fast" as const,
			credits: 4n,
			costMicros: 60n,
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
