import { describe, expect, it, vi } from "vitest";

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
	it("rejects a paid product when the paid subscription is no longer effective", async () => {
		await expect(
			loadCurrentGenerationAdmission(
				{ ownerId: "owner", productKey: "image-nano-banana-2", costMicros: 10n, now: new Date() },
				transaction() as never,
			),
		).rejects.toThrow("ENTITLEMENT_REQUIRED");
	});
	it("derives concurrency and the tighter product size limit from the current plan", async () => {
		const tx = transaction([], "studio");
		const admission = await loadCurrentGenerationAdmission(
			{ ownerId: "owner", productKey: "image-nano-banana", costMicros: 10n, now: new Date() },
			tx as never,
		);
		expect(admission.maximumInputBytes).toBe(10_000_000);
		expect(admission.maximumConcurrentJobs).toBeGreaterThan(1);
		expect(tx.runtimeConfigOverride.findMany).toHaveBeenCalledTimes(1);
		expect(tx.subscription.findMany).toHaveBeenCalledTimes(1);
	});
});
