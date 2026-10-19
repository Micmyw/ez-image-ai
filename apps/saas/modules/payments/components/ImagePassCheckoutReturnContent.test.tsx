import React, { type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	ownerId: "owner-a",
	status: "PENDING",
	cursor: 0,
	slots: [] as { current?: unknown; value?: unknown; deps?: unknown[] }[],
	capture: vi.fn(),
	refetch: vi.fn(),
	invalidate: vi.fn(),
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
	useEffect: (effect: () => void, deps: unknown[]) => {
		const index = state.cursor++,
			prior = state.slots[index];
		if (prior?.deps && deps.every((value, i) => value === prior.deps![i])) return;
		state.slots[index] = { deps };
		effect();
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
	useQuery: () => ({ data: { status: state.status }, isError: false, refetch: state.refetch }),
	useQueryClient: () => ({ invalidateQueries: state.invalidate }),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
import { ImagePassCheckoutReturnContent } from "./ImagePassCheckoutReturnContent";
function render(providerOrderId: string | undefined = "paypal-token") {
	state.cursor = 0;
	return ImagePassCheckoutReturnContent({ intentId: "intent", providerOrderId });
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
	state.capture.mockReset().mockResolvedValue({ accepted: true, replayed: false });
	state.refetch.mockResolvedValue({});
	state.invalidate.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());
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
	it("refreshes only the owner's pass balance after the server confirms completion", () => {
		state.status = "COMPLETED";
		const element = render(undefined);
		expect(texts(element)).toContain("returnCompleted");
		expect(state.invalidate).toHaveBeenCalledWith({
			queryKey: ["media-image-pass-balance", "owner-a"],
			exact: true,
		});
	});
	it.each(["REVIEW", "EXPIRED", "CANCELED"])("keeps %s out of the fulfilled state", (status) => {
		state.status = status;
		const element = render(undefined);
		expect(texts(element)).toContain("returnReview");
		expect(texts(element)).not.toContain("returnCompleted");
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
});
