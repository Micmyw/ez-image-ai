import { describe, expect, it, vi } from "vitest";
vi.mock("../../client", () => ({
	getDatabaseClient: () => {
		throw new Error("explicit test transport required");
	},
}));
import { KIE_SENSITIVE_REJECTION_MESSAGE } from "@repo/config";
import { getImagePassOfferSnapshot, IMAGE_PASS_LEGACY_OFFER } from "@repo/config/image-pass";

import {
	assertImagePassAvailable,
	assertImagePassSelection,
	generationFundingSource,
	reserveImagePassForJobInTransaction,
} from "./image-passes";
import { canSettleKieZeroCostRejection } from "./kie-zero-cost-rejection";

describe("image-pass funding contract", () => {
	it.each([
		{ snapshot: getImagePassOfferSnapshot(), allowed: true },
		{ snapshot: IMAGE_PASS_LEGACY_OFFER, allowed: false },
		{
			snapshot: { ...IMAGE_PASS_LEGACY_OFFER, subscriptionPolicy: "not-required" },
			allowed: false,
		},
		{
			snapshot: { ...getImagePassOfferSnapshot(), allowedSkuKeys: ["nano-banana-pro-4k"] },
			allowed: false,
		},
	])(
		"requires the complete trusted new offer for subscription-free access ($allowed)",
		async ({ snapshot, allowed }) => {
			const result = assertImagePassAvailable(
				{
					ownerId: "owner",
					productKey: "image-nano-banana-pro",
					skuKey: "nano-banana-pro-4k",
					requireModelAccess: true,
				},
				{
					$queryRaw: vi.fn(async () => [{ id: "unit", offerSnapshot: snapshot }]),
				} as never,
			);
			if (allowed) await expect(result).resolves.toBeUndefined();
			else await expect(result).rejects.toThrow("IMAGE_PASS_INSUFFICIENT");
		},
	);
	it("preserves an accepted reservation before subscription rechecks or grant selection", async () => {
		const reservation = {
			id: "reservation",
			amount: 1n,
			status: "ACTIVE",
			fundingSource: "IMAGE_PASS",
		};
		const tx = {
			$executeRaw: vi.fn(async () => 1),
			$queryRaw: vi
				.fn()
				.mockResolvedValueOnce([
					{
						ownerId: "owner",
						ownerType: "USER",
						fundingSource: "IMAGE_PASS",
						creditsReserved: 0n,
						productKey: "image-nano-banana-pro",
						pricingSnapshot: {
							fundingSource: "IMAGE_PASS",
							skuKey: "nano-banana-pro-4k",
							settlementPolicy: { requestedOutputCount: 1 },
						},
						status: "RUNNING",
					},
				])
				.mockResolvedValueOnce([reservation]),
			subscription: { findMany: vi.fn() },
		};
		await expect(
			reserveImagePassForJobInTransaction({ ownerId: "owner", jobId: "job" }, tx as never),
		).resolves.toEqual(reservation);
		expect(tx.subscription.findMany).not.toHaveBeenCalled();
		expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
	});
	it("uses post-lock database time to resolve the subscription before choosing a pass", async () => {
		const databaseNow = new Date("2099-01-01T00:00:00Z");
		const tx = {
			$executeRaw: vi.fn(async () => 1),
			$queryRaw: vi
				.fn()
				.mockResolvedValueOnce([
					{
						ownerId: "owner",
						ownerType: "USER",
						fundingSource: "IMAGE_PASS",
						creditsReserved: 0n,
						productKey: "image-nano-banana-pro",
						pricingSnapshot: {
							fundingSource: "IMAGE_PASS",
							skuKey: "nano-banana-pro-4k",
							settlementPolicy: { requestedOutputCount: 1 },
						},
						status: "RESERVED",
					},
				])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([{ now: databaseNow }])
				.mockResolvedValueOnce([
					{ id: "unit", grantId: "grant", offerSnapshot: getImagePassOfferSnapshot() },
				]),
			subscription: { findMany: vi.fn(async () => []) },
			billingPeriod: { fields: { paidAmount: "paidAmount" } },
		};
		await expect(
			reserveImagePassForJobInTransaction({ ownerId: "owner", jobId: "job" }, tx as never),
		).resolves.toMatchObject({ fundingSource: "IMAGE_PASS" });
		expect(tx.subscription.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					OR: expect.arrayContaining([
						expect.objectContaining({ currentPeriodEnd: { gt: databaseNow } }),
					]),
				}),
			}),
		);
		expect(tx.$queryRaw.mock.calls[3].slice(1)).toContain(false);
	});
	it("supports the highest current image SKU as exactly one successful output", () => {
		expect(() =>
			assertImagePassSelection({
				productKey: "image-nano-banana-pro",
				skuKey: "nano-banana-pro-4k",
				requestedOutputCount: 1,
			}),
		).not.toThrow();
	});
	it.each([
		{ productKey: "video-quality", skuKey: "nano-banana-pro-4k", requestedOutputCount: 1 },
		{
			productKey: "image-nano-banana-2-lite",
			skuKey: "nano-banana-pro-4k",
			requestedOutputCount: 1,
		},
		{ productKey: "image-quality", skuKey: "nano-banana-pro-4k", requestedOutputCount: 1 },
	])("rejects a foreign product/SKU combination", (input) => {
		expect(() => assertImagePassSelection(input)).toThrow("IMAGE_PASS_SELECTION_INVALID");
	});
	it.each([0, 2, 3, -1])("rejects requested output count %s", (requestedOutputCount) => {
		expect(() =>
			assertImagePassSelection({
				productKey: "image-nano-banana-pro",
				skuKey: "nano-banana-pro-4k",
				requestedOutputCount,
			}),
		).toThrow("IMAGE_PASS_OUTPUT_COUNT_INVALID");
	});
	it("retains ordinary-credit funding for historical snapshots", () => {
		expect(generationFundingSource({ credits: 25 })).toBe("CREDITS");
		expect(generationFundingSource({ fundingSource: "IMAGE_PASS" })).toBe("IMAGE_PASS");
	});
	it.each([null, "voucher", 0])(
		"fails closed on an explicitly invalid funding source",
		(fundingSource) => {
			expect(() => generationFundingSource({ fundingSource })).toThrow(
				"GENERATION_FUNDING_CONFLICT",
			);
		},
	);
	it("permits a proven zero-cost rejection to release an independent active pass reservation", async () => {
		const attempt = {
			provider: "kie",
			providerTaskId: "task",
			providerModelId: "nano-banana-pro",
			transferEnvelope: null,
			providerResultUrl: null,
			providerCostMicros: 0n,
			responseSnapshot: { providerCharged: false, outputCount: 0 },
			jobId: "pass-job",
			job: {
				id: "pass-job",
				executionEngine: "legacy",
				productKey: "image-nano-banana-pro",
				reservation: null,
				_count: { attempts: 1, assets: 0 },
			},
		};
		const tx = {
			generationAttempt: { findUnique: async () => attempt },
			$queryRaw: async () => [
				{ id: "pass-hold", amount: 1n, status: "ACTIVE", fundingSource: "IMAGE_PASS" },
			],
		};
		expect(
			await canSettleKieZeroCostRejection(
				"attempt",
				{
					version: 1,
					provider: "kie",
					source: "record-info",
					taskId: "task",
					state: "fail",
					failCode: "400",
					failMsg: KIE_SENSITIVE_REJECTION_MESSAGE,
					consumptionField: "creditsConsumed",
					consumedCredits: 0,
					outputCount: 0,
					observedAt: new Date().toISOString(),
				},
				tx as never,
			),
		).toBe(true);
	});
});
