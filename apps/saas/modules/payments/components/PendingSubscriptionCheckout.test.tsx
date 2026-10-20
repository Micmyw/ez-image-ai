import React, { type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	ownerId: "owner-a",
	data: null as null | {
		id: string;
		provider: string;
		canResume: boolean;
		canChange: boolean;
		status: string;
	},
	cursor: 0,
	slots: [] as { current?: unknown; value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
	refetch: vi.fn(),
	refresh: vi.fn(),
	cancel: vi.fn(),
	resume: vi.fn(),
	queryOptions: vi.fn(),
	invalidate: vi.fn(),
	setQueryData: vi.fn(),
	acquire: vi.fn(() => true),
	release: vi.fn(),
	redirecting: vi.fn(),
	assign: vi.fn(),
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
	useSessionQuery: () => ({ data: { user: { id: state.ownerId } } }),
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		payments: {
			key: () => ["payments"],
			getPendingSubscriptionCheckout: { queryOptions: () => ({ queryKey: ["pending"] }) },
			refreshPendingSubscriptionCheckout: { mutationOptions: () => ({ kind: "refresh" }) },
			cancelPendingSubscriptionCheckout: { mutationOptions: () => ({ kind: "cancel" }) },
			resumePendingSubscriptionCheckout: { mutationOptions: () => ({ kind: "resume" }) },
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: (options: unknown) => {
		state.queryOptions(options);
		return { data: state.data, isError: false, isFetching: false, refetch: state.refetch };
	},
	useMutation: (options: { kind: "refresh" | "cancel" | "resume" }) => ({
		isPending: false,
		mutateAsync: state[options.kind],
	}),
	useQueryClient: () => ({ invalidateQueries: state.invalidate, setQueryData: state.setQueryData }),
}));
vi.mock("../hooks/use-payment-action", () => ({
	usePaymentAction: () => ({
		action: state.action,
		acquire: state.acquire,
		release: state.release,
		redirecting: state.redirecting,
		getSnapshot: () => state.action,
	}),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
import { PendingSubscriptionCheckout } from "./PendingSubscriptionCheckout";

function render() {
	state.cursor = 0;
	return PendingSubscriptionCheckout({});
}
function find(root: ReactElement, id: string): ReactElement {
	if ((root.props as { "data-testid"?: string })["data-testid"] === id) return root;
	for (const child of React.Children.toArray(
		(root.props as { children?: React.ReactNode }).children,
	)) {
		if (React.isValidElement(child)) {
			try {
				return find(child, id);
			} catch {}
		}
	}
	throw new Error(`${id} missing`);
}
function texts(root: React.ReactNode): string {
	if (typeof root === "string") return root;
	return React.isValidElement(root)
		? React.Children.toArray((root.props as { children?: React.ReactNode }).children)
				.map(texts)
				.join(" ")
		: "";
}
function click(root: ReactElement | null, id: string) {
	(find(root!, id).props as { onClick: () => void }).onClick();
}
async function flush() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}
beforeEach(() => {
	vi.clearAllMocks();
	state.slots = [];
	state.cursor = 0;
	state.ownerId = "owner-a";
	state.action = null;
	state.data = {
		id: "intent",
		provider: "paypal",
		canResume: true,
		canChange: true,
		status: "PENDING",
	};
	state.refetch.mockResolvedValue({});
	state.refresh.mockResolvedValue({ status: "CHECKING" });
	state.cancel.mockResolvedValue({ status: "WAITING" });
	state.resume.mockResolvedValue({ checkoutLink: "/mock-checkout" });
	state.invalidate.mockResolvedValue(undefined);
	const events = new EventTarget();
	vi.stubGlobal("window", {
		addEventListener: events.addEventListener.bind(events),
		removeEventListener: events.removeEventListener.bind(events),
		dispatchEvent: events.dispatchEvent.bind(events),
		location: { assign: state.assign },
	});
	vi.stubGlobal("document", { visibilityState: "visible" });
});
afterEach(() => {
	for (const slot of state.slots) slot.cleanup?.();
	vi.unstubAllGlobals();
});

describe("pending subscription checkout actions", () => {
	it("renders no recovery UI without a pending checkout", () => {
		state.data = null;
		expect(render()).toBeNull();
	});
	it("preserves separate resume, change plan and read-only status controls", () => {
		const element = render();
		expect(texts(element)).toContain("resume");
		expect(texts(element)).toContain("changePlan");
		expect(texts(element)).toContain("refresh");
	});
	it("keeps mount, focus and browser Back refreshes read-only", async () => {
		render();
		window.dispatchEvent(new Event("focus"));
		window.dispatchEvent(new Event("pageshow"));
		await flush();
		expect(state.refresh).not.toHaveBeenCalled();
		expect(state.cancel).not.toHaveBeenCalled();
		expect(state.resume).not.toHaveBeenCalled();
		expect(state.refetch).toHaveBeenCalled();
	});
	it("checks status without requesting provider activation", async () => {
		const element = render();
		click(element, "pending-subscription-check-status");
		await flush();
		expect(state.refetch).toHaveBeenCalled();
		expect(state.refresh).not.toHaveBeenCalled();
		expect(state.acquire).not.toHaveBeenCalled();
	});
	it("finishes an approved subscription only after an explicit action", async () => {
		const element = render();
		await flush();
		expect(state.refresh).not.toHaveBeenCalled();
		click(element, "pending-subscription-confirm-payment");
		await flush();
		expect(state.refresh).toHaveBeenCalledExactlyOnceWith({
			checkoutIntentId: "intent",
			retryReview: true,
		});
	});
	it("retains explicit resume and cancel operations", async () => {
		const element = render();
		click(element, "pending-subscription-resume");
		await flush();
		expect(state.resume).toHaveBeenCalledExactlyOnceWith({ checkoutIntentId: "intent" });
		expect(state.assign).toHaveBeenCalledExactlyOnceWith("/mock-checkout");
		click(element, "pending-subscription-change-plan");
		await flush();
		expect(state.cancel).toHaveBeenCalledExactlyOnceWith({ checkoutIntentId: "intent" });
	});
	it("does not offer confirmation or an expired link while closure is pending", () => {
		state.data = {
			id: "intent",
			provider: "waffo",
			canResume: false,
			canChange: false,
			status: "WAITING",
		};
		const element = render();
		expect(texts(element)).toContain("WAITING");
		expect(() => find(element!, "pending-subscription-resume")).toThrow();
		expect(() => find(element!, "pending-subscription-confirm-payment")).toThrow();
	});
	it("scopes read-only checkout data to the active owner", () => {
		render();
		expect(state.queryOptions).toHaveBeenLastCalledWith(
			expect.objectContaining({ queryKey: ["pending-subscription-checkout", "owner-a"] }),
		);
	});
	it("ignores an old owner's pending resume response", async () => {
		let resolve!: (value: unknown) => void;
		state.resume.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		click(render(), "pending-subscription-resume");
		state.ownerId = "owner-b";
		state.data = null;
		render();
		resolve({ checkoutLink: "/old-owner-checkout" });
		await flush();
		expect(state.assign).not.toHaveBeenCalled();
	});
	it("ignores a pending resume after leaving the checkout component", async () => {
		let resolve!: (value: unknown) => void;
		state.resume.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		click(render(), "pending-subscription-resume");
		for (const slot of state.slots) slot.cleanup?.();
		resolve({ checkoutLink: "/old-checkout" });
		await flush();
		expect(state.assign).not.toHaveBeenCalled();
	});
	it("ignores a prior intent response when the owner has a different pending checkout", async () => {
		let resolve!: (value: unknown) => void;
		state.resume.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		click(render(), "pending-subscription-resume");
		state.data = {
			id: "next-intent",
			provider: "paypal",
			canResume: true,
			canChange: true,
			status: "PENDING",
		};
		render();
		resolve({ checkoutLink: "/old-checkout" });
		await flush();
		expect(state.assign).not.toHaveBeenCalled();
	});
});
