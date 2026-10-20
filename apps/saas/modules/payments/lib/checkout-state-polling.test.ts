import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createCheckoutStatePolling,
	subscribeToCheckoutForeground,
} from "./checkout-state-polling";

const pending = { state: { status: "success" as const, data: { status: "PENDING" } } };

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("checkout status polling", () => {
	it.each([1_500, 3_000])(
		"reduces %i ms pending reads after two minutes without changing payment state",
		(interval) => {
			const polling = createCheckoutStatePolling(interval);
			expect(polling.refetchInterval(pending)).toBe(interval);
			vi.advanceTimersByTime(119_999);
			expect(polling.refetchInterval(pending)).toBe(interval);
			vi.advanceTimersByTime(1);
			expect(polling.refetchInterval(pending)).toBe(30_000);
			vi.advanceTimersByTime(600_000);
			expect(polling.refetchInterval(pending)).toBe(30_000);
			expect(pending.state.data.status).toBe("PENDING");
			polling.restart();
			expect(polling.refetchInterval(pending)).toBe(interval);
		},
	);

	it("stops automatic reads after a GET error even when pending data remains cached", () => {
		const polling = createCheckoutStatePolling(1_500);
		const error = { state: { ...pending.state, status: "error" as const } };
		expect(polling.refetchInterval(error)).toBe(false);
		polling.restart();
		expect(polling.refetchInterval(error)).toBe(false);
		expect(polling.refetchInterval(pending)).toBe(1_500);
	});

	it.each(["COMPLETED", "REVIEW", "EXPIRED", "CANCELED"])(
		"does not restart automatic reads for server-confirmed %s",
		(status) => {
			const polling = createCheckoutStatePolling(1_500);
			polling.restart();
			expect(polling.refetchInterval({ state: { status: "success", data: { status } } })).toBe(
				false,
			);
		},
	);

	it("keeps the initial status read eligible without assuming a payment outcome", () => {
		const polling = createCheckoutStatePolling(1_500);
		expect(polling.refetchInterval({ state: { status: "pending" } })).toBe(1_500);
		vi.advanceTimersByTime(120_000);
		expect(polling.refetchInterval({ state: { status: "pending" } })).toBe(30_000);
	});

	it("resumes on browser return or visible focus and removes all listeners on cleanup", () => {
		const browser = new EventTarget();
		const page = Object.assign(new EventTarget(), { visibilityState: "hidden" });
		vi.stubGlobal("window", browser);
		vi.stubGlobal("document", page);
		const refresh = vi.fn();
		const cleanup = subscribeToCheckoutForeground(refresh);
		page.dispatchEvent(new Event("visibilitychange"));
		expect(refresh).not.toHaveBeenCalled();
		page.visibilityState = "visible";
		page.dispatchEvent(new Event("visibilitychange"));
		browser.dispatchEvent(new Event("focus"));
		browser.dispatchEvent(new Event("pageshow"));
		expect(refresh).toHaveBeenCalledTimes(3);
		cleanup();
		page.dispatchEvent(new Event("visibilitychange"));
		browser.dispatchEvent(new Event("focus"));
		browser.dispatchEvent(new Event("pageshow"));
		expect(refresh).toHaveBeenCalledTimes(3);
	});
});
