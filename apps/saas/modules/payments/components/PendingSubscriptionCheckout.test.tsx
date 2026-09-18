import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
	data: null as null | {
		id: string;
		provider: string;
		canResume: boolean;
		canChange: boolean;
		status: string;
	},
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		payments: {
			getPendingSubscriptionCheckout: { queryOptions: () => ({}) },
			refreshPendingSubscriptionCheckout: { mutationOptions: () => ({}) },
			cancelPendingSubscriptionCheckout: { mutationOptions: () => ({}) },
			resumePendingSubscriptionCheckout: { mutationOptions: () => ({}) },
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
	it("offers continuing the same checkout and changing plan", () => {
		state.data = {
			id: "intent",
			provider: "paypal",
			canResume: true,
			canChange: true,
			status: "PENDING",
		};
		const html = renderToStaticMarkup(<PendingSubscriptionCheckout />);
		expect(html).toContain("resume");
		expect(html).toContain("changePlan");
		expect(html).toContain("refresh");
	});
	it("does not render an expired checkout link", () => {
		state.data = {
			id: "intent",
			provider: "waffo",
			canResume: false,
			canChange: false,
			status: "WAITING",
		};
		const html = renderToStaticMarkup(<PendingSubscriptionCheckout />);
		expect(html).not.toContain(">resume<");
		expect(html).toContain(">support<");
		expect(html).toContain("pending-checkout-reference");
		expect(html).toContain("WAITING");
	});
});
