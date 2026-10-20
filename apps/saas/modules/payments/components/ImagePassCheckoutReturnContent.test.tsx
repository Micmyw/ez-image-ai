import React, { type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	ownerId: "owner-a",
	status: "PENDING" as string | undefined,
	isError: false,
	isPending: false,
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
	invalidate: vi.fn(),
	queryOptions: vi.fn(),
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
		state.slots[index] = { deps, effect, cleanup: cleanup || undefined };
	},
}));
vi.mock("@auth/lib/api", () => ({
	useSessionQuery: () => ({ data: { user: { id: state.ownerId, isAnonymous: false } } }),
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		payments: {
			capturePayPalImagePassCheckout: { mutationOptions: () => ({}) },
			getImagePassCheckoutState: { queryOptions: () => ({}) },
		},
	},
}));
vi.mock("@tanstack/react-query", async (original) => ({
	...(await original<typeof import("@tanstack/react-query")>()),
	useMutation: () => ({ mutateAsync: state.capture }),
	useQuery: (options: unknown) => {
		state.queryOptions(options);
		return {
			data: state.status ? { status: state.status } : undefined,
			isPending: state.isPending,
			isError: state.isError,
			isSuccess: !state.isPending && !state.isError && Boolean(state.status),
			refetch: state.refetch,
		};
	},
	useQueryClient: () => ({ invalidateQueries: state.invalidate }),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
import { ImagePassCheckoutReturnContent } from "./ImagePassCheckoutReturnContent";
function render(
	options: { providerOrderId?: string; canceled?: boolean; approved?: boolean } = {
		providerOrderId: "paypal-token",
		approved: true,
	},
) {
	state.cursor = 0;
	return ImagePassCheckoutReturnContent({ intentId: "intent", ...options });
}
function texts(root: React.ReactNode): string {
	if (typeof root === "string") return root;
	if (!React.isValidElement(root)) return "";
	return React.Children.toArray((root.props as { children?: React.ReactNode }).children)
		.map(texts)
		.join(" ");
}
function button(root: ReactElement): () => void {
	if (root.type === "button") return (root.props as { onClick: () => void }).onClick;
	for (const child of React.Children.toArray(
		(root.props as { children?: React.ReactNode }).children,
	)) {
		if (!React.isValidElement(child)) continue;
		try {
			return button(child);
		} catch {}
	}
	throw new Error("recovery button missing");
}
async function flush() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}
beforeEach(() => {
	vi.clearAllMocks();
	state.slots = [];
	state.cursor = 0;
	state.ownerId = "owner-a";
	state.status = "PENDING";
	state.isError = false;
	state.isPending = false;
	state.capture.mockReset().mockResolvedValue({ accepted: true, replayed: false });
	state.refetch.mockResolvedValue({});
	state.invalidate.mockResolvedValue(undefined);
	vi.stubGlobal("window", { sessionStorage: new Map() });
});
afterEach(() => {
	for (const slot of state.slots) slot.cleanup?.();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
describe("trusted image pass payment return", () => {
	it("does not treat PayPal return or capture acceptance as fulfilled image passes", async () => {
		render();
		await flush();
		const element = render();
		expect(state.capture).toHaveBeenCalledTimes(1);
		expect(state.capture).toHaveBeenCalledWith({
			intentId: "intent",
			providerOrderId: "paypal-token",
		});
		expect(texts(element)).toContain("returnPending");
		expect(texts(element)).not.toContain("returnCompleted");
		expect(state.invalidate).not.toHaveBeenCalled();
	});
	it("waits for the first successful pending state before capture", async () => {
		state.status = undefined;
		state.isPending = true;
		render();
		await flush();
		expect(state.capture).not.toHaveBeenCalled();
		state.status = "PENDING";
		state.isPending = false;
		render();
		await flush();
		expect(state.capture).toHaveBeenCalledTimes(1);
	});
	it("does not capture on a failed state query, even with stale pending data", async () => {
		state.isError = true;
		const element = render();
		await flush();
		expect(state.capture).not.toHaveBeenCalled();
		expect(texts(element)).toContain("checkoutStatusError");
		button(element)();
		await flush();
		expect(state.refetch).toHaveBeenCalledOnce();
		expect(state.capture).not.toHaveBeenCalled();
	});
	it("never captures a canceled return with a provider token, including refresh and retry", async () => {
		const options = { providerOrderId: "paypal-token", canceled: true };
		const element = render(options);
		await flush();
		expect(texts(element)).toContain("checkoutUnconfirmed");
		button(element)();
		state.slots = [];
		render(options);
		await flush();
		expect(state.capture).not.toHaveBeenCalled();
		expect(state.refetch).toHaveBeenCalledOnce();
		expect(state.invalidate).not.toHaveBeenCalled();
	});
	it("does not recapture on repeated renders after capture acceptance", async () => {
		render();
		await flush();
		render();
		render();
		await flush();
		expect(state.capture).toHaveBeenCalledOnce();
	});
	it("keeps legacy returns read-only until explicit payment confirmation", async () => {
		const options = { providerOrderId: "paypal-token" };
		let element = render(options);
		expect(element.props).toMatchObject({
			"data-testid": "image-pass-checkout-status",
			"data-status": "PENDING",
		});
		await flush();
		expect(state.capture).not.toHaveBeenCalled();
		expect(texts(element)).toContain("returnAwaitingConfirmation");
		state.slots = [];
		element = render(options);
		await flush();
		expect(state.capture).not.toHaveBeenCalled();
		button(element)();
		await flush();
		expect(state.capture).toHaveBeenCalledOnce();
		expect(state.capture).toHaveBeenCalledWith({
			intentId: "intent",
			providerOrderId: "paypal-token",
		});
	});
	it("refreshes only the owner's pass balance after the server confirms completion", () => {
		state.status = "COMPLETED";
		const element = render({ canceled: true, providerOrderId: "paypal-token" });
		expect(texts(element)).toContain("returnCompleted");
		expect(state.capture).not.toHaveBeenCalled();
		expect(state.invalidate).toHaveBeenCalledWith({
			queryKey: ["media-image-pass-balance", "owner-a"],
			exact: true,
		});
	});
	it.each(["REVIEW", "EXPIRED", "CANCELED"])("keeps %s out of the fulfilled state", (status) => {
		state.status = status;
		const element = render();
		expect(texts(element)).toContain(status === "REVIEW" ? "returnReview" : "checkoutNotCompleted");
		expect(texts(element)).not.toContain("returnCompleted");
		expect(state.capture).not.toHaveBeenCalled();
		expect(state.invalidate).not.toHaveBeenCalled();
	});
	it("retries an uncertain capture explicitly with the same intent and provider order", async () => {
		state.capture.mockRejectedValueOnce(new Error("lost response"));
		render();
		await flush();
		button(render())();
		await flush();
		expect(state.capture).toHaveBeenCalledTimes(2);
		expect(state.capture.mock.calls[1]![0]).toEqual(state.capture.mock.calls[0]![0]);
	});
	it("ignores an old owner's capture result after the owner changes", async () => {
		let resolve!: (value: unknown) => void;
		state.capture.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		render();
		state.ownerId = "owner-b";
		state.status = undefined;
		state.isPending = true;
		render();
		resolve({ accepted: true });
		await flush();
		expect(state.capture).toHaveBeenCalledOnce();
		expect(state.refetch).not.toHaveBeenCalled();
		expect(state.invalidate).not.toHaveBeenCalled();
		expect(state.queryOptions).toHaveBeenLastCalledWith(
			expect.objectContaining({ queryKey: ["image-pass-checkout", "owner-b", "intent"] }),
		);
	});
	it("keeps the in-flight capture valid after StrictMode effect cleanup and setup", async () => {
		let resolve!: (value: unknown) => void;
		state.capture.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		render();
		for (const slot of state.slots) slot.cleanup?.();
		for (const slot of state.slots) {
			if (slot.effect) slot.cleanup = slot.effect() || undefined;
		}
		resolve({ accepted: true });
		await flush();
		expect(state.capture).toHaveBeenCalledOnce();
		expect(state.refetch).toHaveBeenCalledOnce();
	});
});
