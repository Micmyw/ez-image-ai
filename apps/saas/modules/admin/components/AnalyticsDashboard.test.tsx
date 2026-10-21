import type { AdminAnalyticsFunnel } from "@repo/api/modules/admin-analytics/types";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import de from "../../../../../packages/i18n/translations/de/saas.json";
import en from "../../../../../packages/i18n/translations/en/saas.json";
import { ADMIN_DISPLAY_LOCALE, getAdminDisplayMessages } from "../lib/messages";

const state = vi.hoisted(() => ({
	funnel: undefined as AdminAnalyticsFunnel | undefined,
	queries: [] as Array<{ operation: string; input: unknown }>,
	selections: [] as Array<{
		label: string;
		value: string;
		options: Array<{ value: string; label: string }>;
	}>,
}));
vi.mock("../lib/capabilities-client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/capabilities-client")>()),
	useAdminOperation: (operation: string, input: unknown) => {
		state.queries.push({ operation, input });
		return {
			data: operation === "analytics_funnel" ? state.funnel : undefined,
			isPending: false,
			refetch: vi.fn(),
		};
	},
}));
vi.mock("./ConversionFunnelPanel", () => ({ ConversionFunnelPanel: () => null }));
vi.mock("./CapabilityUi", () => ({
	CapabilitySection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
	CapabilityError: () => null,
	CapabilityLoading: () => null,
	CapabilitySelect: (props: (typeof state.selections)[number]) => {
		state.selections.push(props);
		return (
			<select aria-label={props.label} value={props.value} onChange={() => undefined}>
				{props.options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		);
	},
}));

import { AnalyticsDashboard } from "./AnalyticsDashboard";

function funnel(): AdminAnalyticsFunnel {
	return {
		range: "7d",
		environment: "production",
		since: "2026-10-14T12:00:00Z",
		asOf: "2026-10-21T12:00:00Z",
		groupBy: "source",
		totals: { signups: 3, checkouts: 1, paid: 0 },
		rows: [
			{ value: "chatgpt.com", signups: 2, checkouts: 1, paid: 0 },
			{ value: null, signups: 1, checkouts: 0, paid: 0 },
		],
		rowsTruncated: false,
		options: {
			source: ["chatgpt.com", "google", "all", "", null],
			utm_source: ["chatgpt.com", "", null],
			utm_medium: ["", null],
			utm_campaign: ["", null],
			utm_term: ["", null],
			utm_content: ["", null],
			referrer: ["https://chatgpt.com", "", null],
			country: ["US", null],
		},
		basis: "registration_cohort_lifetime_nonrenewal_payments",
		countryBasis: "consented_registration_proxy",
		coverage: {
			unknownPaymentFacts: 0,
			unknownPaymentDates: 0,
			unknownPaymentUsers: 0,
			unknownRenewalKinds: 0,
			unknownAttributionUsers: 1,
			trialingAvailable: false,
			excludedTestPayments: 0,
			unclassifiedPayments: 0,
			unclassifiedRefunds: 0,
			unlinkedCheckoutPayments: 0,
			unclassifiedSubscriptions: 0,
		},
	};
}

describe("registration acquisition-source selection", () => {
	beforeEach(() => {
		state.funnel = undefined;
		state.queries = [];
		state.selections = [];
	});

	it.each([
		["en", en],
		["de", de],
		[ADMIN_DISPLAY_LOCALE, { ...en, admin: getAdminDisplayMessages(en.admin) }],
	] as const)("shows ChatGPT and recorded sources directly in %s", (locale, messages) => {
		state.funnel = funnel();
		const errors: unknown[] = [];
		const markup = renderToStaticMarkup(
			<NextIntlClientProvider
				locale={locale}
				messages={messages}
				timeZone="UTC"
				onError={(error) => errors.push(error)}
			>
				<AnalyticsDashboard />
			</NextIntlClientProvider>,
		);
		const labels = messages.admin.capabilities.analytics;
		expect(errors).toEqual([]);
		expect(state.queries).toContainEqual({
			operation: "analytics_funnel",
			input: { range: "7d", groupBy: "source", filters: {}, environment: "production" },
		});
		expect(markup).toContain(labels.dimensions.source);
		expect(markup).toContain(labels.filters.unknown);
		const options = state.selections.find((s) => s.label === labels.filter)!.options;
		expect(options.filter((o) => o.label === "chatgpt.com")).toEqual([
			{ label: "chatgpt.com", value: "source:chatgpt.com" },
		]);
		expect(options).toContainEqual({ label: "google", value: "source:google" });
		expect(options).toContainEqual({ label: "all", value: "source:all" });
		for (const value of ["all", "empty", "unknown", "value"] as const)
			expect(options).toContainEqual({ value, label: labels.filters[value] });
	});

	it("offers the ChatGPT shortcut even before any registrations are observed", () => {
		renderToStaticMarkup(
			<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
				<AnalyticsDashboard />
			</NextIntlClientProvider>,
		);
		expect(
			state.selections.find((s) => s.label === en.admin.capabilities.analytics.filter)!.options,
		).toContainEqual({ value: "source:chatgpt.com", label: "chatgpt.com" });
	});
});
