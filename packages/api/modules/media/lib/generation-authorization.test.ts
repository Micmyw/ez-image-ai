import { describe, expect, it, vi } from "vitest";

import {
	assertGenerationAllowed,
	isCatalogModelEnabled,
	type GenerationAccessSnapshot,
} from "./generation-authorization";

const BASE_SNAPSHOT: GenerationAccessSnapshot = {
	generationEnabled: true,
	modelEnabled: true,
	spendableCredits: 100n,
	creditDebt: 0n,
	dailyCostMicros: 0n,
	storageUsageBytes: 0n,
	maximumStorageBytes: 2n * 1024n * 1024n * 1024n,
	planId: "studio",
	sourceAssetReady: true,
};

describe("generation authorization", () => {
	it("authorizes the implemented Kie quality-video product when no runtime override disables it", () => {
		expect(isCatalogModelEnabled("video-quality", false)).toBe(true);
		expect(isCatalogModelEnabled("video-quality", true)).toBe(false);
	});

	it.each([
		["kill switch", { generationEnabled: false }, "MODEL_DISABLED"],
		["disabled model", { modelEnabled: false }, "MODEL_DISABLED"],
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
					productKey: "video-fast",
					credits: 25n,
					costMicros: 100_000n,
					input: { kind: "text-to-video", prompt: "x" },
				},
				{
					enforceRateLimit: vi.fn(),
					isEnvironmentGenerationEnabled: () => true,
					loadAccess: vi.fn(async () => ({ ...BASE_SNAPSHOT, ...override })),
				},
			),
		).rejects.toThrow(code);
	});

	it("preserves a stable rate-limit code", async () => {
		await expect(
			assertGenerationAllowed(
				{
					userId: "user-1",
					productKey: "image-fast",
					credits: 4n,
					costMicros: 3_000n,
					input: { kind: "text-to-image", prompt: "x" },
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
					input: { kind: "text-to-image", prompt: "x" },
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
					input: { kind: "text-to-image", prompt: "x" },
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
					input: { kind: "text-to-image", prompt: "x" },
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
			input: { kind: "text-to-image" as const, prompt: "x" },
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
