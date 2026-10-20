import { getCurrentCheckoutAttribution } from "@shared/lib/purchase-attribution";
import React, { type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CheckoutAttribution = Awaited<ReturnType<typeof getCurrentCheckoutAttribution>>;

const state = vi.hoisted(() => ({
	ownerId: "owner-a",
	cursor: 0,
	slots: [] as { current?: unknown; value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
	checkout: vi.fn(),
	capture: vi.fn(),
	assign: vi.fn(),
	replaceState: vi.fn(),
	acquire: vi.fn((_key: string) => true),
	release: vi.fn(),
	redirecting: vi.fn(),
	refetch: vi.fn(),
	queryOptions: vi.fn(),
	available: true,
	passAvailable: 3,
	passReserved: 0,
	checkoutStatus: "PENDING",
	stateError: false,
	action: null as { key: string; stage: string } | null,
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
	useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
		const index = state.cursor++,
			prior = state.slots[index];
		if (prior?.deps && deps.every((value, i) => value === prior.deps![i])) return;
		prior?.cleanup?.();
		const cleanup = effect();
		state.slots[index] = { deps, cleanup: cleanup || undefined };
	},
}));
vi.mock("@auth/lib/api", () => ({
	useSessionQuery: () => ({ data: { user: { id: state.ownerId, isAnonymous: false } } }),
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		payments: {
			createImagePassCheckout: { mutationOptions: () => ({}) },
			capturePayPalImagePassCheckout: { mutationOptions: () => ({ capture: true }) },
			getImagePassCheckoutState: { queryOptions: () => ({}) },
		},
	},
}));
vi.mock("@shared/lib/purchase-attribution", () => ({
	captureCheckoutTrigger: vi.fn(),
	clearCheckoutTrigger: vi.fn(),
	getCurrentCheckoutAttribution: vi.fn(async () => ({ triggerPath: null })),
}));
vi.mock("@tanstack/react-query", async (original) => ({
	...(await original<typeof import("@tanstack/react-query")>()),
	useMutation: (options: { capture?: boolean }) => ({
		mutateAsync: options.capture ? state.capture : state.checkout,
	}),
	useQuery: (options: { queryKey: string[]; enabled?: boolean }) => {
		state.queryOptions(options);
		const checkoutState = options.queryKey[0] === "image-pass-checkout";
		return {
			data: checkoutState
				? options.enabled
					? { status: state.checkoutStatus }
					: undefined
				: {
						available:
							options.queryKey[0] === "payments-image-pass-offer"
								? state.available
								: state.passAvailable,
						reserved: state.passReserved,
					},
			isPending: false,
			isError: checkoutState && state.stateError,
			isSuccess: !(checkoutState && state.stateError),
			isFetching: false,
			refetch: state.refetch,
		};
	},
}));
vi.mock("../hooks/use-payment-action", () => ({
	usePaymentAction: () => ({
		action: state.action,
		getSnapshot: () => state.action,
		acquire: state.acquire,
		release: state.release,
		redirecting: state.redirecting,
	}),
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: { count?: number }) =>
		key === "balance" || key === "fundingReserved" ? `${key} ${values?.count}` : key,
}));
import { ImagePassPurchase } from "./ImagePassPurchase";
function render(options: { intentId?: string; canceled?: boolean } = {}) {
	state.cursor = 0;
	return ImagePassPurchase(options);
}
function texts(root: React.ReactNode): string {
	if (typeof root === "string") return root;
	if (!React.isValidElement(root)) return "";
	return React.Children.toArray((root.props as { children?: React.ReactNode }).children)
		.map(texts)
		.join(" ");
}
function find(root: ReactElement, id: string): ReactElement {
	if ((root.props as { "data-testid"?: string })["data-testid"] === id) return root;
	for (const child of React.Children.toArray(
		(root.props as { children?: React.ReactNode }).children,
	)) {
		if (!React.isValidElement(child)) continue;
		try {
			return find(child, id);
		} catch {}
	}
	throw new Error(`${id} missing`);
}
function buy(root: ReactElement): () => void {
	// Preserve a useful regression failure before the new stable selector exists.
	if (
		(root.props as { "data-testid"?: string })["data-testid"] === "image-pass-buy" ||
		root.type === "button"
	)
		return (root.props as { onClick: () => void }).onClick;
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
	state.available = true;
	state.passAvailable = 3;
	state.passReserved = 0;
	state.stateError = false;
	state.checkoutStatus = "PENDING";
	state.action = null;
	state.acquire.mockReset().mockImplementation((key: string) => {
		if (state.action) return false;
		state.action = { key, stage: "starting" };
		return true;
	});
	state.release.mockReset().mockImplementation(() => {
		state.action = null;
	});
	state.redirecting.mockReset().mockImplementation(() => {
		if (state.action) state.action = { ...state.action, stage: "redirecting" };
	});
	vi.mocked(getCurrentCheckoutAttribution).mockReset().mockResolvedValue({ triggerPath: null });
	state.checkout.mockReset();
	state.refetch.mockResolvedValue({});
	state.replaceState.mockReset().mockImplementation((_savedState, _title, href: string) => {
		window.location.href = new URL(href, window.location.href).href;
	});
	const items = new Map<string, string>();
	const events = new EventTarget();
	vi.stubGlobal("window", {
		location: { assign: state.assign, href: "https://example.test/image-pass" },
		history: { state: { __NA: true }, replaceState: state.replaceState },
		sessionStorage: {
			getItem: (key: string) => items.get(key) ?? null,
			setItem: (key: string, value: string) => items.set(key, value),
			removeItem: (key: string) => items.delete(key),
		},
		addEventListener: events.addEventListener.bind(events),
		removeEventListener: events.removeEventListener.bind(events),
		dispatchEvent: events.dispatchEvent.bind(events),
	});
});
afterEach(() => {
	for (const slot of state.slots) slot.cleanup?.();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
describe("image pass checkout UI", () => {
	it("slows restored pending reads and restarts read-only polling on explicit checks or focus", async () => {
		vi.useFakeTimers();
		const element = render({ intentId: "intent" });
		const polling = state.queryOptions.mock.lastCall![0].refetchInterval;
		const pending = { state: { status: "success", data: { status: "PENDING" } } };
		expect(polling(pending)).toBe(3_000);
		vi.advanceTimersByTime(120_000);
		expect(polling(pending)).toBe(30_000);
		expect(texts(render({ intentId: "intent" }))).toContain("checkoutUnconfirmed");
		(find(element, "image-pass-check-status").props as { onClick: () => void }).onClick();
		expect(polling(pending)).toBe(3_000);
		vi.advanceTimersByTime(120_000);
		window.dispatchEvent(new Event("focus"));
		expect(polling(pending)).toBe(3_000);
		expect(polling({ state: { ...pending.state, status: "error" } })).toBe(false);
		await flush();
		expect(state.refetch).toHaveBeenCalledTimes(2);
		expect(state.checkout).not.toHaveBeenCalled();
		expect(state.capture).not.toHaveBeenCalled();
		expect(window.sessionStorage.getItem("image-pass-checkout:owner-a")).toBe("intent");
	});

	it.each([
		{ available: 3, reserved: 1 },
		{ available: 0, reserved: 2 },
	])(
		"shows available and in-progress image passes on the purchase page: %o",
		({ available, reserved }) => {
			state.passAvailable = available;
			state.passReserved = reserved;
			const element = render();
			expect(texts(element)).toContain(`balance ${available}`);
			expect(texts(element)).toContain(`fundingReserved ${reserved}`);
			expect(state.checkout).not.toHaveBeenCalled();
			expect(state.capture).not.toHaveBeenCalled();
		},
	);
	it("does not suggest in-progress passes when none are reserved", () => {
		expect(texts(render())).not.toContain("fundingReserved");
	});
	it("does not start checkout when the server offer is unavailable", async () => {
		state.available = false;
		buy(render())();
		await flush();
		expect(state.checkout).not.toHaveBeenCalled();
		expect(state.acquire).not.toHaveBeenCalled();
	});
	it.each(["owner change", "unmount"])(
		"does not create checkout after %s while attribution is pending and releases its lock",
		async (change) => {
			let resolve!: (value: CheckoutAttribution) => void;
			vi.mocked(getCurrentCheckoutAttribution).mockImplementationOnce(
				() =>
					new Promise<CheckoutAttribution>((done) => {
						resolve = done;
					}),
			);
			buy(render())();
			expect(state.action?.stage).toBe("starting");
			expect(state.checkout).not.toHaveBeenCalled();
			if (change === "owner change") {
				state.ownerId = "owner-b";
				render();
			} else {
				for (const slot of state.slots) slot.cleanup?.();
			}
			expect.soft(state.action).toBeNull();
			resolve({ triggerPath: null });
			await flush();
			expect(state.checkout).not.toHaveBeenCalled();
			expect(state.assign).not.toHaveBeenCalled();
			expect(state.release).toHaveBeenCalledOnce();
		},
	);
	it.each(["resolve", "reject"])(
		"does not create checkout or release a replacement action when old attribution %s occurs",
		async (outcome) => {
			let resolve!: (value: CheckoutAttribution) => void;
			let reject!: (error: Error) => void;
			vi.mocked(getCurrentCheckoutAttribution).mockImplementationOnce(
				() =>
					new Promise<CheckoutAttribution>((done, fail) => {
						resolve = done;
						reject = fail;
					}),
			);
			buy(render())();
			state.release();
			state.acquire("image-pass:paypal");
			const replacement = state.action;
			if (outcome === "resolve") resolve({ triggerPath: null });
			else reject(new Error("attribution unavailable"));
			await flush();
			expect(state.checkout).not.toHaveBeenCalled();
			expect(state.action).toBe(replacement);
			expect(state.release).toHaveBeenCalledOnce();
			expect(texts(render())).not.toContain("checkoutError");
		},
	);
	it("releases its starting action when attribution fails", async () => {
		vi.mocked(getCurrentCheckoutAttribution).mockRejectedValueOnce(
			new Error("attribution unavailable"),
		);
		buy(render())();
		await flush();
		expect(state.checkout).not.toHaveBeenCalled();
		expect(state.action).toBeNull();
		expect(state.release).toHaveBeenCalledOnce();
		expect(texts(render())).toContain("checkoutError");
	});
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
		expect(state.action).toEqual({ key: "image-pass:paypal", stage: "redirecting" });
		expect(window.sessionStorage.getItem("image-pass-checkout:owner-a")).toBe("intent");
	});
	it("does not redirect or store a different signed-in owner's old checkout", async () => {
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
		expect(window.sessionStorage.getItem("image-pass-checkout:owner-a")).toBeNull();
		expect(window.sessionStorage.getItem("image-pass-checkout:owner-b")).toBeNull();
		expect(state.release).toHaveBeenCalled();
	});
	it("reads a canceled checkout without creating or capturing a payment after refresh", async () => {
		const props = { intentId: "intent", canceled: true };
		let element = render(props);
		expect(texts(element)).toContain("checkoutUnconfirmed");
		(find(element, "image-pass-check-status").props as { onClick: () => void }).onClick();
		state.slots = [];
		element = render(props);
		await flush();
		expect(texts(element)).not.toContain("returnCompleted");
		expect(state.refetch).toHaveBeenCalledOnce();
		expect(state.checkout).not.toHaveBeenCalled();
		expect(state.capture).not.toHaveBeenCalled();
		expect(state.queryOptions).toHaveBeenCalledWith(
			expect.objectContaining({
				queryKey: ["image-pass-checkout", "owner-a", "intent"],
				enabled: true,
			}),
		);
	});
	it("restores the owner's pending intent on browser back and refreshes without capture", async () => {
		window.sessionStorage.setItem("image-pass-checkout:owner-a", "intent");
		state.action = { key: "image-pass:paypal", stage: "redirecting" };
		render();
		const element = render();
		expect(texts(element)).toContain("checkoutUnconfirmed");
		const event = new Event("pageshow");
		Object.defineProperty(event, "persisted", { value: true });
		window.dispatchEvent(event);
		window.dispatchEvent(new Event("focus"));
		await flush();
		expect(state.release).toHaveBeenCalled();
		expect(state.refetch).toHaveBeenCalledTimes(2);
		expect(state.checkout).not.toHaveBeenCalled();
		expect(state.capture).not.toHaveBeenCalled();
	});
	it("does not restore another owner's browser checkout context", () => {
		window.sessionStorage.setItem("image-pass-checkout:owner-a", "intent-a");
		render();
		render();
		state.ownerId = "owner-b";
		render();
		const element = render();
		expect(texts(element)).not.toContain("checkoutUnconfirmed");
		expect(state.queryOptions).toHaveBeenLastCalledWith(
			expect.objectContaining({
				queryKey: ["image-pass-checkout", "owner-b", undefined],
				enabled: false,
			}),
		);
	});
	it.each(["COMPLETED", "REVIEW", "EXPIRED", "CANCELED"])(
		"shows only server-confirmed %s state on cancellation",
		(status) => {
			state.checkoutStatus = status;
			const element = render({ intentId: "intent", canceled: true });
			expect(texts(element)).toContain(
				status === "COMPLETED"
					? "returnCompleted"
					: status === "REVIEW"
						? "returnReview"
						: "checkoutNotCompleted",
			);
			expect(state.capture).not.toHaveBeenCalled();
			expect(state.checkout).not.toHaveBeenCalled();
		},
	);
	it("shows a retryable status error without inferring payment failure", () => {
		state.stateError = true;
		const element = render({ intentId: "intent", canceled: true });
		expect(texts(element)).toContain("checkoutStatusError");
		expect(texts(element)).not.toContain("checkoutNotCompleted");
		expect(texts(element)).not.toContain("returnCompleted");
	});
	it("allows another purchase after server-confirmed completion", async () => {
		state.checkoutStatus = "COMPLETED";
		state.checkout.mockResolvedValue({
			checkoutLink: "https://www.sandbox.paypal.com/new",
			intentId: "next-intent",
		});
		const element = render({ intentId: "intent" });
		const purchaseButton = find(element, "image-pass-buy");
		expect(texts(purchaseButton)).toBe("pay");
		(purchaseButton.props as { onClick: () => void }).onClick();
		await flush();
		expect(state.checkout).toHaveBeenCalledOnce();
		expect(window.sessionStorage.getItem("image-pass-checkout:owner-a")).toBe("next-intent");
	});
	it("shows the latest pending checkout after buying again and navigating back", async () => {
		window.location.href =
			"https://example.test/image-pass?intentId=old-intent&canceled=1&approved=1&token=old-token&lang=de#offer";
		state.checkoutStatus = "COMPLETED";
		state.checkout.mockResolvedValue({
			checkoutLink: "https://www.sandbox.paypal.com/new",
			intentId: "next-intent",
		});
		const props = { intentId: "old-intent" };
		(find(render(props), "image-pass-buy").props as { onClick: () => void }).onClick();
		await flush();
		expect(state.replaceState).toHaveBeenCalledWith(
			window.history.state,
			"",
			"/image-pass?lang=de#offer",
		);
		state.checkoutStatus = "PENDING";
		const event = new Event("pageshow");
		Object.defineProperty(event, "persisted", { value: true });
		window.dispatchEvent(event);
		const restored = render(props);
		expect(texts(restored)).toContain("checkoutUnconfirmed");
		expect(state.queryOptions).toHaveBeenLastCalledWith(
			expect.objectContaining({ queryKey: ["image-pass-checkout", "owner-a", "next-intent"] }),
		);
		for (const slot of state.slots) slot.cleanup?.();
		state.slots = [];
		render();
		expect(texts(render())).toContain("checkoutUnconfirmed");
		expect(state.checkout).toHaveBeenCalledOnce();
		expect(state.capture).not.toHaveBeenCalled();
	});
	it("keeps the new intent and redirects if browser history cannot be updated", async () => {
		state.replaceState.mockImplementationOnce(() => {
			throw new Error("history unavailable");
		});
		state.checkout.mockResolvedValue({
			checkoutLink: "https://www.sandbox.paypal.com/new",
			intentId: "next-intent",
		});
		buy(render())();
		await flush();
		expect(state.replaceState).toHaveBeenCalledOnce();
		expect(state.checkout).toHaveBeenCalledOnce();
		expect(window.sessionStorage.getItem("image-pass-checkout:owner-a")).toBe("next-intent");
		expect(state.assign).toHaveBeenCalledWith("https://www.sandbox.paypal.com/new");
	});
});
