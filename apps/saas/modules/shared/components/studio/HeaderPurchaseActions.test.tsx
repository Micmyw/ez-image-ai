import { renderToReadableStream } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	loaded: true,
	user: { id: "A" } as { id: string; isAnonymous?: boolean } | null,
	balance: "100" as string | undefined,
	query: vi.fn(),
}));
vi.mock("@auth/lib/api", () => ({
	useSessionQuery: () => ({
		isSuccess: state.loaded,
		data: state.user ? { user: state.user } : null,
	}),
}));
vi.mock("@payments/components/upgrade-context", () => ({ useUpgrade: () => vi.fn() }));
vi.mock("@payments/hooks/use-payment-action", () => ({
	usePaymentAction: () => ({ action: null }),
}));
vi.mock("@repo/config/client", () => ({ PLAN_ENTITLEMENTS: [] }));
vi.mock("@shared/components/LocaleSwitch", () => ({ LocaleSwitch: () => null }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { media: { getCreditAccount: vi.fn() } },
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-query")>()),
	useQuery: state.query,
}));
vi.mock("next-intl", () => ({
	useLocale: () => "en",
	useTranslations: () => (key: string, values?: { credits?: string }) =>
		values ? `${key}:${values.credits}` : key,
}));

import { HeaderPurchaseActions } from "./HeaderPurchaseActions";

async function renderHeader(props = { registered: true, showCredits: true }) {
	return new Response(await renderToReadableStream(<HeaderPurchaseActions {...props} />)).text();
}

describe("header credit balance identity", () => {
	beforeEach(() => {
		state.loaded = true;
		state.user = { id: "A" };
		state.balance = "100";
		state.query.mockReset().mockImplementation(() => ({
			data: state.balance === undefined ? undefined : { spendableCredits: state.balance },
			isPending: state.balance === undefined,
		}));
	});

	it("uses a prefetched registered session without a SessionProvider and switches the balance query key", async () => {
		expect(await renderHeader()).toContain('aria-label="creditsLabel:100"');
		expect(state.query).toHaveBeenLastCalledWith(
			expect.objectContaining({ queryKey: ["media-credit-account", "A"], enabled: true }),
		);
		state.user = { id: "B" };
		state.balance = "20";
		const markup = await renderHeader();
		expect(markup).toContain('aria-label="creditsLabel:20"');
		expect(markup).not.toContain("creditsLabel:100");
		expect(state.query).toHaveBeenLastCalledWith(
			expect.objectContaining({ queryKey: ["media-credit-account", "B"], enabled: true }),
		);
	});

	it.each([
		[false, { id: "A" }],
		[true, null],
		[true, { id: "guest", isAnonymous: true }],
	] as const)(
		"does not expose a cached balance when identity is unavailable (%j, %j)",
		async (loaded, user) => {
			state.loaded = loaded;
			state.user = user;
			const markup = await renderHeader();
			expect(state.query).toHaveBeenLastCalledWith(
				expect.objectContaining({ queryKey: ["media-credit-account", null], enabled: false }),
			);
			expect(markup).toContain('aria-label="creditsUnavailable"');
			expect(markup).not.toContain("creditsLabel:100");
		},
	);

	it.each([
		{ registered: false, showCredits: true },
		{ registered: true, showCredits: false },
	])("disables the query when header credits are hidden (%j)", async (props) => {
		expect(await renderHeader(props)).not.toContain('data-test="header-credits"');
		expect(state.query).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
	});

	it("keeps the owner's last balance visible during a failed background refresh", async () => {
		state.query.mockReturnValue({
			data: { spendableCredits: "100" },
			error: new Error("refresh failed"),
			isPending: false,
		});
		expect(await renderHeader()).toContain('aria-label="creditsLabel:100"');
	});
});
