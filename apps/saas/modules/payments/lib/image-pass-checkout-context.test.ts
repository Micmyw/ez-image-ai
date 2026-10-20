import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	clearImagePassCheckoutContext,
	readImagePassCheckoutContext,
	saveImagePassCheckoutContext,
} from "./image-pass-checkout-context";

beforeEach(() => {
	const items = new Map<string, string>();
	vi.stubGlobal("window", {
		sessionStorage: {
			getItem: (key: string) => items.get(key) ?? null,
			setItem: (key: string, value: string) => items.set(key, value),
			removeItem: (key: string) => items.delete(key),
		},
	});
});
afterEach(() => vi.unstubAllGlobals());
describe("owner-scoped image pass checkout recovery", () => {
	it("stores only the pending intent ID for its owner", () => {
		saveImagePassCheckoutContext("owner:a", "intent-1");
		expect(window.sessionStorage.getItem("image-pass-checkout:owner%3Aa")).toBe("intent-1");
		expect(readImagePassCheckoutContext("owner:a")).toBe("intent-1");
		expect(readImagePassCheckoutContext("owner-b")).toBeUndefined();
	});
	it("does not let an older completion erase a newer pending checkout", () => {
		saveImagePassCheckoutContext("owner-a", "intent-2");
		clearImagePassCheckoutContext("owner-a", "intent-1");
		expect(readImagePassCheckoutContext("owner-a")).toBe("intent-2");
		clearImagePassCheckoutContext("owner-a", "intent-2");
		expect(readImagePassCheckoutContext("owner-a")).toBeUndefined();
	});
	it("does not persist IDs outside the status API length bound", () => {
		saveImagePassCheckoutContext("owner-a", "x".repeat(129));
		expect(readImagePassCheckoutContext("owner-a")).toBeUndefined();
		saveImagePassCheckoutContext("owner-a", "");
		expect(readImagePassCheckoutContext("owner-a")).toBeUndefined();
	});
	it("keeps recovery optional when session storage is blocked", () => {
		Object.defineProperty(window, "sessionStorage", {
			get() {
				throw new Error("blocked");
			},
		});
		expect(() => saveImagePassCheckoutContext("owner-a", "intent")).not.toThrow();
		expect(readImagePassCheckoutContext("owner-a")).toBeUndefined();
		expect(() => clearImagePassCheckoutContext("owner-a", "intent")).not.toThrow();
	});
});
