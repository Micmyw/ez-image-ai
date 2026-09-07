import { describe, expect, it } from "vitest";

import { calculateCreditPackRefundTargetCredits } from "./credit-pack-reducer";

describe("credit-pack refund projection", () => {
	it.each([
		{
			label: "the smallest successful partial refund",
			refundedAmountMicros: 1n,
			want: 1n,
		},
		{
			label: "an exact half refund",
			refundedAmountMicros: 29_500_000n,
			want: 900n,
		},
		{
			label: "a full refund",
			refundedAmountMicros: 59_000_000n,
			want: 1_800n,
		},
	] as const)(
		"rounds $label up without exceeding the original grant",
		({ refundedAmountMicros, want }) => {
			expect(
				calculateCreditPackRefundTargetCredits({
					grantedCredits: 1_800n,
					paidAmountMicros: 59_000_000n,
					refundedAmountMicros,
				}),
			).toBe(want);
		},
	);

	it.each([
		{ grantedCredits: 0n, paidAmountMicros: 59_000_000n, refundedAmountMicros: 1n },
		{ grantedCredits: 1_800n, paidAmountMicros: 0n, refundedAmountMicros: 1n },
		{ grantedCredits: 1_800n, paidAmountMicros: 59_000_000n, refundedAmountMicros: 0n },
		{
			grantedCredits: 1_800n,
			paidAmountMicros: 59_000_000n,
			refundedAmountMicros: 59_000_001n,
		},
	] as const)("rejects an impossible monetary or credit snapshot: %o", (input) => {
		expect(() => calculateCreditPackRefundTargetCredits(input)).toThrowError(
			"CREDIT_PACK_REFUND_AMOUNT_INVALID",
		);
	});
});
