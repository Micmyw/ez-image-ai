import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";

import {
	assertCheckoutReturnOwnerScope,
	resolveCheckoutReturnState,
} from "./procedures/get-checkout-return-state";

describe("checkout return ownership", () => {
	it("rejects organization scope in the user-only first release", () => {
		expect(() => assertCheckoutReturnOwnerScope("org-other")).toThrowError(ORPCError);
	});

	it("accepts the authenticated user scope", () => {
		expect(() => assertCheckoutReturnOwnerScope(undefined)).not.toThrow();
	});
});

describe("checkout return webhook state", () => {
	const now = new Date("2026-08-25T06:00:00.000Z");

	it("waits when the latest active subscription is not the plan selected in checkout", () => {
		expect(
			resolveCheckoutReturnState(
				{
					status: "ACTIVE",
					graceEndsAt: null,
					plan: { metadata: { planId: "creator" }, name: "creator" },
					periods: [],
					currentPeriodEnd: null,
				},
				"studio",
			),
		).toEqual({ status: "PENDING", planId: null, paidThrough: null });
	});

	it.each([
		["ACTIVE", null],
		["PAST_DUE", new Date("2026-08-25T06:00:00.001Z")],
	] as const)(
		"accepts %s only while the selected plan remains effective",
		(status, graceEndsAt) => {
			const paidThrough = new Date("2026-09-25T00:00:00.000Z");
			expect(
				resolveCheckoutReturnState(
					{
						status,
						graceEndsAt,
						plan: { metadata: { planId: "creator" }, name: "creator" },
						periods: [{ endsAt: paidThrough }],
						currentPeriodEnd: null,
					},
					"creator",
					now,
				),
			).toEqual({ status, planId: "creator", paidThrough });
		},
	);

	it("uses the canonical legacy plan-name fallback for an effective subscription", () => {
		const paidThrough = new Date("2026-09-25T00:00:00.000Z");
		expect(
			resolveCheckoutReturnState(
				{
					status: "ACTIVE",
					graceEndsAt: null,
					plan: { metadata: {}, name: "creator" },
					periods: [{ endsAt: paidThrough }],
					currentPeriodEnd: null,
				},
				"creator",
				now,
			),
		).toEqual({ status: "ACTIVE", planId: "creator", paidThrough });
	});

	it.each([new Date("2026-08-25T06:00:00.000Z"), new Date("2026-08-25T05:59:59.999Z"), null])(
		"keeps waiting when a PAST_DUE grace is not effective: %s",
		(graceEndsAt) => {
			expect(
				resolveCheckoutReturnState(
					{
						status: "PAST_DUE",
						graceEndsAt,
						plan: { metadata: { planId: "creator" }, name: "creator" },
						periods: [],
						currentPeriodEnd: null,
					},
					"creator",
					now,
				),
			).toEqual({ status: "PENDING", planId: null, paidThrough: null });
		},
	);
});
