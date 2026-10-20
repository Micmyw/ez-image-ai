import {
	classifyInitialSubscriptionPayment,
	readInitialSubscriptionPaymentEvidence,
} from "../../shared/admin-analytics-payment-evidence";
import { normalizeSubscriptionPaymentEvidence } from "../../shared/admin-payment-facts";
import { db } from "../client";
import type { Prisma } from "../generated/client";

export async function getAdminBotConfigRow(client: Prisma.TransactionClient = db) {
	return client.adminBotConfig.findUnique({ where: { id: "platform" } });
}

export async function saveAdminBotConfigRow(
	input: {
		expectedVersion: number;
		payload: Prisma.InputJsonValue;
		encryptedSecrets: string | null;
		updatedBy: string;
	},
	client: Prisma.TransactionClient = db,
) {
	const data = {
		payload: input.payload,
		encryptedSecrets: input.encryptedSecrets,
		updatedBy: input.updatedBy,
		updatedAt: new Date(),
	};
	const changed =
		input.expectedVersion === 0
			? await client.adminBotConfig.createMany({
					data: [{ id: "platform", ...data, version: 1 }],
					skipDuplicates: true,
				})
			: await client.adminBotConfig.updateMany({
					where: { id: "platform", version: input.expectedVersion },
					data: { ...data, version: { increment: 1 } },
				});
	if (changed.count !== 1) throw new Error("ADMIN_BOT_CONFIG_CONFLICT");
	return input.expectedVersion + 1;
}

export async function claimAdminBotReceipt(
	input: { eventKey: string; event: string },
	client: Prisma.TransactionClient = db,
) {
	const result = await client.adminBotReceipt.createMany({
		data: [{ id: crypto.randomUUID(), ...input, status: "CLAIMED" }],
		skipDuplicates: true,
	});
	return result.count === 1;
}

export async function completeAdminBotReceipt(
	input: { eventKey: string; results: Prisma.InputJsonValue },
	client: Prisma.TransactionClient = db,
) {
	return client.adminBotReceipt.updateMany({
		where: { eventKey: input.eventKey, status: "CLAIMED" },
		data: { status: "COMPLETED", results: input.results, completedAt: new Date() },
	});
}

export async function getSupportBotIdentity(userId: string, client: Prisma.TransactionClient = db) {
	return client.user.findUnique({
		where: { id: userId },
		select: { name: true, email: true, createdAt: true, registrationAttribution: true },
	});
}

export interface PaymentBotReference {
	paymentEventId: string;
	provider: string;
	kind: "one-time" | "subscription";
	providerPaymentId: string;
	providerSubscriptionId?: string;
}

/** Re-read committed money and identity. Raw callback fields never become a bot receipt. */
export async function getPaymentBotData(
	input: PaymentBotReference,
	client: Prisma.TransactionClient = db,
) {
	const event = await client.paymentEvent.findUnique({
		where: { id: input.paymentEventId },
		select: {
			provider: true,
			status: true,
			verifiedAt: true,
			providerEnvironment: true,
			envelope: true,
		},
	});
	if (
		!event ||
		event.provider !== input.provider ||
		event.status !== "PROCESSED" ||
		!event.verifiedAt
	)
		return null;
	if (input.kind === "one-time") {
		const [pack, pass] = await Promise.all([
			client.creditPackFulfillment.findUnique({
				where: {
					provider_providerPaymentId: {
						provider: input.provider,
						providerPaymentId: input.providerPaymentId,
					},
				},
				include: {
					checkoutIntent: { select: { submittedByUserId: true, attribution: true, planKey: true } },
				},
			}),
			client.imagePassGrant.findUnique({
				where: {
					provider_providerPaymentId: {
						provider: input.provider,
						providerPaymentId: input.providerPaymentId,
					},
				},
				include: {
					checkoutIntent: { select: { submittedByUserId: true, attribution: true, planKey: true } },
				},
			}),
		]);
		if (!!pack === !!pass) return null;
		const payment = pack ?? pass!;
		const user = await getSupportBotIdentity(payment.checkoutIntent.submittedByUserId, client);
		return {
			eventKey: `payment:${input.provider}:${event.providerEnvironment ?? "unknown"}:${input.providerPaymentId}`,
			provider: input.provider,
			orderId: payment.id,
			providerPaymentId: input.providerPaymentId,
			amountMicros: payment.paidAmountMicros.toString(),
			currency: payment.currency,
			paidAt: payment.paidAt.toISOString(),
			chargeType: "one-time" as const,
			plan: payment.checkoutIntent.planKey,
			user,
			attribution: payment.checkoutIntent.attribution,
		};
	}
	if (!input.providerSubscriptionId) return null;
	const subscription = await client.subscription.findUnique({
		where: {
			provider_providerSubscriptionId: {
				provider: input.provider,
				providerSubscriptionId: input.providerSubscriptionId,
			},
		},
		include: { purchase: { select: { attribution: true } }, plan: { select: { name: true } } },
	});
	if (!subscription) return null;
	const binding =
		input.provider === "stripe"
			? input.providerPaymentId
			: `${input.provider}:${input.providerPaymentId}`;
	const periods = await client.billingPeriod.findMany({
		where: { subscriptionId: subscription.id, providerInvoicePaymentId: binding },
		select: {
			providerInvoiceId: true,
			providerInvoicePaymentId: true,
			providerChargeId: true,
			paidAmount: true,
			startsAt: true,
		},
		orderBy: { startsAt: "asc" },
	});
	const facts = normalizeSubscriptionPaymentEvidence(
		periods.map((period) => ({
			...period,
			provider: input.provider,
			providerSubscriptionId: input.providerSubscriptionId!,
		})),
		[event],
	);
	if (facts.evidence !== "verified") return null;
	const initial = readInitialSubscriptionPaymentEvidence(subscription.initialPaymentEvidence);
	const checkout = await client.paymentCheckoutIntent.findFirst({
		where: {
			provider: input.provider,
			ownerType: subscription.ownerType,
			ownerId: subscription.ownerId,
			...(initial
				? { id: initial.checkoutIntentId }
				: {
						OR: [
							{ providerOrderId: input.providerSubscriptionId },
							{ providerSessionId: input.providerSubscriptionId },
						],
					}),
		},
		select: { submittedByUserId: true, attribution: true },
		orderBy: { createdAt: "asc" },
	});
	const userId =
		checkout?.submittedByUserId ??
		(subscription.ownerType === "USER" ? subscription.ownerId : null);
	const user = userId ? await getSupportBotIdentity(userId, client) : null;
	const firstPayment =
		facts.firstPayment ??
		classifyInitialSubscriptionPayment(
			subscription.initialPaymentEvidence,
			facts.providerPaymentId,
			periods[0]?.startsAt,
		);
	return {
		eventKey: `payment:${input.provider}:${facts.providerEnvironment}:${facts.providerPaymentId}`,
		provider: input.provider,
		orderId: subscription.id,
		providerPaymentId: facts.providerPaymentId,
		amountMicros: facts.amountMicros.toString(),
		currency: facts.currency,
		paidAt: facts.paidAt.toISOString(),
		chargeType:
			firstPayment === true
				? ("first" as const)
				: firstPayment === false
					? ("renewal" as const)
					: ("subscription" as const),
		plan: subscription.plan.name,
		user,
		attribution: checkout?.attribution ?? subscription.purchase?.attribution ?? null,
	};
}
