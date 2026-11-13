import { EZPIC_PRODUCT_KEYS } from "@repo/config";
import {
	getImagePassOfferSnapshot,
	IMAGE_PASS_LEGACY_OFFER,
	IMAGE_PASS_GPT_IMAGE_26_BENEFIT_POLICY,
} from "@repo/config/image-pass";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../client", () => ({
	getDatabaseClient: () => {
		throw new Error("Unexpected implicit database connection");
	},
}));

import { loadCurrentGenerationAdmission } from "./generation-admission";

function transaction(overrides: string[] = [], planId = "free") {
	return {
		$queryRaw: vi.fn(async () => [] as Array<{ id: string; offerSnapshot: unknown }>),
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
	it("rechecks administrator test access at admission and rejects a revoked grant", async () => {
		const tx = transaction();
		const now = new Date("2026-11-13T15:00:00Z");
		const input = {
			ownerId: "owner",
			productKey: "image-gpt-image-2-6-sunburst",
			skuKey: "gpt-image-2-6-sunburst-1k",
			costMicros: 100_000n,
			now,
		};
		tx.$queryRaw.mockResolvedValue([
			{ now, value: { version: 1, expiresAt: "2026-11-14T15:00:00Z", skuKeys: [input.skuKey] } },
		] as never);
		await expect(loadCurrentGenerationAdmission(input, tx as never)).resolves.toBeDefined();
		await expect(
			loadCurrentGenerationAdmission(
				{ ...input, skuKey: "gpt-image-2-6-sunburst-4k" },
				tx as never,
			),
		).rejects.toThrow("ENTITLEMENT_REQUIRED");
		tx.$queryRaw.mockResolvedValue([]);
		await expect(loadCurrentGenerationAdmission(input, tx as never)).rejects.toThrow(
			"ENTITLEMENT_REQUIRED",
		);
	});
	it.each(["seedream-5-5-1k", "seedream-5-5-1-5k", "seedream-5-5-2k"])(
		"rechecks Seedream 5.5 subscription and its 10 MB input limit for %s",
		async (skuKey) => {
			const input = {
				ownerId: "owner",
				productKey: "image-seedream-5-5",
				skuKey,
				costMicros: 38_700n,
				now: new Date(),
			};
			await expect(loadCurrentGenerationAdmission(input, transaction() as never)).rejects.toThrow(
				"ENTITLEMENT_REQUIRED",
			);
			await expect(
				loadCurrentGenerationAdmission(input, transaction([], "creator") as never),
			).resolves.toMatchObject({ maximumInputBytes: 10_000_000 });
		},
	);
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
	it.each(
		EZPIC_PRODUCT_KEYS.filter(
			(key) => key !== "image-nano-banana-2-lite" && key !== "image-minimax-h3",
		),
	)("rejects %s without an effective paid subscription", async (productKey) => {
		await expect(
			loadCurrentGenerationAdmission(
				{ ownerId: "owner", productKey, costMicros: 30_000n, now: new Date() },
				transaction() as never,
			),
		).rejects.toThrow("ENTITLEMENT_REQUIRED");
	});
	it("retains Nano Banana 2 Lite 1K access without an effective paid subscription", async () => {
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
	it.each(["minimax-h3-1k", "minimax-h3-2k", "minimax-h3-4k"])(
		"rechecks H3 tier access for %s inside reservation",
		async (skuKey) => {
			const input = {
				ownerId: "owner",
				productKey: "image-minimax-h3",
				skuKey,
				costMicros: 30_000n,
				now: new Date(),
			};
			const free = loadCurrentGenerationAdmission(input, transaction() as never);
			if (skuKey === "minimax-h3-1k")
				await expect(free).resolves.toMatchObject({ maximumInputBytes: 10 * 1024 * 1024 });
			else await expect(free).rejects.toThrow("ENTITLEMENT_REQUIRED");
			await expect(
				loadCurrentGenerationAdmission(input, transaction([], "creator") as never),
			).resolves.toMatchObject({ maximumInputBytes: 20_000_000 });
		},
	);
	it("rejects a previously quoted H3 premium tier after subscription expiry", async () => {
		const input = {
			ownerId: "owner",
			productKey: "image-minimax-h3",
			skuKey: "minimax-h3-4k",
			costMicros: 30_000n,
			now: new Date(),
		};
		const tx = transaction([], "creator");
		await expect(loadCurrentGenerationAdmission(input, tx as never)).resolves.toBeDefined();
		tx.subscription.findMany.mockResolvedValue([]);
		await expect(loadCurrentGenerationAdmission(input, tx as never)).rejects.toThrow(
			"ENTITLEMENT_REQUIRED",
		);
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
	it("does not let historical image passes unlock premium models without a subscription", async () => {
		const tx = transaction();
		tx.$queryRaw.mockResolvedValue([{ id: "legacy-unit", offerSnapshot: IMAGE_PASS_LEGACY_OFFER }]);
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
				tx as never,
			),
		).rejects.toThrow("IMAGE_PASS_INSUFFICIENT");
	});
	it("admits a premium 4K product only with a validated subscription-free available pass", async () => {
		const tx = transaction();
		tx.$queryRaw.mockResolvedValue([
			{ id: "new-unit", offerSnapshot: getImagePassOfferSnapshot() },
		]);
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
				tx as never,
			),
		).resolves.toMatchObject({ maximumInputBytes: expect.any(Number) });
		const [parts, ...parameters] = tx.$queryRaw.mock.calls[0] as unknown as [
			TemplateStringsArray,
			...unknown[],
		];
		expect(parts.join("?")).toContain("subscriptionPolicy");
		expect(parameters).toContain(false);
	});
	it("keeps an allowed historical pass usable with a paid subscription", async () => {
		const tx = transaction([], "creator");
		tx.$queryRaw.mockResolvedValue([{ id: "legacy-unit", offerSnapshot: IMAGE_PASS_LEGACY_OFFER }]);
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
				tx as never,
			),
		).resolves.toMatchObject({ maximumInputBytes: expect.any(Number) });
	});
	it.each(["png", "jpeg", "svg", "gif"])(
		"passes the exact frozen policy and %s format to current admission",
		async (outputFormat) => {
			const tx = transaction();
			tx.$queryRaw.mockResolvedValue([
				{ id: "new-unit", offerSnapshot: getImagePassOfferSnapshot() },
			]);
			const input = {
				ownerId: "owner",
				productKey: "image-gpt-image-2-6-sunburst",
				skuKey: "gpt-image-2-6-sunburst-1k",
				fundingSource: "IMAGE_PASS" as const,
				costMicros: 460_000n,
				now: new Date(),
				outputFormat,
			};
			await expect(loadCurrentGenerationAdmission(input, tx as never)).rejects.toThrow(
				"IMAGE_PASS_SELECTION_INVALID",
			);
			await expect(
				loadCurrentGenerationAdmission(
					{ ...input, imagePassBenefitPolicy: IMAGE_PASS_GPT_IMAGE_26_BENEFIT_POLICY },
					tx as never,
				),
			).resolves.toMatchObject({ maximumInputBytes: expect.any(Number) });
		},
	);
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
