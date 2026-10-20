import {
	claimPaymentEvent,
	failPaymentEvent,
	PAYMENT_PROVIDER_CORRELATION_MISSING,
	runSerializable,
	type Prisma,
} from "@repo/database";
import { getImagePassPurchaseByProviderPayment } from "@repo/database";
import { logger } from "@repo/logs";
import { notifyAdminPaymentSuccess } from "@repo/notifications/admin-bots";

import { applyCreditPackPaymentFact, applyCreditPackRefundFact } from "./credit-pack-reducer";
import {
	applyImagePassPaymentFact,
	tryApplyImagePassAdjustment,
	lockImagePassPayment,
} from "./image-pass-reducer";
import { requeueImagePassAdjustments } from "./image-pass-reducer";
import {
	normalizeProviderPaymentEvent,
	type NormalizedProviderPaymentEvent,
} from "./lifecycle-normalization";
import { applyProviderBillingFact } from "./lifecycle-reducer";
import { applyProviderRefundFact } from "./refund-reducer";
import type { PaymentEventAttempt } from "./stripe/processor";

interface ProcessResult {
	outcome: "PROCESSED" | "SKIPPED" | "DEAD_LETTER";
	grantsCreated: number;
}

type DatabaseClient = Parameters<typeof claimPaymentEvent>[1];
type NonStripeProvider = "paypal" | "waffo";

class PaymentEventFenceError extends Error {}

/** Product routing happens inside the same verified-event transaction. */
export async function applyVerifiedProviderFact(
	normalized: NormalizedProviderPaymentEvent,
	tx: Prisma.TransactionClient,
	options: { paymentEventId: string; providerEnvironment?: string | null; now: Date },
): Promise<{ grantsCreated: number }> {
	if (normalized.kind === "NOOP") return { grantsCreated: 0 };
	if (normalized.kind === "SUBSCRIPTION") return applyProviderBillingFact(normalized.fact, tx);
	if (normalized.kind === "CREDIT_PACK_PAID") {
		if (normalized.fact.provider === "paypal") {
			await lockImagePassPayment(normalized.fact.providerPaymentId, tx);
			const intent = normalized.fact.checkoutIntentId
				? await tx.paymentCheckoutIntent.findUnique({
						where: { id: normalized.fact.checkoutIntentId },
						select: { productKind: true },
					})
				: null;
			if (intent?.productKind === "IMAGE_PASS")
				return applyImagePassPaymentFact(normalized.fact, tx, options);
		}
		return applyCreditPackPaymentFact(normalized.fact, tx, options);
	}
	const imagePass = await tryApplyImagePassAdjustment(
		normalized.fact,
		tx,
		normalized.kind === "PAYMENT_DISPUTED" ? "DISPUTE" : undefined,
	);
	if (imagePass) return imagePass;
	if (normalized.kind === "PAYMENT_DISPUTED") throw new Error(PAYMENT_PROVIDER_CORRELATION_MISSING);
	return normalized.kind === "PAYMENT_REFUNDED"
		? applyProviderRefundFact(normalized.fact, tx, options)
		: applyCreditPackRefundFact(normalized.fact, tx, options);
}

class PaymentEventLeaseExpiredError extends Error {
	constructor() {
		super("PAYMENT_EVENT_LEASE_EXPIRED");
	}
}

class PaymentEventLeaseActiveError extends Error {
	constructor() {
		super("PAYMENT_EVENT_LEASE_ACTIVE");
	}
}

export async function processProviderPaymentEvent(
	input: { paymentEventId: string; now?: Date },
	client: DatabaseClient,
	attempt: PaymentEventAttempt = { attempt: 1, maxAttempts: 1 },
): Promise<ProcessResult> {
	const claimTime = input.now ?? new Date();
	const claim = await claimPaymentEvent(input.paymentEventId, client, { now: claimTime });
	if (!claim) {
		const event = await client.paymentEvent.findUnique({
			where: { id: input.paymentEventId },
			select: { status: true, processingLeasedUntil: true },
		});
		if (
			attempt.attempt > 1 &&
			event?.status === "PROCESSING" &&
			event.processingLeasedUntil &&
			event.processingLeasedUntil > claimTime
		) {
			throw new PaymentEventLeaseActiveError();
		}
		return { outcome: "SKIPPED", grantsCreated: 0 };
	}
	return processClaimedProviderPaymentEvent(
		{ paymentEventId: claim.event.id, processingToken: claim.token, now: input.now },
		client,
		attempt,
	);
}

export async function processClaimedProviderPaymentEvent(
	input: { paymentEventId: string; processingToken: string; now?: Date },
	client: DatabaseClient,
	attempt: PaymentEventAttempt = { attempt: 1, maxAttempts: 1 },
): Promise<ProcessResult> {
	const initialFenceTime = input.now ?? new Date();
	let durableAttemptCount = 0;
	let creditPackReviewCandidate:
		| {
				provider: NonStripeProvider;
				checkoutIntentId: string;
				providerOrderId: string;
				providerCustomerId: string | null;
		  }
		| undefined;
	let creditPackRefundCorrelationCandidate:
		| { provider: NonStripeProvider; providerPaymentId: string }
		| undefined;
	try {
		const event = await client.paymentEvent.findUnique({
			where: { id: input.paymentEventId },
			select: {
				provider: true,
				providerEnvironment: true,
				status: true,
				processingToken: true,
				processingLeasedUntil: true,
				attemptCount: true,
				envelope: true,
			},
		});
		if (
			!event ||
			event.status !== "PROCESSING" ||
			event.processingToken !== input.processingToken ||
			!event.processingLeasedUntil ||
			event.processingLeasedUntil <= initialFenceTime
		) {
			throw new PaymentEventFenceError();
		}
		durableAttemptCount = event.attemptCount;
		const provider = nonStripeProvider(event.provider);
		const configuredEnvironment =
			process.env[provider === "paypal" ? "PAYPAL_ENVIRONMENT" : "WAFFO_ENVIRONMENT"];
		if (
			(configuredEnvironment === "live" || configuredEnvironment === "prod") &&
			event.providerEnvironment !== configuredEnvironment
		)
			throw new Error("PAYMENT_PROVIDER_ENVIRONMENT_MISMATCH");
		const normalized = normalizeProviderPaymentEvent(provider, event.envelope);
		if (normalized.kind === "CREDIT_PACK_PAID" && normalized.fact.checkoutIntentId) {
			creditPackReviewCandidate = {
				provider: normalized.fact.provider,
				checkoutIntentId: normalized.fact.checkoutIntentId,
				providerOrderId: normalized.fact.providerOrderId,
				providerCustomerId: normalized.fact.providerCustomerId,
			};
		}
		if (
			normalized.kind === "CREDIT_PACK_REFUNDED" ||
			normalized.kind === "PAYMENT_REFUNDED" ||
			normalized.kind === "PAYMENT_DISPUTED"
		) {
			creditPackRefundCorrelationCandidate = {
				provider: normalized.fact.provider,
				providerPaymentId: normalized.fact.providerPaymentId,
			};
		}
		const transactionFenceTime = input.now ?? new Date();
		const subscriptionPaymentWhere =
			normalized.kind === "SUBSCRIPTION" && normalized.fact.payment
				? {
						providerInvoicePaymentId: `${provider}:${normalized.fact.payment.providerPaymentId}`,
						subscription: {
							provider,
							providerSubscriptionId: normalized.fact.providerSubscriptionId,
						},
					}
				: null;

		const committed = await runSerializable(client, async (tx) => {
			const rows = await tx.$queryRaw<
				Array<{
					id: string;
					status: string;
					processingToken: string | null;
					processingLeasedUntil: Date | null;
				}>
			>`SELECT "id", "status", "processingToken", "processingLeasedUntil"
			  FROM "payment_event" WHERE "id" = ${input.paymentEventId} FOR UPDATE`;
			const lockedEvent = rows[0];
			if (
				!lockedEvent ||
				lockedEvent.status !== "PROCESSING" ||
				lockedEvent.processingToken !== input.processingToken ||
				!lockedEvent.processingLeasedUntil ||
				lockedEvent.processingLeasedUntil <= transactionFenceTime
			) {
				throw new PaymentEventFenceError();
			}

			const existingPayment = subscriptionPaymentWhere
				? await tx.billingPeriod.findFirst({
						where: subscriptionPaymentWhere,
						select: { id: true },
					})
				: null;
			const result = await applyVerifiedProviderFact(normalized, tx, {
				paymentEventId: input.paymentEventId,
				providerEnvironment: event.providerEnvironment,
				now: transactionFenceTime,
			});
			await finishPaymentEvent(input, transactionFenceTime, tx);
			const paymentNewlyRecorded = subscriptionPaymentWhere
				? !existingPayment &&
					!!(await tx.billingPeriod.findFirst({
						where: subscriptionPaymentWhere,
						select: { id: true },
					}))
				: result.grantsCreated > 0;
			return {
				outcome: "PROCESSED" as const,
				grantsCreated: result.grantsCreated,
				paymentNewlyRecorded,
			};
		});
		// The newly committed payment binding is the settlement winner. A prepaid
		// future period can be paid before its credit grant becomes active.
		// External bot work is strictly after commit and never enters payment retry.
		if (committed.paymentNewlyRecorded) {
			const payment =
				normalized.kind === "CREDIT_PACK_PAID"
					? { kind: "one-time" as const, providerPaymentId: normalized.fact.providerPaymentId }
					: normalized.kind === "SUBSCRIPTION" && normalized.fact.payment
						? {
								kind: "subscription" as const,
								providerPaymentId: normalized.fact.payment.providerPaymentId,
								providerSubscriptionId: normalized.fact.providerSubscriptionId,
							}
						: null;
			if (payment)
				await notifyAdminPaymentSuccess({
					paymentEventId: input.paymentEventId,
					provider,
					...payment,
				}).catch(() =>
					logger.warn(
						{ paymentEventId: input.paymentEventId },
						"Admin payment notification failed",
					),
				);
		}
		return { outcome: committed.outcome, grantsCreated: committed.grantsCreated };
	} catch (error) {
		if (error instanceof PaymentEventFenceError) {
			const event = await client.paymentEvent.findUnique({
				where: { id: input.paymentEventId },
				select: { status: true, processingToken: true, processingLeasedUntil: true },
			});
			const leaseCheckTime = new Date(Math.max(initialFenceTime.getTime(), Date.now()));
			if (
				event?.status === "PROCESSING" &&
				event.processingToken === input.processingToken &&
				event.processingLeasedUntil &&
				event.processingLeasedUntil <= leaseCheckTime
			) {
				throw new PaymentEventLeaseExpiredError();
			}
			return { outcome: "SKIPPED", grantsCreated: 0 };
		}

		const errorClass = classifyPaymentEventError(error);
		const deadLetter =
			errorClass === "TERMINAL" ||
			attempt.attempt >= attempt.maxAttempts ||
			durableAttemptCount + 1 >= attempt.maxAttempts;
		const reason = safeFailureReason(error, errorClass);
		const persisted = await failPaymentEvent(
			input.paymentEventId,
			input.processingToken,
			{
				reason,
				errorClass,
				triggerAttempt: attempt.attempt,
				triggerRunId: attempt.triggerRunId,
				deadLetter,
				...(deadLetter && creditPackReviewCandidate ? { creditPackReviewCandidate } : {}),
				...(reason === PAYMENT_PROVIDER_CORRELATION_MISSING && creditPackRefundCorrelationCandidate
					? { creditPackRefundCorrelationCandidate }
					: {}),
			},
			client,
		);
		if (!persisted) return { outcome: "SKIPPED", grantsCreated: 0 };
		if (
			reason === PAYMENT_PROVIDER_CORRELATION_MISSING &&
			creditPackRefundCorrelationCandidate?.provider === "paypal"
		) {
			// Close the failure-persist race: fulfillment may commit after the first
			// lookup but before this event is marked FAILED. Both sides use the same
			// payment lock and requeue after their own durable state is visible.
			const providerPaymentId = creditPackRefundCorrelationCandidate.providerPaymentId;
			await runSerializable(client, async (tx) => {
				await lockImagePassPayment(providerPaymentId, tx);
				if (
					await getImagePassPurchaseByProviderPayment({ provider: "paypal", providerPaymentId }, tx)
				)
					await requeueImagePassAdjustments(providerPaymentId, tx);
			});
		}
		logger.error(
			{ paymentEventId: input.paymentEventId, errorClass, reason },
			"Payment provider event failed",
		);
		if (errorClass === "TERMINAL") return { outcome: "DEAD_LETTER", grantsCreated: 0 };
		throw error;
	}
}

async function finishPaymentEvent(
	input: { paymentEventId: string; processingToken: string },
	now: Date,
	client: Prisma.TransactionClient,
) {
	const completed = await client.paymentEvent.updateMany({
		where: {
			id: input.paymentEventId,
			status: "PROCESSING",
			processingToken: input.processingToken,
			processingLeasedUntil: { gt: now },
		},
		data: {
			status: "PROCESSED",
			processedAt: now,
			processingToken: null,
			processingLeasedUntil: null,
		},
	});
	if (completed.count !== 1) throw new PaymentEventFenceError();
}

function nonStripeProvider(provider: string): NonStripeProvider {
	if (provider === "paypal" || provider === "waffo") return provider;
	throw new Error("PAYMENT_PROVIDER_EVENT_UNSUPPORTED");
}

function classifyPaymentEventError(error: unknown): "TERMINAL" | "TRANSIENT" {
	const message = error instanceof Error ? error.message : "";
	if (message === PAYMENT_PROVIDER_CORRELATION_MISSING) return "TRANSIENT";
	return /^(?:PAYMENT_PROVIDER|PAYPAL|WAFFO|CREDIT_PACK|IMAGE_PASS)_[A-Z0-9_]+$/.test(message)
		? "TERMINAL"
		: "TRANSIENT";
}

function safeFailureReason(error: unknown, errorClass: "TERMINAL" | "TRANSIENT"): string {
	const message = error instanceof Error ? error.message : "";
	if (message === PAYMENT_PROVIDER_CORRELATION_MISSING) return message;
	return errorClass === "TERMINAL" ? message : "PAYMENT_EVENT_RETRYABLE_FAILURE";
}
