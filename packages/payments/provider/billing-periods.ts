import { isExactBillingInterval } from "./stripe/events";

export function isProviderBillingInterval(
	provider: "paypal" | "waffo",
	input: Parameters<typeof isExactBillingInterval>[0],
): boolean {
	if (provider !== "paypal") return isExactBillingInterval(input);

	// PayPal schedules the next billing time independently of the first payment's
	// time of day. Validate its calendar interval while keeping the original
	// timestamps for entitlement boundaries, renewal anchors and payment replay.
	const startsAt = new Date(input.startsAt);
	const endsAt = new Date(input.endsAt);
	startsAt.setUTCHours(0, 0, 0, 0);
	endsAt.setUTCHours(0, 0, 0, 0);
	return isExactBillingInterval({ ...input, startsAt, endsAt });
}
