import {
	getImagePassOfferSnapshot,
	IMAGE_PASS_LEGACY_OFFER,
	IMAGE_PASS_GPT_IMAGE_26_BENEFIT_POLICY,
} from "@repo/config/image-pass";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	db: {
		$queryRaw: vi.fn(),
		runtimeConfigOverride: { findFirst: vi.fn() },
		creditAccount: { findUnique: vi.fn() },
		creditLot: { aggregate: vi.fn() },
		generationQuote: { aggregate: vi.fn() },
		storageUsageReservation: { aggregate: vi.fn() },
		mediaAsset: { findFirst: vi.fn() },
		subscription: { findMany: vi.fn() },
		billingPeriod: { fields: { paidAmount: "paidAmount" }, aggregate: vi.fn() },
	},
}));
vi.mock("@repo/database/client", () => ({
	db: fixture.db,
	getDatabaseClient: () => {
		throw new Error("Unexpected implicit database connection");
	},
}));
// Exercise the real subscription resolver and both projections against an in-memory
// DB port. No generated client, live database or external provider is involved.
vi.mock("@repo/database", async () => ({
	findEffectivePaidSubscription: (await import("../../../../database/prisma/queries/media/billing"))
		.findEffectivePaidSubscription,
	effectiveMediaStorageLimit: (
		await import("../../../../database/prisma/queries/media/storage-quota")
	).effectiveMediaStorageLimit,
	unexpiredStorageReservations: (
		await import("../../../../database/prisma/queries/media/temporary-references")
	).unexpiredStorageReservations,
}));
vi.mock("@repo/config/server", async (original) => ({
	...(await original<typeof import("@repo/config/server")>()),
	maximumMediaStorageBytes: () => 100n,
}));
vi.mock("./free-plan-credits", () => ({ ensureFreePlanCreditsForGeneration: vi.fn() }));
vi.mock("./rate-limit", () => ({ enforceMediaRateLimit: vi.fn() }));

import { assertGenerationAllowed } from "./generation-authorization";

const NOW = new Date("2026-10-22T08:09:10.000Z");
const request = {
	userId: "owner",
	productKey: "image-nano-banana-2-lite" as const,
	credits: 5n,
	costMicros: 20_000n,
	input: {
		kind: "text-to-image" as const,
		prompt: "A ceramic vase",
		skuKey: "nano-banana-2-lite-1k" as const,
		aspectRatio: "1:1" as const,
	},
	routeGraphOptions: {
		enabledProviders: new Set(["kie" as const]),
		generationEnabled: true,
	},
};
const paidSubscription = {
	id: "subscription",
	provider: "paypal",
	status: "ACTIVE",
	plan: { metadata: { planId: "creator" }, name: "creator" },
	periods: [{ paidAmount: 100n, refundedAmount: 0n, providerInvoiceId: "invoice" }],
};

describe("generation subscription preflight", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		fixture.db.creditAccount.findUnique.mockResolvedValue({ creditDebt: 0n });
		fixture.db.creditLot.aggregate.mockResolvedValue({ _sum: { remainingAmount: 100n } });
		fixture.db.generationQuote.aggregate.mockResolvedValue({ _sum: { costMicros: 0n } });
		fixture.db.storageUsageReservation.aggregate.mockResolvedValue({ _sum: { bytes: 0n } });
		fixture.db.mediaAsset.findFirst.mockResolvedValue({ mimeType: "image/png", byteSize: 1n });
		fixture.db.subscription.findMany.mockResolvedValue([paidSubscription]);
		fixture.db.$queryRaw.mockResolvedValue([]);
	});
	afterEach(() => vi.useRealTimers());
	it.each(["flare", "sunburst"] as const)(
		"lets a $2.99 pass fund %s GIF without subscription or credits",
		async (model) => {
			fixture.db.subscription.findMany.mockResolvedValue([]);
			fixture.db.creditLot.aggregate.mockResolvedValue({ _sum: { remainingAmount: 0n } });
			fixture.db.$queryRaw.mockResolvedValue([
				{ id: "pass-unit", offerSnapshot: getImagePassOfferSnapshot() },
			]);
			await expect(
				assertGenerationAllowed({
					...request,
					productKey: `image-gpt-image-2-6-${model}`,
					fundingSource: "IMAGE_PASS",
					imagePassBenefitPolicy: IMAGE_PASS_GPT_IMAGE_26_BENEFIT_POLICY,
					input: {
						...request.input,
						skuKey: `gpt-image-2-6-${model}-1k`,
						outputFormat: "gif",
						frameCount: 9,
						frameDurationMs: 200,
					},
				}),
			).resolves.toBeUndefined();
		},
	);
	it("allows the administrator's granted SKU on credits and still enforces the balance", async () => {
		fixture.db.subscription.findMany.mockResolvedValue([]);
		fixture.db.$queryRaw.mockResolvedValue([
			{
				now: NOW,
				value: {
					version: 1,
					expiresAt: "2026-11-14T00:00:00Z",
					skuKeys: ["gpt-image-2-6-sunburst-1k"],
				},
			},
		]);
		const input = {
			...request,
			productKey: "image-gpt-image-2-6-sunburst" as const,
			credits: 57n,
			input: {
				...request.input,
				skuKey: "gpt-image-2-6-sunburst-1k" as const,
				outputFormat: "gif" as const,
				frameCount: 9,
				frameDurationMs: 200,
			},
		};
		await expect(assertGenerationAllowed(input)).resolves.toBeUndefined();
		fixture.db.creditLot.aggregate.mockResolvedValue({ _sum: { remainingAmount: 56n } });
		await expect(assertGenerationAllowed(input)).rejects.toThrow("INSUFFICIENT_CREDITS");
		fixture.db.$queryRaw.mockResolvedValue([]);
		await expect(assertGenerationAllowed(input)).rejects.toThrow("ENTITLEMENT_REQUIRED");
	});

	it("reads the effective subscription once for both plan and storage eligibility", async () => {
		await expect(assertGenerationAllowed(request)).resolves.toBeUndefined();
		expect(fixture.db.subscription.findMany).toHaveBeenCalledTimes(1);
	});
	it("authorizes the exact premium selection from a new pass through real preflight", async () => {
		fixture.db.subscription.findMany.mockResolvedValue([]);
		fixture.db.creditLot.aggregate.mockResolvedValue({ _sum: { remainingAmount: 0n } });
		fixture.db.$queryRaw.mockResolvedValue([
			{ id: "pass-unit", offerSnapshot: getImagePassOfferSnapshot() },
		]);
		const premium = {
			...request,
			productKey: "image-nano-banana-pro" as const,
			fundingSource: "IMAGE_PASS" as const,
			credits: 25n,
			costMicros: 120_000n,
			input: { ...request.input, skuKey: "nano-banana-pro-4k" as const },
		};
		await expect(assertGenerationAllowed(premium)).resolves.toBeUndefined();
		expect(fixture.db.$queryRaw.mock.calls[0].slice(1)).toContain("nano-banana-pro-4k");
		fixture.db.$queryRaw.mockResolvedValue([
			{ id: "legacy-unit", offerSnapshot: IMAGE_PASS_LEGACY_OFFER },
		]);
		await expect(assertGenerationAllowed(premium)).rejects.toThrow("IMAGE_PASS_INSUFFICIENT");
	});

	it("uses the same request time for subscription, credits, storage and source expiry", async () => {
		fixture.db.creditAccount.findUnique.mockImplementationOnce(async () => {
			vi.setSystemTime(new Date(NOW.getTime() + 60_000));
			return { creditDebt: 0n };
		});
		await assertGenerationAllowed({
			...request,
			input: {
				...request.input,
				kind: "image-to-image",
				sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
			},
		});
		const where = fixture.db.subscription.findMany.mock.calls[0][0].where;
		const now = where.OR[0].currentPeriodStart.lte;
		expect(now).toEqual(NOW);
		expect(where).toMatchObject({ ownerType: "USER", ownerId: "owner" });
		expect(where.OR[0].currentPeriodEnd.gt).toBe(now);
		expect(where.OR[1].graceEndsAt.gt).toBe(now);
		expect(fixture.db.creditLot.aggregate.mock.calls[0][0].where.OR[1].expiresAt.gt).toBe(now);
		expect(
			fixture.db.storageUsageReservation.aggregate.mock.calls[0][0].where.OR[1].expiresAt.gt,
		).toBe(now);
		expect(fixture.db.mediaAsset.findFirst.mock.calls[0][0].where.OR[1].deleteAfter.gt).toBe(now);
		expect(fixture.db.generationQuote.aggregate.mock.calls[0][0].where.createdAt.gte).toEqual(
			new Date("2026-10-22T00:00:00.000Z"),
		);
	});

	it.each(["ACTIVE", "CANCELED", "PAST_DUE"])(
		"uses the effective %s subscription for both input entitlement and unlimited storage",
		async (status) => {
			fixture.db.subscription.findMany.mockResolvedValue([{ ...paidSubscription, status }]);
			fixture.db.storageUsageReservation.aggregate.mockResolvedValue({ _sum: { bytes: 100n } });
			fixture.db.mediaAsset.findFirst.mockResolvedValue({
				mimeType: "image/png",
				byteSize: 15n * 1024n * 1024n,
			});
			await expect(
				assertGenerationAllowed({
					...request,
					input: {
						...request.input,
						kind: "image-to-image",
						sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
					},
				}),
			).resolves.toBeUndefined();
			expect(fixture.db.subscription.findMany).toHaveBeenCalledTimes(1);
		},
	);

	it("does not infer the storage policy from an unrecognized paid plan name", async () => {
		fixture.db.subscription.findMany.mockResolvedValue([
			{ ...paidSubscription, plan: { metadata: {}, name: "legacy-paid-plan" } },
		]);
		fixture.db.storageUsageReservation.aggregate.mockResolvedValue({ _sum: { bytes: 100n } });
		await expect(assertGenerationAllowed(request)).resolves.toBeUndefined();
	});

	it("keeps the finite quota when the effective query excludes expired or refunded subscriptions", async () => {
		fixture.db.subscription.findMany.mockResolvedValue([]);
		fixture.db.storageUsageReservation.aggregate.mockResolvedValue({ _sum: { bytes: 100n } });
		await expect(assertGenerationAllowed(request)).rejects.toThrow("STORAGE_QUOTA_EXCEEDED");
		expect(fixture.db.subscription.findMany).toHaveBeenCalledTimes(1);
	});

	it("does not keep grace access after the latest paid period is fully refunded", async () => {
		fixture.db.subscription.findMany.mockResolvedValue([
			{
				...paidSubscription,
				status: "PAST_DUE",
				periods: [{ paidAmount: 100n, refundedAmount: 100n, providerInvoiceId: "invoice" }],
			},
		]);
		fixture.db.storageUsageReservation.aggregate.mockResolvedValue({ _sum: { bytes: 100n } });
		await expect(assertGenerationAllowed(request)).rejects.toThrow("STORAGE_QUOTA_EXCEEDED");
	});

	it.each([60n, 100n])(
		"checks Stripe annual invoice refunds once even when the latest monthly projection has no refund (%s)",
		async (refundedAmount) => {
			fixture.db.subscription.findMany.mockResolvedValue([
				{ ...paidSubscription, provider: "stripe" },
			]);
			fixture.db.billingPeriod.aggregate.mockResolvedValue({
				_min: { paidAmount: 100n },
				_max: { refundedAmount },
			});
			fixture.db.storageUsageReservation.aggregate.mockResolvedValue({ _sum: { bytes: 100n } });
			const check = assertGenerationAllowed(request);
			if (refundedAmount === 100n) await expect(check).rejects.toThrow("STORAGE_QUOTA_EXCEEDED");
			else await expect(check).resolves.toBeUndefined();
			expect(fixture.db.subscription.findMany).toHaveBeenCalledTimes(1);
			expect(fixture.db.billingPeriod.aggregate).toHaveBeenCalledExactlyOnceWith({
				where: { subscriptionId: "subscription", providerInvoiceId: "invoice" },
				_min: { paidAmount: true },
				_max: { refundedAmount: true },
			});
		},
	);

	it("reads again on the next request after subscription eligibility changes", async () => {
		fixture.db.storageUsageReservation.aggregate.mockResolvedValue({ _sum: { bytes: 100n } });
		await expect(assertGenerationAllowed(request)).resolves.toBeUndefined();
		fixture.db.subscription.findMany.mockResolvedValue([]);
		await expect(assertGenerationAllowed(request)).rejects.toThrow("STORAGE_QUOTA_EXCEEDED");
		expect(fixture.db.subscription.findMany).toHaveBeenCalledTimes(2);
	});
});
