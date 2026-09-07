import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) =>
		({
			loading: "Confirming your credit purchase…",
			completed: "Credits added. Opening the editor…",
			review: "This payment needs review before credits can be added.",
			notCompleted: "This checkout was not completed.",
			tryAgain: "View credit packs",
			returnToEditor: "Return to editor",
		})[key] ?? key,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		payments: {
			capturePayPalCreditPackCheckout: { mutationOptions: () => ({}) },
			getCreditPackCheckoutState: { queryOptions: () => ({}) },
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
	useQuery: () => ({ data: { status: "PENDING" }, isError: false, refetch: vi.fn() }),
}));

describe("CreditPackCheckoutReturnContent", () => {
	it("renders a provider-neutral confirmation state while fulfillment is pending", async () => {
		const module = await import("./CreditPackCheckoutReturnContent");
		const markup = renderToStaticMarkup(
			<module.CreditPackCheckoutReturnContent
				intentId="intent-public-safe"
				providerOrderId="paypal-order-public-safe"
			/>,
		);
		const visibleText = markup.replaceAll(/<[^>]+>/g, " ");

		expect(visibleText).toContain("Confirming your credit purchase");
		expect(markup).not.toContain("intent-public-safe");
		expect(markup).not.toContain("paypal-order-public-safe");
		expect(visibleText).not.toMatch(/product.?id|provider.?id/i);
	});
});
