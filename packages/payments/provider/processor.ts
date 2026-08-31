import { claimPaymentEvent, failPaymentEvent, runSerializable, type Prisma } from "@repo/database";
import { logger } from "@repo/logs";

import { normalizeProviderBillingEvent } from "./lifecycle-normalization";
import { applyProviderBillingFact } from "./lifecycle-reducer";
import type { PaymentEventAttempt } from "./stripe/processor";

interface ProcessResult {
	outcome: "PROCESSED" | "SKIPPED" | "DEAD_LETTER";
	grantsCreated: number;
}

type DatabaseClient = Parameters<typeof claimPaymentEvent>[1];
type NonStripeProvider = "paypal" | "waffo";

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
	try {
		const event = await client.paymentEvent.findUnique({
			where: { id: input.paymentEventId },
			select: {
				provider: true,
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
		const fact = normalizeProviderBillingEvent(provider, event.envelope);
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

			const result = await applyProviderBillingFact(fact, tx);
			await finishPaymentEvent(input, transactionFenceTime, tx);
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
	return /^(?:PAYMENT_PROVIDER|PAYPAL|WAFFO)_[A-Z0-9_]+$/.test(message) ? "TERMINAL" : "TRANSIENT";
}

function safeFailureReason(error: unknown, errorClass: "TERMINAL" | "TRANSIENT"): string {
	const message = error instanceof Error ? error.message : "";
	return errorClass === "TERMINAL" ? message : "PAYMENT_EVENT_RETRYABLE_FAILURE";
}
