import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import en from "../../../../../packages/i18n/translations/en/saas.json";
import { getAdminDisplayMessages } from "../lib/messages";

const fixture = vi.hoisted(() => ({
	truncated: false,
	rows: [
		{
			id: "historical-checkout",
			ownerId: "owner",
			ownerType: "USER",
			provider: "paypal",
			productKind: "IMAGE_PASS",
			planKey: "image-pass-3",
			status: "PROVIDER_PENDING",
			createdAt: "2026-10-29T09:22:52Z",
			expired: true,
			outcome: "UNCONFIRMED",
			events: [],
			eventsTruncated: false,
			unreadableEvents: 0,
		},
		{
			id: "capture-checkout",
			ownerId: "owner",
			ownerType: "USER",
			provider: "paypal",
			productKind: "CREDIT_PACK",
			planKey: "credits-1500",
			status: "PROVIDER_PENDING",
			createdAt: "2026-11-02T00:00:00Z",
			expired: false,
			outcome: "UNCONFIRMED",
			eventsTruncated: true,
			unreadableEvents: 1,
			events: [
				{
					id: "browser-1",
					receivedAt: "2026-11-02T00:01:00Z",
					diagnostic: { source: "browser", event: "return_canceled" },
				},
				{
					id: "server-1",
					receivedAt: "2026-11-02T00:02:00Z",
					diagnostic: {
						source: "server",
						operation: "capture",
						phase: "failed",
						attemptId: "attempt-1",
						durationMs: 100,
						error: {
							kind: "provider_response",
							httpStatus: 422,
							providerIssue: "INSTRUMENT_DECLINED",
							debugId: "debug123",
						},
					},
				},
			],
		},
	],
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: { payments: { getAdminCheckoutDiagnostics: { queryOptions: () => ({}) } } },
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
		data: fixture,
		isPending: false,
		isFetching: false,
		error: null,
		refetch: vi.fn(),
	}),
}));
vi.mock("./CapabilityUi", () => ({ CapabilityError: () => null, CapabilityLoading: () => null }));

import { CheckoutDiagnosticsPanel } from "./CheckoutDiagnosticsPanel";

describe("checkout diagnostic evidence presentation", () => {
	it.each([
		["en", en],
		["zh-CN", { ...en, admin: getAdminDisplayMessages(en.admin) }],
	] as const)(
		"shows unknown history, client provenance and concrete error evidence in %s",
		(locale, messages) => {
			const errors: unknown[] = [];
			const html = renderToStaticMarkup(
				<NextIntlClientProvider
					locale={locale}
					messages={messages}
					timeZone="UTC"
					onError={(error) => errors.push(error)}
				>
					<CheckoutDiagnosticsPanel range="30d" />
				</NextIntlClientProvider>,
			);
			const labels = messages.admin.conversion.checkoutDiagnostics;
			expect(errors).toEqual([]);
			for (const text of [
				labels.outcomes.UNCONFIRMED,
				labels.noBrowser,
				labels.noEvents,
				labels.expired,
				labels.sources.browser,
				labels.sources.server,
				labels.browser.return_canceled,
				labels.timelineTruncated,
				"INSTRUMENT_DECLINED",
				"debug123",
				"HTTP 422",
			])
				expect(html).toContain(text);
			expect(html).not.toContain(labels.outcomes.COMPLETED);
		},
	);
});
