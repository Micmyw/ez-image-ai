import React, { type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	cursor: 0,
	slots: [] as unknown[],
	boundaries: [] as ReactElement["type"][],
	fallbacks: [] as Array<() => ReactNode>,
	moduleLoaded: vi.fn(),
}));

vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useState: (initial: unknown) => {
		const index = state.cursor++;
		if (!(index in state.slots)) state.slots[index] = initial;
		return [
			state.slots[index],
			(value: unknown) => {
				state.slots[index] = value;
			},
		];
	},
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) =>
		key === "pricing.paymentOptionsLoading" ? "Checking payment options…" : key,
}));
vi.mock("next/dynamic", () => ({
	default: (_loader: unknown, options?: { loading?: () => ReactNode }) => {
		const Boundary = () => null;
		state.boundaries.push(Boundary);
		if (options?.loading) state.fallbacks.push(options.loading);
		return Boundary;
	},
}));
vi.mock("./CreditPackCheckoutActions", () => {
	state.moduleLoaded();
	return { CreditPackPaymentOptions: () => null, CreditPackCheckoutActions: () => null };
});
vi.mock("../hooks/use-payment-action", () => ({
	usePaymentAction: () => ({ action: null }),
}));
vi.mock("./upgrade-context", () => ({ useUpgrade: () => null }));

import { PublicPricingPlans } from "./PublicPricingPlans";

function render(initialView: "month" | "year" | "credit-packs" = "year") {
	state.cursor = 0;
	return PublicPricingPlans({ locale: "en-US", initialView });
}

function elements(root: ReactNode): ReactElement<Record<string, unknown>>[] {
	if (!React.isValidElement<Record<string, unknown>>(root)) return [];
	return [root, ...React.Children.toArray(root.props.children as ReactNode).flatMap(elements)];
}

function select(root: ReactNode, dataTest: string) {
	const button = elements(root).find((element) => element.props.dataTest === dataTest);
	expect(button).toBeDefined();
	(button!.props.onClick as () => void)();
}

beforeEach(() => {
	state.cursor = 0;
	state.slots = [];
});

describe("public credit-pack checkout mounting", () => {
	it("shows localized placeholders while chunks load and keeps pricing tabs available", () => {
		expect(state.fallbacks).toHaveLength(2);
		const panel = renderToStaticMarkup(state.fallbacks[0]!());
		const action = renderToStaticMarkup(state.fallbacks[1]!());
		for (const markup of [panel, action]) {
			expect(markup).toContain("Checking payment options…");
			expect(markup).toContain('aria-live="polite"');
		}
		expect(panel).toContain("min-h-[30rem]");
		expect(action).toContain("min-h-11");

		let tree = render("credit-packs");
		expect(elements(tree).find((element) => element.type === "fieldset")!.props.disabled).toBe(
			false,
		);
		select(tree, "public-pricing-interval-month");
		tree = render();
		expect(
			elements(tree).find(
				(element) => element.props["data-test"] === "public-pricing-credit-packs",
			)!.props.hidden,
		).toBe(true);
	});

	it("defers checkout until selection and retains the same checkout boundaries when hidden", () => {
		let tree = render();
		expect(
			elements(tree).filter((element) => element.props["data-test"] === "public-credit-pack"),
		).toHaveLength(4);
		expect(
			elements(tree).filter((element) => state.boundaries.includes(element.type)),
		).toHaveLength(0);

		select(tree, "public-pricing-credit-packs-tab");
		tree = render();
		const mounted = elements(tree).filter((element) => state.boundaries.includes(element.type));
		expect(mounted).toHaveLength(5);
		expect(mounted[0]!.props.active).toBe(true);
		const packKeys = mounted.slice(1).map((element) => element.props.packKey);
		expect(new Set(packKeys).size).toBe(4);

		select(tree, "public-pricing-interval-month");
		tree = render();
		const hidden = elements(tree).filter((element) => state.boundaries.includes(element.type));
		expect(hidden.map((element) => element.type)).toEqual(mounted.map((element) => element.type));
		expect(hidden[0]!.props.active).toBe(false);
		expect(hidden.slice(1).map((element) => element.props.packKey)).toEqual(packKeys);
		expect(
			elements(tree).find(
				(element) => element.props["data-test"] === "public-pricing-credit-packs",
			)!.props.hidden,
		).toBe(true);

		select(tree, "public-pricing-credit-packs-tab");
		tree = render();
		expect(elements(tree).find((element) => element.type === mounted[0]!.type)!.props.active).toBe(
			true,
		);
	});

	it("mounts checkout immediately when opened directly in the credit-packs view", () => {
		const tree = render("credit-packs");
		expect(
			elements(tree).filter((element) => state.boundaries.includes(element.type)),
		).toHaveLength(5);
	});

	it("warms only the static module on hover and focus without mounting checkout", async () => {
		const tree = render();
		const tab = elements(tree).find(
			(element) => element.props.dataTest === "public-pricing-credit-packs-tab",
		)!;
		expect(state.moduleLoaded).not.toHaveBeenCalled();
		await (tab.props.onMouseEnter as () => Promise<void>)();
		await (tab.props.onFocus as () => Promise<void>)();
		expect(state.moduleLoaded).toHaveBeenCalledOnce();
		expect(
			elements(render()).filter((element) => state.boundaries.includes(element.type)),
		).toHaveLength(0);
		select(tree, "public-pricing-credit-packs-tab");
		expect(
			elements(render()).filter((element) => state.boundaries.includes(element.type)),
		).toHaveLength(5);
	});
});
