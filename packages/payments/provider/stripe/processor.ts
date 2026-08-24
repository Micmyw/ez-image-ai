import { claimPaymentEvent, failPaymentEvent, runSerializable, type Prisma } from "@repo/database";
import { logger } from "@repo/logs";

import type { StripeBillingSource } from "./billing-source";
import { normalizeStripePaymentEvent } from "./event-normalizer";
import { applyStripeBillingFact } from "./reducer";

interface ProcessResult {
	outcome: "PROCESSED" | "SKIPPED" | "IGNORED" | "DEAD_LETTER";
	grantsCreated: number;
}

export interface PaymentEventAttempt {
	attempt: number;
	maxAttempts: number;
	triggerRunId?: string;
}

export interface StripePaymentEventDependencies {
	billingSource?: Pick<StripeBillingSource, "listInvoicePayments">;
}

type DatabaseClient = Parameters<typeof claimPaymentEvent>[1];

class PaymentEventFenceError extends Error {}

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

export async function processStripePaymentEvent(
	input: { paymentEventId: string; now?: Date },
	client: DatabaseClient,
	attempt: PaymentEventAttempt = { attempt: 1, maxAttempts: 1 },
	dependencies: StripePaymentEventDependencies = {},
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
	return processClaimedStripePaymentEvent(
		{ paymentEventId: claim.event.id, processingToken: claim.token, now: input.now },
		client,
		attempt,
		dependencies,
	);
}

export async function processClaimedStripePaymentEvent(
	input: { paymentEventId: string; processingToken: string; now?: Date },
	client: DatabaseClient,
	attempt: PaymentEventAttempt = { attempt: 1, maxAttempts: 1 },
	dependencies: StripePaymentEventDependencies = {},
): Promise<ProcessResult> {
	const initialFenceTime = input.now ?? new Date();
	let durableAttemptCount = 0;
	try {
		const event = await client.paymentEvent.findUnique({
			where: { id: input.paymentEventId },
			select: {
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

		// Reduce the verified raw envelope to an explicit allowlist before any business
		// transaction. A current Stripe invoice may require a short external lookup; the
		// transaction below fences that result against the still-current processing lease.
		const normalized = await normalizeStripePaymentEvent(event.envelope, {
			billingSource: dependencies.billingSource,
		});
		const transactionFenceTime = input.now ?? new Date();

		return await runSerializable(client, async (tx) => {
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

			if (!normalized.fact) {
				await finishPaymentEvent(input, transactionFenceTime, "IGNORED", tx);
				return { outcome: "IGNORED" as const, grantsCreated: 0 };
			}

			const result = await applyStripeBillingFact(normalized.fact, tx, {
				paymentEventId: input.paymentEventId,
				now: transactionFenceTime,
			});
			await finishPaymentEvent(input, transactionFenceTime, "PROCESSED", tx);
			return { outcome: "PROCESSED" as const, grantsCreated: result.grantsCreated };
		});
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
			},
			client,
		);
		if (!persisted) return { outcome: "SKIPPED", grantsCreated: 0 };
		logger.error(
			{ paymentEventId: input.paymentEventId, errorClass, reason },
			"Stripe payment event failed",
		);
		if (errorClass === "TERMINAL") return { outcome: "DEAD_LETTER", grantsCreated: 0 };
		throw error;
	}
}

async function finishPaymentEvent(
	input: { paymentEventId: string; processingToken: string },
	now: Date,
	status: "PROCESSED" | "IGNORED",
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
			status,
			processedAt: now,
			processingToken: null,
			processingLeasedUntil: null,
		},
	});
	if (completed.count !== 1) throw new PaymentEventFenceError();
}

function classifyPaymentEventError(error: unknown): "TERMINAL" | "TRANSIENT" {
	const message = error instanceof Error ? error.message : "";
	if (
		/^STRIPE_EVENT_(INVALID|MISSING)(?:_|$)/.test(message) ||
		/^STRIPE_.+_(AMBIGUOUS|CONFLICT|INVALID|MISMATCH|UNMAPPED|UNSUPPORTED)$/.test(message) ||
		[
			"STRIPE_SUBSCRIPTION_ID_MISSING",
			"STRIPE_OWNER_TYPE_INVALID",
			"STRIPE_REFUND_CHARGE_MISSING",
			"STRIPE_INVOICE_PAYMENT_NOT_PAID",
			"STRIPE_INVOICE_PAYMENT_CHARGE_MISSING",
			"STRIPE_INVOICE_PAYMENT_PAGE_OVERFLOW",
			"STRIPE_INVOICE_CUSTOMER_MISSING",
			"STRIPE_INVOICE_LINES_INCOMPLETE",
			"STRIPE_REFUND_AMOUNT_EXCEEDS_INVOICE",
			"STRIPE_LEGACY_REFUND_REPAIR_REQUIRED",
		].includes(message)
	) {
		return "TERMINAL";
	}
	return "TRANSIENT";
}

function safeFailureReason(error: unknown, errorClass: "TERMINAL" | "TRANSIENT"): string {
	const message = error instanceof Error ? error.message : "";
	return errorClass === "TERMINAL" && message.startsWith("STRIPE_")
		? message
		: "PAYMENT_EVENT_RETRYABLE_FAILURE";
}
