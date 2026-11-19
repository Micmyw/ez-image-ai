import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ prefetch: false }));
vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useState: () => [
		runtime.prefetch,
		(next: boolean) => {
			runtime.prefetch = next;
		},
	],
}));

import { IntentPrefetchLink } from "./IntentPrefetchLink";

describe("purchase navigation prefetch", () => {
	beforeEach(() => {
		runtime.prefetch = false;
	});

	const pricingLink = () => IntentPrefetchLink({ href: "/pricing", children: "Pricing" });

	it("keeps an ordinary navigation link with viewport prefetch disabled", () => {
		const link = pricingLink();
		expect(link.props.href).toBe("/pricing");
		expect(link.props.prefetch).toBe(false);
		expect(link.props.onClick).toBeUndefined();
	});

	it.each(["onMouseEnter", "onFocus", "onPointerDown"])("lets Next prefetch after %s", (event) => {
		pricingLink().props[event]();
		expect(pricingLink().props.prefetch).toBeNull();
	});
});
