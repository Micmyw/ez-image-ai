import React, { type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	ownerId: "owner-a",
	orgId: null as string | null,
	data: { status: "PENDING", provider: "paypal", amount: "15.00", currency: "USD" } as
		| { status: string; provider: string; amount: string; currency: string }
		| undefined,
	isPending: false,
	isError: false,
	cursor: 0,
	slots: [] as {
		current?: unknown;
		value?: unknown;
		deps?: unknown[];
		cleanup?: () => void;
		effect?: () => void | (() => void);
	}[],
	capture: vi.fn(),
	refetch: vi.fn(),
	replace: vi.fn(),
	consumeReturn: vi.fn(),
	query: vi.fn(),
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
		state.slots[index] = { deps, effect, cleanup: effect() || undefined };
	},
}));
vi.mock("@auth/lib/api", () => ({
	useSessionQuery: () => ({
		data: {
			user: { id: state.ownerId, isAnonymous: false },
			session: { activeOrganizationId: state.orgId },
		},
		isPending: false,
	}),
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, string>) =>
		key + (values ? ` ${values.currency} ${values.amount}` : ""),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: state.replace }) }));
vi.mock("../../video-effects/lib/payment-return", () => ({
	consumeVideoEffectPaymentReturn: state.consumeReturn,
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		payments: {
			capturePayPalCreditPackCheckout: { mutationOptions: () => ({}) },
			getCreditPackCheckoutState: { queryOptions: () => ({}) },
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useMutation: () => ({ mutateAsync: state.capture, isPending: false }),
	useQuery: (options: unknown) => {
		state.query(options);
		return {
			data: state.data,
			isPending: state.isPending,
			isError: state.isError,
			isSuccess: !state.isPending && !state.isError && Boolean(state.data),
			refetch: state.refetch,
		};
	},
}));
import { CreditPackCheckoutReturnContent } from "./CreditPackCheckoutReturnContent";
function render(
	props: { intentId?: string; providerOrderId?: string; canceled?: boolean; approved?: boolean } = {
		providerOrderId: "order",
		approved: true,
	},
) {
	state.cursor = 0;
	return CreditPackCheckoutReturnContent({ intentId: "intent", ...props });
}
function text(node: React.ReactNode): string {
	if (typeof node === "string") return node;
	if (!React.isValidElement(node)) return "";
	return React.Children.toArray((node.props as { children?: React.ReactNode }).children)
		.map(text)
		.join(" ");
}
function find(node: ReactElement, id: string): ReactElement {
	if ((node.props as { "data-testid"?: string })["data-testid"] === id) return node;
	for (const child of React.Children.toArray(
		(node.props as { children?: React.ReactNode }).children,
	)) {
		if (!React.isValidElement(child)) continue;
		try {
			return find(child, id);
		} catch {}
	}
	throw new Error(`missing ${id}`);
}
async function flush() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}
beforeEach(() => {
	vi.clearAllMocks();
	state.slots = [];
	state.cursor = 0;
	state.ownerId = "owner-a";
	state.orgId = null;
	state.data = { status: "PENDING", provider: "paypal", amount: "15.00", currency: "USD" };
	state.isPending = false;
	state.isError = false;
	state.capture.mockReset().mockResolvedValue({ accepted: true });
	state.refetch.mockResolvedValue({});
	state.consumeReturn.mockReturnValue(null);
	const items = new Map<string, string>();
	const events = new EventTarget();
	vi.stubGlobal("window", {
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
describe("credit pack checkout return boundaries", () => {
	it("slows pending reads and resumes only status checks after manual or foreground recovery", async () => {
		vi.useFakeTimers();
		const element = render({ canceled: true });
		const polling = state.query.mock.lastCall![0].refetchInterval;
		const pending = { state: { status: "success", data: state.data } };
		expect(polling(pending)).toBe(1_500);
		vi.advanceTimersByTime(120_000);
		expect(polling(pending)).toBe(30_000);
		expect(text(render({ canceled: true }))).toContain("pending");
		(find(element, "credit-pack-check-status").props as { onClick: () => void }).onClick();
		expect(polling(pending)).toBe(1_500);
		vi.advanceTimersByTime(120_000);
		window.dispatchEvent(new Event("focus"));
		expect(polling(pending)).toBe(1_500);
		expect(polling({ state: { ...pending.state, status: "error" } })).toBe(false);
		await flush();
		expect(state.refetch).toHaveBeenCalledTimes(2);
		expect(state.capture).not.toHaveBeenCalled();
		expect(state.replace).not.toHaveBeenCalled();
	});

	it("starts a new fast window only for the new owner and intent scope", () => {
		vi.useFakeTimers();
		render({ canceled: true });
		const oldPolling = state.query.mock.lastCall![0].refetchInterval;
		const pending = { state: { status: "success", data: state.data } };
		vi.advanceTimersByTime(120_000);
		state.orgId = "org-b";
		render({ canceled: true });
		const newPolling = state.query.mock.lastCall![0].refetchInterval;
		expect(oldPolling(pending)).toBe(30_000);
		expect(newPolling(pending)).toBe(1_500);
		expect(state.capture).not.toHaveBeenCalled();
	});

	it("waits for successful owner-scoped pending state before automatic capture", async () => {
		state.data = undefined;
		state.isPending = true;
		render();
		await flush();
		expect(state.capture).not.toHaveBeenCalled();
		state.data = { status: "PENDING", provider: "paypal", amount: "15.00", currency: "USD" };
		state.isPending = false;
		render();
		await flush();
		expect(state.capture).toHaveBeenCalledOnce();
		expect(state.capture).toHaveBeenCalledWith({ intentId: "intent", providerOrderId: "order" });
		expect(state.query).toHaveBeenLastCalledWith(
			expect.objectContaining({
				queryKey: ["credit-pack-checkout", "owner-a", null, "intent"],
				enabled: true,
			}),
		);
	});
	it("never captures canceled returns with approval and token, including refresh", async () => {
		const props = { canceled: true, approved: true, providerOrderId: "order" };
		let element = render(props);
		await flush();
		expect(text(element)).toContain("pending");
		(find(element, "credit-pack-check-status").props as { onClick: () => void }).onClick();
		state.slots = [];
		element = render(props);
		await flush();
		expect(state.capture).not.toHaveBeenCalled();
		expect(state.refetch).toHaveBeenCalledOnce();
		expect(state.replace).not.toHaveBeenCalled();
	});
	it("keeps legacy returns read-only until an explicit server-priced confirmation", async () => {
		let element = render({ providerOrderId: "order" });
		await flush();
		expect(state.capture).not.toHaveBeenCalled();
		expect(text(element)).toContain("awaitingConfirmation USD 15.00");
		state.slots = [];
		element = render({ providerOrderId: "order" });
		const confirm = find(element, "credit-pack-confirm-payment");
		expect(text(confirm)).toContain("confirmPayment USD 15.00");
		(confirm.props as { onClick: () => void }).onClick();
		await flush();
		expect(state.capture).toHaveBeenCalledOnce();
		expect(state.replace).not.toHaveBeenCalled();
	});
	it("never captures Waffo even when the URL carries an approval and PayPal-looking token", async () => {
		state.data!.provider = "waffo";
		const element = render();
		await flush();
		expect(text(element)).toContain("pending");
		expect(() => find(element, "credit-pack-confirm-payment")).toThrow();
		expect(state.capture).not.toHaveBeenCalled();
	});
	it("does not capture or infer nonpayment after a state-query error", async () => {
		state.isError = true;
		const element = render();
		await flush();
		expect(text(element)).toContain("error");
		(find(element, "credit-pack-check-status").props as { onClick: () => void }).onClick();
		await flush();
		expect(state.capture).not.toHaveBeenCalled();
		expect(state.refetch).toHaveBeenCalledOnce();
		expect(state.replace).not.toHaveBeenCalled();
	});
	it.each(["REVIEW", "EXPIRED", "CANCELED"])("keeps %s read-only with recovery", async (status) => {
		state.data!.status = status;
		const element = render();
		await flush();
		expect(text(element)).toContain(status === "REVIEW" ? "review" : "notCompleted");
		expect(find(element, "credit-pack-check-status")).toBeTruthy();
		expect(state.capture).not.toHaveBeenCalled();
		expect(state.replace).not.toHaveBeenCalled();
	});
	it("never treats capture acceptance as completed and coalesces repeated returns", async () => {
		render();
		await flush();
		const element = render();
		render();
		await flush();
		expect(state.capture).toHaveBeenCalledOnce();
		expect(text(element)).toContain("pending");
		expect(state.replace).not.toHaveBeenCalled();
	});
	it("retries uncertain capture only through explicit priced confirmation, while check stays read-only", async () => {
		state.capture.mockRejectedValueOnce(new Error("response lost"));
		render();
		await flush();
		const element = render();
		(find(element, "credit-pack-check-status").props as { onClick: () => void }).onClick();
		await flush();
		expect(state.capture).toHaveBeenCalledOnce();
		(find(element, "credit-pack-confirm-payment").props as { onClick: () => void }).onClick();
		await flush();
		expect(state.capture).toHaveBeenCalledTimes(2);
		expect(state.capture.mock.calls[1]![0]).toEqual(state.capture.mock.calls[0]![0]);
	});
	it("ignores old-owner and old-organization in-flight results", async () => {
		let resolve!: (value: unknown) => void;
		state.capture.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		render();
		state.ownerId = "owner-b";
		state.orgId = "org-b";
		state.data = undefined;
		state.isPending = true;
		render();
		resolve({ accepted: true });
		await flush();
		expect(state.refetch).not.toHaveBeenCalled();
		expect(state.replace).not.toHaveBeenCalled();
		expect(state.query).toHaveBeenLastCalledWith(
			expect.objectContaining({ queryKey: ["credit-pack-checkout", "owner-b", "org-b", "intent"] }),
		);
	});
	it("survives StrictMode effect cleanup/setup without repeating capture", async () => {
		let resolve!: (value: unknown) => void;
		state.capture.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		render();
		for (const slot of state.slots) slot.cleanup?.();
		for (const slot of state.slots) if (slot.effect) slot.cleanup = slot.effect() || undefined;
		resolve({ accepted: true });
		await flush();
		expect(state.capture).toHaveBeenCalledOnce();
		expect(state.refetch).toHaveBeenCalledOnce();
	});
	it("preserves a video-effect destination only after trusted completion", () => {
		state.data!.status = "COMPLETED";
		state.consumeReturn.mockReturnValue("/video/effects/raindance");
		render({ canceled: true, providerOrderId: "order" });
		expect(state.capture).not.toHaveBeenCalled();
		expect(state.consumeReturn).toHaveBeenCalledWith("owner-a", "intent");
		expect(state.replace).toHaveBeenCalledWith("/video/effects/raindance");
	});
	it("uses the editor fallback on server completion", () => {
		state.data!.status = "COMPLETED";
		render();
		expect(state.replace).toHaveBeenCalledWith("/create?credits=purchased");
		expect(state.capture).not.toHaveBeenCalled();
	});
	it("shows successful completion after a lost capture response is settled by GET", async () => {
		state.capture.mockRejectedValueOnce(new Error("response lost"));
		render();
		await flush();
		expect(text(render())).toContain("error");
		state.data!.status = "COMPLETED";
		const element = render();
		expect(text(element)).toContain("completed");
		expect(text(element)).not.toContain("error");
		expect(state.replace).toHaveBeenCalledWith("/create?credits=purchased");
	});
	it("does not treat stale completed data as success after a GET error", () => {
		state.data!.status = "COMPLETED";
		state.isError = true;
		const element = render();
		expect(text(element)).toContain("error");
		expect(text(element)).not.toContain("completed");
		expect(state.replace).not.toHaveBeenCalled();
	});
});
