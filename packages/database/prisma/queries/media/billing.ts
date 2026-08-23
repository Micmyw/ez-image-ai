import type { Prisma } from "../../generated/client";
import type { MediaTransactionClient } from "./types";
import { isDatabaseUniqueConflict, runSerializable } from "./types";

export interface IngestPaymentEventInput {
	provider: string;
	providerEventId: string;
	normalizedTransactionId?: string;
	verifiedAt: Date;
	receivedAt?: Date;
	envelope: Prisma.InputJsonValue;
}

export async function ingestPaymentEvent(
	input: IngestPaymentEventInput,
	client: MediaTransactionClient,
) {
	return runSerializable(client, async (tx) => {
		const replay = await tx.paymentEvent.findUnique({
			where: {
				provider_providerEventId: {
					provider: input.provider,
					providerEventId: input.providerEventId,
				},
			},
		});
		if (replay) return { event: replay, replayed: true };
		let event;
		try {
			event = await tx.paymentEvent.create({ data: input });
		} catch (error) {
			if (!isDatabaseUniqueConflict(error)) throw error;
			const duplicate = await tx.paymentEvent.findFirst({
				where: {
					provider: input.provider,
					OR: [
						{ providerEventId: input.providerEventId },
						...(input.normalizedTransactionId
							? [{ normalizedTransactionId: input.normalizedTransactionId }]
							: []),
					],
				},
			});
			if (!duplicate) throw error;
			return { event: duplicate, replayed: true };
		}
		await tx.outboxEvent.create({
			data: {
				eventType: "PAYMENT_EVENT_RECEIVED",
				aggregateType: "PAYMENT_EVENT",
				aggregateId: event.id,
				dedupeKey: `payment-event:${input.provider}:${input.providerEventId}`,
				payload: { paymentEventId: event.id },
			},
		});
		return { event, replayed: false };
	});
}

export async function claimPaymentEvent(
	id: string,
	client: MediaTransactionClient,
	input: { now?: Date; leaseSeconds?: number } = {},
) {
	const now = input.now ?? new Date();
	const token = crypto.randomUUID();
	const changed = await client.paymentEvent.updateMany({
		where: {
			id,
			OR: [
				{ status: { in: ["RECEIVED", "FAILED"] } },
				{ status: "PROCESSING", processingLeasedUntil: { lt: now } },
			],
		},
		data: {
			status: "PROCESSING",
			processingToken: token,
			processingLeasedUntil: new Date(now.getTime() + (input.leaseSeconds ?? 60) * 1_000),
			failureReason: null,
		},
	});
	if (changed.count !== 1) return null;
	return client.paymentEvent
		.findUniqueOrThrow({ where: { id } })
		.then((event) => ({ event, token }));
}

export async function completePaymentEvent(
	id: string,
	token: string,
	client: MediaTransactionClient,
) {
	const changed = await client.paymentEvent.updateMany({
		where: { id, status: "PROCESSING", processingToken: token },
		data: {
			status: "PROCESSED",
			processedAt: new Date(),
			processingToken: null,
			processingLeasedUntil: null,
		},
	});
	return changed.count === 1;
}

export async function failPaymentEvent(
	id: string,
	token: string,
	reason: string,
	client: MediaTransactionClient,
) {
	const changed = await client.paymentEvent.updateMany({
		where: { id, status: "PROCESSING", processingToken: token },
		data: {
			status: "FAILED",
			failureReason: reason.slice(0, 500),
			processingToken: null,
			processingLeasedUntil: null,
		},
	});
	return changed.count === 1;
}

export async function upsertSubscription(
	input: Prisma.SubscriptionUncheckedCreateInput,
	client: MediaTransactionClient,
) {
	return client.subscription.upsert({
		where: { providerSubscriptionId: input.providerSubscriptionId },
		create: input,
		update: {
			planId: input.planId,
			purchaseId: input.purchaseId,
			status: input.status,
			currentPeriodStart: input.currentPeriodStart,
			currentPeriodEnd: input.currentPeriodEnd,
			cancelAtPeriodEnd: input.cancelAtPeriodEnd,
		},
	});
}

export async function upsertBillingPeriod(
	input: Prisma.BillingPeriodUncheckedCreateInput,
	client: MediaTransactionClient,
) {
	return client.billingPeriod.upsert({
		where: {
			subscriptionId_startsAt: {
				subscriptionId: input.subscriptionId,
				startsAt: input.startsAt,
			},
		},
		create: input,
		update: {
			endsAt: input.endsAt,
			status: input.status,
			creditAmount: input.creditAmount,
			grantReferenceKey: input.grantReferenceKey,
		},
	});
}
