import { describe, expect, it, vi } from "vitest";

import {
	ADMIN_ANALYTICS_SQL,
	readAdminAnalyticsFacts,
	type AdminAnalyticsQuery,
} from "./admin-analytics-reader";

const paidAt = new Date("2026-10-10T12:00:00Z");
function annualRoot() {
	return {
		subscriptionId: "sub",
		provider: "stripe",
		providerSubscriptionId: "sub-provider",
		ownerType: "USER",
		ownerId: "user-a",
		rootId: "period-1",
		firstPeriodStartsAt: paidAt,
		providerInvoicePaymentId: "payment-1",
		providerInvoiceId: "invoice-1",
		chargeIds: ["charge-1"],
		periods: Array.from({ length: 12 }, () => ({
			provider: "stripe",
			providerSubscriptionId: "sub-provider",
			providerInvoicePaymentId: "payment-1",
			providerInvoiceId: "invoice-1",
			paidAmount: "12000",
		})),
		events: [
			{
				provider: "stripe",
				providerEnvironment: "live",
				verifiedAt: paidAt,
				status: "PROCESSED",
				envelope: {
					type: "invoice.paid",
					livemode: true,
					data: {
						object: {
							id: "invoice-1",
							subscription: "sub-provider",
							amount_paid: 12000,
							currency: "USD",
							status_transitions: { paid_at: paidAt.getTime() / 1000 },
							billing_reason: "subscription_create",
						},
					},
				},
			},
		],
		checkoutIntentId: null,
		userId: "user-a",
	};
}
function reader(overrides: Partial<Record<keyof typeof ADMIN_ANALYTICS_SQL, unknown[]>> = {}) {
	return vi.fn(async (statement: string, _parameters: readonly unknown[]) => {
		const key = Object.entries(ADMIN_ANALYTICS_SQL).find(
			([, value]) => value === statement,
		)?.[0] as keyof typeof ADMIN_ANALYTICS_SQL;
		return overrides[key] ?? [];
	});
}

describe("administration payment fact reader", () => {
	it("counts twelve annual credit projections as one actual payment and maps its refund once", async () => {
		const query = reader({
			subscriptionPayments: [annualRoot()],
			refunds: [
				{
					id: "r",
					paymentId: null,
					ownerType: "USER",
					ownerId: "user-a",
					occurredAt: paidAt,
					amount: "100",
					currency: "USD",
					minorUnits: true,
					provider: "stripe",
					providerPaymentId: null,
					providerChargeId: "charge-1",
					subscriptionId: "sub",
				},
			],
		});
		const result = await readAdminAnalyticsFacts(query as AdminAnalyticsQuery, {
			kind: "user",
			userId: "user-a",
		});
		expect(result.payments).toHaveLength(1);
		expect(result.payments[0]).toMatchObject({
			id: "plan:period-1",
			amountMicros: 120_000_000n,
			paidAt,
			currency: "USD",
			renewal: false,
			evidence: "verified",
			environment: "production",
		});
		expect(result.refunds[0]).toMatchObject({
			paymentId: "plan:period-1",
			amountMicros: 1_000_000n,
			environment: "production",
		});
		expect(
			query.mock.calls.every(
				([, parameters]) => parameters[0] === "user" && parameters[1] === "user-a",
			),
		).toBe(true);
	});

	it("does not replace missing receipt time with a credit period's start or created time", async () => {
		const root = annualRoot();
		root.events = [];
		const result = await readAdminAnalyticsFacts(
			reader({ subscriptionPayments: [root] }) as AdminAnalyticsQuery,
			{ kind: "platform" },
		);
		expect(result.payments[0]).toMatchObject({
			evidence: "unknown",
			paidAt: null,
			amountMicros: null,
			currency: null,
			renewal: null,
			environment: "unknown",
		});
	});

	it("binds server scope values as parameters instead of interpolating tenant identifiers", async () => {
		const query = vi.fn(async (_statement: string, _parameters: readonly unknown[]) => []);
		const organizationId = "org'; SELECT secret FROM user; --";
		await readAdminAnalyticsFacts(query as AdminAnalyticsQuery, {
			kind: "organization",
			organizationId,
		});
		expect(query).toHaveBeenCalledTimes(7);
		for (const [statement, parameters] of query.mock.calls) {
			expect(statement).not.toContain(organizationId);
			expect(parameters).toEqual(["organization", organizationId]);
		}
	});

	it("refuses oversized data rather than reporting a silently truncated financial total", async () => {
		const query = reader({ users: Array.from({ length: 20_001 }, () => ({})) });
		await expect(
			readAdminAnalyticsFacts(query as AdminAnalyticsQuery, { kind: "platform" }),
		).rejects.toThrow("ADMIN_ANALYTICS_DATASET_LIMIT");
	});
});
