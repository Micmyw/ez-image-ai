import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import {
	assertPaymentSubscriptionCheckoutAllowed,
	createPaymentCheckoutIntent,
} from "../payment-providers";

const runId = crypto.randomUUID();
const now = new Date("2026-09-12T12:00:00Z");
const owners: string[] = [];
const plans: string[] = [];
let client: PrismaClient;

function owner() {
	const id = `subscription-admission-${runId}-${owners.length}`;
	owners.push(id);
	return id;
}

function command(ownerId: string, provider: "paypal" | "waffo" = "paypal") {
	return {
		provider,
		ownerType: "USER" as const,
		ownerId,
		submittedByUserId: ownerId,
		billingPlanId: plans[provider === "paypal" ? 0 : 1]!,
		planKey: provider === "paypal" ? "creator" : "studio",
		interval: provider === "paypal" ? ("month" as const) : ("year" as const),
		idempotencyKey: crypto.randomUUID(),
		now,
	};
}

describe("account-wide subscription checkout admission", () => {
	beforeAll(async () => {
		const url = process.env.TEST_DATABASE_URL;
		if (!url || url === process.env.DATABASE_URL) throw new Error("UNSAFE_TEST_DATABASE");
		const parsed = new URL(url);
		if (
			!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
			parsed.port !== "55432" ||
			!/test/.test(parsed.pathname)
		)
			throw new Error("UNSAFE_TEST_DATABASE");
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
		for (const provider of ["paypal", "waffo"]) {
			const plan = await client.billingPlan.create({
				data: {
					provider,
					providerPriceId: `admission-${provider}-${runId}`,
					name: provider === "paypal" ? "creator" : "studio",
					creditsPerPeriod: 700n,
					priceMicros: 19_000_000n,
					currency: "USD",
					metadata: {},
				},
			});
			plans.push(plan.id);
		}
	});

	afterAll(async () => {
		if (!client) return;
		await client.paymentCheckoutIntent.deleteMany({ where: { ownerId: { in: owners } } });
		await client.subscription.deleteMany({ where: { ownerId: { in: owners } } });
		await client.user.deleteMany({ where: { id: { in: owners } } });
		await client.billingPlan.deleteMany({ where: { id: { in: plans } } });
		await client.$disconnect();
	});

	it("admits only one concurrent checkout across providers, plans and billing intervals", async () => {
		const ownerId = owner();
		const results = await Promise.allSettled([
			createPaymentCheckoutIntent(command(ownerId), client),
			createPaymentCheckoutIntent(command(ownerId, "waffo"), client),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find(
			(result) => result.status === "rejected",
		) as PromiseRejectedResult;
		expect(rejected.reason.message).toBe("PAYMENT_CHECKOUT_INTENT_CONFLICT");
		expect(await client.paymentCheckoutIntent.count({ where: { ownerId } })).toBe(1);
	});

	it.each(["PENDING", "ACTIVE", "PAST_DUE", "CANCELED"] as const)(
		"blocks both providers while an existing %s subscription can still overlap",
		async (status) => {
			const ownerId = owner();
			await client.subscription.create({
				data: {
					ownerType: "USER",
					ownerId,
					provider: "waffo",
					providerSubscriptionId: crypto.randomUUID(),
					planId: plans[1]!,
					status,
					cancelAtPeriodEnd: true,
					currentPeriodEnd: new Date("2026-10-12T12:00:00Z"),
				},
			});
			for (const provider of ["paypal", "waffo"] as const) {
				await expect(
					createPaymentCheckoutIntent(command(ownerId, provider), client),
				).rejects.toThrow("PAYMENT_SUBSCRIPTION_ALREADY_EXISTS");
			}
			expect(await client.paymentCheckoutIntent.count({ where: { ownerId } })).toBe(0);
		},
	);

	it("blocks a second recurring charge when local access expired but provider renewal is still open", async () => {
		const ownerId = owner();
		await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "waffo",
				providerSubscriptionId: crypto.randomUUID(),
				planId: plans[1]!,
				status: "EXPIRED",
				cancelAtPeriodEnd: false,
				currentPeriodEnd: new Date("2026-08-12T12:00:00Z"),
			},
		});
		await expect(createPaymentCheckoutIntent(command(ownerId), client)).rejects.toThrow(
			"PAYMENT_SUBSCRIPTION_ALREADY_EXISTS",
		);
	});

	it.each(["CANCELED", "EXPIRED"] as const)(
		"allows a new plan after a %s subscription has ended",
		async (status) => {
			const ownerId = owner();
			await client.subscription.create({
				data: {
					ownerType: "USER",
					ownerId,
					provider: "waffo",
					providerSubscriptionId: crypto.randomUUID(),
					planId: plans[1]!,
					status,
					currentPeriodEnd: new Date("2026-08-12T12:00:00Z"),
					cancelAtPeriodEnd: true,
				},
			});
			await expect(createPaymentCheckoutIntent(command(ownerId), client)).resolves.toMatchObject({
				replayed: false,
			});
		},
	);

	it.each(["CREATED", "PROVIDER_CREATING", "PROVIDER_PENDING", "REVIEW"] as const)(
		"blocks a different product while a legacy checkout is %s",
		async (status) => {
			const ownerId = owner();
			const input = command(ownerId);
			const { now: _now, ...data } = input;
			await client.paymentCheckoutIntent.create({
				data: { ...data, status, activeScopeKey: null },
			});
			await expect(createPaymentCheckoutIntent(command(ownerId, "waffo"), client)).rejects.toThrow(
				"PAYMENT_CHECKOUT_INTENT_CONFLICT",
			);
		},
	);

	it("checks existing subscriptions again on exact replay and provider recovery", async () => {
		const ownerId = owner();
		const input = command(ownerId);
		const first = await createPaymentCheckoutIntent(input, client);
		await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "waffo",
				providerSubscriptionId: crypto.randomUUID(),
				planId: plans[1]!,
				status: "ACTIVE",
			},
		});
		await expect(createPaymentCheckoutIntent(input, client)).rejects.toThrow(
			"PAYMENT_SUBSCRIPTION_ALREADY_EXISTS",
		);
		await expect(
			assertPaymentSubscriptionCheckoutAllowed(
				{ ownerType: "USER", ownerId, checkoutIntentId: first.intent.id },
				client,
			),
		).rejects.toThrow("PAYMENT_SUBSCRIPTION_ALREADY_EXISTS");
	});

	it("does not open an admission gap while a checkout becomes a subscription", async () => {
		const ownerId = owner();
		const first = await createPaymentCheckoutIntent(command(ownerId), client);
		let ready!: () => void;
		let commit!: () => void;
		const staged = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const mayCommit = new Promise<void>((resolve) => {
			commit = resolve;
		});
		const completion = client.$transaction(async (tx) => {
			await tx.subscription.create({
				data: {
					ownerType: "USER",
					ownerId,
					provider: "paypal",
					providerSubscriptionId: crypto.randomUUID(),
					planId: plans[0]!,
					status: "ACTIVE",
				},
			});
			await tx.paymentCheckoutIntent.update({
				where: { id: first.intent.id },
				data: { status: "COMPLETED", activeScopeKey: null },
			});
			ready();
			await mayCommit;
		});
		await staged;
		try {
			await expect(createPaymentCheckoutIntent(command(ownerId, "waffo"), client)).rejects.toThrow(
				"PAYMENT_CHECKOUT_INTENT_CONFLICT",
			);
		} finally {
			commit();
			await completion;
		}
		await expect(createPaymentCheckoutIntent(command(ownerId, "waffo"), client)).rejects.toThrow(
			"PAYMENT_SUBSCRIPTION_ALREADY_EXISTS",
		);
		expect(await client.paymentCheckoutIntent.count({ where: { ownerId } })).toBe(1);
	});

	it("isolates user and organization billing ownership", async () => {
		const ownerId = owner();
		await createPaymentCheckoutIntent(command(ownerId), client);
		await expect(
			createPaymentCheckoutIntent(
				{ ...command(ownerId, "waffo"), ownerType: "ORGANIZATION" },
				client,
			),
		).resolves.toMatchObject({ replayed: false });
	});

	it("blocks a legacy live purchase even before its canonical subscription exists", async () => {
		const ownerId = owner();
		await client.user.create({
			data: {
				id: ownerId,
				name: "Subscription admission test",
				email: `${ownerId}@example.test`,
				emailVerified: true,
				createdAt: now,
				updatedAt: now,
			},
		});
		await client.purchase.create({
			data: {
				userId: ownerId,
				provider: "stripe",
				type: "SUBSCRIPTION",
				productKind: "PLAN",
				status: "TRIALING",
				customerId: crypto.randomUUID(),
				priceId: crypto.randomUUID(),
			},
		});
		await expect(createPaymentCheckoutIntent(command(ownerId), client)).rejects.toThrow(
			"PAYMENT_SUBSCRIPTION_ALREADY_EXISTS",
		);
	});

	it("preserves credit-pack checkout while the account has an active subscription", async () => {
		const ownerId = owner();
		await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "waffo",
				providerSubscriptionId: crypto.randomUUID(),
				planId: plans[1]!,
				status: "ACTIVE",
			},
		});
		await expect(
			createPaymentCheckoutIntent(
				{
					...command(ownerId),
					productKind: "CREDIT_PACK",
					planKey: "credits-1500",
					interval: "one-time",
					creditPackSnapshot: {
						catalogVersion: "test",
						pricingVersion: "test",
						subscriberEligibilityVersion: "test",
						baseCredits: 1500n,
						bonusCredits: 0n,
						totalCredits: 1500n,
						expiryMonths: 6,
						subscriberBonusEligible: false,
						subscriberSubscriptionId: null,
						subscriberPlanKey: null,
						eligibilityEvaluatedAt: now,
					},
				},
				client,
			),
		).resolves.toMatchObject({ replayed: false });
	});
});
