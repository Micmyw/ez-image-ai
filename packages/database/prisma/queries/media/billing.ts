import { createHash } from "node:crypto";

import type { Prisma } from "../../generated/client";
import { transitionPaymentCheckoutIntentToReview } from "../payment-providers";
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
	providerSubscriptionId?: string;
	verifiedAt: Date;
	receivedAt?: Date;
	envelope: Prisma.InputJsonValue;
}

export const PAYMENT_PROVIDER_CORRELATION_MISSING = "PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISSING";

interface CreditPackReviewCandidate {
	provider: "paypal" | "waffo";
	checkoutIntentId: string;
	providerOrderId: string;
	providerCustomerId: string | null;
}

interface CreditPackRefundCorrelationCandidate {
	provider: "paypal";
	providerPaymentId: string;
}

export async function lockCreditPackProviderPayment(
	input: { provider: string; providerPaymentId: string },
	client: Prisma.TransactionClient,
): Promise<void> {
	await client.$queryRaw<Array<{ locked: string }>>`
		SELECT pg_advisory_xact_lock(
			hashtextextended(
				${`credit-pack-payment:${input.provider}:${input.providerPaymentId}`},
				0
			)
		)::text AS "locked"`;
}

export async function requeuePaymentEventsMissingCheckoutCorrelation(
	input: { provider: string; providerSubscriptionId: string },
	client: Prisma.TransactionClient,
): Promise<{ requeued: number }> {
	const candidates = await client.$queryRaw<Array<{ id: string }>>`
		SELECT "id"
		FROM "payment_event"
		WHERE "provider" = ${input.provider}
		  AND "providerSubscriptionId" = ${input.providerSubscriptionId}
		  AND "status" IN ('FAILED', 'DEAD_LETTER')
		  AND "lastErrorClass" = 'TRANSIENT'
		  AND "failureReason" = ${PAYMENT_PROVIDER_CORRELATION_MISSING}
		ORDER BY "receivedAt", "id"
		FOR UPDATE SKIP LOCKED`;
	let requeued = 0;
	for (const candidate of candidates) {
		const changed = await client.paymentEvent.updateMany({
			where: {
				id: candidate.id,
				provider: input.provider,
				providerSubscriptionId: input.providerSubscriptionId,
				status: { in: ["FAILED", "DEAD_LETTER"] },
				lastErrorClass: "TRANSIENT",
				failureReason: PAYMENT_PROVIDER_CORRELATION_MISSING,
			},
			data: {
				status: "FAILED",
				attemptCount: 0,
				processedAt: null,
				processingToken: null,
				processingLeasedUntil: null,
			},
		});
		if (changed.count !== 1) continue;
		const dedupeKey = `payment-event-correlation-replay:${candidate.id}`;
		await client.outboxEvent.upsert({
			where: { dedupeKey },
			create: {
				eventType: "PAYMENT_EVENT_RECEIVED",
				aggregateType: "PAYMENT_EVENT",
				aggregateId: candidate.id,
				dedupeKey,
				payload: { paymentEventId: candidate.id },
			},
			update: {},
		});
		requeued += 1;
	}
	return { requeued };
}

export async function requeueCreditPackRefundEventsMissingCheckoutCorrelation(
	input: { provider: "paypal"; providerPaymentId: string },
	client: Prisma.TransactionClient,
): Promise<{ requeued: number }> {
	const candidates = await client.$queryRaw<Array<{ id: string }>>`
		SELECT event."id"
		FROM "payment_event" event
		WHERE event."provider" = ${input.provider}
		  AND event."status" IN ('FAILED', 'DEAD_LETTER')
		  AND event."lastErrorClass" = 'TRANSIENT'
		  AND event."failureReason" = ${PAYMENT_PROVIDER_CORRELATION_MISSING}
		  AND EXISTS (
			SELECT 1
			FROM "credit_pack_fulfillment" fulfillment
			WHERE fulfillment."provider" = ${input.provider}
			  AND fulfillment."providerPaymentId" = ${input.providerPaymentId}
		  )
		  AND event."envelope"->>'event_type' = 'PAYMENT.CAPTURE.REFUNDED'
		  AND EXISTS (
			SELECT 1
			FROM jsonb_array_elements(
				CASE
					WHEN jsonb_typeof(event."envelope" #> '{resource,links}') = 'array'
						THEN event."envelope" #> '{resource,links}'
					ELSE '[]'::jsonb
				END
			) refund_link
			WHERE refund_link->>'rel' = 'up'
			  AND substring(
				refund_link->>'href'
				FROM '^https://[^/]+/v2/payments/captures/([^/]+)$'
			  ) = ${input.providerPaymentId}
		  )
		ORDER BY event."receivedAt", event."id"
		FOR UPDATE OF event SKIP LOCKED`;
	let requeued = 0;
	for (const candidate of candidates) {
		const changed = await client.paymentEvent.updateMany({
			where: {
				id: candidate.id,
				provider: input.provider,
				status: { in: ["FAILED", "DEAD_LETTER"] },
				lastErrorClass: "TRANSIENT",
				failureReason: PAYMENT_PROVIDER_CORRELATION_MISSING,
			},
			data: {
				status: "FAILED",
				attemptCount: 0,
				processedAt: null,
				processingToken: null,
				processingLeasedUntil: null,
			},
		});
		if (changed.count !== 1) continue;
		const dedupeKey = `credit-pack-refund-correlation-replay:${candidate.id}`;
		await client.outboxEvent.upsert({
			where: { dedupeKey },
			create: {
				eventType: "PAYMENT_EVENT_RECEIVED",
				aggregateType: "PAYMENT_EVENT",
				aggregateId: candidate.id,
				dedupeKey,
				payload: { paymentEventId: candidate.id },
			},
			update: {},
		});
		requeued += 1;
	}
	return { requeued };
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
		creditPackReviewCandidate?: CreditPackReviewCandidate;
		creditPackRefundCorrelationCandidate?: CreditPackRefundCorrelationCandidate;
	},
	client: MediaTransactionClient,
) {
	return client.$transaction(async (tx) => {
		if (input.creditPackRefundCorrelationCandidate) {
			await lockCreditPackProviderPayment(input.creditPackRefundCorrelationCandidate, tx);
		}
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
		if (input.deadLetter && input.creditPackReviewCandidate) {
			await reviewReliablyCorrelatedCreditPackCheckout(input.creditPackReviewCandidate, tx);
		}
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
		if (input.creditPackRefundCorrelationCandidate) {
			await requeueCreditPackRefundEventsMissingCheckoutCorrelation(
				input.creditPackRefundCorrelationCandidate,
				tx,
			);
		}
		return true;
	});
}

async function reviewReliablyCorrelatedCreditPackCheckout(
	candidate: CreditPackReviewCandidate,
	client: Prisma.TransactionClient,
): Promise<void> {
	const checkoutIntent = await client.paymentCheckoutIntent.findUnique({
		where: { id: candidate.checkoutIntentId },
		select: {
			id: true,
			provider: true,
			ownerType: true,
			ownerId: true,
			productKind: true,
			status: true,
			providerSessionId: true,
			providerOrderId: true,
			billingPlan: { select: { productKind: true } },
		},
	});
	if (
		!checkoutIntent ||
		checkoutIntent.provider !== candidate.provider ||
		checkoutIntent.productKind !== "CREDIT_PACK" ||
		checkoutIntent.billingPlan.productKind !== "CREDIT_PACK" ||
		checkoutIntent.status !== "PROVIDER_PENDING" ||
		!checkoutIntent.providerSessionId
	) {
		return;
	}

	const orderBinding = await client.paymentCheckoutIntent.findUnique({
		where: {
			provider_providerOrderId: {
				provider: candidate.provider,
				providerOrderId: candidate.providerOrderId,
			},
		},
		select: { id: true },
	});
	if (orderBinding && orderBinding.id !== checkoutIntent.id) return;
	if (
		checkoutIntent.providerOrderId !== null &&
		checkoutIntent.providerOrderId !== candidate.providerOrderId
	) {
		return;
	}
	if (
		candidate.provider === "paypal" &&
		checkoutIntent.providerSessionId !== candidate.providerOrderId
	) {
		return;
	}
	if (
		candidate.provider === "waffo" &&
		candidate.providerCustomerId !== `${checkoutIntent.ownerType}:${checkoutIntent.ownerId}`
	) {
		return;
	}

	await transitionPaymentCheckoutIntentToReview(
		{
			intentId: checkoutIntent.id,
			provider: candidate.provider,
			ownerType: checkoutIntent.ownerType,
			ownerId: checkoutIntent.ownerId,
			expectedProductKind: "CREDIT_PACK",
			expectedStatus: "PROVIDER_PENDING",
			expectedProviderSessionId: checkoutIntent.providerSessionId,
			...(checkoutIntent.providerOrderId
				? { expectedProviderOrderId: checkoutIntent.providerOrderId }
				: {}),
		},
		client,
	);
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
		where: {
			provider_providerSubscriptionId: {
				provider: input.provider,
				providerSubscriptionId: input.providerSubscriptionId,
			},
		},
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
