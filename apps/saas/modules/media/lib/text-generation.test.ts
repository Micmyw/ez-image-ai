import { describe, expect, it } from "vitest";

import { readEditorUpgradeDraft, writeEditorUpgradeDraft } from "../../payments/lib/editor-upgrade";
import { resolveEditorRecovery } from "./editor-recovery.server";
import { buildGenerationInput, generationFormValuesSchema } from "./form-schema";

const input = {
	kind: "text-to-image" as const,
	prompt: "An architectural photograph in warm light",
	skuKey: "gpt-image-2-1k" as const,
	aspectRatio: "1:1" as const,
};
const draft = { productKey: "image-gpt-image-2" as const, input };
describe("source-free creator workflow", () => {
	it("validates and builds a prompt-only request without manufacturing a source", () => {
		expect(
			generationFormValuesSchema.safeParse({
				productKey: draft.productKey,
				sourceAssetId: "",
				...input,
			}).success,
		).toBe(true);
		expect(buildGenerationInput(input)).toEqual(input);
	});
	it("restores a text generation from owner-scoped history without source verification", () => {
		expect(
			resolveEditorRecovery({
				requested: true,
				candidate: draft,
				sourceAsset: null,
				allowedProductKeys: [draft.productKey],
			}),
		).toMatchObject({ initialDraft: draft, restoreState: "ready", notice: null });
	});
	it("retains a text draft across sign-in or upgrade in the existing bounded browser store", () => {
		const data = new Map<string, string>();
		const storage = {
			getItem: (key: string) => data.get(key) ?? null,
			setItem: (key: string, value: string) => data.set(key, value),
			removeItem: (key: string) => data.delete(key),
		};
		expect(writeEditorUpgradeDraft(storage, { draft, parentJobId: null, sourceReady: false })).toBe(
			true,
		);
		expect(readEditorUpgradeDraft(storage)?.draft).toEqual(draft);
	});
});
