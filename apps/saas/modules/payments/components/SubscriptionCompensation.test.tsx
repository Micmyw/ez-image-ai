import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../../packages/i18n/translations/en/saas.json";

const state = vi.hoisted(() => ({
	data: null as unknown,
	query: vi.fn(),
	dismiss: vi.fn(),
	onOpenChange: (_open: boolean) => {},
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: (options: unknown) => {
		state.query(options);
		return { data: state.data };
	},
	useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueriesData: vi.fn() }),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { payments: { dismissSubscriptionCompensation: state.dismiss } },
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: { payments: { getSubscriptionCompensation: { queryOptions: () => ({}) } } },
}));
vi.mock("next-intl", () => ({
	useTranslations:
		() => (key: keyof typeof messages.payments.technicalCompensation, values?: { date: string }) =>
			messages.payments.technicalCompensation[key].replace("{date}", values?.date ?? ""),
	useLocale: () => "en",
	useFormatter: () => ({ dateTime: () => "Nov 20, 2026" }),
}));
vi.mock("@repo/ui/components/dialog", () => ({
	Dialog: ({
		open,
		onOpenChange,
		children,
	}: {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		children: React.ReactNode;
	}) => {
		state.onOpenChange = onOpenChange;
		return open ? <div>{children}</div> : null;
	},
	DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
	DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
	DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
	DialogFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
}));
vi.mock("@repo/ui/components/button", () => ({
	Button: ({
		children,
		render,
	}: {
		children: React.ReactNode;
		render?: (props: { children: React.ReactNode }) => React.ReactNode;
	}) => (render ? render({ children }) : <button>{children}</button>),
}));

import {
	SubscriptionCompensationBanner,
	SubscriptionCompensationDialog,
} from "./SubscriptionCompensation";

const offer = {
	id: "offer-1",
	bonusPercent: 10,
	dismissed: false,
	expiresAt: "2099-11-20T00:00:00.000Z",
};
beforeEach(() => {
	vi.clearAllMocks();
	state.data = { offer };
	state.dismiss.mockResolvedValue({ dismissed: true });
});
describe("technical compensation feedback", () => {
	it("shows the one-time first-month terms, normal prices and automatic application", () => {
		const html = renderToStaticMarkup(
			<SubscriptionCompensationDialog ownerId="owner-a" assetId="asset-a" enabled />,
		);
		expect(html).toContain("10% extra credits");
		expect(html).toContain("Annual plans receive the bonus in month one only");
		expect(html).toContain("Regular prices apply");
		expect(html).toContain("Applied automatically after confirmed payment");
		expect(html).toContain("/pricing?plan=creator&amp;interval=month");
		expect(state.query).toHaveBeenCalledWith(
			expect.objectContaining({
				queryKey: ["subscription-compensation-claim", "owner-a", "asset-a"],
				enabled: true,
			}),
		);
	});
	it.each([null, { ...offer, dismissed: true }, { ...offer, expiresAt: "2000-01-01T00:00:00Z" }])(
		"does not pop up without a current undismissed offer",
		(value) => {
			state.data = { offer: value };
			expect(
				renderToStaticMarkup(
					<SubscriptionCompensationDialog ownerId="owner-a" assetId="asset-a" enabled />,
				),
			).toBe("");
		},
	);
	it("does not claim for an inactive source or anonymous context", () => {
		for (const props of [
			{ ownerId: null, enabled: true },
			{ ownerId: "owner-a", enabled: false },
		]) {
			expect(
				renderToStaticMarkup(<SubscriptionCompensationDialog {...props} assetId="asset-a" />),
			).toBe("");
			expect(state.query).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
		}
	});
	it("dismissal only acknowledges the offer; it does not submit or cancel a generation", () => {
		renderToStaticMarkup(
			<SubscriptionCompensationDialog ownerId="owner-a" assetId="asset-a" enabled />,
		);
		state.onOpenChange(false);
		expect(state.dismiss).toHaveBeenCalledExactlyOnceWith({});
	});
	it("keeps a dismissed offer visible on the pricing page until expiry", () => {
		state.data = { offer: { ...offer, dismissed: true } };
		expect(renderToStaticMarkup(<SubscriptionCompensationBanner ownerId="owner-a" />)).toContain(
			"Your first subscription includes 10% extra credits for month one",
		);
	});
});
