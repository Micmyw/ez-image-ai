import { describe, expect, it } from "vitest";

import { readEffectGuestDraft, saveEffectGuestDraft } from "./editor-guest-draft";

function memoryStorage() {
	const items = new Map<string, string>();
	return {
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => items.set(key, value),
		removeItem: (key: string) => items.delete(key),
		items,
	};
}
const effect = { id: "1980s-ai-photo" };
const preset = { id: "studio-portrait", version: 1 };
const values = {
	productKey: "image-nano-banana-2-lite" as const,
	skuKey: "nano-banana-2-lite-1k" as const,
	prompt: "My edited portrait prompt",
	aspectRatio: "4:5" as const,
};

describe("guest effect draft continuity", () => {
	it("restores editable text and warns about a lost local reference without storing files or URLs", () => {
		const storage = memoryStorage();
		expect(saveEffectGuestDraft(storage, effect, preset, values, true, 1000)).toBe(true);
		expect(readEffectGuestDraft(storage, effect, preset, 2000)).toMatchObject({
			values,
			hadReference: true,
		});
		const serialized = [...storage.items.values()][0];
		expect(serialized).not.toMatch(/sourceAssetId|base64|https?:|blob:/);
	});
	it("does not restore a different effect, preset, version, or expired draft", () => {
		const storage = memoryStorage();
		saveEffectGuestDraft(storage, effect, preset, values, false, 1000);
		expect(readEffectGuestDraft(storage, { id: "other-effect" }, preset, 2000)).toBeNull();
		expect(
			readEffectGuestDraft(storage, effect, { ...preset, id: "family-snapshot" }, 2000),
		).toBeNull();
		expect(readEffectGuestDraft(storage, effect, { ...preset, version: 2 }, 2000)).toBeNull();
		expect(readEffectGuestDraft(storage, effect, preset, 3_601_001)).toBeNull();
	});
	it("rejects invalid model/SKU pairs and extra private data", () => {
		const storage = memoryStorage();
		expect(
			saveEffectGuestDraft(
				storage,
				effect,
				preset,
				{ ...values, skuKey: "gpt-image-2-4k" },
				false,
				1000,
			),
		).toBe(false);
		const withAsset = { ...values, sourceAssetId: "private-asset" };
		expect(saveEffectGuestDraft(storage, effect, preset, withAsset, false, 1000)).toBe(false);
	});
});
