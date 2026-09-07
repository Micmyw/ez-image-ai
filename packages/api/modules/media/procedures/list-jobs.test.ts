import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), findMany: vi.fn() }));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@repo/database/client", () => ({
	db: { generationJob: { findMany: mocks.findMany } },
}));

import { listJobs } from "./list-jobs";

function job(input: { id: string; productKey: string; inputSnapshot: Record<string, unknown> }) {
	return {
		...input,
		status: "SUCCEEDED",
		version: 2,
		creditsReserved: 17n,
		reservation: { settledAmount: 17n, releasedAmount: 0n },
		assets: [{ assetId: `${input.id}-output` }],
		createdAt: new Date("2026-09-07T08:00:00.000Z"),
	};
}

describe("listJobs", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSession.mockResolvedValue({
			user: { id: "user-1" },
			session: { id: "session-1" },
		} as never);
	});

	it("returns matrix-validated current selections and keeps legacy jobs unclassified", async () => {
		mocks.findMany.mockResolvedValue([
			job({
				id: "job-current",
				productKey: "image-gpt-image-2",
				inputSnapshot: {
					kind: "image-to-image",
					prompt: "Current",
					sourceAssetId: "asset-current",
					skuKey: "gpt-image-2-4k",
					aspectRatio: "4:5",
					providerModelId: "must-not-leak",
				},
			}),
			job({
				id: "job-legacy",
				productKey: "image-quality",
				inputSnapshot: {
					kind: "image-to-image",
					prompt: "Legacy",
					sourceAssetId: "asset-legacy",
					aspectRatio: "1:1",
				},
			}),
		] as never);

		const result = await call(listJobs, {}, { context: { headers: new Headers() } });

		expect(result.items).toEqual([
			expect.objectContaining({
				id: "job-current",
				productKey: "image-gpt-image-2",
				skuKey: "gpt-image-2-4k",
				aspectRatio: "4:5",
			}),
			expect.objectContaining({
				id: "job-legacy",
				productKey: "image-quality",
				skuKey: null,
				aspectRatio: null,
			}),
		]);
		expect(JSON.stringify(result)).not.toMatch(/provider|cost|prompt|sourceAsset/i);
	});

	it("scopes a current-product filter to the authenticated user", async () => {
		mocks.findMany.mockResolvedValue([]);

		await call(
			listJobs,
			{ productKey: "image-seedream-5-pro", status: "succeeded" },
			{ context: { headers: new Headers() } },
		);

		expect(mocks.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					ownerType: "USER",
					ownerId: "user-1",
					productKey: "image-seedream-5-pro",
					status: "SUCCEEDED",
				}),
			}),
		);
	});
});
