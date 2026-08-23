import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { cancelStripeSubscription } from "./cancellation";

describe("Stripe subscription cancellation", () => {
	it("cancels an active subscription", async () => {
		const retrieve = vi.fn().mockResolvedValue({ id: "sub_active", status: "active" });
		const cancel = vi.fn().mockResolvedValue({ id: "sub_active", status: "canceled" });

		await expect(
			cancelStripeSubscription({ subscriptions: { retrieve, cancel } }, "sub_active"),
		).resolves.toBeUndefined();
		expect(retrieve).toHaveBeenCalledWith("sub_active");
		expect(cancel).toHaveBeenCalledWith("sub_active");
	});

	it("treats an already-canceled subscription as an idempotent success", async () => {
		const retrieve = vi.fn().mockResolvedValue({ id: "sub_canceled", status: "canceled" });
		const cancel = vi.fn();

		await expect(
			cancelStripeSubscription({ subscriptions: { retrieve, cancel } }, "sub_canceled"),
		).resolves.toBeUndefined();
		expect(cancel).not.toHaveBeenCalled();
	});

	it("treats a missing subscription as an idempotent success", async () => {
		const retrieve = vi.fn().mockRejectedValue(
			new Stripe.errors.StripeInvalidRequestError({
				message: "No such subscription: 'sub_deleted'",
				param: "id",
				code: "resource_missing",
			}),
		);
		const cancel = vi.fn();

		await expect(
			cancelStripeSubscription({ subscriptions: { retrieve, cancel } }, "sub_deleted"),
		).resolves.toBeUndefined();
		expect(cancel).not.toHaveBeenCalled();
	});

	it("treats a subscription removed between retrieval and cancellation as success", async () => {
		const retrieve = vi.fn().mockResolvedValue({ id: "sub_raced", status: "active" });
		const cancel = vi.fn().mockRejectedValue(
			new Stripe.errors.StripeInvalidRequestError({
				message: "No such subscription: 'sub_raced'",
				param: "id",
				code: "resource_missing",
			}),
		);

		await expect(
			cancelStripeSubscription({ subscriptions: { retrieve, cancel } }, "sub_raced"),
		).resolves.toBeUndefined();
	});

	it("propagates transient provider failures", async () => {
		const providerError = new Stripe.errors.StripeConnectionError({
			message: "Connection failed",
		});
		const retrieve = vi.fn().mockRejectedValue(providerError);
		const cancel = vi.fn();

		await expect(
			cancelStripeSubscription({ subscriptions: { retrieve, cancel } }, "sub_active"),
		).rejects.toBe(providerError);
		expect(cancel).not.toHaveBeenCalled();
	});
});
