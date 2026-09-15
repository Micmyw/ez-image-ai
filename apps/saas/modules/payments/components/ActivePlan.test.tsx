import messages from "@repo/i18n/translations/en/saas.json";
import shared from "@repo/i18n/translations/en/shared.json";
import { NextIntlClientProvider } from "next-intl";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	cancelAtPeriodEnd: false,
	multiple: false,
	refundTermination: null as "PENDING" | "RETRYING" | null,
}));
vi.mock("@payments/hooks/plan-data", () => ({
	usePlanData: () => ({
		planData: {
			ultimate: { title: "Ultimate", features: [] },
			studio: { title: "Max", features: [] },
		},
	}),
}));
vi.mock("@payments/hooks/purchases", () => ({
	usePurchases: () => {
		const activePlan = {
			id: "ultimate",
			status: "active",
			purchaseId: "purchase-1",
			provider: "waffo",
			price: { amount: 49, currency: "USD", interval: "month" },
			providerCapabilities: { portal: false, cancellation: true },
			subscription: {
				refundTermination: state.refundTermination,
				cancelAtPeriodEnd: state.cancelAtPeriodEnd,
				currentPeriodEnd: new Date("2026-10-12T00:00:00Z"),
			},
		};
		return {
			purchases: [],
			activePlan,
			activeSubscriptions: state.multiple
				? [
						activePlan,
						{
							...activePlan,
							id: "studio",
							provider: "paypal",
							purchaseId: "purchase-2",
							subscription: { ...activePlan.subscription, cancelAtPeriodEnd: false },
						},
					]
				: [activePlan],
		};
	},
}));
vi.mock("@shared/components/SettingsItem", () => ({
	SettingsItem: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));
vi.mock("../../settings/components/CancelSubscriptionButton", () => ({
	CancelSubscriptionButton: ({ purchaseId }: { purchaseId: string }) => (
		<button data-purchase-id={purchaseId}>Cancel subscription</button>
	),
}));
vi.mock("../../settings/components/CustomerPortalButton", () => ({
	CustomerPortalButton: () => <button>Manage subscription</button>,
}));

import { ActivePlan } from "./ActivePlan";

function renderPlan() {
	return renderToStaticMarkup(
		<NextIntlClientProvider locale="en" timeZone="UTC" messages={{ ...shared, ...messages }}>
			<ActivePlan />
		</NextIntlClientProvider>,
	);
}

describe("ActivePlan cancellation display", () => {
	beforeEach(() => {
		state.multiple = false;
		state.refundTermination = null;
	});
	it.each(["PENDING", "RETRYING"] as const)(
		"shows honest refunded benefits and renewal state for %s",
		(refundTermination) => {
			state.refundTermination = refundTermination;
			state.cancelAtPeriodEnd = true;
			const html = renderPlan();
			expect(html).toContain(
				refundTermination === "PENDING"
					? "confirming renewal cancellation"
					: "we will keep retrying",
			);
			expect(html).not.toContain("Renewal canceled");
			expect(html).not.toContain("Your plan remains available");
			expect(html).not.toContain("Cancel subscription");
		},
	);
	it("renders both providers with separate renewal state and the correct cancel target", () => {
		state.multiple = true;
		state.cancelAtPeriodEnd = true;
		const html = renderPlan();
		expect(html).toContain("Ultimate");
		expect(html).toContain("Max");
		expect(html).toContain("PayPal");
		expect(html).toContain("Waffo");
		expect(html).toContain('data-purchase-id="purchase-2"');
		expect(html).not.toContain('data-purchase-id="purchase-1"');
	});
	it("shows the end date and removes the cancel action after renewal cancellation", () => {
		state.cancelAtPeriodEnd = true;
		const html = renderPlan();
		expect(html).toContain("Renewal canceled");
		expect(html).toContain("Oct 12, 2026");
		expect(html).toContain("It will not renew.");
		expect(html).not.toContain("Cancel subscription");
	});

	it("keeps the cancel action for an active renewing subscription", () => {
		state.cancelAtPeriodEnd = false;
		const html = renderPlan();
		expect(html).toContain("Cancel subscription");
		expect(html).not.toContain("Renewal canceled");
	});
});
