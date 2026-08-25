import { createHash } from "node:crypto";

import type { Prisma } from "../../generated/client";
import type { MediaDatabaseClient, MediaTransactionClient } from "./types";
import { isDatabaseUniqueConflict, runSerializable } from "./types";

export interface FindEffectivePaidSubscriptionInput {
	ownerType: "USER" | "ORGANIZATION";
	ownerId: string;
	now?: Date;
}

export async function findEffectivePaidSubscription(
	input: FindEffectivePaidSubscriptionInput,
	client: MediaDatabaseClient,
) {
	const now = input.now ?? new Date();
	return client.subscription.findFirst({
		where: {
			ownerType: input.ownerType,
			ownerId: input.ownerId,
			OR: [{ status: "ACTIVE" }, { status: "PAST_DUE", graceEndsAt: { gt: now } }],
		},
		select: {
			id: true,
			ownerType: true,
			ownerId: true,
			status: true,
			graceEndsAt: true,
			plan: { select: { metadata: true, name: true } },
		},
		orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
	});
}

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
			const duplicate = await tx.paymentEvent.findUnique({
				where: {
					provider_providerEventId: {
						provider: input.provider,
						providerEventId: input.providerEventId,
					},
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
			status: { in: ["RECEIVED", "FAILED"] },
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
	input: {
		reason: string;
		errorClass: "TERMINAL" | "TRANSIENT";
		triggerAttempt: number;
		triggerRunId?: string;
		deadLetter: boolean;
	},
	client: MediaTransactionClient,
) {
	return client.$transaction(async (tx) => {
		const changed = await tx.paymentEvent.updateMany({
			where: { id, status: "PROCESSING", processingToken: token },
			data: {
				status: input.deadLetter ? "DEAD_LETTER" : "FAILED",
				failureReason: input.reason.slice(0, 500),
				attemptCount: { increment: 1 },
				lastTriggerAttempt: input.triggerAttempt,
				lastAttemptAt: new Date(),
				lastTriggerRunId: input.triggerRunId ?? null,
				lastErrorClass: input.errorClass,
				processingToken: null,
				processingLeasedUntil: null,
			},
		});
		if (changed.count !== 1) return false;
		const event = await tx.paymentEvent.findUniqueOrThrow({
			where: { id },
			select: {
				status: true,
				failureReason: true,
				attemptCount: true,
				lastTriggerAttempt: true,
				lastAttemptAt: true,
				lastTriggerRunId: true,
				lastErrorClass: true,
			},
		});
		await tx.auditLog.create({
			data: {
				action: "PAYMENT_EVENT_FAILURE_RECORDED",
				targetType: "PAYMENT_EVENT",
				targetId: id,
				after: {
					status: event.status,
					failureReason: event.failureReason,
					attemptCount: event.attemptCount,
					lastTriggerAttempt: event.lastTriggerAttempt,
					lastAttemptAt: event.lastAttemptAt?.toISOString() ?? null,
					lastTriggerRunId: event.lastTriggerRunId,
					lastErrorClass: event.lastErrorClass,
				},
				metadata: { durable: true },
			},
		});
		return true;
	});
}

export async function recoverExpiredPaymentEvents(
	input: { now?: Date; limit?: number; maxAttempts?: number } = {},
	client: MediaTransactionClient,
): Promise<{ recovered: number; deadLettered: number }> {
	const now = input.now ?? new Date();
	const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
	const maxAttempts = Math.min(Math.max(input.maxAttempts ?? 8, 1), 100);
	return runSerializable(client, async (tx) => {
		const candidates = await tx.paymentEvent.findMany({
			where: {
				status: "PROCESSING",
				processingLeasedUntil: { lte: now },
			},
			select: {
				id: true,
				attemptCount: true,
				processingToken: true,
				processingLeasedUntil: true,
			},
			orderBy: [{ processingLeasedUntil: "asc" }, { id: "asc" }],
			take: limit,
		});
		let recovered = 0;
		let deadLettered = 0;
		for (const candidate of candidates) {
			const processingToken = candidate.processingToken;
			const processingLeasedUntil = candidate.processingLeasedUntil;
			if (!processingToken || !processingLeasedUntil) continue;
			const recoveryDedupeKey = `payment-event-recovery:${candidate.id}:${createHash("sha256")
				.update(processingToken)
				.digest("hex")}`;
			const nextAttemptCount = candidate.attemptCount + 1;
			const budgetExhausted = nextAttemptCount >= maxAttempts;
			const changed = await tx.paymentEvent.updateMany({
				where: {
					id: candidate.id,
					status: "PROCESSING",
					processingToken,
					processingLeasedUntil,
				},
				data: {
					status: budgetExhausted ? "DEAD_LETTER" : "FAILED",
					failureReason: budgetExhausted
						? "PAYMENT_EVENT_RETRY_BUDGET_EXHAUSTED"
						: "PAYMENT_EVENT_LEASE_EXPIRED",
					attemptCount: { increment: 1 },
					lastAttemptAt: now,
					lastErrorClass: "TRANSIENT",
					processingToken: null,
					processingLeasedUntil: null,
				},
			});
			if (changed.count !== 1) continue;
			if (!budgetExhausted) {
				await tx.outboxEvent.create({
					data: {
						eventType: "PAYMENT_EVENT_RECEIVED",
						aggregateType: "PAYMENT_EVENT",
						aggregateId: candidate.id,
						dedupeKey: recoveryDedupeKey,
						payload: { paymentEventId: candidate.id },
					},
				});
			}
			await tx.auditLog.create({
				data: {
					action: budgetExhausted
						? "PAYMENT_EVENT_LEASE_DEAD_LETTERED"
						: "PAYMENT_EVENT_LEASE_RECOVERED",
					targetType: "PAYMENT_EVENT",
					targetId: candidate.id,
					before: { status: "PROCESSING", attemptCount: candidate.attemptCount },
					after: {
						status: budgetExhausted ? "DEAD_LETTER" : "FAILED",
						failureReason: budgetExhausted
							? "PAYMENT_EVENT_RETRY_BUDGET_EXHAUSTED"
							: "PAYMENT_EVENT_LEASE_EXPIRED",
						attemptCount: nextAttemptCount,
						lastErrorClass: "TRANSIENT",
					},
					metadata: {
						reason: budgetExhausted
							? "PAYMENT_EVENT_RETRY_BUDGET_EXHAUSTED"
							: "PAYMENT_EVENT_LEASE_EXPIRED",
						maxAttempts,
						expiredAt: processingLeasedUntil.toISOString(),
						lastAttemptAt: now.toISOString(),
					},
				},
			});
			if (budgetExhausted) deadLettered += 1;
			else recovered += 1;
		}
		return { recovered, deadLettered };
	});
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
