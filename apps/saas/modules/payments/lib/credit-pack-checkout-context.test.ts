import { PUBLIC_CREDIT_PACKS } from "@repo/config/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	clearCreditPackCheckoutContext,
	readCreditPackCheckoutContext,
	saveCreditPackCheckoutContext,
} from "./credit-pack-checkout-context";
const packKey = PUBLIC_CREDIT_PACKS[0]!.packKey;
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
describe("credit pack browser recovery context", () => {
	it("isolates the minimal intent by owner, organization and public pack", () => {
		saveCreditPackCheckoutContext("owner-a", "org-a", packKey, "intent");
		expect(readCreditPackCheckoutContext("owner-a", "org-a", packKey)).toBe("intent");
		expect(readCreditPackCheckoutContext("owner-b", "org-a", packKey)).toBeUndefined();
		expect(readCreditPackCheckoutContext("owner-a", "org-b", packKey)).toBeUndefined();
		expect(readCreditPackCheckoutContext("owner-a", null, packKey)).toBeUndefined();
	});
	it("does not erase a newer intent or another owner's pending context", () => {
		saveCreditPackCheckoutContext("owner-a", null, packKey, "new-intent");
		saveCreditPackCheckoutContext("owner-b", null, packKey, "old-intent");
		clearCreditPackCheckoutContext("owner-a", null, "old-intent");
		expect(readCreditPackCheckoutContext("owner-a", null, packKey)).toBe("new-intent");
		clearCreditPackCheckoutContext("owner-a", null, "new-intent");
		expect(readCreditPackCheckoutContext("owner-a", null, packKey)).toBeUndefined();
		expect(readCreditPackCheckoutContext("owner-b", null, packKey)).toBe("old-intent");
	});
	it("ignores IDs exceeding the status API bound", () => {
		saveCreditPackCheckoutContext("owner-a", null, packKey, "x".repeat(129));
		expect(readCreditPackCheckoutContext("owner-a", null, packKey)).toBeUndefined();
	});
	it("does not make checkout depend on session storage availability", () => {
		Object.defineProperty(window, "sessionStorage", {
			get() {
				throw new Error("blocked");
			},
		});
		expect(() => saveCreditPackCheckoutContext("owner-a", null, packKey, "intent")).not.toThrow();
		expect(readCreditPackCheckoutContext("owner-a", null, packKey)).toBeUndefined();
		expect(() => clearCreditPackCheckoutContext("owner-a", null, "intent")).not.toThrow();
	});
});
