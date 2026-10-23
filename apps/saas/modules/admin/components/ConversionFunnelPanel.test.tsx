import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import en from "../../../../../packages/i18n/translations/en/saas.json";
import { ADMIN_DISPLAY_LOCALE, getAdminDisplayMessages } from "../lib/messages";

const state = vi.hoisted(() => ({
	data: undefined as unknown,
	selections: [] as Array<{ value: string; options: Array<{ value: string }> }>,
}));
vi.mock("../lib/capabilities-client", () => ({
	useAdminOperation: () => ({ data: state.data, isPending: false, refetch: vi.fn() }),
}));
vi.mock("./CapabilityUi", () => ({
	CapabilitySection: ({ children, description }: { children: ReactNode; description: string }) => (
		<section>
			{description}
			{children}
		</section>
	),
	CapabilityError: () => null,
	CapabilityLoading: () => null,
	CapabilitySelect: (props: {
		value: string;
		options: Array<{ value: string; label: string }>;
	}) => {
		state.selections.push(props);
		return (
			<select value={props.value} onChange={() => undefined}>
				{props.options.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
		);
	},
}));
import { ConversionFunnelPanel } from "./ConversionFunnelPanel";

describe("conversion panel evidence labels", () => {
	it.each([
		["en", en],
		[ADMIN_DISPLAY_LOCALE, { ...en, admin: getAdminDisplayMessages(en.admin) }],
	] as const)(
		"separates missing observations from authoritative zero payments in %s",
		(locale, messages) => {
			state.data = {
				experiments: [],
				activity: [],
				totals: {
					signups: 2,
					generated: 1,
					succeeded: 1,
					purchaseClicked: 0,
					checkouts: 0,
					paid: 0,
				},
				traffic: { browsers: 0, pageViews: 0 },
				aggregateTraffic: {
					since: "2026-10-21T00:00:00Z",
					views: 12,
					sources: [{ source: "chatgpt.com", views: 12 }],
				},
				generationObservations: [
					{
						mediaKind: "video",
						phase: "blocked",
						publicModel: null,
						textLength: "1-50",
						inputCount: 0,
						reason: "insufficient_credits",
						observations: 2,
					},
				],
				visitorCohort: {
					registeredBrowsers: 0,
					successfulBrowsers: 0,
					paidBrowsers: 0,
					registrationRate: null,
				},
				coverage: {
					usersWithBrowserEvents: 0,
					unknownSourceUsers: 2,
					internalBrowsersExcluded: 1,
					firstObservedAt: null,
				},
				firstAttempt: { attempted: 1, succeeded: 1, failed: 0 },
				sources: ["unknown"],
				rows: [
					{
						source: "unknown",
						browsers: 0,
						signups: 2,
						generated: 1,
						succeeded: 1,
						purchaseClicked: 0,
						checkouts: 0,
						paid: 0,
					},
				],
				checkoutProducts: [
					{ productKind: "IMAGE_PASS", clicked: 0, requested: 0, redirected: 0, failed: 0 },
				],
				checkoutFailures: [{ category: "network", events: 1 }],
				failures: [{ reason: "INPUT_CONTENT_REJECTED", jobs: 1 }],
			};
			state.selections = [];
			const errors: unknown[] = [];
			const markup = renderToStaticMarkup(
				<NextIntlClientProvider
					locale={locale}
					messages={messages}
					timeZone="UTC"
					onError={(error) => errors.push(error)}
				>
					<ConversionFunnelPanel />
				</NextIntlClientProvider>,
			);
			const labels = messages.admin.conversion;
			expect(errors).toEqual([]);
			expect(markup).toContain(labels.noObservations);
			expect(markup).toContain("50.0%");
			expect(markup).toContain(labels.sourceBasis);
			expect(markup).toContain(labels.INPUT_CONTENT_REJECTED);
			expect(markup).toContain(labels.checkoutErrors.network);
			expect(markup).toContain(labels.IMAGE_PASS);
			expect(markup).toContain(messages.admin.capabilities.analytics.ranges["30d"]);
			expect(markup).toContain(`aria-label="${labels.paid}" min="0" max="2" value="0"`);
			expect(state.selections.slice(1).every((s) => s.options[0]?.value === "__all__")).toBe(true);
		},
	);
});
