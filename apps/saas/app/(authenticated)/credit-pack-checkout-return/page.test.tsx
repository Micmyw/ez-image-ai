import React from "react";
import { describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
const redirect = vi.fn((path: string): never => {
	throw new Error(`REDIRECT:${path}`);
});

vi.mock("@auth/lib/server", () => ({ getSession }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next-intl/server", () => ({
	getTranslations: () =>
		Promise.resolve(
			(key: string) =>
				({
					description: "Your credit balance will update after payment confirmation.",
					title: "Adding your credits",
				})[key] ?? key,
		),
}));
vi.mock("@shared/components/AuthWrapper", () => ({
	AuthWrapper: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock("@payments/components/CreditPackCheckoutReturnContent", () => ({
	CreditPackCheckoutReturnContent: (props: { intentId: string; providerOrderId?: string }) => (
		<div data-intent-id={props.intentId} data-provider-order-id={props.providerOrderId} />
	),
}));

describe("credit pack checkout return page", () => {
	it("keeps the return route authenticated", async () => {
		getSession.mockResolvedValue(null);
		const module = await import("./page");

		await expect(
			module.default({ searchParams: Promise.resolve({ intentId: "intent-1" }) }),
		).rejects.toThrow("REDIRECT:/login");
	});

	it("rejects a return without the checkout intent", async () => {
		getSession.mockResolvedValue({ user: { id: "user-1" } });
		const module = await import("./page");

		await expect(module.default({ searchParams: Promise.resolve({}) })).rejects.toThrow(
			"REDIRECT:/pricing",
		);
	});

	it("passes only the intent and optional PayPal order token into the client flow", async () => {
		getSession.mockResolvedValue({ user: { id: "user-1" } });
		const module = await import("./page");
		const result = await module.default({
			searchParams: Promise.resolve({ intentId: "intent-1", token: "order-1" }),
		});
		const content = (result.props.children as React.ReactElement[])[1];

		expect(content.props).toEqual({ intentId: "intent-1", providerOrderId: "order-1" });
	});
});
