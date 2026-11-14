import { describe, expect, it, vi } from "vitest";
vi.mock("../../client", () => ({
	getDatabaseClient: () => {
		throw new Error("explicit test transport required");
	},
}));
import { KIE_SENSITIVE_REJECTION_MESSAGE } from "@repo/config";
import {
	getImagePassOfferSnapshot,
	IMAGE_PASS_LEGACY_OFFER,
	IMAGE_PASS_STANDARD_OFFER,
	IMAGE_PASS_GPT_IMAGE_26_BENEFIT_POLICY,
} from "@repo/config/image-pass";

import {
	assertImagePassAvailable,
	assertImagePassSelection,
	generationFundingSource,
	getImagePassBalance,
	reserveImagePassForJobInTransaction,
} from "./image-passes";
import { canSettleKieZeroCostRejection } from "./kie-zero-cost-rejection";

describe("image-pass funding contract", () => {
	it.each([IMAGE_PASS_LEGACY_OFFER, IMAGE_PASS_STANDARD_OFFER, getImagePassOfferSnapshot()])(
		"allows every existing pack cohort for Sheru's 1K model without a subscription",
		async (offerSnapshot) => {
			// In-memory transport only; this unit test never connects to a database.
			const tx = { $queryRaw: vi.fn(async () => [{ id: "unit", offerSnapshot }]) };
			await expect(
				assertImagePassAvailable(
					{
						ownerId: "owner",
						productKey: "image-nano-banana-2",
						skuKey: "nano-banana-2-1k",
						requireModelAccess: true,
					},
					tx as never,
				),
			).resolves.toBeUndefined();
			expect(tx.$queryRaw).toHaveBeenCalledOnce();
		},
	);
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

describe("GPT Image 2.6 pass admission", () => {
	const policy = IMAGE_PASS_GPT_IMAGE_26_BENEFIT_POLICY;
	const selection = {
		ownerId: "owner",
		productKey: "image-gpt-image-2-6-flare",
		skuKey: "gpt-image-2-6-flare-1k",
		imagePassBenefitPolicy: policy,
		outputFormat: "gif",
		requireModelAccess: true,
	};
	it.each([
		getImagePassOfferSnapshot(),
		IMAGE_PASS_LEGACY_OFFER,
		IMAGE_PASS_STANDARD_OFFER,
		{ ...getImagePassOfferSnapshot(), allowedSkuKeys: [...policy.addedSkuKeys] },
		{ ...getImagePassOfferSnapshot(), amount: "1.00" },
	])(
		"requires the complete USD 2.99 offer, even with a paid subscription: %j",
		async (offerSnapshot) => {
			for (const requireModelAccess of [true, false]) {
				const tx = { $queryRaw: vi.fn(async () => [{ id: "unit", offerSnapshot }]) };
				const result = assertImagePassAvailable({ ...selection, requireModelAccess }, tx as never);
				if (JSON.stringify(offerSnapshot) === JSON.stringify(getImagePassOfferSnapshot()))
					await expect(result).resolves.toBeUndefined();
				else await expect(result).rejects.toThrow("IMAGE_PASS_INSUFFICIENT");
			}
		},
	);
	it.each([
		undefined,
		null,
		{ ...policy, version: "unreviewed-v2" },
		{ ...policy, unitsPerSuccessfulOutput: 0 },
	])(
		"rejects missing/forged policy before looking up a grant %j",
		async (imagePassBenefitPolicy) => {
			const tx = { $queryRaw: vi.fn() };
			await expect(
				assertImagePassAvailable({ ...selection, imagePassBenefitPolicy }, tx as never),
			).rejects.toThrow("IMAGE_PASS_SELECTION_INVALID");
			expect(tx.$queryRaw).not.toHaveBeenCalled();
		},
	);
	it.each(["png", "jpeg", "svg", "gif"])(
		"rechecks frozen %s coverage under owner and job locks before reserving one unit",
		async (outputFormat) => {
			const events: string[] = [];
			const tx = {
				$executeRaw: vi.fn(async (parts: TemplateStringsArray) => {
					events.push(parts.join("?"));
					return 1;
				}),
				$queryRaw: vi
					.fn()
					.mockImplementationOnce(async (parts: TemplateStringsArray) => {
						events.push(parts.join("?"));
						return [
							{
								ownerId: "owner",
								ownerType: "USER",
								fundingSource: "IMAGE_PASS",
								creditsReserved: 0n,
								productKey: selection.productKey,
								status: "RESERVED",
								inputSnapshot: { outputFormat },
								pricingSnapshot: {
									fundingSource: "IMAGE_PASS",
									skuKey: selection.skuKey,
									imagePassBenefitPolicy: policy,
									settlementPolicy: { requestedOutputCount: 1 },
								},
							},
						];
					})
					.mockResolvedValueOnce([])
					.mockResolvedValueOnce([{ now: new Date("2099-01-01T00:00:00Z") }])
					.mockResolvedValueOnce([
						{ id: "unit", grantId: "grant", offerSnapshot: getImagePassOfferSnapshot() },
					]),
				subscription: { findMany: vi.fn(async () => []) },
				billingPeriod: { fields: { paidAmount: "paidAmount" } },
			};
			await expect(
				reserveImagePassForJobInTransaction({ ownerId: "owner", jobId: "job" }, tx as never),
			).resolves.toMatchObject({ fundingSource: "IMAGE_PASS", amount: 1n });
			expect(events[0]).toContain("pg_advisory_xact_lock");
			expect(events[1]).toContain("FOR UPDATE");
			const [parts, ...parameters] = tx.$queryRaw.mock.calls[3] as unknown as [
				TemplateStringsArray,
				...unknown[],
			];
			expect(parts.join("?")).toContain("FOR UPDATE OF unit,g");
			expect(parameters).toContain(JSON.stringify(getImagePassOfferSnapshot()));
			expect(parameters).toContain(true);
			expect(tx.$executeRaw).toHaveBeenCalledTimes(4);
		},
	);
	it.each([undefined, { ...policy, version: "unknown" }])(
		"never upgrades unreserved historical/unknown snapshots %j",
		async (imagePassBenefitPolicy) => {
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
							productKey: selection.productKey,
							status: "RESERVED",
							inputSnapshot: { outputFormat: "gif" },
							pricingSnapshot: {
								fundingSource: "IMAGE_PASS",
								skuKey: selection.skuKey,
								imagePassBenefitPolicy,
								settlementPolicy: { requestedOutputCount: 1 },
							},
						},
					])
					.mockResolvedValueOnce([]),
			};
			await expect(
				reserveImagePassForJobInTransaction({ ownerId: "owner", jobId: "job" }, tx as never),
			).rejects.toThrow("IMAGE_PASS_SELECTION_INVALID");
			expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
		},
	);
	it("projects 35 effective SKUs only for current grants and never mutates a frozen grant", async () => {
		for (const offerSnapshot of [
			getImagePassOfferSnapshot(),
			IMAGE_PASS_LEGACY_OFFER,
			IMAGE_PASS_STANDARD_OFFER,
		]) {
			const original = JSON.stringify(offerSnapshot);
			const tx = {
				$queryRaw: vi
					.fn()
					.mockResolvedValueOnce([{ available: 2n, reserved: 0n, consumed: 1n, revoked: 0n }])
					.mockResolvedValue([{ offerSnapshot }]),
			};
			const balance = await getImagePassBalance({ ownerId: "owner" }, tx as never);
			const current = offerSnapshot.offerVersion === "2026-11-04.2";
			expect(balance.availableSkuKeys).toHaveLength(
				current ? 35 : offerSnapshot.allowedSkuKeys.length,
			);
			expect(balance.subscriptionFreeSkuKeys).toHaveLength(current ? 35 : 0);
			expect(balance.available).toBe(2);
			expect(JSON.stringify(offerSnapshot)).toBe(original);
		}
	});
});
