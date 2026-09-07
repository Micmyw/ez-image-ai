import { describe, expect, it, vi } from "vitest";

import {
	bindPaymentCheckoutIntentOrder,
	bindPaymentCheckoutIntentSession,
	createPaymentCheckoutIntent,
	getPaymentCheckoutIntentForOwner,
	getPaymentCheckoutIntentForOwnerByIdempotencyKey,
	resetPaymentCheckoutIntentProviderCreating,
	transitionPaymentCheckoutIntentToReview,
} from "./payment-providers";

describe("createPaymentCheckoutIntent credit-pack snapshots", () => {
	it("persists the immutable snapshot in the checkout transaction", async () => {
		const createdIntent = {
			id: "intent-pack-1",
			status: "CREATED",
		};
		const findUnique = vi.fn().mockResolvedValue(null);
		const create = vi.fn().mockResolvedValue(createdIntent);
		const transaction = {
			$queryRaw: vi.fn().mockResolvedValue([]),
			paymentCheckoutIntent: { findUnique, create },
			paymentCheckoutIntentIdempotencyAlias: {
				findUnique: vi.fn().mockResolvedValue(null),
			},
		};
		const client = {
			$transaction: vi.fn(async (operation: (tx: typeof transaction) => Promise<unknown>) =>
				operation(transaction),
			),
		};
		const evaluatedAt = new Date("2026-09-06T04:00:00.000Z");

		const result = await createPaymentCheckoutIntent(
			{
				provider: "paypal",
				ownerType: "USER",
				ownerId: "user-1",
				submittedByUserId: "user-1",
				billingPlanId: "billing-pack-1500",
				productKind: "CREDIT_PACK",
				planKey: "credits-1500",
				interval: "one-time",
				idempotencyKey: "pack-attempt-1",
				creditPackSnapshot: {
					catalogVersion: "2026-09-06.1",
					pricingVersion: "2026-09-06.1",
					subscriberEligibilityVersion: "2026-09-06.1",
					baseCredits: 1_500n,
					bonusCredits: 300n,
					totalCredits: 1_800n,
					expiryMonths: 6,
					subscriberBonusEligible: true,
					subscriberSubscriptionId: "subscription-1",
					subscriberPlanKey: "ultimate",
					eligibilityEvaluatedAt: evaluatedAt,
				},
			},
			client as never,
		);

		expect(result).toEqual({ intent: createdIntent, replayed: false });
		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				productKind: "CREDIT_PACK",
				interval: "one-time",
				activeScopeKey: "USER:user-1:CREDIT_PACK:credits-1500:one-time",
				creditPackCatalogVersion: "2026-09-06.1",
				creditPackPricingVersion: "2026-09-06.1",
				creditPackSubscriberEligibilityVersion: "2026-09-06.1",
				creditPackBaseCredits: 1_500n,
				creditPackBonusCredits: 300n,
				creditPackTotalCredits: 1_800n,
				creditPackExpiryMonths: 6,
				creditPackSubscriberBonusEligible: true,
				creditPackSubscriberSubscriptionId: "subscription-1",
				creditPackSubscriberPlanKey: "ultimate",
				creditPackEligibilityEvaluatedAt: evaluatedAt,
			}),
		});
	});

	it("replays the first frozen snapshot when dynamic eligibility changes", async () => {
		const firstEvaluation = new Date("2026-09-06T04:00:00.000Z");
		const retryEvaluation = new Date("2026-09-06T04:05:00.000Z");
		const frozenIntent = {
			id: "intent-pack-1",
			provider: "paypal",
			ownerType: "USER" as const,
			ownerId: "user-1",
			submittedByUserId: "user-1",
			productKind: "CREDIT_PACK" as const,
			billingPlanId: "billing-pack-v1",
			planKey: "credits-1500",
			interval: "one-time",
			status: "CREATED",
			providerSessionId: null,
			providerCheckoutUrl: null,
			expiresAt: null,
			creditPackCatalogVersion: "2026-09-06.1",
			creditPackPricingVersion: "2026-09-06.1",
			creditPackSubscriberEligibilityVersion: "2026-09-06.1",
			creditPackBaseCredits: 1_500n,
			creditPackBonusCredits: 0n,
			creditPackTotalCredits: 1_500n,
			creditPackExpiryMonths: 6,
			creditPackSubscriberBonusEligible: false,
			creditPackSubscriberSubscriptionId: null,
			creditPackSubscriberPlanKey: null,
			creditPackEligibilityEvaluatedAt: firstEvaluation,
		};
		const create = vi.fn();
		const transaction = {
			$queryRaw: vi.fn().mockResolvedValue([]),
			paymentCheckoutIntent: {
				findUnique: vi.fn().mockResolvedValue(frozenIntent),
				create,
			},
			paymentCheckoutIntentIdempotencyAlias: {
				findUnique: vi.fn().mockResolvedValue(null),
			},
		};
		const client = {
			$transaction: vi.fn(async (operation: (tx: typeof transaction) => Promise<unknown>) =>
				operation(transaction),
			),
		};

		await expect(
			createPaymentCheckoutIntent(
				{
					provider: "paypal",
					ownerType: "USER",
					ownerId: "user-1",
					submittedByUserId: "user-1",
					billingPlanId: "billing-pack-v2",
					productKind: "CREDIT_PACK",
					planKey: "credits-1500",
					interval: "one-time",
					idempotencyKey: "pack-attempt-1",
					creditPackSnapshot: {
						catalogVersion: "2026-09-06.2",
						pricingVersion: "2026-09-06.2",
						subscriberEligibilityVersion: "2026-09-06.2",
						baseCredits: 1_500n,
						bonusCredits: 300n,
						totalCredits: 1_800n,
						expiryMonths: 6,
						subscriberBonusEligible: true,
						subscriberSubscriptionId: "subscription-1",
						subscriberPlanKey: "ultimate",
						eligibilityEvaluatedAt: retryEvaluation,
					},
				},
				client as never,
			),
		).resolves.toEqual({ intent: frozenIntent, replayed: true });
		expect(create).not.toHaveBeenCalled();
	});

	it("fails closed when Stripe is submitted for a credit pack", async () => {
		await expect(
			createPaymentCheckoutIntent(
				{
					provider: "stripe",
					ownerType: "USER",
					ownerId: "user-1",
					submittedByUserId: "user-1",
					billingPlanId: "billing-pack-1500",
					productKind: "CREDIT_PACK",
					planKey: "credits-1500",
					interval: "one-time",
					idempotencyKey: "pack-attempt-stripe",
					creditPackSnapshot: {
						catalogVersion: "2026-09-06.1",
						pricingVersion: "2026-09-06.1",
						subscriberEligibilityVersion: "2026-09-06.1",
						baseCredits: 1_500n,
						bonusCredits: 0n,
						totalCredits: 1_500n,
						expiryMonths: 6,
						subscriberBonusEligible: false,
						subscriberSubscriptionId: null,
						subscriberPlanKey: null,
						eligibilityEvaluatedAt: new Date("2026-09-06T04:00:00.000Z"),
					},
				} as never,
				{} as never,
			),
		).rejects.toThrow("PAYMENT_CHECKOUT_INTENT_CREDIT_PACK_SNAPSHOT_INVALID");
	});
});

describe("createPaymentCheckoutIntent active scope compatibility", () => {
	it("keeps PLAN writes on the legacy scope used by pre-product-kind deployments", async () => {
		const createdIntent = { id: "intent-plan-1", status: "CREATED" };
		const create = vi.fn().mockResolvedValue(createdIntent);
		const transaction = {
			$queryRaw: vi.fn().mockResolvedValue([]),
			paymentCheckoutIntent: { findUnique: vi.fn().mockResolvedValue(null), create },
			paymentCheckoutIntentIdempotencyAlias: {
				findUnique: vi.fn().mockResolvedValue(null),
			},
		};
		const client = {
			$transaction: vi.fn(async (operation: (tx: typeof transaction) => Promise<unknown>) =>
				operation(transaction),
			),
		};

		await createPaymentCheckoutIntent(
			{
				provider: "paypal",
				ownerType: "USER",
				ownerId: "user-1",
				submittedByUserId: "user-1",
				billingPlanId: "billing-plan-1",
				planKey: "creator",
				interval: "month",
				idempotencyKey: "plan-attempt-1",
			},
			client as never,
		);

		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				productKind: "PLAN",
				activeScopeKey: "USER:user-1:creator:month",
			}),
		});
	});
});

describe("createPaymentCheckoutIntent active checkout reuse", () => {
	const subscriptionCommand = {
		provider: "paypal" as const,
		ownerType: "USER" as const,
		ownerId: "user-1",
		submittedByUserId: "user-1",
		billingPlanId: "billing-plan-1",
		planKey: "creator",
		interval: "month" as const,
	};
	const pendingSubscription = {
		id: "intent-subscription-1",
		...subscriptionCommand,
		productKind: "PLAN" as const,
		idempotencyKey: "subscription-attempt-1",
		status: "PROVIDER_PENDING",
		providerSessionId: "I-SUBSCRIPTION",
		providerCheckoutUrl: "https://www.sandbox.paypal.com/approve",
		expiresAt: null,
		creditPackCatalogVersion: null,
		creditPackPricingVersion: null,
		creditPackSubscriberEligibilityVersion: null,
		creditPackBaseCredits: null,
		creditPackBonusCredits: null,
		creditPackTotalCredits: null,
		creditPackExpiryMonths: null,
		creditPackSubscriberBonusEligible: null,
		creditPackSubscriberSubscriptionId: null,
		creditPackSubscriberPlanKey: null,
		creditPackEligibilityEvaluatedAt: null,
	};

	function clientWithActive(active: Record<string, unknown>) {
		const create = vi.fn();
		const createAlias = vi.fn().mockResolvedValue({ id: "alias-1" });
		const update = vi.fn();
		const transaction = {
			$queryRaw: vi.fn().mockResolvedValue([]),
			paymentCheckoutIntent: {
				findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(active),
				create,
				update,
			},
			paymentCheckoutIntentIdempotencyAlias: {
				findUnique: vi.fn().mockResolvedValue(null),
				create: createAlias,
			},
		};
		return {
			create,
			createAlias,
			update,
			client: {
				$transaction: vi.fn(async (operation: (tx: typeof transaction) => Promise<unknown>) =>
					operation(transaction),
				),
			},
		};
	}

	it("reuses a provider-bound trusted subscription command for a new idempotency key", async () => {
		const { client, create, createAlias, update } = clientWithActive(pendingSubscription);

		await expect(
			createPaymentCheckoutIntent(
				{
					...subscriptionCommand,
					billingPlanId: "billing-plan-rotated",
					idempotencyKey: "subscription-attempt-2",
					now: new Date("2026-09-06T06:00:00.000Z"),
				},
				client as never,
			),
		).resolves.toEqual({ intent: pendingSubscription, replayed: true });
		expect(create).not.toHaveBeenCalled();
		expect(createAlias).toHaveBeenCalledWith({
			data: {
				ownerType: "USER",
				ownerId: "user-1",
				idempotencyKey: "subscription-attempt-2",
				checkoutIntentId: pendingSubscription.id,
			},
		});
		expect(update).not.toHaveBeenCalled();
	});

	it("does not reuse a provider-bound checkout across payment providers", async () => {
		const active = { ...pendingSubscription, provider: "waffo" };
		const { client, create, createAlias, update } = clientWithActive(active);

		await expect(
			createPaymentCheckoutIntent(
				{ ...subscriptionCommand, idempotencyKey: "subscription-attempt-2" },
				client as never,
			),
		).rejects.toThrow("PAYMENT_CHECKOUT_INTENT_CONFLICT");
		expect(create).not.toHaveBeenCalled();
		expect(createAlias).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	it.each([
		["provider creating", { status: "PROVIDER_CREATING" }],
		["review", { status: "REVIEW" }],
		["missing provider session", { providerSessionId: null }],
		["missing checkout URL", { providerCheckoutUrl: null }],
	])("does not reuse a %s checkout", async (_label, override) => {
		const active = { ...pendingSubscription, ...override };
		const { client, create, createAlias, update } = clientWithActive(active);

		await expect(
			createPaymentCheckoutIntent(
				{ ...subscriptionCommand, idempotencyKey: "subscription-attempt-2" },
				client as never,
			),
		).rejects.toThrow("PAYMENT_CHECKOUT_INTENT_CONFLICT");
		expect(create).not.toHaveBeenCalled();
		expect(createAlias).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	it("expires an explicitly stale checkout before creating a replacement", async () => {
		const active = {
			...pendingSubscription,
			expiresAt: new Date("2026-09-06T05:00:00.000Z"),
		};
		const replacement = { id: "intent-subscription-2", status: "CREATED" };
		const { client, create, createAlias, update } = clientWithActive(active);
		create.mockResolvedValue(replacement);
		update.mockResolvedValue(active);

		await expect(
			createPaymentCheckoutIntent(
				{
					...subscriptionCommand,
					idempotencyKey: "subscription-attempt-2",
					now: new Date("2026-09-06T06:00:00.000Z"),
				},
				client as never,
			),
		).resolves.toEqual({ intent: replacement, replayed: false });
		expect(update).toHaveBeenCalledWith({
			where: { id: pendingSubscription.id },
			data: { status: "EXPIRED", activeScopeKey: null },
		});
		expect(createAlias).not.toHaveBeenCalled();
		expect(create).toHaveBeenCalledOnce();
	});

	it("reuses the persisted credit-pack snapshot instead of recalculating a new request", async () => {
		const firstEvaluation = new Date("2026-09-06T04:00:00.000Z");
		const pendingPack = {
			...pendingSubscription,
			id: "intent-pack-1",
			productKind: "CREDIT_PACK" as const,
			billingPlanId: "billing-pack-v1",
			planKey: "credits-1500",
			interval: "one-time",
			providerSessionId: "ORDER-1",
			providerCheckoutUrl: "https://www.sandbox.paypal.com/approve-order",
			creditPackCatalogVersion: "2026-09-06.1",
			creditPackPricingVersion: "2026-09-06.1",
			creditPackSubscriberEligibilityVersion: "2026-09-06.1",
			creditPackBaseCredits: 1_500n,
			creditPackBonusCredits: 0n,
			creditPackTotalCredits: 1_500n,
			creditPackExpiryMonths: 6,
			creditPackSubscriberBonusEligible: false,
			creditPackSubscriberSubscriptionId: null,
			creditPackSubscriberPlanKey: null,
			creditPackEligibilityEvaluatedAt: firstEvaluation,
		};
		const { client, create, createAlias, update } = clientWithActive(pendingPack);

		await expect(
			createPaymentCheckoutIntent(
				{
					provider: "paypal",
					ownerType: "USER",
					ownerId: "user-1",
					submittedByUserId: "user-1",
					billingPlanId: "billing-pack-v2",
					productKind: "CREDIT_PACK",
					planKey: "credits-1500",
					interval: "one-time",
					idempotencyKey: "pack-attempt-2",
					creditPackSnapshot: {
						catalogVersion: "2026-09-06.2",
						pricingVersion: "2026-09-06.2",
						subscriberEligibilityVersion: "2026-09-06.2",
						baseCredits: 1_500n,
						bonusCredits: 300n,
						totalCredits: 1_800n,
						expiryMonths: 6,
						subscriberBonusEligible: true,
						subscriberSubscriptionId: "subscription-1",
						subscriberPlanKey: "ultimate",
						eligibilityEvaluatedAt: new Date("2026-09-06T06:00:00.000Z"),
					},
				},
				client as never,
			),
		).resolves.toEqual({ intent: pendingPack, replayed: true });
		expect(create).not.toHaveBeenCalled();
		expect(createAlias).toHaveBeenCalledWith({
			data: {
				ownerType: "USER",
				ownerId: "user-1",
				idempotencyKey: "pack-attempt-2",
				checkoutIntentId: pendingPack.id,
			},
		});
		expect(update).not.toHaveBeenCalled();
	});

	it("resolves an alias to the original frozen checkout and rejects command changes", async () => {
		const aliasReplay = {
			checkoutIntent: pendingSubscription,
		};
		const findDirect = vi.fn().mockResolvedValue(null);
		const findAlias = vi.fn().mockResolvedValue(aliasReplay);
		const transaction = {
			$queryRaw: vi.fn().mockResolvedValue([]),
			paymentCheckoutIntent: { findUnique: findDirect },
			paymentCheckoutIntentIdempotencyAlias: { findUnique: findAlias },
		};
		const client = {
			$transaction: vi.fn(async (operation: (tx: typeof transaction) => Promise<unknown>) =>
				operation(transaction),
			),
		};

		await expect(
			createPaymentCheckoutIntent(
				{ ...subscriptionCommand, idempotencyKey: "subscription-attempt-2" },
				client as never,
			),
		).resolves.toEqual({ intent: pendingSubscription, replayed: true });

		await expect(
			createPaymentCheckoutIntent(
				{
					...subscriptionCommand,
					planKey: "studio",
					interval: "year",
					idempotencyKey: "subscription-attempt-2",
				},
				client as never,
			),
		).rejects.toThrow("PAYMENT_CHECKOUT_INTENT_IDEMPOTENCY_CONFLICT");
	});

	it.each([
		["provider creating", { status: "PROVIDER_CREATING" }],
		["review", { status: "REVIEW" }],
		["missing provider session", { providerSessionId: null }],
		["missing checkout URL", { providerCheckoutUrl: null }],
	])("does not replay an aliased %s checkout", async (_label, override) => {
		const aliasedIntent = { ...pendingSubscription, ...override };
		const transaction = {
			$queryRaw: vi.fn().mockResolvedValue([]),
			paymentCheckoutIntent: { findUnique: vi.fn().mockResolvedValue(null) },
			paymentCheckoutIntentIdempotencyAlias: {
				findUnique: vi.fn().mockResolvedValue({ checkoutIntent: aliasedIntent }),
			},
		};
		const client = {
			$transaction: vi.fn(async (operation: (tx: typeof transaction) => Promise<unknown>) =>
				operation(transaction),
			),
		};

		await expect(
			createPaymentCheckoutIntent(
				{ ...subscriptionCommand, idempotencyKey: "subscription-attempt-2" },
				client as never,
			),
		).rejects.toThrow("PAYMENT_CHECKOUT_INTENT_REPLAY_UNSAFE");
	});

	it("expires the original intent before rejecting an explicitly stale alias replay", async () => {
		const staleIntent = {
			...pendingSubscription,
			expiresAt: new Date("2026-09-06T05:00:00.000Z"),
		};
		const update = vi.fn().mockResolvedValue(staleIntent);
		const transaction = {
			$queryRaw: vi.fn().mockResolvedValue([]),
			paymentCheckoutIntent: {
				findUnique: vi.fn().mockResolvedValue(null),
				update,
			},
			paymentCheckoutIntentIdempotencyAlias: {
				findUnique: vi.fn().mockResolvedValue({ checkoutIntent: staleIntent }),
			},
		};
		const client = {
			$transaction: vi.fn(async (operation: (tx: typeof transaction) => Promise<unknown>) =>
				operation(transaction),
			),
		};

		await expect(
			createPaymentCheckoutIntent(
				{
					...subscriptionCommand,
					idempotencyKey: "subscription-attempt-2",
					now: new Date("2026-09-06T06:00:00.000Z"),
				},
				client as never,
			),
		).rejects.toThrow("PAYMENT_CHECKOUT_INTENT_REPLAY_UNSAFE");
		expect(update).toHaveBeenCalledWith({
			where: { id: pendingSubscription.id },
			data: { status: "EXPIRED", activeScopeKey: null },
		});
	});

	it("fails closed when a key is bound both directly and through an alias", async () => {
		const transaction = {
			$queryRaw: vi.fn().mockResolvedValue([]),
			paymentCheckoutIntent: { findUnique: vi.fn().mockResolvedValue(pendingSubscription) },
			paymentCheckoutIntentIdempotencyAlias: {
				findUnique: vi.fn().mockResolvedValue({ checkoutIntent: pendingSubscription }),
			},
		};
		const client = {
			$transaction: vi.fn(async (operation: (tx: typeof transaction) => Promise<unknown>) =>
				operation(transaction),
			),
		};

		await expect(
			createPaymentCheckoutIntent(
				{ ...subscriptionCommand, idempotencyKey: pendingSubscription.idempotencyKey },
				client as never,
			),
		).rejects.toThrow("PAYMENT_CHECKOUT_INTENT_IDEMPOTENCY_CONFLICT");
	});
});

describe("credit-pack checkout intent correlation", () => {
	it("resets only the exact owner-scoped provider-creating intent for a safe retry", async () => {
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const client = { paymentCheckoutIntent: { updateMany } };

		await expect(
			resetPaymentCheckoutIntentProviderCreating(
				{
					intentId: "intent-pack-1",
					provider: "waffo",
					ownerType: "USER",
					ownerId: "user-1",
					expectedProductKind: "CREDIT_PACK",
				},
				client as never,
			),
		).resolves.toEqual({ count: 1 });
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: "intent-pack-1",
				provider: "waffo",
				ownerType: "USER",
				ownerId: "user-1",
				productKind: "CREDIT_PACK",
				status: "PROVIDER_CREATING",
				providerSessionId: null,
				providerCheckoutUrl: null,
				providerOrderId: null,
			},
			data: { status: "CREATED" },
		});
	});

	it("moves only the expected owner-scoped state and correlation to review", async () => {
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const client = { paymentCheckoutIntent: { updateMany } };

		await expect(
			transitionPaymentCheckoutIntentToReview(
				{
					intentId: "intent-pack-1",
					provider: "paypal",
					ownerType: "ORGANIZATION",
					ownerId: "organization-1",
					expectedStatus: "PROVIDER_PENDING",
					expectedProductKind: "CREDIT_PACK",
					expectedProviderSessionId: "paypal-order-1",
					expectedProviderOrderId: "paypal-order-1",
				},
				client as never,
			),
		).resolves.toEqual({ count: 1 });
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: "intent-pack-1",
				provider: "paypal",
				ownerType: "ORGANIZATION",
				ownerId: "organization-1",
				status: "PROVIDER_PENDING",
				productKind: "CREDIT_PACK",
				providerSessionId: "paypal-order-1",
				providerOrderId: "paypal-order-1",
			},
			data: { status: "REVIEW" },
		});
	});

	it("binds a provider order together with the checkout session", async () => {
		const boundIntent = { id: "intent-pack-1", providerOrderId: "paypal-order-1" };
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const findUniqueOrThrow = vi.fn().mockResolvedValue(boundIntent);

		const result = await bindPaymentCheckoutIntentSession(
			{
				intentId: "intent-pack-1",
				provider: "paypal",
				providerSessionId: "paypal-order-1",
				providerOrderId: "paypal-order-1",
				providerCheckoutUrl: "https://www.paypal.com/checkoutnow?token=paypal-order-1",
			},
			{ paymentCheckoutIntent: { updateMany, findUniqueOrThrow } } as never,
		);

		expect(result).toBe(boundIntent);
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: "intent-pack-1",
				provider: "paypal",
				status: "PROVIDER_CREATING",
				providerSessionId: null,
				providerCheckoutUrl: null,
				providerOrderId: null,
			},
			data: {
				providerSessionId: "paypal-order-1",
				providerOrderId: "paypal-order-1",
				providerCheckoutUrl: "https://www.paypal.com/checkoutnow?token=paypal-order-1",
				status: "PROVIDER_PENDING",
				expiresAt: null,
			},
		});
	});

	it("treats rebinding the same provider order as an idempotent replay", async () => {
		const existing = {
			id: "intent-pack-1",
			provider: "waffo",
			providerOrderId: "waffo-order-1",
		};
		const updateMany = vi.fn().mockResolvedValue({ count: 0 });
		const findUnique = vi.fn().mockResolvedValue(existing);

		const result = await bindPaymentCheckoutIntentOrder(
			{
				intentId: "intent-pack-1",
				provider: "waffo",
				providerOrderId: "waffo-order-1",
			},
			{ paymentCheckoutIntent: { updateMany, findUnique } } as never,
		);

		expect(result).toBe(existing);
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: "intent-pack-1",
				provider: "waffo",
				providerOrderId: null,
				status: { in: ["CREATED", "PROVIDER_CREATING", "PROVIDER_PENDING"] },
			},
			data: { providerOrderId: "waffo-order-1" },
		});
	});

	it("scopes checkout return state to its owner and includes fulfillment", async () => {
		const checkoutState = {
			id: "intent-pack-1",
			creditPackFulfillment: { status: "FULFILLED" },
		};
		const findFirst = vi.fn().mockResolvedValue(checkoutState);

		const result = await getPaymentCheckoutIntentForOwner(
			{ intentId: "intent-pack-1", ownerType: "USER", ownerId: "user-1" },
			{ paymentCheckoutIntent: { findFirst } } as never,
		);

		expect(result).toBe(checkoutState);
		expect(findFirst).toHaveBeenCalledWith({
			where: { id: "intent-pack-1", ownerType: "USER", ownerId: "user-1" },
			include: { billingPlan: true, creditPackFulfillment: true },
		});
	});

	it("loads the first frozen attempt by owner-scoped idempotency key", async () => {
		const checkoutState = {
			id: "intent-pack-1",
			creditPackCatalogVersion: "2026-09-06.1",
		};
		const findUnique = vi.fn().mockResolvedValue(checkoutState);
		const findAlias = vi.fn().mockResolvedValue(null);

		const result = await getPaymentCheckoutIntentForOwnerByIdempotencyKey(
			{ idempotencyKey: "pack-attempt-1", ownerType: "USER", ownerId: "user-1" },
			{
				paymentCheckoutIntent: { findUnique },
				paymentCheckoutIntentIdempotencyAlias: { findUnique: findAlias },
			} as never,
		);

		expect(result).toBe(checkoutState);
		expect(findUnique).toHaveBeenCalledWith({
			where: {
				ownerType_ownerId_idempotencyKey: {
					ownerType: "USER",
					ownerId: "user-1",
					idempotencyKey: "pack-attempt-1",
				},
			},
			include: { billingPlan: true, creditPackFulfillment: true },
		});
		expect(findAlias).toHaveBeenCalledWith({
			where: {
				ownerType_ownerId_idempotencyKey: {
					ownerType: "USER",
					ownerId: "user-1",
					idempotencyKey: "pack-attempt-1",
				},
			},
			include: {
				checkoutIntent: { include: { billingPlan: true, creditPackFulfillment: true } },
			},
		});
	});

	it("loads the original complete checkout through an idempotency alias", async () => {
		const checkoutState = {
			id: "intent-pack-1",
			ownerType: "USER",
			ownerId: "user-1",
			billingPlan: { id: "billing-pack-v1" },
			creditPackFulfillment: { status: "FULFILLED" },
		};
		const directFind = vi.fn().mockResolvedValue(null);
		const aliasFind = vi.fn().mockResolvedValue({ checkoutIntent: checkoutState });

		await expect(
			getPaymentCheckoutIntentForOwnerByIdempotencyKey(
				{ idempotencyKey: "pack-attempt-2", ownerType: "USER", ownerId: "user-1" },
				{
					paymentCheckoutIntent: { findUnique: directFind },
					paymentCheckoutIntentIdempotencyAlias: { findUnique: aliasFind },
				} as never,
			),
		).resolves.toBe(checkoutState);
	});

	it("fails closed when owner lookup finds both a direct key and an alias", async () => {
		const checkoutState = { id: "intent-pack-1" };

		await expect(
			getPaymentCheckoutIntentForOwnerByIdempotencyKey(
				{ idempotencyKey: "ambiguous-key", ownerType: "USER", ownerId: "user-1" },
				{
					paymentCheckoutIntent: {
						findUnique: vi.fn().mockResolvedValue(checkoutState),
					},
					paymentCheckoutIntentIdempotencyAlias: {
						findUnique: vi.fn().mockResolvedValue({ checkoutIntent: checkoutState }),
					},
				} as never,
			),
		).rejects.toThrow("PAYMENT_CHECKOUT_INTENT_IDEMPOTENCY_CONFLICT");
	});

	it("fails closed when an owner-scoped alias points at another owner's intent", async () => {
		await expect(
			getPaymentCheckoutIntentForOwnerByIdempotencyKey(
				{ idempotencyKey: "cross-owner-alias", ownerType: "USER", ownerId: "user-1" },
				{
					paymentCheckoutIntent: { findUnique: vi.fn().mockResolvedValue(null) },
					paymentCheckoutIntentIdempotencyAlias: {
						findUnique: vi.fn().mockResolvedValue({
							checkoutIntent: {
								id: "intent-user-2",
								ownerType: "USER",
								ownerId: "user-2",
							},
						}),
					},
				} as never,
			),
		).rejects.toThrow("PAYMENT_CHECKOUT_INTENT_IDEMPOTENCY_CONFLICT");
	});
});
