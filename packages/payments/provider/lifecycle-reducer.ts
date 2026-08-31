import { createCreditGrant, type Prisma } from "@repo/database";

import type {
	ProviderBillingFact,
	ProviderBillingPeriodFact,
	ProviderPaymentFact,
} from "./lifecycle-normalization";
import { createAnnualBillingPeriods, isExactBillingInterval } from "./stripe/events";

type TransactionClient = Prisma.TransactionClient;
type ResolvedProviderPayment = Omit<ProviderPaymentFact, "periodStart" | "periodEnd"> & {
	periodStart: Date;
	periodEnd: Date;
	interval: "month" | "year";
	allowsStaleEvent: boolean;
};

export async function applyProviderBillingFact(
	fact: ProviderBillingFact,
	client: TransactionClient,
): Promise<{ grantsCreated: number }> {
	await client.$queryRaw<Array<{ locked: string }>>`
		SELECT pg_advisory_xact_lock(
			hashtextextended(${`${fact.provider}:${fact.providerSubscriptionId}`}, 0)
		)::text AS "locked"`;

	const checkoutIntent = fact.checkoutIntentId
		? await client.paymentCheckoutIntent.findUnique({
				where: { id: fact.checkoutIntentId },
				include: { billingPlan: true },
			})
		: null;
	let subscription = await client.subscription.findUnique({
		where: {
			provider_providerSubscriptionId: {
				provider: fact.provider,
				providerSubscriptionId: fact.providerSubscriptionId,
			},
		},
		include: { plan: true, purchase: true },
	});

	const subscriptionExisted = Boolean(subscription);
	if (!subscription) {
		if (fact.payment && (!fact.payment.periodStart || !fact.payment.periodEnd)) {
			throw new Error("PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISSING");
		}
		assertCheckoutCorrelation(fact, checkoutIntent);
		const providerCustomerId = requiredInitialCustomer(fact, checkoutIntent!);
		await assertAndPersistCustomer(
			fact.provider,
			checkoutIntent!.ownerType,
			checkoutIntent!.ownerId,
			providerCustomerId,
			client,
		);
		const purchase = await createBoundPurchase(fact, checkoutIntent!, providerCustomerId, client);
		subscription = await client.subscription.create({
			data: {
				provider: fact.provider,
				providerSubscriptionId: fact.providerSubscriptionId,
				ownerType: checkoutIntent!.ownerType,
				ownerId: checkoutIntent!.ownerId,
				planId: checkoutIntent!.billingPlanId,
				purchaseId: purchase.id,
				status: fact.status,
				cancelAtPeriodEnd: fact.cancelAtPeriodEnd,
				lastProviderEventAt: fact.occurredAt,
				lastProviderEventId: fact.providerEventId,
			},
			include: { plan: true, purchase: true },
		});
	} else {
		assertExistingSubscription(fact, subscription, checkoutIntent);
		const providerCustomerId = fact.providerCustomerId ?? subscription.purchase!.customerId;
		if (providerCustomerId !== subscription.purchase!.customerId) {
			throw new Error("PAYMENT_PROVIDER_CUSTOMER_MISMATCH");
		}
		await assertAndPersistCustomer(
			fact.provider,
			subscription.ownerType,
			subscription.ownerId,
			providerCustomerId,
			client,
		);
	}

	const lifecyclePeriod = fact.currentPeriod
		? validateLifecyclePeriod(fact.currentPeriod, subscription.plan.metadata)
		: null;
	const paymentPeriod = fact.payment ? await validatePayment(fact, subscription, client) : null;
	const currentPeriod = paymentPeriod ?? lifecyclePeriod;
	const preserveSubscriptionEvent =
		subscriptionExisted &&
		paymentPeriod?.allowsStaleEvent === true &&
		isEventStale(fact, subscription);
	if (subscriptionExisted && !preserveSubscriptionEvent) {
		assertEventOrdering(fact, subscription);
	}
	const updated = preserveSubscriptionEvent
		? subscription
		: await client.subscription.update({
				where: { id: subscription.id },
				data: {
					status: fact.status,
					cancelAtPeriodEnd: fact.cancelAtPeriodEnd,
					lastProviderEventAt: fact.occurredAt,
					lastProviderEventId: fact.providerEventId,
					...(currentPeriod
						? {
								currentPeriodStart: currentPeriod.periodStart,
								currentPeriodEnd: currentPeriod.periodEnd,
							}
						: {}),
					graceEndsAt:
						fact.status === "PAST_DUE"
							? subscription.currentPeriodEnd
							: fact.status === "ACTIVE"
								? null
								: subscription.graceEndsAt,
				},
			});
	if (!preserveSubscriptionEvent) {
		await client.purchase.update({
			where: { id: subscription.purchase!.id },
			data: { status: fact.status.toLowerCase(), priceId: subscription.plan.providerPriceId },
		});
	}
	if (checkoutIntent) {
		const completed = await client.paymentCheckoutIntent.updateMany({
			where: {
				id: checkoutIntent.id,
				provider: fact.provider,
				providerSessionId: fact.providerSubscriptionId,
				status: "PROVIDER_PENDING",
			},
			data: { status: "COMPLETED", activeScopeKey: null },
		});
		if (!subscriptionExisted && completed.count !== 1) {
			throw new Error("PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISMATCH");
		}
	}

	const grantsCreated = paymentPeriod
		? await applyProviderPayment(
				fact,
				paymentPeriod,
				{
					id: updated.id,
					ownerType: updated.ownerType,
					ownerId: updated.ownerId,
					plan: subscription.plan,
				},
				client,
			)
		: 0;
	return { grantsCreated };
}

function assertCheckoutCorrelation(
	fact: ProviderBillingFact,
	checkoutIntent:
		| (Awaited<ReturnType<TransactionClient["paymentCheckoutIntent"]["findUnique"]>> & {
				billingPlan?: unknown;
		  })
		| null,
): void {
	if (!checkoutIntent) {
		throw new Error("PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISSING");
	}
	if (checkoutIntent.provider !== fact.provider || checkoutIntent.status !== "PROVIDER_PENDING") {
		throw new Error("PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISMATCH");
	}
	if (checkoutIntent.providerSessionId !== fact.providerSubscriptionId) {
		throw new Error("PAYMENT_PROVIDER_CHECKOUT_SESSION_MISMATCH");
	}
}

function requiredInitialCustomer(
	fact: ProviderBillingFact,
	checkoutIntent: { ownerType: "USER" | "ORGANIZATION"; ownerId: string },
): string {
	const providerCustomerId = fact.providerCustomerId;
	if (!providerCustomerId) throw new Error("PAYMENT_PROVIDER_CUSTOMER_MISSING");
	if (
		fact.provider === "waffo" &&
		providerCustomerId !== `${checkoutIntent.ownerType}:${checkoutIntent.ownerId}`
	) {
		throw new Error("PAYMENT_PROVIDER_OWNER_MISMATCH");
	}
	return providerCustomerId;
}

async function createBoundPurchase(
	fact: ProviderBillingFact,
	checkoutIntent: {
		ownerType: "USER" | "ORGANIZATION";
		ownerId: string;
		billingPlan: { providerPriceId: string };
	},
	providerCustomerId: string,
	client: TransactionClient,
) {
	const existing = await client.purchase.findUnique({
		where: {
			provider_subscriptionId: {
				provider: fact.provider,
				subscriptionId: fact.providerSubscriptionId,
			},
		},
	});
	if (existing) throw new Error("PAYMENT_PROVIDER_PURCHASE_BINDING_CONFLICT");
	return client.purchase.create({
		data: {
			provider: fact.provider,
			type: "SUBSCRIPTION",
			customerId: providerCustomerId,
			subscriptionId: fact.providerSubscriptionId,
			priceId: checkoutIntent.billingPlan.providerPriceId,
			status: fact.status.toLowerCase(),
			organizationId: checkoutIntent.ownerType === "ORGANIZATION" ? checkoutIntent.ownerId : null,
			userId: checkoutIntent.ownerType === "USER" ? checkoutIntent.ownerId : null,
		},
	});
}

function assertExistingSubscription(
	fact: ProviderBillingFact,
	subscription: {
		provider: string;
		ownerType: "USER" | "ORGANIZATION";
		ownerId: string;
		planId: string;
		purchase: { provider: string; subscriptionId: string | null; customerId: string } | null;
	},
	checkoutIntent: {
		provider: string;
		ownerType: "USER" | "ORGANIZATION";
		ownerId: string;
		billingPlanId: string;
		providerSessionId: string | null;
	} | null,
): void {
	if (
		subscription.provider !== fact.provider ||
		!subscription.purchase ||
		subscription.purchase.provider !== fact.provider ||
		subscription.purchase.subscriptionId !== fact.providerSubscriptionId
	) {
		throw new Error("PAYMENT_PROVIDER_SUBSCRIPTION_BINDING_INVALID");
	}
	if (
		checkoutIntent &&
		(checkoutIntent.provider !== fact.provider ||
			checkoutIntent.providerSessionId !== fact.providerSubscriptionId ||
			checkoutIntent.ownerType !== subscription.ownerType ||
			checkoutIntent.ownerId !== subscription.ownerId ||
			checkoutIntent.billingPlanId !== subscription.planId)
	) {
		throw new Error("PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISMATCH");
	}
}

function assertEventOrdering(
	fact: ProviderBillingFact,
	subscription: { lastProviderEventAt: Date | null; lastProviderEventId: string | null },
): void {
	if (isEventStale(fact, subscription)) {
		throw new Error("PAYMENT_PROVIDER_EVENT_STALE");
	}
}

function isEventStale(
	fact: ProviderBillingFact,
	subscription: { lastProviderEventAt: Date | null; lastProviderEventId: string | null },
): boolean {
	if (!subscription.lastProviderEventAt) return false;
	const delta = fact.occurredAt.getTime() - subscription.lastProviderEventAt.getTime();
	return (
		delta < 0 ||
		(delta === 0 &&
			subscription.lastProviderEventId !== null &&
			fact.providerEventId !== subscription.lastProviderEventId &&
			fact.providerEventId < subscription.lastProviderEventId)
	);
}

async function assertAndPersistCustomer(
	provider: "paypal" | "waffo",
	ownerType: "USER" | "ORGANIZATION",
	ownerId: string,
	providerCustomerId: string,
	client: TransactionClient,
): Promise<void> {
	const existing = await client.paymentCustomer.findUnique({
		where: { provider_ownerType_ownerId: { provider, ownerType, ownerId } },
	});
	if (existing && existing.providerCustomerId !== providerCustomerId) {
		throw new Error("PAYMENT_PROVIDER_CUSTOMER_MISMATCH");
	}
	if (!existing) {
		await client.paymentCustomer.create({
			data: { provider, ownerType, ownerId, providerCustomerId },
		});
	}
}

async function validatePayment(
	fact: ProviderBillingFact,
	subscription: {
		id: string;
		currentPeriodStart: Date | null;
		currentPeriodEnd: Date | null;
		plan: {
			priceMicros: bigint;
			currency: string;
			creditsPerPeriod: bigint;
			metadata: Prisma.JsonValue;
		};
	},
	client: TransactionClient,
): Promise<ResolvedProviderPayment> {
	const payment = fact.payment!;
	const providerPaymentId = `${fact.provider}:${payment.providerPaymentId}`;
	await client.$queryRaw<Array<{ locked: string }>>`
		SELECT pg_advisory_xact_lock(
			hashtextextended(${`payment-provider-payment:${providerPaymentId}`}, 0)
		)::text AS "locked"`;
	const existingBindings = await client.billingPeriod.findMany({
		where: { providerInvoicePaymentId: providerPaymentId },
		orderBy: { startsAt: "asc" },
	});
	if (existingBindings.some((period) => period.subscriptionId !== subscription.id)) {
		throw new Error("PAYMENT_PROVIDER_PAYMENT_BINDING_CONFLICT");
	}

	if (payment.amountMicros !== subscription.plan.priceMicros) {
		throw new Error("PAYMENT_PROVIDER_AMOUNT_MISMATCH");
	}
	if (payment.currency !== subscription.plan.currency) {
		throw new Error("PAYMENT_PROVIDER_CURRENCY_MISMATCH");
	}
	const interval = jsonString(subscription.plan.metadata, "interval");
	if (interval !== "month" && interval !== "year") {
		throw new Error("PAYMENT_PROVIDER_PERIOD_MISMATCH");
	}

	if (existingBindings.length > 0) {
		const expectedCount = interval === "year" ? 12 : 1;
		const first = existingBindings[0]!;
		const last = existingBindings[existingBindings.length - 1]!;
		if (
			existingBindings.length !== expectedCount ||
			existingBindings.some(
				(period) =>
					period.paidAmount !== payment.amountMicros ||
					period.creditAmount !== subscription.plan.creditsPerPeriod,
			) ||
			(payment.periodStart && payment.periodStart.getTime() !== first.startsAt.getTime()) ||
			(payment.periodEnd && payment.periodEnd.getTime() !== last.endsAt.getTime()) ||
			!isExactBillingInterval({
				interval,
				startsAt: first.startsAt,
				endsAt: last.endsAt,
			})
		) {
			throw new Error("PAYMENT_PROVIDER_PAYMENT_BINDING_CONFLICT");
		}
		return {
			...payment,
			periodStart: first.startsAt,
			periodEnd: last.endsAt,
			interval,
			allowsStaleEvent: true,
		};
	}

	let periodStart = payment.periodStart;
	let periodEnd = payment.periodEnd;
	let allowsStaleEvent = false;
	if (!periodStart && !periodEnd) {
		if (
			fact.provider !== "paypal" ||
			!subscription.currentPeriodStart ||
			!subscription.currentPeriodEnd
		) {
			throw new Error("PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISSING");
		}
		if (
			fact.occurredAt >= subscription.currentPeriodStart &&
			fact.occurredAt < subscription.currentPeriodEnd
		) {
			periodStart = subscription.currentPeriodStart;
			periodEnd = subscription.currentPeriodEnd;
			allowsStaleEvent = true;
		} else {
			periodStart = subscription.currentPeriodEnd;
			periodEnd = nextPeriodEndFromTrustedBounds(
				subscription.currentPeriodStart,
				subscription.currentPeriodEnd,
				interval,
			);
		}
		if (fact.occurredAt < periodStart || fact.occurredAt >= periodEnd) {
			throw new Error("PAYMENT_PROVIDER_PERIOD_MISMATCH");
		}
	} else if (!periodStart || !periodEnd) {
		throw new Error("PAYMENT_PROVIDER_PERIOD_MISMATCH");
	}
	if (
		!isExactBillingInterval({
			interval,
			startsAt: periodStart,
			endsAt: periodEnd,
		})
	) {
		throw new Error("PAYMENT_PROVIDER_PERIOD_MISMATCH");
	}
	return {
		...payment,
		periodStart,
		periodEnd,
		interval,
		allowsStaleEvent,
	};
}

function validateLifecyclePeriod(
	period: ProviderBillingPeriodFact,
	metadata: Prisma.JsonValue,
): ProviderBillingPeriodFact {
	const interval = jsonString(metadata, "interval");
	if (
		(interval !== "month" && interval !== "year") ||
		!isExactBillingInterval({
			interval,
			startsAt: period.periodStart,
			endsAt: period.periodEnd,
		})
	) {
		throw new Error("PAYMENT_PROVIDER_PERIOD_MISMATCH");
	}
	return period;
}

async function applyProviderPayment(
	fact: ProviderBillingFact,
	payment: ResolvedProviderPayment,
	subscription: {
		id: string;
		ownerType: "USER" | "ORGANIZATION";
		ownerId: string;
		plan: { creditsPerPeriod: bigint; metadata: Prisma.JsonValue };
	},
	client: TransactionClient,
): Promise<number> {
	const interval = jsonString(subscription.plan.metadata, "interval");
	if (interval !== payment.interval) {
		throw new Error("PAYMENT_PROVIDER_PERIOD_MISMATCH");
	}
	const periods =
		interval === "year"
			? createAnnualBillingPeriods({
					startsAt: payment.periodStart,
					endsAt: payment.periodEnd,
					creditsPerPeriod: subscription.plan.creditsPerPeriod,
				})
			: [
					{
						startsAt: payment.periodStart,
						endsAt: payment.periodEnd,
						creditAmount: subscription.plan.creditsPerPeriod,
					},
				];
	let grantsCreated = 0;
	const providerPaymentId = `${fact.provider}:${payment.providerPaymentId}`;
	for (const [index, period] of periods.entries()) {
		const referenceKey = `${fact.provider}-payment:${payment.providerPaymentId}:period:${index}:grant`;
		const existing = await client.billingPeriod.findUnique({
			where: {
				subscriptionId_startsAt: {
					subscriptionId: subscription.id,
					startsAt: period.startsAt,
				},
			},
		});
		if (
			existing &&
			(existing.endsAt.getTime() !== period.endsAt.getTime() ||
				existing.creditAmount !== period.creditAmount ||
				(existing.providerInvoicePaymentId !== null &&
					existing.providerInvoicePaymentId !== providerPaymentId))
		) {
			throw new Error("PAYMENT_PROVIDER_PAYMENT_BINDING_CONFLICT");
		}
		const active = fact.occurredAt >= period.startsAt && fact.occurredAt < period.endsAt;
		const saved = existing
			? await client.billingPeriod.update({
					where: { id: existing.id },
					data: {
						status: active ? "ACTIVE" : existing.status,
						grantReferenceKey: existing.grantReferenceKey ?? referenceKey,
						providerInvoiceId: providerPaymentId,
						providerInvoicePaymentId: providerPaymentId,
						paidAmount: payment.amountMicros,
					},
				})
			: await client.billingPeriod.create({
					data: {
						subscriptionId: subscription.id,
						startsAt: period.startsAt,
						endsAt: period.endsAt,
						status: active ? "ACTIVE" : "PENDING",
						creditAmount: period.creditAmount,
						grantReferenceKey: referenceKey,
						providerInvoiceId: providerPaymentId,
						providerInvoicePaymentId: providerPaymentId,
						paidAmount: payment.amountMicros,
					},
				});
		if (!active) continue;
		const account = await client.creditAccount.upsert({
			where: {
				ownerType_ownerId: {
					ownerType: subscription.ownerType,
					ownerId: subscription.ownerId,
				},
			},
			create: { ownerType: subscription.ownerType, ownerId: subscription.ownerId },
			update: {},
		});
		const existingGrant = await client.creditLedgerEntry.findUnique({
			where: { referenceKey },
		});
		await createCreditGrant(
			{
				accountId: account.id,
				amount: saved.creditAmount,
				referenceKey,
				expiresAt: saved.endsAt,
				metadata: {
					provider: fact.provider,
					providerPaymentId: payment.providerPaymentId,
					billingPeriodId: saved.id,
				},
			},
			client,
		);
		if (!existingGrant) grantsCreated += 1;
	}
	return grantsCreated;
}

function nextPeriodEndFromTrustedBounds(
	currentStart: Date,
	currentEnd: Date,
	interval: "month" | "year",
): Date {
	if (currentEnd <= currentStart) throw new Error("PAYMENT_PROVIDER_PERIOD_MISMATCH");
	const monthOffset = interval === "year" ? 12 : 1;
	const anchorDay = Math.max(currentStart.getUTCDate(), currentEnd.getUTCDate());
	const target = new Date(
		Date.UTC(
			currentEnd.getUTCFullYear(),
			currentEnd.getUTCMonth() + monthOffset,
			1,
			currentEnd.getUTCHours(),
			currentEnd.getUTCMinutes(),
			currentEnd.getUTCSeconds(),
			currentEnd.getUTCMilliseconds(),
		),
	);
	const lastDay = new Date(
		Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
	).getUTCDate();
	target.setUTCDate(Math.min(anchorDay, lastDay));
	return target;
}

function jsonString(value: Prisma.JsonValue, key: string): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const result = value[key];
	return typeof result === "string" ? result : null;
}
