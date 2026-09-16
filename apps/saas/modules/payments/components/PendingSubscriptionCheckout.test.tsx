import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
	data: null as null | { id: string; provider: string; checkoutLink: string | null },
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		payments: {
			getPendingSubscriptionCheckout: { queryOptions: () => ({}) },
			refreshPendingSubscriptionCheckout: { mutationOptions: () => ({}) },
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => state,
	useMutation: () => ({ isPending: false }),
	useQueryClient: () => ({}),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
import { PendingSubscriptionCheckout } from "./PendingSubscriptionCheckout";
describe("pending subscription checkout rendering", () => {
	it("renders no recovery UI when the account has no pending checkout", () => {
		state.data = null;
		expect(renderToStaticMarkup(<PendingSubscriptionCheckout />)).toBe("");
	});
	it("renders a usable anchor to the server-approved pending checkout", () => {
		state.data = {
			id: "intent",
			provider: "paypal",
			checkoutLink: "https://www.sandbox.paypal.com/approve?token=I-TEST",
		};
		const html = renderToStaticMarkup(<PendingSubscriptionCheckout />);
		expect(html).toContain('href="https://www.sandbox.paypal.com/approve?token=I-TEST"');
		expect(html).toContain("resume");
		expect(html).toContain("refresh");
	});
	it("does not render an expired checkout link", () => {
		state.data = { id: "intent", provider: "waffo", checkoutLink: null };
		const html = renderToStaticMarkup(<PendingSubscriptionCheckout />);
		expect(html).not.toContain(">resume<");
		expect(html).toContain(">support<");
		expect(html).toContain("pending-checkout-reference");
	});
});
