import { describe, expect, it } from "vitest";

import {
	EDITOR_DRAFT_RESUME_PATH,
	EDITOR_UPGRADE_STORAGE_KEY,
	editorContinuePath,
	hasPendingEditorUpgradeDraft,
	readEditorUpgradeDraft,
	writeEditorUpgradeDraft,
} from "./editor-upgrade";

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		removeItem: (key: string) => values.delete(key),
		setItem: (key: string, value: string) => values.set(key, value),
		values,
	};
}

const imagePassDraft = {
	draft: {
		productKey: "image-nano-banana-2" as const,
		input: {
			kind: "image-to-image" as const,
			prompt: "Turn my cat photo into a watercolor poster",
			sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
			skuKey: "nano-banana-2-2k" as const,
			aspectRatio: "1:1" as const,
		},
	},
	parentJobId: null,
	sourceReady: true,
};

describe("Image Pass draft save and restore", () => {
	it("keeps prompt, uploaded source and parameters across the purchase round trip", () => {
		const storage = memoryStorage();
		const now = 1_800_000_000_000;
		expect(writeEditorUpgradeDraft(storage, imagePassDraft, now)).toBe(true);

		// The purchase page and PayPal return page only peek; they never consume the draft.
		expect(hasPendingEditorUpgradeDraft(storage, now + 10 * 60_000)).toBe(true);
		expect(hasPendingEditorUpgradeDraft(storage, now + 20 * 60_000)).toBe(true);
		expect(storage.values.has(EDITOR_UPGRADE_STORAGE_KEY)).toBe(true);

		// The editor resume path consumes it once with everything intact.
		const restored = readEditorUpgradeDraft(storage, now + 25 * 60_000);
		expect(restored?.draft.input).toMatchObject({
			prompt: "Turn my cat photo into a watercolor poster",
			sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
			skuKey: "nano-banana-2-2k",
			aspectRatio: "1:1",
		});
		expect(restored?.draft.productKey).toBe("image-nano-banana-2");
		expect(hasPendingEditorUpgradeDraft(storage, now + 25 * 60_000)).toBe(false);
	});

	it("links back to the resume path only while a usable draft exists", () => {
		const storage = memoryStorage();
		expect(editorContinuePath(storage)).toBe("/create");
		expect(editorContinuePath(null)).toBe("/create");
		writeEditorUpgradeDraft(storage, imagePassDraft);
		expect(editorContinuePath(storage)).toBe(EDITOR_DRAFT_RESUME_PATH);
	});

	it("ignores expired, malformed and unreadable drafts", () => {
		const storage = memoryStorage();
		const now = 1_800_000_000_000;
		writeEditorUpgradeDraft(storage, imagePassDraft, now);
		expect(hasPendingEditorUpgradeDraft(storage, now + 61 * 60_000)).toBe(false);
		storage.setItem(EDITOR_UPGRADE_STORAGE_KEY, "{not json");
		expect(hasPendingEditorUpgradeDraft(storage)).toBe(false);
		expect(
			hasPendingEditorUpgradeDraft({
				getItem: () => {
					throw new Error("SecurityError");
				},
			}),
		).toBe(false);
	});
});
