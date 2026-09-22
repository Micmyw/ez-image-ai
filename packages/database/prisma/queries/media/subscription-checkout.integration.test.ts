import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import {
	requestCheckoutRecovery,
	claimCheckoutRecovery,
	claimCheckoutActivation,
	finishCheckoutRecovery,
	readCheckoutRecovery,
	resolveCheckoutReview,
	recoverPendingCheckouts,
} from "../checkout-recovery";
import {
	assertPaymentSubscriptionCheckoutAllowed,
	createPaymentCheckoutIntent,
	bindPaymentCheckoutIntentSession,
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
		const intents = await client.paymentCheckoutIntent.findMany({
			where: { ownerId: { in: owners } },
			select: { id: true },
		});
		await client.outboxEvent.deleteMany({
			where: { aggregateId: { in: intents.map((i) => i.id) } },
		});
		await client.auditLog.deleteMany({ where: { targetId: { in: intents.map((i) => i.id) } } });
		await client.paymentEvent.deleteMany({
			where: { providerEventId: { startsWith: `recovery-${runId}` } },
		});
		await client.paymentCheckoutIntent.deleteMany({ where: { ownerId: { in: owners } } });
		await client.subscription.deleteMany({ where: { ownerId: { in: owners } } });
		await client.user.deleteMany({ where: { id: { in: owners } } });
		await client.billingPlan.deleteMany({ where: { id: { in: plans } } });
		await client.$disconnect();
	});

	async function openCheckout(mode: "MERCHANT" | "AUTOMATIC" = "MERCHANT") {
		const result = await createPaymentCheckoutIntent(
			{
				...command(owner()),
				checkoutRecovery: {
					version: 1,
					mode,
					sequence: 0,
					status: "PENDING",
					failures: 0,
					checks: 0,
				},
			},
			client,
		);
		const intent = await client.paymentCheckoutIntent.update({
			where: { id: result.intent.id },
			data: {
				status: "PROVIDER_PENDING",
				providerSessionId: `I-${crypto.randomUUID()}`,
				providerCheckoutUrl: "https://paypal.test/approve",
			},
		});
		return {
			id: intent.id,
			ownerType: "USER" as const,
			ownerId: intent.ownerId,
			actorUserId: intent.ownerId,
			now,
		};
	}
	async function legacyReview() {
		const pending = await openCheckout();
		const current = await client.paymentCheckoutIntent.update({
			where: { id: pending.id },
			data: {
				checkoutRecovery: {
					version: 1,
					mode: "LEGACY",
					status: "REVIEW",
					sequence: 3,
					completedSequence: 3,
					failures: 3,
					checks: 3,
					reason: "RESOURCE_NOT_FOUND",
				},
			},
			include: { billingPlan: true },
		});
		return {
			id: current.id,
			actorUserId: "admin-review-test",
			expectedUpdatedAt: current.updatedAt.toISOString(),
			operationKey: crypto.randomUUID(),
			reason: "Customer did not sign in or approve PayPal",
			evidenceReference: "Test case: merchant payment records checked",
			customerConfirmedNoApproval: true,
			merchantRecordsReviewed: true,
			providerObservation: {
				status: "UNKNOWN" as const,
				reason: "RESOURCE_NOT_FOUND" as const,
				checkedAt: now.toISOString(),
				environment: "sandbox" as const,
				scope: "paypal:integration",
				priceId: current.billingPlan.providerPriceId,
				providerSessionId: current.providerSessionId!,
			},
			now,
		};
	}
	it("closes a reviewed legacy checkout exactly once and admits only one replacement", async () => {
		const input = await legacyReview();
		const results = await Promise.all([
			resolveCheckoutReview(input, client),
			resolveCheckoutReview(input, client),
		]);
		expect(results.every((r) => r.status === "CANCELED" && r.providerCheckoutUrl === null)).toBe(
			true,
		);
		expect(results[0]!.providerSessionId).toBe(input.providerObservation.providerSessionId);
		const audits = await client.auditLog.findMany({
			where: { targetId: input.id, action: "PAYMENT_CHECKOUT_MANUALLY_CLOSED" },
		});
		expect(audits).toHaveLength(1);
		expect(audits[0]!.metadata).toMatchObject({
			providerConfirmed: false,
			evidenceReference: input.evidenceReference,
		});
		await expect(
			resolveCheckoutReview({ ...input, reason: "Changed evidence must not replay" }, client),
		).rejects.toThrow("CHECKOUT_REVIEW_STALE");
		expect(await claimCheckoutRecovery({ id: input.id, sequence: 3, now }, client)).toBeNull();
		const replacements = await Promise.allSettled([
			createPaymentCheckoutIntent(command(results[0]!.ownerId), client),
			createPaymentCheckoutIntent(command(results[0]!.ownerId, "waffo"), client),
		]);
		expect(replacements.filter((r) => r.status === "fulfilled")).toHaveLength(1);
	});
	it.each(["BILLING.SUBSCRIPTION.APPROVED", "PAYMENT.SALE.COMPLETED"])(
		"blocks a reviewed closure when %s arrived during provider inspection",
		async (eventType) => {
			const input = await legacyReview();
			await client.paymentEvent.create({
				data: {
					provider: "paypal",
					providerEventId: `recovery-${runId}-${crypto.randomUUID()}`,
					verifiedAt: now,
					envelope: {
						event_type: eventType,
						resource: { custom_id: input.id, status: "APPROVED" },
					},
				},
			});
			await expect(resolveCheckoutReview(input, client)).rejects.toThrow(
				"CHECKOUT_REVIEW_FINANCIAL_ACTIVITY",
			);
			expect(
				(await client.paymentCheckoutIntent.findUniqueOrThrow({ where: { id: input.id } })).status,
			).toBe("PROVIDER_PENDING");
			expect(await client.auditLog.count({ where: { targetId: input.id } })).toBe(0);
		},
	);
	it("rejects a changed snapshot after provider inspection without releasing the lock", async () => {
		const input = await legacyReview();
		await requestCheckoutRecovery(
			{
				id: input.id,
				ownerType: "USER",
				ownerId: (await client.paymentCheckoutIntent.findUniqueOrThrow({ where: { id: input.id } }))
					.ownerId,
				actorUserId: "owner",
				retryReview: true,
				now,
			},
			client,
		);
		await expect(resolveCheckoutReview(input, client)).rejects.toThrow("CHECKOUT_REVIEW_STALE");
	});
	it("hourly recovery never requeues REVIEW or PAID in either persistence adapter", async () => {
		const reviewed = await legacyReview();
		const paid = await openCheckout();
		await client.paymentCheckoutIntent.update({
			where: { id: paid.id },
			data: {
				checkoutRecovery: {
					version: 1,
					mode: "MERCHANT",
					status: "PAID",
					sequence: 1,
					failures: 0,
				},
			},
		});
		const ids = [reviewed.id, paid.id];
		await recoverPendingCheckouts(client, 1000, new Date("2099-01-01"));
		expect(await client.outboxEvent.count({ where: { aggregateId: { in: ids } } })).toBe(0);
	});
	it("abandons a merchant checkout atomically and admits only one replacement across providers", async () => {
		const pending = await openCheckout();
		const closed = await requestCheckoutRecovery({ ...pending, cancel: true }, client);
		expect(closed.status).toBe("CANCELED");
		expect(closed.providerCheckoutUrl).toBeNull();
		const replacements = await Promise.allSettled([
			createPaymentCheckoutIntent(command(pending.ownerId), client),
			createPaymentCheckoutIntent(command(pending.ownerId, "waffo"), client),
		]);
		expect(replacements.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(
			await client.auditLog.count({
				where: { targetId: pending.id, action: "PAYMENT_CHECKOUT_ABANDONED" },
			}),
		).toBe(1);
	});
	it("serializes activation against abandonment with the same subscription owner lock", async () => {
		for (let index = 0; index < 8; index++) {
			const pending = await openCheckout();
			await requestCheckoutRecovery(pending, client);
			const claimed = await claimCheckoutRecovery({ id: pending.id, sequence: 1, now }, client);
			const [activation] = await Promise.all([
				claimCheckoutActivation({ id: pending.id, leaseToken: claimed!.leaseToken, now }, client),
				requestCheckoutRecovery({ ...pending, cancel: true }, client),
			]);
			const current = await client.paymentCheckoutIntent.findUniqueOrThrow({
				where: { id: pending.id },
			});
			expect(current.status).toBe(activation ? "PROVIDER_PENDING" : "CANCELED");
			if (activation)
				await expect(
					createPaymentCheckoutIntent(command(pending.ownerId, "waffo"), client),
				).rejects.toThrow("PAYMENT_CHECKOUT_INTENT_CONFLICT");
		}
	});
	it("retains a verified payment received before the provider closure result", async () => {
		const pending = await openCheckout("AUTOMATIC");
		await requestCheckoutRecovery({ ...pending, cancel: true }, client);
		const claimed = await claimCheckoutRecovery({ id: pending.id, sequence: 1, now }, client);
		await client.paymentEvent.create({
			data: {
				provider: "paypal",
				providerEventId: `recovery-${runId}-paid`,
				providerSubscriptionId: claimed!.intent.providerSessionId,
				verifiedAt: now,
				envelope: { event_type: "PAYMENT.SALE.COMPLETED", resource: { custom_id: pending.id } },
			},
		});
		const result = await finishCheckoutRecovery(
			{ id: pending.id, leaseToken: claimed!.leaseToken, status: "CLOSED", now },
			client,
		);
		expect(result!.status).toBe("PROVIDER_PENDING");
		expect(readCheckoutRecovery(result!.checkoutRecovery).status).toBe("PAID");
		await expect(createPaymentCheckoutIntent(command(pending.ownerId), client)).rejects.toThrow(
			"PAYMENT_CHECKOUT_INTENT_CONFLICT",
		);
	});
	it("treats creation-only notifications as unpaid and never revives a canceled attempt", async () => {
		const pending = await openCheckout();
		await client.paymentEvent.create({
			data: {
				provider: "paypal",
				providerEventId: `recovery-${runId}-created`,
				verifiedAt: now,
				envelope: {
					event_type: "BILLING.SUBSCRIPTION.CREATED",
					resource: { custom_id: pending.id },
				},
			},
		});
		expect((await requestCheckoutRecovery({ ...pending, cancel: true }, client)).status).toBe(
			"CANCELED",
		);
		expect(await claimCheckoutRecovery({ id: pending.id, sequence: 0, now }, client)).toBeNull();
		await expect(
			bindPaymentCheckoutIntentSession(
				{
					intentId: pending.id,
					provider: "paypal",
					providerSessionId: "late-provider-create",
					providerCheckoutUrl: "https://paypal.test/late",
				},
				client,
			),
		).rejects.toThrow("PAYMENT_CHECKOUT_INTENT_BINDING_CONFLICT");
	});
	it("persists cancellation during an inspection and enqueues a fresh recovery sequence", async () => {
		const pending = await openCheckout("AUTOMATIC");
		await requestCheckoutRecovery(pending, client);
		const claimed = await claimCheckoutRecovery({ id: pending.id, sequence: 1, now }, client);
		await requestCheckoutRecovery({ ...pending, cancel: true }, client);
		const result = await finishCheckoutRecovery(
			{ id: pending.id, leaseToken: claimed!.leaseToken, status: "PENDING", now },
			client,
		);
		expect(readCheckoutRecovery(result!.checkoutRecovery)).toMatchObject({
			sequence: 2,
			cancelRequestedAt: now.toISOString(),
		});
		expect(await client.outboxEvent.count({ where: { aggregateId: pending.id } })).toBe(2);
	});
	it("keeps three unknown checks in review without preventing delayed verified payment processing", async () => {
		const pending = await openCheckout("AUTOMATIC");
		await requestCheckoutRecovery(pending, client);
		for (let sequence = 1; sequence <= 3; sequence++) {
			const at = new Date(now.getTime() + sequence * 30_000);
			const claimed = await claimCheckoutRecovery({ id: pending.id, sequence, now: at }, client);
			await finishCheckoutRecovery(
				{ id: pending.id, leaseToken: claimed!.leaseToken, status: "UNKNOWN", now: at },
				client,
			);
		}
		const current = await client.paymentCheckoutIntent.findUniqueOrThrow({
			where: { id: pending.id },
		});
		expect(current.status).toBe("PROVIDER_PENDING");
		expect(readCheckoutRecovery(current.checkoutRecovery).status).toBe("REVIEW");
		expect(
			await client.auditLog.count({
				where: { targetId: pending.id, action: "PAYMENT_CHECKOUT_RECOVERY_REVIEW" },
			}),
		).toBe(1);
	});
	it("rejects another user's cancellation without an audit or Outbox write", async () => {
		const pending = await openCheckout();
		await expect(
			requestCheckoutRecovery({ ...pending, ownerId: "other", cancel: true }, client),
		).rejects.toThrow("CHECKOUT_NOT_FOUND");
		expect(await client.outboxEvent.count({ where: { aggregateId: pending.id } })).toBe(0);
	});
	it("maintains the same closure, receipt and Outbox behavior through the Drizzle alternative", async () => {
		const previousUrl = process.env.DATABASE_URL;
		process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
		const { db: alternative } = await import("../../../drizzle/client");
		const recovery = await import("../../../drizzle/queries/checkout-recovery");
		if (previousUrl === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = previousUrl;
		try {
			const reviewed = await legacyReview();
			await recovery.recoverPendingCheckouts(1000, new Date("2099-01-01"));
			expect(await client.outboxEvent.count({ where: { aggregateId: reviewed.id } })).toBe(0);
			const closed = await recovery.resolveCheckoutReview(reviewed);
			expect(closed.status).toBe("CANCELED");
			await recovery.resolveCheckoutReview(reviewed);
			expect(
				await client.auditLog.count({
					where: { targetId: reviewed.id, action: "PAYMENT_CHECKOUT_MANUALLY_CLOSED" },
				}),
			).toBe(1);
			const approved = await legacyReview();
			await client.paymentEvent.create({
				data: {
					provider: "paypal",
					providerEventId: `recovery-${runId}-drizzle-approved`,
					verifiedAt: now,
					envelope: {
						event_type: "BILLING.SUBSCRIPTION.APPROVED",
						resource: { custom_id: approved.id, status: "APPROVED" },
					},
				},
			});
			await expect(recovery.resolveCheckoutReview(approved)).rejects.toThrow(
				"CHECKOUT_REVIEW_FINANCIAL_ACTIVITY",
			);
			const replaceable = await openCheckout();
			expect(
				(await recovery.requestCheckoutRecovery({ ...replaceable, cancel: true })).status,
			).toBe("CANCELED");
			const pending = await openCheckout("AUTOMATIC");
			await recovery.requestCheckoutRecovery({ ...pending, cancel: true });
			const claimed = await recovery.claimCheckoutRecovery({ id: pending.id, sequence: 1, now });
			expect(claimed?.leaseToken).toBeTruthy();
			await client.paymentEvent.create({
				data: {
					provider: "paypal",
					providerEventId: `recovery-${runId}-drizzle-paid`,
					verifiedAt: now,
					envelope: { event_type: "PAYMENT.SALE.COMPLETED", resource: { custom_id: pending.id } },
				},
			});
			const result = await recovery.finishCheckoutRecovery({
				id: pending.id,
				leaseToken: claimed!.leaseToken,
				status: "CLOSED",
				now,
			});
			expect(result?.status).toBe("PROVIDER_PENDING");
			expect(readCheckoutRecovery(result?.checkoutRecovery).status).toBe("PAID");
			expect(await client.outboxEvent.count({ where: { aggregateId: pending.id } })).toBe(1);
		} finally {
			await alternative.$client.end();
		}
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
		"blocks legacy %s cancellation without provider confirmation after local expiry",
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
					currentPeriodEnd: new Date("2026-08-12T12:00:00Z"),
				},
			});
			await expect(createPaymentCheckoutIntent(command(ownerId), client)).rejects.toThrow(
				"PAYMENT_SUBSCRIPTION_ALREADY_EXISTS",
			);
		},
	);

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
					renewalDisabledAt: new Date("2026-08-10T12:00:00Z"),
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

	it.each(["paypal", "waffo"] as const)(
		"blocks another provider after a %s checkout link expires while payment remains unresolved",
		async (provider) => {
			const ownerId = owner();
			const first = await createPaymentCheckoutIntent(command(ownerId, provider), client);
			await client.paymentCheckoutIntent.update({
				where: { id: first.intent.id },
				data: {
					status: "PROVIDER_PENDING",
					providerSessionId: `pending-${crypto.randomUUID()}`,
					providerCheckoutUrl: "https://checkout.example.test/expired",
					expiresAt: new Date(now.getTime() - 1),
				},
			});
			await expect(
				createPaymentCheckoutIntent(
					command(ownerId, provider === "paypal" ? "waffo" : "paypal"),
					client,
				),
			).rejects.toThrow("PAYMENT_CHECKOUT_INTENT_CONFLICT");
			expect(await client.paymentCheckoutIntent.count({ where: { ownerId } })).toBe(1);
			await expect(
				client.paymentCheckoutIntent.findUnique({ where: { id: first.intent.id } }),
			).resolves.toMatchObject({
				status: "PROVIDER_PENDING",
				activeScopeKey: first.intent.activeScopeKey,
			});
		},
	);

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
