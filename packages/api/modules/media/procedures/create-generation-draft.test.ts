import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({ createGenerationDraftTransaction: vi.fn() }));
vi.mock("@repo/database/client", () => ({ db: { $queryRaw: vi.fn() } }));
vi.mock("@repo/storage", () => ({
	createAssetObjectKey: vi.fn(),
	deleteObject: vi.fn(),
	putPrivateMediaObject: vi.fn(),
}));

import * as draftProcedureModule from "./create-generation-draft";

interface InputSchema {
	safeParse: (input: unknown) => { success: boolean; data?: unknown };
}

const inputSchema = (
	draftProcedureModule as typeof draftProcedureModule & {
		marketingGenerationDraftInputSchema?: InputSchema;
	}
).marketingGenerationDraftInputSchema;

const validDraft = {
	productKey: "image-quality",
	input: { kind: "image-to-image", prompt: "  Replace the background  " },
	upload: { contentType: "image/png", base64: "c291cmNl" },
};

describe("marketing generation draft input", () => {
	it("accepts the pre-asset image-to-image shape for Standard and Quality", () => {
		expect(inputSchema).toBeDefined();
		if (!inputSchema) return;

		for (const productKey of ["image-fast", "image-quality"]) {
			const result = inputSchema.safeParse({ ...validDraft, productKey });
			expect(result.success).toBe(true);
			expect(result.data).toEqual({
				...validDraft,
				productKey,
				input: { kind: "image-to-image", prompt: "Replace the background" },
			});
		}
	});

	it.each([
		["a text-to-image request", { ...validDraft, input: { kind: "text-to-image", prompt: "x" } }],
		["a missing upload", { productKey: "image-fast", input: validDraft.input }],
		["a video product", { ...validDraft, productKey: "video-fast" }],
		["a Provider field", { ...validDraft, provider: "replicate" }],
	])("rejects %s before creating storage or business state", (_label, input) => {
		expect(inputSchema).toBeDefined();
		if (!inputSchema) return;
		expect(inputSchema.safeParse(input).success).toBe(false);
	});
});
