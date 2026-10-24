import { EZPIC_PRODUCT_KEYS } from "@repo/config";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../client", () => ({
	getDatabaseClient: () => {
		throw new Error("Unexpected implicit database connection");
	},
}));

import { loadCurrentGenerationAdmission } from "./generation-admission";

function transaction(overrides: string[] = [], planId = "free") {
	return {
		runtimeConfigOverride: {
			findMany: vi.fn(async () => overrides.map((configKey) => ({ configKey }))),
		},
		billingPeriod: { fields: { paidAmount: "paidAmount" } },
		subscription: {
			findMany: vi.fn(async () =>
				planId === "free"
					? []
					: [
							{
								id: "subscription-1",
								status: "ACTIVE",
								plan: { metadata: { planId }, name: planId },
								periods: [{ paidAmount: 100n, refundedAmount: 0n }],
							},
						],
			),
		},
	};
}

describe("transaction-current admission", () => {
	it.each(["media.generation.enabled", "media.model.image-nano-banana-2-lite.enabled"])(
		"rejects the %s switch changed while Waffo was running",
		async (key) => {
			const tx = transaction([key]);
			await expect(
				loadCurrentGenerationAdmission(
					{
						ownerId: "owner",
						productKey: "image-nano-banana-2-lite",
						costMicros: 10n,
						now: new Date(),
					},
					tx as never,
				),
			).rejects.toThrow("MODEL_DISABLED");
		},
	);
	it.each(EZPIC_PRODUCT_KEYS.filter((key) => key !== "image-nano-banana-2-lite"))(
		"rejects %s without an effective paid subscription",
		async (productKey) => {
			await expect(
				loadCurrentGenerationAdmission(
					{ ownerId: "owner", productKey, costMicros: 30_000n, now: new Date() },
					transaction() as never,
				),
			).rejects.toThrow("ENTITLEMENT_REQUIRED");
		},
	);
	it("admits only Nano Banana 2 Lite 1K without an effective paid subscription", async () => {
		await expect(
			loadCurrentGenerationAdmission(
				{
					ownerId: "owner",
					productKey: "image-nano-banana-2-lite",
					skuKey: "nano-banana-2-lite-1k",
					costMicros: 20_000n,
					now: new Date(),
				},
				transaction() as never,
			),
		).resolves.toMatchObject({ maximumInputBytes: expect.any(Number) });
	});
	it.each(EZPIC_PRODUCT_KEYS)(
		"admits %s with an effective paid subscription",
		async (productKey) => {
			await expect(
				loadCurrentGenerationAdmission(
					{ ownerId: "owner", productKey, costMicros: 30_000n, now: new Date() },
					transaction([], "creator") as never,
				),
			).resolves.toMatchObject({ maximumInputBytes: expect.any(Number) });
		},
	);
	it("does not let image passes unlock premium models without an effective subscription", async () => {
		await expect(
			loadCurrentGenerationAdmission(
				{
					ownerId: "owner",
					productKey: "image-nano-banana-pro",
					skuKey: "nano-banana-pro-4k",
					fundingSource: "IMAGE_PASS",
					costMicros: 120_000n,
					now: new Date(),
				},
				transaction() as never,
			),
		).rejects.toThrow("ENTITLEMENT_REQUIRED");
	});
	it("derives the tighter product size limit without limiting unfinished task counts", async () => {
		const tx = transaction([], "studio");
		const admission = await loadCurrentGenerationAdmission(
			{ ownerId: "owner", productKey: "image-nano-banana", costMicros: 10n, now: new Date() },
			tx as never,
		);
		expect(admission.maximumInputBytes).toBe(10_000_000);
		expect(admission).not.toHaveProperty("maximumConcurrentJobs");
		expect(tx.runtimeConfigOverride.findMany).toHaveBeenCalledTimes(1);
		expect(tx.subscription.findMany).toHaveBeenCalledTimes(1);
	});
});
