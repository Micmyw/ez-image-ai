import { PUBLIC_CREDIT_PACKS } from "@repo/config/client";
import React, { type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	ownerId: "owner-a",
	orgId: null as string | null,
	cursor: 0,
	slots: [] as { current?: unknown; value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
	checkout: vi.fn(),
	attribution: vi.fn(),
	query: vi.fn(),
	refetch: vi.fn(),
	push: vi.fn(),
	bindReturn: vi.fn(),
	action: null as { key: string; stage: "starting" | "redirecting" } | null,
	acquire: vi.fn(),
	release: vi.fn(),
	redirecting: vi.fn(),
	status: "PENDING",
}));
vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useContext: () => ({
		provider: "paypal",
		availability: new Map(
			PUBLIC_CREDIT_PACKS.map(({ packKey }) => [
				packKey,
				{ ready: true, providers: ["paypal", "waffo"], failed: false },
			]),
		),
	}),
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
		state.slots[index] = { deps, cleanup: effect() || undefined };
	},
}));
vi.mock("@auth/lib/api", () => ({
	useSessionQuery: () => ({
		data: {
			user: { id: state.ownerId, isAnonymous: false },
			session: { activeOrganizationId: state.orgId },
		},
	}),
}));
vi.mock("@shared/hooks/router", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		payments: {
			createCreditPackCheckout: { mutationOptions: () => ({}) },
			getCreditPackCheckoutState: { queryOptions: () => ({}) },
			getCreditPackProviderAvailability: { queryOptions: () => ({}) },
		},
	},
}));
vi.mock("@shared/lib/purchase-attribution", () => ({
	captureCheckoutTrigger: vi.fn(),
	clearCheckoutTrigger: vi.fn(),
	getCurrentCheckoutAttribution: state.attribution,
}));
vi.mock("../../video-effects/lib/payment-return", () => ({
	bindVideoEffectPaymentReturn: state.bindReturn,
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
vi.mock("@tanstack/react-query", () => ({
	useMutation: () => ({ mutateAsync: state.checkout }),
	useQueries: () => [],
	useQuery: (options: { enabled: boolean }) => {
		state.query(options);
		return {
			data: options.enabled
				? { status: state.status, provider: "paypal", amount: "15.00", currency: "USD" }
				: undefined,
			isSuccess: options.enabled,
			isError: false,
			refetch: state.refetch,
		};
	},
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
import {
	readCreditPackCheckoutContext,
	saveCreditPackCheckoutContext,
} from "../lib/credit-pack-checkout-context";
import { CreditPackCheckoutActions } from "./CreditPackCheckoutActions";
const packKey = PUBLIC_CREDIT_PACKS[0]!.packKey;
function render() {
	state.cursor = 0;
	return CreditPackCheckoutActions({ packKey });
}
function button(node: ReactElement): () => void {
	if (node.type === "button") return (node.props as { onClick: () => void }).onClick;
	for (const child of React.Children.toArray(
		(node.props as { children?: React.ReactNode }).children,
	)) {
		if (!React.isValidElement(child)) continue;
		try {
			return button(child);
		} catch {}
	}
	throw new Error("purchase button missing");
}
function text(node: React.ReactNode): string {
	if (typeof node === "string") return node;
	if (!React.isValidElement(node)) return "";
	return React.Children.toArray((node.props as { children?: React.ReactNode }).children)
		.map(text)
		.join(" ");
}
async function flush() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}
beforeEach(() => {
	vi.clearAllMocks();
	state.ownerId = "owner-a";
	state.orgId = null;
	state.cursor = 0;
	state.slots = [];
	state.action = null;
	state.status = "PENDING";
	state.acquire.mockImplementation((key: string) => {
		if (state.action) return false;
		state.action = { key, stage: "starting" };
		return true;
	});
	state.release.mockImplementation(() => {
		state.action = null;
	});
	state.redirecting.mockImplementation(() => {
		if (state.action) state.action = { ...state.action, stage: "redirecting" };
	});
	state.checkout.mockReset();
	state.attribution.mockReset().mockResolvedValue({});
	state.refetch.mockResolvedValue({});
	const items = new Map<string, string>();
	const events = new EventTarget();
	vi.stubGlobal("window", {
		location: {
			href: "https://example.test/pricing",
			pathname: "/pricing",
			search: "?returnTo=%2Fvideo%2Feffects%2Fraindance",
		},
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
	vi.unstubAllGlobals();
});
describe("credit pack checkout creation and browser recovery", () => {
	it("coalesces clicks and saves only the current owner's returned intent before redirect", async () => {
		state.checkout.mockResolvedValue({
			checkoutLink: "https://paypal.example/approve",
			intentId: "intent",
		});
		const click = button(render());
		click();
		click();
		await flush();
		expect(state.checkout).toHaveBeenCalledOnce();
		expect(readCreditPackCheckoutContext("owner-a", null, packKey)).toBe("intent");
		expect(window.location.href).toBe("https://paypal.example/approve");
		expect(state.bindReturn).toHaveBeenCalledWith(
			"owner-a",
			"intent",
			expect.stringContaining("returnTo="),
		);
	});
	it("restores a read-only pending status on Back or refresh without creating another checkout", async () => {
		saveCreditPackCheckoutContext("owner-a", null, packKey, "intent");
		render();
		const element = render();
		expect(text(element)).toContain("creditPackCheckoutReturn.viewStatus");
		window.dispatchEvent(new Event("pageshow"));
		window.dispatchEvent(new Event("focus"));
		await flush();
		expect(state.refetch).toHaveBeenCalledTimes(2);
		expect(state.checkout).not.toHaveBeenCalled();
		expect(state.query).toHaveBeenLastCalledWith(
			expect.objectContaining({
				queryKey: ["credit-pack-checkout", "owner-a", null, "intent"],
				enabled: true,
			}),
		);
	});
	it("does not redirect, store or bind another owner's late checkout response", async () => {
		let resolve!: (value: unknown) => void;
		state.checkout.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		button(render())();
		await flush();
		state.ownerId = "owner-b";
		state.orgId = "org-b";
		render();
		resolve({ checkoutLink: "https://paypal.example/owner-a", intentId: "intent-a" });
		await flush();
		expect(window.location.href).toBe("https://example.test/pricing");
		expect(readCreditPackCheckoutContext("owner-a", null, packKey)).toBeUndefined();
		expect(state.bindReturn).not.toHaveBeenCalled();
	});
	it("preserves a purchase key after uncertain failure and uses a new key after an owner switch", async () => {
		state.checkout.mockRejectedValue(new Error("response lost"));
		button(render())();
		await flush();
		const first = state.checkout.mock.calls[0]![0];
		button(render())();
		await flush();
		expect(state.checkout.mock.calls[1]![0]).toEqual(first);
		state.ownerId = "owner-b";
		state.orgId = "org-b";
		button(render())();
		await flush();
		expect(state.checkout.mock.calls[2]![0].idempotencyKey).not.toBe(first.idempotencyKey);
	});
	it("does not restore a different organization's pending checkout", () => {
		saveCreditPackCheckoutContext("owner-a", "org-a", packKey, "intent-a");
		state.orgId = "org-b";
		render();
		const element = render();
		expect(text(element)).not.toContain("creditPackCheckoutReturn.viewStatus");
	});
	it("unlocks the new owner while ignoring the old owner's unresolved checkout", async () => {
		let resolve!: (value: unknown) => void;
		state.checkout
			.mockImplementationOnce(
				() =>
					new Promise((done) => {
						resolve = done;
					}),
			)
			.mockResolvedValueOnce({
				checkoutLink: "https://paypal.example/owner-b",
				intentId: "intent-b",
			});
		button(render())();
		await flush();
		state.ownerId = "owner-b";
		state.orgId = "org-b";
		button(render())();
		await flush();
		expect(state.checkout).toHaveBeenCalledTimes(2);
		resolve({ checkoutLink: "https://paypal.example/owner-a", intentId: "intent-a" });
		await flush();
		expect(window.location.href).toBe("https://paypal.example/owner-b");
		expect(readCreditPackCheckoutContext("owner-b", "org-b", packKey)).toBe("intent-b");
	});
	it("releases an unmounted pending checkout so a later checkout can begin", async () => {
		let resolve!: (value: unknown) => void;
		state.checkout
			.mockImplementationOnce(
				() =>
					new Promise((done) => {
						resolve = done;
					}),
			)
			.mockResolvedValueOnce({
				checkoutLink: "https://paypal.example/new",
				intentId: "new-intent",
			});
		button(render())();
		await flush();
		for (const slot of state.slots) slot.cleanup?.();
		resolve({ checkoutLink: "https://paypal.example/old", intentId: "old-intent" });
		await flush();
		expect(state.action).toBeNull();
		expect(window.location.href).toBe("https://example.test/pricing");
		state.slots = [];
		button(render())();
		await flush();
		expect(state.checkout).toHaveBeenCalledTimes(2);
		expect(window.location.href).toBe("https://paypal.example/new");
	});
	it("does not let an unmounted response release a newer action with the same key", async () => {
		let resolve!: (value: unknown) => void;
		state.checkout.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		button(render())();
		await flush();
		for (const slot of state.slots) slot.cleanup?.();
		expect(state.acquire(`pack:${packKey}:paypal`)).toBe(true);
		const newAction = state.action;
		resolve({ checkoutLink: "https://paypal.example/old", intentId: "old-intent" });
		await flush();
		expect(state.action).toBe(newAction);
		expect(window.location.href).toBe("https://example.test/pricing");
	});
	it("does not release a replacement action already active when the component unmounts", async () => {
		let reject!: (reason: Error) => void;
		state.checkout.mockImplementationOnce(
			() =>
				new Promise((_resolve, fail) => {
					reject = fail;
				}),
		);
		button(render())();
		await flush();
		state.release();
		expect(state.acquire(`pack:${packKey}:paypal`)).toBe(true);
		const replacement = state.action;
		for (const slot of state.slots) slot.cleanup?.();
		reject(new Error("old response lost"));
		await flush();
		expect(state.action).toBe(replacement);
	});
	it.each(["owner change", "unmount"])(
		"does not create checkout after %s while attribution is pending",
		async (change) => {
			let resolve!: (value: unknown) => void;
			state.attribution.mockImplementationOnce(
				() =>
					new Promise((done) => {
						resolve = done;
					}),
			);
			state.checkout.mockResolvedValue({
				checkoutLink: "https://paypal.example/stale",
				intentId: "stale-intent",
			});
			button(render())();
			await flush();
			expect(state.checkout).not.toHaveBeenCalled();
			if (change === "owner change") {
				state.ownerId = "owner-b";
				state.orgId = "org-b";
				render();
			} else for (const slot of state.slots) slot.cleanup?.();
			resolve({});
			await flush();
			expect(state.checkout).not.toHaveBeenCalled();
			expect(state.action).toBeNull();
			expect(window.location.href).toBe("https://example.test/pricing");
		},
	);
});
