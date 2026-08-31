import { describe, expect, it, vi } from "vitest";

import { cancelOrganizationSubscriptionsBeforeDeletion } from "./organization-deletion";

interface HarnessOptions {
	role?: string;
	subscriptionIds?: string[];
	provider?: string;
}

function createHarness({
	role,
	subscriptionIds = ["sub_org_1"],
	provider = "stripe",
}: HarnessOptions = {}) {
	const findMembership = vi.fn().mockResolvedValue(role ? { role } : null);
	const listPurchases = vi.fn().mockResolvedValue(
		subscriptionIds.map((subscriptionId) => ({
			type: "SUBSCRIPTION" as const,
			provider,
			subscriptionId,
		})),
	);
	const cancelSubscription = vi.fn().mockResolvedValue(undefined);

	return {
		findMembership,
		listPurchases,
		cancelSubscription,
		cancel: () =>
			cancelOrganizationSubscriptionsBeforeDeletion(
				{ organizationId: "org-1", userId: "user-1" },
				{ findMembership, listPurchases, cancelSubscription },
			),
	};
}

describe("organization deletion subscription safety", () => {
	it("rejects a non-member without reading purchases or calling the provider", async () => {
		const harness = createHarness();

		await expect(harness.cancel()).rejects.toMatchObject({ status: "FORBIDDEN" });
		expect(harness.listPurchases).not.toHaveBeenCalled();
		expect(harness.cancelSubscription).not.toHaveBeenCalled();
	});

	it.each(["member", "admin"])(
		"rejects a %s without reading purchases or calling the provider",
		async (role) => {
			const harness = createHarness({ role });

			await expect(harness.cancel()).rejects.toMatchObject({ status: "FORBIDDEN" });
			expect(harness.listPurchases).not.toHaveBeenCalled();
			expect(harness.cancelSubscription).not.toHaveBeenCalled();
		},
	);

	it("lets an owner cancel every organization subscription before deletion proceeds", async () => {
		const harness = createHarness({
			role: "owner",
			subscriptionIds: ["sub_org_1", "sub_org_2"],
		});

		await expect(harness.cancel()).resolves.toBeUndefined();
		expect(harness.listPurchases).toHaveBeenCalledWith("org-1");
		expect(harness.cancelSubscription).toHaveBeenNthCalledWith(1, "stripe", "sub_org_1");
		expect(harness.cancelSubscription).toHaveBeenNthCalledWith(2, "stripe", "sub_org_2");
	});

	it("keeps identical subscription IDs isolated by provider", async () => {
		const findMembership = vi.fn().mockResolvedValue({ role: "owner" });
		const listPurchases = vi.fn().mockResolvedValue([
			{ type: "SUBSCRIPTION", provider: "paypal", subscriptionId: "shared-id" },
			{ type: "SUBSCRIPTION", provider: "waffo", subscriptionId: "shared-id" },
		]);
		const cancelSubscription = vi.fn();

		await cancelOrganizationSubscriptionsBeforeDeletion(
			{ organizationId: "org-1", userId: "user-1" },
			{ findMembership, listPurchases, cancelSubscription },
		);
		expect(cancelSubscription).toHaveBeenNthCalledWith(1, "paypal", "shared-id");
		expect(cancelSubscription).toHaveBeenNthCalledWith(2, "waffo", "shared-id");
	});

	it("propagates a provider failure so Better Auth cannot delete the organization", async () => {
		const harness = createHarness({ role: "owner" });
		const providerError = new Error("Stripe temporarily unavailable");
		harness.cancelSubscription.mockRejectedValueOnce(providerError);

		await expect(harness.cancel()).rejects.toBe(providerError);
	});

	it("can be retried after a temporary provider failure", async () => {
		const harness = createHarness({ role: "owner" });
		harness.cancelSubscription
			.mockRejectedValueOnce(new Error("Stripe temporarily unavailable"))
			.mockResolvedValueOnce(undefined);

		await expect(harness.cancel()).rejects.toThrow("Stripe temporarily unavailable");
		await expect(harness.cancel()).resolves.toBeUndefined();
		expect(harness.cancelSubscription).toHaveBeenCalledTimes(2);
	});

	it("can be retried when cancellation succeeded but the later database deletion failed", async () => {
		const harness = createHarness({ role: "owner" });

		await expect(harness.cancel()).resolves.toBeUndefined();
		// Better Auth deletes the organization after this hook. If that separate DB operation fails,
		// the owner retries and the payment provider must accept the repeated cancellation.
		await expect(harness.cancel()).resolves.toBeUndefined();
		expect(harness.cancelSubscription).toHaveBeenCalledTimes(2);
	});
});
