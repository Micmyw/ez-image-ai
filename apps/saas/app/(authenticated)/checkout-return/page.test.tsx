import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ redirect: vi.fn(), session: { user: { id: "owner" } } }));
vi.mock("@auth/lib/server", () => ({ getSession: async () => state.session }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("next/navigation", () => ({
	redirect: (path: string) => {
		state.redirect(path);
		throw new Error(`redirect:${path}`);
	},
}));
vi.mock("@payments/components/CheckoutReturnContent", () => ({
	CheckoutReturnContent: () => null,
}));
vi.mock("@shared/components/AuthWrapper", () => ({
	AuthWrapper: ({ children }: { children: React.ReactNode }) => children,
}));
import { CheckoutReturnContent } from "@payments/components/CheckoutReturnContent";

import CheckoutReturnPage from "./page";

async function props(params: Record<string, string | string[]>) {
	const element = await CheckoutReturnPage({ searchParams: Promise.resolve(params) } as never);
	function find(root: React.ReactNode): Record<string, unknown> | undefined {
		if (!React.isValidElement(root)) return undefined;
		if (root.type === CheckoutReturnContent) return root.props as Record<string, unknown>;
		for (const child of React.Children.toArray(
			(root.props as { children?: React.ReactNode }).children,
		)) {
			const found = find(child);
			if (found) return found;
		}
	}
	return find(element)!;
}
beforeEach(() => vi.clearAllMocks());
describe("subscription checkout return query", () => {
	it("gives any cancellation parameter priority over approval", async () => {
		expect(
			await props({
				expectedPlanId: "creator",
				checkoutIntentId: "intent",
				approved: "1",
				canceled: "0",
			}),
		).toMatchObject({ checkoutIntentId: "intent", approved: false, canceled: true });
	});
	it("does not infer approval from a repeated or missing query", async () => {
		expect(
			await props({ expectedPlanId: "creator", checkoutIntentId: "intent", approved: ["1", "1"] }),
		).toMatchObject({ approved: false });
		expect(await props({ expectedPlanId: "creator", checkoutIntentId: "intent" })).toMatchObject({
			approved: false,
		});
	});
	it("handles repeated optional query values without crashing or cross-scope inputs", async () => {
		expect(
			await props({
				expectedPlanId: "creator",
				checkoutIntentId: ["intent", "other"],
				organizationId: ["org", "other"],
				returnTo: ["javascript:evil", "/history"],
			}),
		).toMatchObject({
			checkoutIntentId: undefined,
			organizationId: undefined,
			returnTo: "/create",
		});
	});
	it("trims and bounds a trusted lookup id and sanitizes the continuation", async () => {
		expect(
			await props({
				expectedPlanId: "creator",
				checkoutIntentId: " intent ",
				approved: "1",
				returnTo: "https://evil.invalid",
			}),
		).toMatchObject({ checkoutIntentId: "intent", approved: true, returnTo: "/create" });
		expect(
			await props({ expectedPlanId: "creator", checkoutIntentId: "x".repeat(129) }),
		).toMatchObject({ checkoutIntentId: undefined });
	});
});
