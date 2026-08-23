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
}

export function addUtcBillingMonth(anchor: Date, monthOffset: number): Date {
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
	target.setUTCDate(Math.min(anchor.getUTCDate(), lastDay));
	return target;
}

export function createAnnualBillingPeriods(input: {
	startsAt: Date;
	creditsPerPeriod: bigint;
}): AnnualBillingPeriod[] {
	return Array.from({ length: 12 }, (_, index) => ({
		startsAt: addUtcBillingMonth(input.startsAt, index),
		endsAt: addUtcBillingMonth(input.startsAt, index + 1),
		creditAmount: input.creditsPerPeriod,
	}));
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

export function shouldApplySubscriptionEvent(input: SubscriptionOrderingInput): boolean {
	if (input.lastEventCreatedAt) {
		const incomingTime = input.incomingEventCreatedAt.getTime();
		const lastTime = input.lastEventCreatedAt.getTime();
		if (incomingTime < lastTime) return false;
		if (
			incomingTime === lastTime &&
			input.lastEventId &&
			input.incomingEventId <= input.lastEventId
		) {
			return false;
		}
	}
	if (
		(input.currentStatus === "CANCELED" || input.currentStatus === "EXPIRED") &&
		input.incomingStatus !== input.currentStatus
	) {
		return false;
	}
	return true;
}
