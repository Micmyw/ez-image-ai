import React, { type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	ownerId: "owner-a" as string | null,
	status: "PENDING" as string | undefined,
	isPending: false,
	isError: false,
	cursor: 0,
	slots: [] as { current?: unknown; value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
	refresh: vi.fn(),
	refetch: vi.fn(),
	queryOptions: vi.fn(),
	push: vi.fn(),
	replace: vi.fn(),
	consume: vi.fn(),
	activated: vi.fn(),
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
	useSessionQuery: () => ({
		data: state.ownerId ? { user: { id: state.ownerId } } : null,
		isPending: false,
	}),
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		payments: {
			refreshPendingSubscriptionCheckout: { mutationOptions: () => ({}) },
			getCheckoutReturnState: {
				queryOptions: (options: unknown) => {
					state.queryOptions(options);
					return {};
				},
			},
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useMutation: () => ({ mutateAsync: state.refresh, isPending: false }),
	useQuery: (options: unknown) => {
		state.queryOptions(options);
		return {
			data: state.status
				? { status: state.status, planId: state.status === "ACTIVE" ? "creator" : null }
				: undefined,
			isPending: state.isPending,
			isError: state.isError,
			isSuccess: !state.isPending && !state.isError && Boolean(state.status),
			isFetching: false,
			refetch: state.refetch,
		};
	},
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: state.push, replace: state.replace }),
}));
vi.mock("@shared/lib/growth-analytics", () => ({
	saasGrowthFunnel: { subscriptionActivated: state.activated },
}));
vi.mock("../../video-effects/lib/payment-return", () => ({
	consumeVideoEffectPaymentReturn: state.consume,
}));
import { CheckoutReturnContent } from "./CheckoutReturnContent";

function render(
	options: { canceled?: boolean; approved?: boolean; checkoutIntentId?: string } = {},
) {
	state.cursor = 0;
	return CheckoutReturnContent({
		expectedPlanId: "creator",
		returnTo: "/create",
		checkoutIntentId: "intent",
		...options,
	});
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
function click(root: ReactElement, id: string) {
	(find(root, id).props as { onClick: () => void }).onClick();
}
async function flush() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}
beforeEach(() => {
	vi.clearAllMocks();
	state.ownerId = "owner-a";
	state.status = "PENDING";
	state.isPending = false;
	state.isError = false;
	state.slots = [];
	state.refresh.mockReset().mockResolvedValue({ status: "APPROVED" });
	state.refetch.mockResolvedValue({});
	state.activated.mockResolvedValue(undefined);
});
afterEach(() => {
	for (const slot of state.slots) slot.cleanup?.();
	vi.restoreAllMocks();
});

describe("subscription checkout return intent", () => {
	it("keeps cancellation read-only even when approval is also present", async () => {
		const element = render({ canceled: true, approved: true });
		await flush();
		expect(state.refresh).not.toHaveBeenCalled();
		expect(state.replace).not.toHaveBeenCalled();
		expect(texts(element)).toContain("canceled");
		expect(() => find(element, "subscription-confirm-payment")).toThrow();
		click(element, "subscription-check-status");
		await flush();
		expect(state.refetch).toHaveBeenCalledOnce();
		expect(state.refresh).not.toHaveBeenCalled();
	});
	it("requires explicit confirmation on a legacy return", async () => {
		const element = render();
		await flush();
		expect(state.refresh).not.toHaveBeenCalled();
		expect(texts(element)).toContain("finishHint");
		click(element, "subscription-confirm-payment");
		await flush();
		expect(state.refresh).toHaveBeenCalledExactlyOnceWith({ checkoutIntentId: "intent" });
	});
	it("waits for a successful state read before finishing an approved return once", async () => {
		state.status = undefined;
		state.isPending = true;
		render({ approved: true });
		await flush();
		expect(state.refresh).not.toHaveBeenCalled();
		state.status = "PENDING";
		state.isPending = false;
		render({ approved: true });
		await flush();
		render({ approved: true });
		await flush();
		expect(state.refresh).toHaveBeenCalledOnce();
	});
	it.each(["REVIEW", "EXPIRED", "CANCELED"])("never activates a %s checkout", async (status) => {
		state.status = status;
		const element = render({ approved: true });
		await flush();
		expect(state.refresh).not.toHaveBeenCalled();
		expect(texts(element)).toContain(status === "REVIEW" ? "review" : "notCompleted");
		expect(texts(element)).not.toContain("completed");
	});
	it("does not use stale pending data when checking payment failed", async () => {
		state.isError = true;
		const element = render({ approved: true });
		await flush();
		expect(state.refresh).not.toHaveBeenCalled();
		expect(texts(element)).toContain("error");
		click(element, "subscription-check-status");
		await flush();
		expect(state.refetch).toHaveBeenCalledOnce();
		expect(state.refresh).not.toHaveBeenCalled();
	});
	it("scopes the query to the signed-in owner and this intent", () => {
		render();
		expect(state.queryOptions).toHaveBeenCalledWith({
			input: { expectedPlanId: "creator", organizationId: undefined, checkoutIntentId: "intent" },
		});
		expect(state.queryOptions).toHaveBeenLastCalledWith(
			expect.objectContaining({
				queryKey: ["subscription-checkout-return", "owner-a", null, "intent", "creator"],
			}),
		);
	});
	it("never equates an existing paid plan with an uncorrelated legacy return", async () => {
		state.status = "ACTIVE";
		const element = render({ approved: true, checkoutIntentId: undefined });
		await flush();
		expect(state.refresh).not.toHaveBeenCalled();
		expect(texts(element)).not.toContain("completed");
		expect(state.replace).not.toHaveBeenCalled();
	});
	it("keeps a pending checkout visible instead of redirecting after a timeout", () => {
		const timeout = vi.spyOn(globalThis, "setTimeout");
		render();
		expect(timeout).not.toHaveBeenCalled();
		expect(state.replace).not.toHaveBeenCalled();
	});
	it("ignores an old owner's unfinished confirmation response", async () => {
		let resolve!: (value: unknown) => void;
		state.refresh.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		render({ approved: true });
		state.ownerId = "owner-b";
		state.status = undefined;
		state.isPending = true;
		render({ approved: true });
		resolve({ status: "PAID" });
		await flush();
		expect(state.refetch).not.toHaveBeenCalled();
		expect(state.activated).not.toHaveBeenCalled();
	});
	it("shows server-confirmed completion without forcing navigation", () => {
		state.status = "ACTIVE";
		const element = render();
		expect(texts(element)).toContain("completed");
		expect(state.replace).not.toHaveBeenCalled();
		expect(find(element, "subscription-continue")).toBeTruthy();
		expect(state.activated).toHaveBeenCalledExactlyOnceWith("creator");
		render();
		expect(state.activated).toHaveBeenCalledOnce();
	});
	it("describes past-due access without claiming a new subscription activation", () => {
		state.status = "PAST_DUE";
		const element = render();
		expect(texts(element)).toContain("pastDue");
		expect(texts(element)).not.toContain("completed");
		expect(state.activated).not.toHaveBeenCalled();
	});
	it.each(["ACTIVE", "PAST_DUE"])(
		"replaces an uncertain finish error with the later %s result",
		async (status) => {
			state.refresh.mockRejectedValueOnce(new Error("response lost"));
			render({ approved: true });
			await flush();
			state.status = status;
			const element = render({ approved: true });
			expect(texts(element)).toContain(status === "ACTIVE" ? "completed" : "pastDue");
			expect(texts(element)).not.toContain("error");
		},
	);
	it.each(["ACTIVE", "PAST_DUE"])(
		"does not present stale %s data after a failed state read",
		(status) => {
			state.status = status;
			state.isError = true;
			const element = render({ approved: true });
			expect(texts(element)).toContain("error");
			expect(texts(element)).not.toContain("completed");
			expect(texts(element)).not.toContain("pastDue");
			expect(state.activated).not.toHaveBeenCalled();
		},
	);
});
