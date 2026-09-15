import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";

import {
	assertCheckoutReturnOwnerScope,
	resolveCheckoutReturnState,
} from "./procedures/get-checkout-return-state";

const now = new Date("2026-08-25T06:00:00Z");
const start = new Date("2026-08-25T00:00:00Z");
const end = new Date("2026-09-25T00:00:00Z");
const pending = { status: "PENDING", planId: null, paidThrough: null };
function paidSubscription() {
	return {
		status: "ACTIVE",
		graceEndsAt: null as Date | null,
		plan: { metadata: { planId: "creator" }, name: "creator" },
		currentPeriodStart: start,
		currentPeriodEnd: end,
		periods: [
			{ startsAt: start, endsAt: end, paidAmount: 19000000n, refundedAmount: 0n, status: "ACTIVE" },
		],
	};
}

describe("checkout return ownership and paid confirmation", () => {
	it("rejects organization scope in the user-only first release", () => {
		expect(() => assertCheckoutReturnOwnerScope("org-other")).toThrow(ORPCError);
	});
	it("accepts the authenticated user scope", () => {
		expect(() => assertCheckoutReturnOwnerScope(undefined)).not.toThrow();
	});
	it("waits for actual payment even after provider activation", () => {
		expect(
			resolveCheckoutReturnState({ ...paidSubscription(), periods: [] }, "creator", now),
		).toEqual(pending);
	});
	it("waits for the plan selected by the customer", () => {
		expect(resolveCheckoutReturnState(paidSubscription(), "studio", now)).toEqual(pending);
	});
	it.each(["ACTIVE", "CANCELED"])("confirms %s only during the paid period", (status) => {
		const subscription = { ...paidSubscription(), status };
		expect(resolveCheckoutReturnState(subscription, "creator", now)).toEqual({
			status: "ACTIVE",
			planId: "creator",
			paidThrough: end,
		});
		expect(resolveCheckoutReturnState(subscription, "creator", end)).toEqual(pending);
	});
	it("does not confirm a fully refunded payment", () => {
		const subscription = paidSubscription();
		subscription.periods[0]!.refundedAmount = 19000000n;
		expect(resolveCheckoutReturnState(subscription, "creator", now)).toEqual(pending);
	});
	it("keeps partial-refund feature access even if this month's credits were clawed back first", () => {
		const subscription = paidSubscription();
		subscription.periods[0]!.refundedAmount = 9500000n;
		subscription.periods[0]!.status = "REFUNDED";
		expect(resolveCheckoutReturnState(subscription, "creator", now).status).toBe("ACTIVE");
	});
	it("honors the exact grace boundary with prior payment evidence", () => {
		const subscription = {
			...paidSubscription(),
			status: "PAST_DUE",
			graceEndsAt: new Date(now.getTime() + 1),
		};
		expect(resolveCheckoutReturnState(subscription, "creator", now).status).toBe("PAST_DUE");
		expect(resolveCheckoutReturnState(subscription, "creator", subscription.graceEndsAt)).toEqual(
			pending,
		);
		expect(resolveCheckoutReturnState({ ...subscription, periods: [] }, "creator", now)).toEqual(
			pending,
		);
	});
	it("does not confirm grace using an older payment after the latest paid period was refunded", () => {
		const subscription = { ...paidSubscription(), status: "PAST_DUE", graceEndsAt: end };
		subscription.periods[0]!.refundedAmount = 19000000n;
		subscription.periods[0]!.status = "REFUNDED";
		subscription.periods.unshift({
			startsAt: new Date("2026-07-25T00:00:00Z"),
			endsAt: start,
			paidAmount: 19000000n,
			refundedAmount: 0n,
			status: "CLOSED",
		});
		expect(resolveCheckoutReturnState(subscription, "creator", now)).toEqual(pending);
	});
	it("does not use a future paid period to confirm grace early", () => {
		const subscription = { ...paidSubscription(), status: "PAST_DUE", graceEndsAt: end };
		subscription.periods[0]!.startsAt = new Date(now.getTime() + 1);
		expect(resolveCheckoutReturnState(subscription, "creator", now)).toEqual(pending);
	});
	it("preserves grace after an unpaid renewal when the last actual payment was not fully refunded", () => {
		const subscription = { ...paidSubscription(), status: "PAST_DUE", graceEndsAt: end };
		subscription.periods[0]!.paidAmount = 0n;
		subscription.periods[0]!.status = "PENDING";
		subscription.periods.push({
			startsAt: new Date("2026-07-25T00:00:00Z"),
			endsAt: start,
			paidAmount: 19000000n,
			refundedAmount: 0n,
			status: "CLOSED",
		});
		expect(resolveCheckoutReturnState(subscription, "creator", now).status).toBe("PAST_DUE");
	});
	it("uses the canonical legacy plan name and supports Ultimate", () => {
		expect(
			resolveCheckoutReturnState(
				{ ...paidSubscription(), plan: { metadata: {} as { planId: string }, name: "ultimate" } },
				"ultimate",
				now,
			).planId,
		).toBe("ultimate");
	});
});
