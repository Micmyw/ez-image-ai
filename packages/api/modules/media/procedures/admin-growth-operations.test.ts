import { call } from "@orpc/server";
import { EZPIC_PRODUCT_KEYS, IMAGE_SKU_KEYS } from "@repo/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({ getAdminGrowthOperations: vi.fn() }));
vi.mock("@repo/database/client", () => ({ db: {} }));

import { auth } from "@repo/auth";
import * as database from "@repo/database";

import * as diagnostics from "./admin-diagnostics";

const context = { context: { headers: new Headers() } };
const adminGrowthOperations = (
	diagnostics as typeof diagnostics & { adminGrowthOperations?: Parameters<typeof call>[0] }
).adminGrowthOperations;
const getAdminGrowthOperations = (
	database as typeof database & {
		getAdminGrowthOperations?: ReturnType<typeof vi.fn>;
	}
).getAdminGrowthOperations;

const validInput = {
	productKey: "image-gpt-image-2" as const,
	skuKey: "gpt-image-2-4k" as const,
	status: "SUCCEEDED" as const,
	from: "2026-08-01T00:00:00.000Z",
	to: "2026-08-25T00:00:00.000Z",
};

describe("admin growth operations procedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("rejects non-admin callers before executing the aggregate query", async () => {
		expect(adminGrowthOperations).toBeDefined();
		expect(getAdminGrowthOperations).toBeTypeOf("function");
		if (!adminGrowthOperations || !getAdminGrowthOperations) return;
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "user_1", role: "user" },
			session: { id: "session_1" },
		} as never);

		await expect(call(adminGrowthOperations, validInput, context)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(getAdminGrowthOperations).not.toHaveBeenCalled();
	});

	it("accepts only EzPic products and a forward date range", async () => {
		expect(adminGrowthOperations).toBeDefined();
		expect(getAdminGrowthOperations).toBeTypeOf("function");
		if (!adminGrowthOperations || !getAdminGrowthOperations) return;
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "admin_1", role: "admin" },
			session: { id: "session_1" },
		} as never);

		for (const input of [
			{ ...validInput, productKey: "video-fast" },
			{ ...validInput, skuKey: "seedream-5-pro-high-2k" },
			{ ...validInput, provider: "provider-must-not-be-client-selectable" },
			{ ...validInput, model: "private-model-must-not-be-client-selectable" },
			{
				...validInput,
				from: "2026-08-26T00:00:00.000Z",
				to: "2026-08-25T00:00:00.000Z",
			},
			{
				productKey: validInput.productKey,
				skuKey: validInput.skuKey,
				status: validInput.status,
				from: "2000-01-01T00:00:00.000Z",
			},
		]) {
			await expect(call(adminGrowthOperations, input as never, context)).rejects.toBeDefined();
		}
		expect(getAdminGrowthOperations).not.toHaveBeenCalled();
	});

	it("passes filters to one read-only query and strips private fields from its DTO", async () => {
		expect(adminGrowthOperations).toBeDefined();
		expect(getAdminGrowthOperations).toBeTypeOf("function");
		if (!adminGrowthOperations || !getAdminGrowthOperations) return;
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "admin_1", role: "admin" },
			session: { id: "session_1" },
		} as never);
		getAdminGrowthOperations.mockResolvedValue({
			generatedAt: "2026-08-25T00:00:00.000Z",
			summary: {
				jobs: 4,
				succeeded: 3,
				failed: 1,
				successRate: 0.75,
				latencyMs: { p50: 2_000, p95: 8_000 },
				moderationRejectionRate: 0.2,
				repeatEditRate: 0.5,
			},
			credits: { reserved: "40", charged: "30", released: "10" },
			failureCodes: [{ code: "PROVIDER_FAILED", count: 1 }],
			skuBreakdown: [
				{
					productKey: "image-gpt-image-2",
					skuKey: "gpt-image-2-4k",
					status: "SUCCEEDED",
					jobs: 3,
				},
			],
			controls: {
				generationEnabled: true,
				products: [
					{
						productKey: "image-nano-banana-2-lite",
						publicName: "Nano Banana 2 Lite",
						enabled: true,
					},
					{
						productKey: "image-gpt-image-2",
						publicName: "GPT Image 2",
						enabled: false,
					},
					{
						productKey: "image-seedream-5-pro",
						publicName: "Seedream 5 Pro",
						enabled: true,
					},
				],
			},
			prompt: "private prompt must be stripped",
			signedUrl: "https://private.example/output?signature=secret",
			jobId: "raw_job_id",
			providerResponse: { secret: "must be stripped" },
		} as never);

		const result = await call(adminGrowthOperations, validInput, context);

		expect(getAdminGrowthOperations).toHaveBeenCalledWith(
			{
				...validInput,
				from: new Date(validInput.from),
				to: new Date(validInput.to),
				generationEnabled: true,
			},
			expect.anything(),
			expect.arrayContaining([
				expect.objectContaining({
					productKey: "image-gpt-image-2",
					publicName: "GPT Image 2",
					skuCells: expect.arrayContaining([expect.objectContaining({ skuKey: "gpt-image-2-1k" })]),
				}),
			]),
		);
		expect(JSON.stringify(getAdminGrowthOperations.mock.calls[0]?.[2])).not.toMatch(
			/provider|modelId|cost|credential|secret/i,
		);
		const safeProducts = getAdminGrowthOperations.mock.calls[0]?.[2] as Array<{
			productKey: string;
			skuCells: Array<{ skuKey: string }>;
		}>;
		expect(safeProducts.map(({ productKey }) => productKey)).toEqual(EZPIC_PRODUCT_KEYS);
		expect(safeProducts.every(({ skuCells }) => skuCells.length > 0)).toBe(true);
		const safeSkuKeys = safeProducts.flatMap(({ skuCells }) =>
			skuCells.map(({ skuKey }) => skuKey),
		);
		expect(safeSkuKeys).toHaveLength(IMAGE_SKU_KEYS.length);
		expect(safeSkuKeys).toEqual(expect.arrayContaining([...IMAGE_SKU_KEYS]));
		expect(result.summary).toMatchObject({
			jobs: 4,
			successRate: 0.75,
			latencyMs: { p50: 2_000, p95: 8_000 },
		});
		expect(
			result.controls.products.map(({ publicName }: { publicName: string }) => publicName),
		).toEqual(["Nano Banana 2 Lite", "GPT Image 2", "Seedream 5 Pro"]);
		expect(Object.keys(result).sort()).toEqual(
			["summary", "credits", "failureCodes", "skuBreakdown", "controls"].sort(),
		);
		expect(JSON.stringify(result)).not.toMatch(
			/prompt|signedUrl|signature|raw_job_id|"provider(?:ModelId|Response|CostMicros)?":|"model":|"costMicros":|secret|objectKey|sourceUrl/i,
		);
	});

	it("fails closed if the data layer returns raw text instead of a normalized failure code", async () => {
		expect(adminGrowthOperations).toBeDefined();
		expect(getAdminGrowthOperations).toBeTypeOf("function");
		if (!adminGrowthOperations || !getAdminGrowthOperations) return;
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "admin_1", role: "admin" },
			session: { id: "session_1" },
		} as never);
		getAdminGrowthOperations.mockResolvedValue({
			summary: {
				jobs: 1,
				succeeded: 0,
				failed: 1,
				successRate: 0,
				latencyMs: { p50: null, p95: null },
				moderationRejectionRate: null,
				repeatEditRate: null,
			},
			credits: { reserved: "1", charged: "0", released: "1" },
			failureCodes: [{ code: "https://private.example/raw-provider-error", count: 1 }],
			skuBreakdown: [],
			controls: {
				generationEnabled: true,
				products: [
					{
						productKey: "image-nano-banana-2-lite",
						publicName: "Nano Banana 2 Lite",
						enabled: true,
					},
					{
						productKey: "image-gpt-image-2",
						publicName: "GPT Image 2",
						enabled: true,
					},
					{
						productKey: "image-seedream-5-pro",
						publicName: "Seedream 5 Pro",
						enabled: true,
					},
				],
			},
		} as never);

		await expect(call(adminGrowthOperations, validInput, context)).rejects.toBeDefined();
	});
});
