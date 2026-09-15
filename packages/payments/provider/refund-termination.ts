import { runSerializable, type Prisma } from "@repo/database";

import type { PaymentProvider } from "../types";

type DatabaseClient = Parameters<typeof runSerializable>[0];
const eventType = "SUBSCRIPTION_REFUND_TERMINATION";

/** Called under the subscription lock, in the same transaction as credit revocation. */
export async function requestRefundTerminationIfCurrent(
	input: {
		subscriptionId: string;
		paymentKey: string;
		providerEnvironment?: string | null;
		now: Date;
	},
	client: Prisma.TransactionClient,
) {
	const subscription = await client.subscription.findUniqueOrThrow({
		where: { id: input.subscriptionId },
	});
	if (subscription.refundTerminationRequestedAt) return;
	// An annual payment owns twelve periods. Compare the last funded period,
	// including refunded periods, rather than falling back to an older payment.
	const latest = await client.billingPeriod.findFirst({
		where: { subscriptionId: subscription.id, paidAmount: { gt: 0n } },
		orderBy: [{ endsAt: "desc" }, { startsAt: "desc" }, { id: "desc" }],
	});
	if (latest?.providerInvoicePaymentId !== input.paymentKey) return;
	if (!(await refundIsSettled(subscription.id, input.paymentKey, client))) return;
	await client.subscription.update({
		where: { id: subscription.id },
		data: {
			refundTerminationRequestedAt: input.now,
			refundTerminationPaymentId: input.paymentKey,
			refundTerminationEnvironment: input.providerEnvironment ?? null,
			graceEndsAt: null,
		},
	});
	await enqueueTermination(subscription.id, client);
}

/** Network calls intentionally run outside any database transaction/owner lock. */
export async function terminateRefundedSubscription(
	input: { subscriptionId: string },
	client: DatabaseClient,
	dependencies: {
		getProvider(name: string): PaymentProvider | null;
		environment: Record<string, string | undefined>;
		now?: () => Date;
	},
) {
	const subscription = await client.subscription.findUnique({
		where: { id: input.subscriptionId },
		include: { plan: true },
	});
	if (!subscription?.refundTerminationRequestedAt || subscription.refundTerminatedAt) return;
	try {
		const configuredEnvironment =
			dependencies.environment[
				subscription.provider === "paypal" ? "PAYPAL_ENVIRONMENT" : "WAFFO_ENVIRONMENT"
			];
		if (
			!["paypal", "waffo"].includes(subscription.provider) ||
			!subscription.refundTerminationEnvironment ||
			subscription.refundTerminationEnvironment !== configuredEnvironment
		)
			throw new Error("REFUND_TERMINATION_ENVIRONMENT_MISMATCH");
		const checkout = await client.paymentCheckoutIntent.findFirst({
			where: {
				provider: subscription.provider,
				productKind: "PLAN",
				ownerType: subscription.ownerType,
				ownerId: subscription.ownerId,
				billingPlanId: subscription.planId,
				...(subscription.provider === "paypal"
					? { providerSessionId: subscription.providerSubscriptionId }
					: { providerOrderId: subscription.providerSubscriptionId }),
			},
		});
		if (!checkout) throw new Error("REFUND_TERMINATION_BINDING_MISSING");
		const adapter = dependencies.getProvider(subscription.provider);
		if (
			adapter?.name !== subscription.provider ||
			!adapter.cancelSubscription ||
			!adapter.inspectSubscriptionCancellation
		)
			throw new Error("REFUND_TERMINATION_PROVIDER_UNAVAILABLE");
		const inspect = () =>
			adapter.inspectSubscriptionCancellation!({
				subscriptionId: subscription.providerSubscriptionId,
				checkoutIntentId: checkout.id,
				priceId: subscription.plan.providerPriceId,
			});
		let state = await inspect();
		if (state === "RENEWING") {
			try {
				await adapter.cancelSubscription(subscription.providerSubscriptionId);
			} catch {
				// A timeout may follow provider acceptance; an authoritative read can
				// settle it. Never interpret HTTP success or failure as confirmation.
			}
			state = await inspect();
		}
		if (state !== "DISABLED") throw new Error("REFUND_TERMINATION_CONFIRMATION_PENDING");
		await runSerializable(client, async (tx) => {
			const ownerScope = `payment-subscription:${JSON.stringify([subscription.ownerType, subscription.ownerId])}`;
			await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ownerScope}, 0))::text AS "locked"`;
			await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${subscription.provider}:${subscription.providerSubscriptionId}`}, 0))::text AS "locked"`;
			const current = await tx.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
			if (current.refundTerminatedAt) return;
			if (
				!current.refundTerminationRequestedAt ||
				!current.refundTerminationPaymentId ||
				current.refundTerminationPaymentId !== subscription.refundTerminationPaymentId ||
				!(await refundIsSettled(current.id, current.refundTerminationPaymentId, tx))
			)
				throw new Error("REFUND_TERMINATION_REFUND_UNSETTLED");
			const now = dependencies.now?.() ?? new Date();
			await tx.subscription.update({
				where: { id: current.id },
				data: {
					status: "CANCELED",
					cancelAtPeriodEnd: true,
					refundTerminatedAt: now,
					refundTerminationError: null,
					graceEndsAt: null,
				},
			});
			if (current.purchaseId)
				await tx.purchase.update({
					where: { id: current.purchaseId },
					data: { status: "canceled" },
				});
			await tx.auditLog.create({
				data: {
					action: "SUBSCRIPTION_REFUND_TERMINATED",
					targetType: "SUBSCRIPTION",
					targetId: current.id,
					after: { paymentKey: current.refundTerminationPaymentId, renewalConfirmedDisabled: true },
					metadata: {
						provider: current.provider,
						providerEnvironment: current.refundTerminationEnvironment,
					},
				},
			});
		});
	} catch (error) {
		const code =
			error instanceof Error && /^REFUND_TERMINATION_[A-Z_]+$/.test(error.message)
				? error.message
				: "REFUND_TERMINATION_PROVIDER_UNAVAILABLE";
		await client.subscription.updateMany({
			where: { id: subscription.id, refundTerminatedAt: null },
			data: { refundTerminationError: code },
		});
		throw new Error(code);
	}
}

/** The hourly sweep repairs exhausted/crashed deliveries, without resetting live leases. */
export async function recoverRefundTerminations(client: DatabaseClient, limit = 100) {
	// Upgrade repair: receipts processed before automatic termination existed
	// remain immutable. Reuse their verified provenance; never invent an environment.
	const refunded = await client.$queryRaw<
		Array<{
			id: string;
			provider: string;
			providerSubscriptionId: string;
			paymentKey: string;
			providerEnvironment: string | null;
		}>
	>`
		SELECT s."id", s."provider", s."providerSubscriptionId",
			latest."providerInvoicePaymentId" AS "paymentKey", e."providerEnvironment"
		FROM "subscription" s
		JOIN LATERAL (
			SELECT p.* FROM "billing_period" p WHERE p."subscriptionId" = s."id" AND p."paidAmount" > 0
			ORDER BY p."endsAt" DESC, p."startsAt" DESC, p."id" DESC LIMIT 1
		) latest ON true
		JOIN LATERAL (
			SELECT a."paymentEventId" FROM "subscription_payment_adjustment" a
			WHERE a."subscriptionId" = s."id" AND a."creditsFinalizedAt" IS NOT NULL
			AND a."provider" || ':' || a."providerPaymentId" = latest."providerInvoicePaymentId"
			ORDER BY a."providerCreatedAt" DESC, a."id" DESC LIMIT 1
		) adjustment ON true
		LEFT JOIN "payment_event" e ON e."id" = adjustment."paymentEventId" AND e."verifiedAt" IS NOT NULL
		WHERE s."provider" IN ('paypal', 'waffo') AND s."refundTerminationRequestedAt" IS NULL
		AND latest."refundedAmount" = latest."paidAmount"
		AND (s."status" IN ('ACTIVE', 'PAST_DUE')
			OR (s."status" = 'EXPIRED' AND s."cancelAtPeriodEnd" = false)
			OR (s."status" = 'CANCELED' AND s."currentPeriodEnd" > ${new Date()}))
		ORDER BY s."createdAt", s."id" LIMIT ${Math.min(Math.max(limit, 1), 1000)}`;
	for (const candidate of refunded) {
		await runSerializable(client, async (tx) => {
			await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${candidate.provider}:${candidate.providerSubscriptionId}`}, 0))::text AS "locked"`;
			await requestRefundTerminationIfCurrent(
				{
					subscriptionId: candidate.id,
					paymentKey: candidate.paymentKey,
					providerEnvironment: candidate.providerEnvironment,
					now: new Date(),
				},
				tx,
			);
		});
	}
	const candidates = await client.$queryRaw<Array<{ id: string }>>`
		SELECT s."id" FROM "subscription" s
		LEFT JOIN "outbox_event" e ON e."dedupeKey" = 'refund-termination:' || s."id"
		WHERE s."refundTerminationRequestedAt" IS NOT NULL AND s."refundTerminatedAt" IS NULL
		AND (e."id" IS NULL OR e."status" IN ('DEAD_LETTER', 'PROCESSED'))
		ORDER BY s."refundTerminationRequestedAt", s."id" LIMIT ${Math.min(Math.max(limit, 1), 1000)}`;
	for (const candidate of candidates) {
		await runSerializable(client, async (tx) => {
			await enqueueTermination(candidate.id, tx);
			await tx.outboxEvent.updateMany({
				where: {
					dedupeKey: `refund-termination:${candidate.id}`,
					status: { in: ["DEAD_LETTER", "PROCESSED"] },
				},
				data: { status: "PENDING", attempts: 0, availableAt: new Date(), processedAt: null },
			});
		});
	}
	return { inspectedRefunds: refunded.length, requeued: candidates.length };
}

async function refundIsSettled(
	subscriptionId: string,
	paymentKey: string,
	client: Prisma.TransactionClient,
) {
	const periods = await client.billingPeriod.findMany({
		where: { subscriptionId, providerInvoicePaymentId: paymentKey },
	});
	return (
		periods.length > 0 &&
		periods.every(
			(period) =>
				period.paidAmount > 0n &&
				period.refundedAmount === period.paidAmount &&
				period.refundedCredits === period.creditAmount &&
				period.status === "REFUNDED",
		)
	);
}

export async function wakeRefundTermination(
	subscriptionId: string,
	client: Prisma.TransactionClient,
) {
	await enqueueTermination(subscriptionId, client);
	await client.outboxEvent.updateMany({
		where: {
			dedupeKey: `refund-termination:${subscriptionId}`,
			status: { in: ["DEAD_LETTER", "PROCESSED"] },
		},
		data: { status: "PENDING", attempts: 0, availableAt: new Date(), processedAt: null },
	});
	await client.outboxEvent.updateMany({
		where: { dedupeKey: `refund-termination:${subscriptionId}`, status: "PENDING" },
		data: { availableAt: new Date() },
	});
}

function enqueueTermination(subscriptionId: string, client: Prisma.TransactionClient) {
	const dedupeKey = `refund-termination:${subscriptionId}`;
	return client.outboxEvent.upsert({
		where: { dedupeKey },
		create: {
			eventType,
			aggregateType: "SUBSCRIPTION",
			aggregateId: subscriptionId,
			dedupeKey,
			payload: { subscriptionId },
		},
		update: {},
	});
}
