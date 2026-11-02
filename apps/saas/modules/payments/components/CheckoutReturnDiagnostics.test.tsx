import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => vi.fn());
vi.mock("@auth/lib/api", () => ({
	useSessionQuery: () => ({
		data: { user: { id: "owner", isAnonymous: false }, session: {} },
		isPending: false,
	}),
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		payments: {
			capturePayPalImagePassCheckout: { mutationOptions: () => ({}) },
			capturePayPalCreditPackCheckout: { mutationOptions: () => ({}) },
			getImagePassCheckoutState: { queryOptions: () => ({}) },
			getCreditPackCheckoutState: { queryOptions: () => ({}) },
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useMutation: () => ({ mutateAsync: capture }),
	useQuery: () => ({
		isSuccess: true,
		isPending: false,
		data: { status: "PENDING", provider: "paypal", amount: "1.00", currency: "USD" },
		refetch: vi.fn(),
	}),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@media/lib/image-pass-query", () => ({ imagePassBalanceQueryKey: () => ["balance"] }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

import { CreditPackCheckoutReturnContent } from "./CreditPackCheckoutReturnContent";
import { ImagePassCheckoutReturnContent } from "./ImagePassCheckoutReturnContent";

afterEach(() => vi.unstubAllGlobals());
describe("return-page server rendering is not customer return evidence", () => {
	it.each([ImagePassCheckoutReturnContent, CreditPackCheckoutReturnContent])(
		"emits no browser receipt or capture from SSR",
		(Component) => {
			const fetch = vi.fn();
			vi.stubGlobal("fetch", fetch);
			const html = renderToStaticMarkup(
				<Component intentId="intent" providerOrderId="order" approved />,
			);
			expect(html).toContain("PENDING");
			expect(fetch).not.toHaveBeenCalled();
			expect(capture).not.toHaveBeenCalled();
		},
	);
});
