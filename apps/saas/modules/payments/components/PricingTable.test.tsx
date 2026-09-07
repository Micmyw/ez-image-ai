import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
	availabilityInputs: [] as Array<{ interval: "month" | "year"; planId: string }>,
}));

vi.mock("@payments/hooks/plan-data", () => ({
	usePlanData: () => ({
		planData: {
			creator: { title: "Pro", description: "Pro plan", features: [] },
			ultimate: { title: "Ultimate", description: "Ultimate plan", features: [] },
			studio: { title: "Max", description: "Max plan", features: [] },
		},
	}),
}));
vi.mock("@repo/payments/config", () => ({
	config: {
		plans: {
			creator: {
				prices: [
					{ type: "subscription", amount: 19, currency: "USD", interval: "month" },
					{ type: "subscription", amount: 190, currency: "USD", interval: "year" },
				],
			},
			ultimate: {
				recommended: true,
				prices: [
					{ type: "subscription", amount: 49, currency: "USD", interval: "month" },
					{ type: "subscription", amount: 490, currency: "USD", interval: "year" },
				],
			},
			studio: {
				prices: [
					{ type: "subscription", amount: 79, currency: "USD", interval: "month" },
					{ type: "subscription", amount: 790, currency: "USD", interval: "year" },
				],
			},
		},
	},
}));
vi.mock("@repo/ui", () => ({
	cn: (...values: unknown[]) => values.filter((value) => typeof value === "string").join(" "),
}));
vi.mock("@repo/ui/components/button", () => ({
	Button: ({
		children,
		loading: _loading,
		variant: _variant,
		...props
	}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
		loading?: boolean;
		variant?: string;
	}) => <button {...props}>{children}</button>,
}));
vi.mock("@repo/ui/components/tabs", () => ({
	Tabs: ({ children, value }: { children: React.ReactNode; value: string }) => (
		<div data-selected-interval={value}>{children}</div>
	),
	TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	TabsTrigger: ({ children, value }: { children: React.ReactNode; value: string }) => (
		<button data-interval={value}>{children}</button>
	),
}));
vi.mock("@shared/hooks/locale-currency", () => ({ useLocaleCurrency: () => "USD" }));
vi.mock("@shared/hooks/router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@shared/lib/growth-analytics", () => ({
	saasGrowthFunnel: { checkoutStarted: vi.fn() },
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		payments: {
			createCheckoutLink: { mutationOptions: () => ({}) },
			getProviderAvailability: {
				queryOptions: ({ input }: { input: { interval: "month" | "year"; planId: string } }) => ({
					input,
				}),
			},
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useMutation: () => ({ mutateAsync: vi.fn() }),
	useQuery: ({ input }: { input: { interval: "month" | "year"; planId: string } }) => {
		testState.availabilityInputs.push(input);
		return {
			data: {
				providers: [{ name: "paypal", capabilities: { checkout: true } }],
			},
			isError: false,
			isPending: false,
		};
	},
}));
vi.mock("next-intl", () => ({
	useFormatter: () => ({
		number: (value: number, { currency }: { currency: string }) => `${currency} ${value}`,
	}),
	useTranslations: () => (key: string) => key,
}));
vi.mock("./PaymentProviderSelector", () => ({
	PaymentProviderSelector: ({ name }: { name: string }) => <div data-provider-selector={name} />,
}));

import { PricingTable } from "./PricingTable";

describe("PricingTable", () => {
	beforeEach(() => {
		testState.availabilityInputs.length = 0;
	});

	it("defaults authenticated subscription selection to yearly billing", () => {
		const markup = renderToStaticMarkup(<PricingTable userId="user-1" />);

		expect(markup).toContain('data-selected-interval="year"');
		expect(markup).toContain("USD 190");
		expect(markup).toContain("USD 490");
		expect(markup).toContain("USD 790");
	});

	it("renders checkout controls and provider availability for Ultimate", () => {
		const markup = renderToStaticMarkup(<PricingTable userId="user-1" />);

		expect(markup).toContain('data-provider-selector="ultimate-year-provider"');
		expect(testState.availabilityInputs).toContainEqual({ planId: "ultimate", interval: "year" });
	});
});
