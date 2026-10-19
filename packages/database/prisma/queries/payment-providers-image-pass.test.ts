import { describe, it, expect, vi } from "vitest";
// Isolated transaction-unit tests supply their own client. No generated runtime
// or database connection is substituted by this unused default-client boundary.
vi.mock("../client", () => ({
	getDatabaseClient: vi.fn(() => {
		throw new Error("UNEXPECTED_DEFAULT_DATABASE");
	}),
}));
import { getImagePassOfferSnapshot } from "@repo/config/image-pass";

import { createPaymentCheckoutIntent } from "./payment-providers";

const command = {
	provider: "paypal" as const,
	ownerType: "USER" as const,
	ownerId: "buyer",
	submittedByUserId: "buyer",
	billingPlanId: "image-pass-plan",
	productKind: "IMAGE_PASS" as const,
	planKey: "image-pass-3",
	interval: "one-time" as const,
	idempotencyKey: "image-pass-buy-1",
	imagePassOfferSnapshot: getImagePassOfferSnapshot(),
};
function fixture(replay: unknown = null) {
	const create = vi
		.fn()
		.mockImplementation(async ({ data }) => ({ id: "new-intent", status: "CREATED", ...data }));
	const tx = {
		$queryRaw: vi.fn().mockResolvedValue([]),
		paymentCheckoutIntent: {
			findUnique: vi
				.fn()
				.mockImplementation(async ({ where }) =>
					where.ownerType_ownerId_idempotencyKey ? replay : null,
				),
			create,
		},
		paymentCheckoutIntentIdempotencyAlias: { findUnique: vi.fn().mockResolvedValue(null) },
	};
	return {
		create,
		client: { $transaction: async (operation: (tx: unknown) => unknown) => operation(tx) },
	};
}
describe("image-pass checkout persistence", () => {
	it("stores the server snapshot without credit-pack columns or ordinary credit grants", async () => {
		const { client, create } = fixture();
		await createPaymentCheckoutIntent(command, client as never);
		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				productKind: "IMAGE_PASS",
				imagePassOfferSnapshot: getImagePassOfferSnapshot(),
				creditPackTotalCredits: null,
				activeScopeKey: "USER:buyer:IMAGE_PASS:image-pass-3:one-time",
			}),
		});
	});
	it.each([
		{ provider: "waffo" },
		{ ownerType: "ORGANIZATION" },
		{ ownerId: "someone-else" },
		{ planKey: "other" },
		{ imagePassOfferSnapshot: { ...getImagePassOfferSnapshot(), units: 75 } },
	])("refuses malformed purchase commands %s", async (patch) => {
		const { client, create } = fixture();
		await expect(
			createPaymentCheckoutIntent({ ...command, ...patch } as never, client as never),
		).rejects.toThrow("PAYMENT_CHECKOUT_INTENT_IMAGE_PASS_SNAPSHOT_INVALID");
		expect(create).not.toHaveBeenCalled();
	});
	it("replays the exact bound command with its frozen snapshot", async () => {
		const replay = {
			...command,
			id: "first",
			status: "PROVIDER_PENDING",
			providerSessionId: "ORDER",
			providerCheckoutUrl: "https://paypal.test/order",
		};
		const { client, create } = fixture(replay);
		await expect(createPaymentCheckoutIntent(command, client as never)).resolves.toMatchObject({
			intent: { id: "first" },
			replayed: true,
		});
		expect(create).not.toHaveBeenCalled();
	});
	it("rejects idempotency reuse with another frozen snapshot or plan", async () => {
		for (const patch of [
			{ billingPlanId: "another" },
			{ imagePassOfferSnapshot: { ...getImagePassOfferSnapshot(), units: 4 } },
		]) {
			const { client } = fixture({ ...command, ...patch, status: "CREATED" });
			await expect(createPaymentCheckoutIntent(command, client as never)).rejects.toThrow(
				"PAYMENT_CHECKOUT_INTENT_IDEMPOTENCY_CONFLICT",
			);
		}
	});
	it("permits separate completed purchases with fresh idempotency keys", async () => {
		const { client, create } = fixture();
		await createPaymentCheckoutIntent(command, client as never);
		await createPaymentCheckoutIntent(
			{ ...command, idempotencyKey: "image-pass-buy-2" },
			client as never,
		);
		expect(create).toHaveBeenCalledTimes(2);
	});
});
