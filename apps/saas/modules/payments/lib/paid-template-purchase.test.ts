import { describe, expect, it } from "vitest";

import {
	clearPaidTemplatePurchase,
	readPaidTemplatePurchase,
	savePaidTemplatePurchase,
} from "./paid-template-purchase";

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
		removeItem: (key: string) => values.delete(key),
	};
}
const template = { effectId: "sheru-bhai-ai-photo", presetId: "selfie" };

describe("paid template purchase continuation", () => {
	it("retains the chosen checkout only for the matching template and preset, then clears it", () => {
		const storage = memoryStorage();
		expect(savePaidTemplatePurchase(storage, { ...template, purchase: "image-pass" }, 100)).toBe(
			true,
		);
		expect(
			readPaidTemplatePurchase(storage, { ...template, presetId: "transform" }, 200),
		).toBeNull();
		expect(readPaidTemplatePurchase(storage, { ...template, effectId: "another" }, 200)).toBeNull();
		expect(readPaidTemplatePurchase(storage, template, 200)).toBe("image-pass");
		clearPaidTemplatePurchase(storage);
		expect(readPaidTemplatePurchase(storage, template, 200)).toBeNull();
	});
	it("does not send a later visit or a clock-skewed visit into checkout", () => {
		const storage = memoryStorage();
		savePaidTemplatePurchase(storage, { ...template, purchase: "plans" }, 100);
		expect(readPaidTemplatePurchase(storage, template, 100 + 10 * 60_000 + 1)).toBeNull();
		expect(readPaidTemplatePurchase(storage, template, 99)).toBeNull();
	});
	it.each([
		"null",
		"{",
		JSON.stringify({ ...template, savedAt: 1, purchase: "https://untrusted.test" }),
	])("ignores malformed or unsupported intents", (raw) => {
		expect(
			readPaidTemplatePurchase({ getItem: () => raw, setItem() {}, removeItem() {} }, template, 2),
		).toBeNull();
	});
	it("reports unavailable storage so checkout cannot discard the draft", () => {
		const storage = {
			getItem() {
				throw new Error("blocked");
			},
			setItem() {
				throw new Error("blocked");
			},
			removeItem() {
				throw new Error("blocked");
			},
		};
		expect(savePaidTemplatePurchase(storage, { ...template, purchase: "image-pass" })).toBe(false);
		expect(readPaidTemplatePurchase(storage, template)).toBeNull();
		expect(() => clearPaidTemplatePurchase(storage)).not.toThrow();
	});
});
