import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ planId: "free", blocked: false }));
vi.mock("@payments/hooks/purchases", () => ({
	usePurchases: () => ({
		activePlan: { id: state.planId },
		hasBlockingSubscription: state.blocked,
	}),
}));
vi.mock("@payments/components/PricingTable", () => ({
	PricingTable: ({
		activePlanId,
		subscriptionBlocked,
	}: {
		activePlanId: string;
		subscriptionBlocked: boolean;
	}) => <div data-plan={activePlanId} data-blocked={subscriptionBlocked} />,
}));
vi.mock("@shared/components/SettingsItem", () => ({
	SettingsItem: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

import { ChangePlan } from "./ChangePlan";

describe("ChangePlan after asynchronous refund termination", () => {
	it("uses the refreshed Free plan after termination even when the server page initially had Creator", () => {
		state.planId = "free";
		state.blocked = false;
		const html = renderToStaticMarkup(<ChangePlan userId="user-1" activePlanId="creator" />);
		expect(html).toContain('data-plan="free"');
		expect(html).toContain('data-blocked="false"');
	});
	it("keeps new checkout blocked while refunded benefits have ended but cancellation is pending", () => {
		state.planId = "free";
		state.blocked = true;
		const html = renderToStaticMarkup(<ChangePlan userId="user-1" activePlanId="creator" />);
		expect(html).toContain('data-blocked="true"');
	});
});
