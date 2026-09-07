import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ findEffectiveSubscription: vi.fn() }));

vi.mock("@repo/database", () => ({
	findEffectivePaidSubscription: database.findEffectiveSubscription,
}));
vi.mock("@repo/database/client", () => ({ db: {} }));

import { loadUserPlanEntitlement } from "./plan-entitlement";

describe("loadUserPlanEntitlement", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps the paid plan selected by the server-side grace query", async () => {
		const now = new Date("2026-08-25T06:00:00.000Z");
		database.findEffectiveSubscription.mockResolvedValue({
			status: "PAST_DUE",
			graceEndsAt: new Date("2026-08-26T06:00:00.000Z"),
			plan: { metadata: { planId: "creator" }, name: "creator" },
		});

		await expect(loadUserPlanEntitlement("user-1", { now })).resolves.toMatchObject({
			id: "creator",
			maximumConcurrentJobs: 3,
			maximumInputBytes: 20 * 1024 * 1024,
			allowedProducts: [
				"image-nano-banana-2-lite",
				"image-nano-banana",
				"image-nano-banana-2",
				"image-nano-banana-pro",
				"image-gpt-image-1-5",
				"image-gpt-image-2",
				"image-seedream-4-5",
				"image-seedream-5-lite",
				"image-seedream-5-pro",
			],
		});
		expect(database.findEffectiveSubscription).toHaveBeenCalledWith(
			{ ownerType: "USER", ownerId: "user-1", now },
			expect.anything(),
		);
	});

	it("fails closed to Free when no paid subscription remains effective", async () => {
		database.findEffectiveSubscription.mockResolvedValue(null);

		await expect(loadUserPlanEntitlement("user-2")).resolves.toMatchObject({
			id: "free",
			maximumConcurrentJobs: 1,
			maximumInputBytes: 10 * 1024 * 1024,
			allowedProducts: ["image-nano-banana-2-lite"],
		});
	});
});
