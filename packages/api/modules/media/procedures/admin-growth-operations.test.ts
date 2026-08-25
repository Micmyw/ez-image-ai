import { call } from "@orpc/server";
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
	productKey: "image-quality" as const,
	provider: "fal",
	model: "fal-ai/flux-pro/kontext",
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
			{ ...validInput, provider: "provider with spaces" },
			{ ...validInput, model: "https://provider.example/private-model" },
			{
				...validInput,
				from: "2026-08-26T00:00:00.000Z",
				to: "2026-08-25T00:00:00.000Z",
			},
			{
				productKey: validInput.productKey,
				provider: validInput.provider,
				model: validInput.model,
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
				averageProviderCostMicros: "125000",
				moderationRejectionRate: 0.2,
				repeatEditRate: 0.5,
			},
			credits: { reserved: "40", charged: "30", released: "10" },
			failureCodes: [{ code: "PROVIDER_FAILED", count: 1 }],
			routes: [
				{
					productKey: "image-quality",
					provider: "fal",
					model: "fal-ai/flux-pro/kontext",
					status: "SUCCEEDED",
					jobs: 3,
				},
			],
			controls: {
				generationEnabled: true,
				products: [
					{ productKey: "image-fast", publicName: "Standard Edit", enabled: true },
					{ productKey: "image-quality", publicName: "Quality Edit", enabled: false },
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
		);
		expect(result.summary).toMatchObject({
			jobs: 4,
			successRate: 0.75,
			latencyMs: { p50: 2_000, p95: 8_000 },
		});
		expect(
			result.controls.products.map(
				({ publicName }: { publicName: "Standard Edit" | "Quality Edit" }) => publicName,
			),
		).toEqual(["Standard Edit", "Quality Edit"]);
		expect(JSON.stringify(result)).not.toMatch(
			/prompt|signedUrl|signature|raw_job_id|providerResponse|secret|objectKey|sourceUrl/i,
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
			generatedAt: "2026-08-25T00:00:00.000Z",
			summary: {
				jobs: 1,
				succeeded: 0,
				failed: 1,
				successRate: 0,
				latencyMs: { p50: null, p95: null },
				averageProviderCostMicros: null,
				moderationRejectionRate: null,
				repeatEditRate: null,
			},
			credits: { reserved: "1", charged: "0", released: "1" },
			failureCodes: [{ code: "https://private.example/raw-provider-error", count: 1 }],
			routes: [],
			controls: {
				generationEnabled: true,
				products: [
					{ productKey: "image-fast", publicName: "Standard Edit", enabled: true },
					{ productKey: "image-quality", publicName: "Quality Edit", enabled: true },
				],
			},
		} as never);

		await expect(call(adminGrowthOperations, validInput, context)).rejects.toBeDefined();
	});
});
