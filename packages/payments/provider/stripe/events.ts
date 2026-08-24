export interface AnnualBillingPeriod {
	startsAt: Date;
	endsAt: Date;
	creditAmount: bigint;
}

interface SubscriptionOrderingInput {
	currentStatus: "PENDING" | "ACTIVE" | "PAST_DUE" | "CANCELED" | "EXPIRED";
	lastEventCreatedAt: Date | null;
	lastEventId: string | null;
	incomingStatus: "PENDING" | "ACTIVE" | "PAST_DUE" | "CANCELED" | "EXPIRED";
	incomingEventCreatedAt: Date;
	incomingEventId: string;
	allowExpiredRecovery?: boolean;
}

export function addUtcBillingMonth(anchor: Date, monthOffset: number): Date {
	return utcDateAtAnchorDay(anchor, monthOffset, anchor.getUTCDate());
}

function utcDateAtAnchorDay(anchor: Date, monthOffset: number, anchorDay: number): Date {
	const target = new Date(
		Date.UTC(
			anchor.getUTCFullYear(),
			anchor.getUTCMonth() + monthOffset,
			1,
			anchor.getUTCHours(),
			anchor.getUTCMinutes(),
			anchor.getUTCSeconds(),
			anchor.getUTCMilliseconds(),
		),
	);
	const lastDay = new Date(
		Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
	).getUTCDate();
	target.setUTCDate(Math.min(anchorDay, lastDay));
	return target;
}

export function createAnnualBillingPeriods(input: {
	startsAt: Date;
	endsAt?: Date;
	creditsPerPeriod: bigint;
}): AnnualBillingPeriod[] {
	const periods = Array.from({ length: 12 }, (_, index) => ({
		startsAt: addUtcBillingMonth(input.startsAt, index),
		endsAt: addUtcBillingMonth(input.startsAt, index + 1),
		creditAmount: input.creditsPerPeriod,
	}));
	if (input.endsAt) {
		const last = periods[periods.length - 1]!;
		if (input.endsAt.getTime() <= last.startsAt.getTime()) {
			throw new Error("STRIPE_ANNUAL_INVOICE_PERIOD_INVALID");
		}
		last.endsAt = input.endsAt;
	}
	return periods;
}

export function isExactBillingInterval(input: {
	interval: "month" | "year";
	startsAt: Date;
	endsAt: Date;
}): boolean {
	const monthOffset = input.interval === "year" ? 12 : 1;
	if (
		Number.isNaN(input.startsAt.getTime()) ||
		Number.isNaN(input.endsAt.getTime()) ||
		input.endsAt.getTime() <= input.startsAt.getTime()
	) {
		return false;
	}
	return Array.from({ length: 31 }, (_, index) => index + 1).some(
		(anchorDay) =>
			utcDateAtAnchorDay(input.startsAt, 0, anchorDay).getTime() === input.startsAt.getTime() &&
			utcDateAtAnchorDay(input.startsAt, monthOffset, anchorDay).getTime() ===
				input.endsAt.getTime(),
	);
}

export function calculateProportionalCreditRefund(input: {
	invoicePaidAmount: bigint;
	invoiceCredits: bigint;
	refundAmount: bigint;
	creditsAlreadyRefunded: bigint;
}): bigint {
	if (input.invoicePaidAmount <= 0n || input.refundAmount <= 0n) return 0n;
	const proportional =
		(input.invoiceCredits * input.refundAmount + input.invoicePaidAmount - 1n) /
		input.invoicePaidAmount;
	const remaining = input.invoiceCredits - input.creditsAlreadyRefunded;
	if (remaining <= 0n) return 0n;
	return proportional < remaining ? proportional : remaining;
}

type RefundLifecycleStatus = "PENDING" | "REQUIRES_ACTION" | "SUCCEEDED" | "FAILED" | "CANCELED";

interface RefundOrderingInput {
	currentStatus: RefundLifecycleStatus;
	lastEventCreatedAt: Date;
	lastEventId: string;
	incomingStatus: RefundLifecycleStatus;
	incomingEventCreatedAt: Date;
	incomingEventId: string;
}

export function calculateCumulativeCreditRefund(input: {
	invoicePaidAmount: bigint;
	invoiceCredits: bigint;
	cumulativeSucceededRefundAmount: bigint;
}): bigint {
	if (
		input.invoicePaidAmount <= 0n ||
		input.invoiceCredits <= 0n ||
		input.cumulativeSucceededRefundAmount <= 0n
	) {
		return 0n;
	}
	const refundableAmount =
		input.cumulativeSucceededRefundAmount < input.invoicePaidAmount
			? input.cumulativeSucceededRefundAmount
			: input.invoicePaidAmount;
	const cumulative =
		(input.invoiceCredits * refundableAmount + input.invoicePaidAmount - 1n) /
		input.invoicePaidAmount;
	return cumulative < input.invoiceCredits ? cumulative : input.invoiceCredits;
}

export function shouldApplySubscriptionEvent(input: SubscriptionOrderingInput): boolean {
	if (input.lastEventCreatedAt) {
		const incomingTime = input.incomingEventCreatedAt.getTime();
		const lastTime = input.lastEventCreatedAt.getTime();
		if (incomingTime < lastTime) return false;
		if (incomingTime === lastTime && input.lastEventId) {
			if (input.incomingEventId === input.lastEventId) return false;
			throw new Error("STRIPE_SUBSCRIPTION_EVENT_ORDER_AMBIGUOUS");
		}
	}
	if (input.currentStatus === "CANCELED" && input.incomingStatus !== "CANCELED") {
		return false;
	}
	if (
		input.currentStatus === "EXPIRED" &&
		input.incomingStatus !== "EXPIRED" &&
		!input.allowExpiredRecovery
	) {
		return false;
	}
	return true;
}

export function shouldApplyRefundEvent(input: RefundOrderingInput): boolean {
	if (input.incomingEventId === input.lastEventId) return false;
	const incomingTime = input.incomingEventCreatedAt.getTime();
	const lastTime = input.lastEventCreatedAt.getTime();
	if (incomingTime < lastTime) return false;
	if (["SUCCEEDED", "FAILED", "CANCELED"].includes(input.currentStatus)) return false;
	if (input.incomingStatus === input.currentStatus) return incomingTime > lastTime;
	if (["SUCCEEDED", "FAILED", "CANCELED"].includes(input.incomingStatus)) return true;
	return input.currentStatus === "PENDING" && input.incomingStatus === "REQUIRES_ACTION";
}
