import { runSerializable, type Prisma } from "@repo/database";

import type { PaymentProvider } from "../types";

type DatabaseClient = Parameters<typeof runSerializable>[0];

/** Persist the owned request and its delivery atomically, before contacting a PSP. */
export async function requestSubscriptionCancellation(
	input: { purchaseId: string; ownerType: "USER" | "ORGANIZATION"; ownerId: string },
	client: DatabaseClient,
) {
	return runSerializable(client, async (tx) => {
		const ownerScope = `payment-subscription:${JSON.stringify([input.ownerType, input.ownerId])}`;
		await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ownerScope}, 0))::text AS "locked"`;
		const subscription = await tx.subscription.findUnique({
			where: { purchaseId: input.purchaseId },
			include: { purchase: true },
		});
		if (
			!subscription ||
			!["paypal", "waffo"].includes(subscription.provider) ||
			subscription.ownerType !== input.ownerType ||
			subscription.ownerId !== input.ownerId ||
			subscription.purchase?.productKind !== "PLAN" ||
			subscription.purchase.type !== "SUBSCRIPTION" ||
			subscription.purchase.provider !== subscription.provider ||
			subscription.purchase.subscriptionId !== subscription.providerSubscriptionId ||
			(input.ownerType === "USER"
				? subscription.purchase.userId !== input.ownerId ||
					subscription.purchase.organizationId !== null
				: subscription.purchase.organizationId !== input.ownerId ||
					subscription.purchase.userId !== null)
		)
			throw new Error("SUBSCRIPTION_CANCELLATION_BINDING_INVALID");
		await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${subscription.provider}:${subscription.providerSubscriptionId}`}, 0))::text AS "locked"`;
		const current = await tx.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
		if (current.renewalDisabledAt || current.refundTerminationRequestedAt) return;
		await tx.subscription.update({
			where: { id: current.id },
			data: {
				cancellationRequestedAt: current.cancellationRequestedAt ?? new Date(),
				cancellationError: null,
			},
		});
		await enqueueCancellation(current.id, tx);
	});
}

/** Authenticated inspection is required for historical ambiguous cancellation rows too. */
export async function confirmSubscriptionCancellation(
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
	if (!subscription || subscription.renewalDisabledAt || subscription.refundTerminationRequestedAt)
		return;
	try {
		// Use a verified receipt bound to this subscription; never assume today's
		// merchant mode is the one under which the old subscription was created.
		const receipt = await client.paymentEvent.findFirst({
			where: {
				provider: subscription.provider,
				providerSubscriptionId: subscription.providerSubscriptionId,
				status: "PROCESSED",
			},
			orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
		});
		const environment =
			dependencies.environment[
				subscription.provider === "paypal" ? "PAYPAL_ENVIRONMENT" : "WAFFO_ENVIRONMENT"
			];
		if (
			!["paypal", "waffo"].includes(subscription.provider) ||
			!receipt?.providerEnvironment ||
			receipt.providerEnvironment !== environment
		)
			throw new Error("SUBSCRIPTION_CANCELLATION_ENVIRONMENT_MISMATCH");
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
		if (!checkout) throw new Error("SUBSCRIPTION_CANCELLATION_BINDING_INVALID");
		const adapter = dependencies.getProvider(subscription.provider);
		if (
			adapter?.name !== subscription.provider ||
			!adapter.inspectSubscriptionCancellation ||
			!adapter.cancelSubscription
		)
			throw new Error("SUBSCRIPTION_CANCELLATION_PROVIDER_UNAVAILABLE");
		const inspect = () =>
			adapter.inspectSubscriptionCancellation!({
				subscriptionId: subscription.providerSubscriptionId,
				checkoutIntentId: checkout.id,
				priceId: subscription.plan.providerPriceId,
			});
		let state = await inspect();
		if (state === "RENEWING" && subscription.cancellationRequestedAt) {
			try {
				await adapter.cancelSubscription(subscription.providerSubscriptionId);
			} catch {
				// Provider acceptance can precede a timeout. Read back before retrying.
			}
			state = await inspect();
		}
		if (state !== "DISABLED") throw new Error("SUBSCRIPTION_CANCELLATION_CONFIRMATION_PENDING");
		await runSerializable(client, async (tx) => {
			const ownerScope = `payment-subscription:${JSON.stringify([subscription.ownerType, subscription.ownerId])}`;
			await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ownerScope}, 0))::text AS "locked"`;
			await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${subscription.provider}:${subscription.providerSubscriptionId}`}, 0))::text AS "locked"`;
			const current = await tx.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
			if (current.renewalDisabledAt || current.refundTerminationRequestedAt) return;
			await tx.subscription.update({
				where: { id: current.id },
				data: {
					renewalDisabledAt: dependencies.now?.() ?? new Date(),
					cancelAtPeriodEnd: true,
					cancellationError: null,
					status: "CANCELED",
				},
			});
			if (current.purchaseId)
				await tx.purchase.update({
					where: { id: current.purchaseId },
					data: { status: "canceled" },
				});
			await tx.auditLog.create({
				data: {
					action: "SUBSCRIPTION_RENEWAL_DISABLED",
					targetType: "SUBSCRIPTION",
					targetId: current.id,
					after: { renewalConfirmedDisabled: true },
					metadata: { provider: current.provider, providerEnvironment: environment },
				},
			});
		});
	} catch (error) {
		const code =
			error instanceof Error && /^SUBSCRIPTION_CANCELLATION_[A-Z_]+$/.test(error.message)
				? error.message
				: "SUBSCRIPTION_CANCELLATION_PROVIDER_UNAVAILABLE";
		await client.subscription.updateMany({
			where: { id: subscription.id, renewalDisabledAt: null, refundTerminationRequestedAt: null },
			data: { cancellationError: code },
		});
		throw new Error(code);
	}
}

/** Requeue exhausted deliveries and inspect legacy canceling/expired rows fairly. */
export async function recoverSubscriptionCancellations(client: DatabaseClient, limit = 100) {
	const candidates = await client.$queryRaw<Array<{ id: string }>>`
		SELECT s."id" FROM "subscription" s
		LEFT JOIN "outbox_event" e ON e."dedupeKey" = 'subscription-cancellation:' || s."id"
		WHERE s."provider" IN ('paypal', 'waffo') AND s."renewalDisabledAt" IS NULL
		AND s."refundTerminationRequestedAt" IS NULL
		AND (s."cancellationRequestedAt" IS NOT NULL OR s."cancelAtPeriodEnd" = true OR s."status" = 'CANCELED')
		AND (e."id" IS NULL OR e."status" IN ('DEAD_LETTER', 'PROCESSED'))
		ORDER BY s."updatedAt", s."id" LIMIT ${Math.min(Math.max(limit, 1), 1000)}`;
	for (const candidate of candidates)
		await runSerializable(client, (tx) => enqueueCancellation(candidate.id, tx));
	return { requeued: candidates.length };
}

async function enqueueCancellation(subscriptionId: string, client: Prisma.TransactionClient) {
	const dedupeKey = `subscription-cancellation:${subscriptionId}`;
	await client.outboxEvent.upsert({
		where: { dedupeKey },
		create: {
			eventType: "SUBSCRIPTION_CANCELLATION_REQUESTED",
			aggregateType: "SUBSCRIPTION",
			aggregateId: subscriptionId,
			dedupeKey,
			payload: { subscriptionId },
		},
		update: {},
	});
	await client.outboxEvent.updateMany({
		where: { dedupeKey, status: { in: ["DEAD_LETTER", "PROCESSED"] } },
		data: { status: "PENDING", attempts: 0, availableAt: new Date(), processedAt: null },
	});
}
