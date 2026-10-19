import React, { type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	ownerId: "owner-a",
	cursor: 0,
	slots: [] as { current?: unknown; value?: unknown }[],
	checkout: vi.fn(),
	assign: vi.fn(),
	acquire: vi.fn(() => true),
	release: vi.fn(),
	redirecting: vi.fn(),
}));
vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useRef: (value: unknown) => (state.slots[state.cursor++] ??= { current: value }),
	useState: (value: unknown) => {
		const slot = (state.slots[state.cursor++] ??= { value });
		return [
			slot.value,
			(next: unknown) => {
				slot.value = next;
			},
		];
	},
	useEffect: () => {},
}));
vi.mock("@auth/lib/api", () => ({
	useSessionQuery: () => ({ data: { user: { id: state.ownerId, isAnonymous: false } } }),
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: { payments: { createImagePassCheckout: { mutationOptions: () => ({}) } } },
}));
vi.mock("@shared/lib/purchase-attribution", () => ({
	captureCheckoutTrigger: vi.fn(),
	clearCheckoutTrigger: vi.fn(),
	getCurrentCheckoutAttribution: vi.fn(async () => ({})),
}));
vi.mock("@tanstack/react-query", async (original) => ({
	...(await original<typeof import("@tanstack/react-query")>()),
	useMutation: () => ({ mutateAsync: state.checkout }),
	useQuery: () => ({ data: { available: 3 } }),
}));
vi.mock("../hooks/use-payment-action", () => ({
	usePaymentAction: () => ({
		action: null,
		acquire: state.acquire,
		release: state.release,
		redirecting: state.redirecting,
	}),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
import { ImagePassPurchase } from "./ImagePassPurchase";
function render() {
	state.cursor = 0;
	return ImagePassPurchase();
}
function buy(root: ReactElement): () => void {
	if (root.type === "button") return (root.props as { onClick: () => void }).onClick;
	for (const child of React.Children.toArray(
		(root.props as { children?: React.ReactNode }).children,
	)) {
		if (!React.isValidElement(child)) continue;
		try {
			return buy(child);
		} catch {}
	}
	throw new Error("buy button missing");
}
async function flush() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}
beforeEach(() => {
	vi.clearAllMocks();
	state.ownerId = "owner-a";
	state.cursor = 0;
	state.slots = [];
	state.checkout.mockReset();
	vi.stubGlobal("window", { location: { assign: state.assign } });
});
afterEach(() => vi.unstubAllGlobals());
describe("image pass checkout UI", () => {
	it("coalesces clicks and preserves the same purchase key after an uncertain checkout response", async () => {
		let reject!: (reason: Error) => void;
		state.checkout
			.mockImplementationOnce(
				() =>
					new Promise((_resolve, fail) => {
						reject = fail;
					}),
			)
			.mockResolvedValueOnce({
				checkoutLink: "https://www.sandbox.paypal.com/approve",
				intentId: "intent",
			});
		const click = buy(render());
		click();
		click();
		await flush();
		expect(state.checkout).toHaveBeenCalledTimes(1);
		const request = state.checkout.mock.calls[0]![0];
		expect(request).toMatchObject({ provider: "paypal", idempotencyKey: expect.any(String) });
		expect(request).not.toHaveProperty("amount");
		expect(request).not.toHaveProperty("credits");
		reject(new Error("response lost"));
		await flush();
		click();
		await flush();
		expect(state.checkout.mock.calls[1]![0]).toEqual(request);
		expect(state.assign).toHaveBeenCalledWith("https://www.sandbox.paypal.com/approve");
	});
	it("does not redirect a different signed-in owner to the old owner's checkout", async () => {
		let resolve!: (value: { checkoutLink: string; intentId: string }) => void;
		state.checkout.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		buy(render())();
		await flush();
		state.ownerId = "owner-b";
		render();
		resolve({ checkoutLink: "https://www.sandbox.paypal.com/owner-a", intentId: "intent-a" });
		await flush();
		expect(state.assign).not.toHaveBeenCalled();
		expect(state.release).toHaveBeenCalled();
	});
});
