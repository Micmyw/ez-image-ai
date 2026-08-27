import { call } from "@orpc/server";
import { DEFAULT_PRODUCT_CONFIG } from "@repo/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({ queryRaw: vi.fn() }));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({ createGenerationDraftTransaction: vi.fn() }));
vi.mock("@repo/database/client", () => ({ db: { $queryRaw: databaseMocks.queryRaw } }));
vi.mock("@repo/storage", () => ({
	createAssetObjectKey: vi.fn(),
	deleteObject: vi.fn(),
	putPrivateMediaObject: vi.fn(),
}));

import { createGenerationDraftTransaction } from "@repo/database";
import { createAssetObjectKey, putPrivateMediaObject } from "@repo/storage";

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
} as const;

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("NEXT_PUBLIC_MARKETING_URL", "https://marketing.test");
	vi.stubEnv("BETTER_AUTH_SECRET", "test-draft-secret");
	databaseMocks.queryRaw.mockResolvedValue([{ allowed: true }] as never);
	vi.mocked(createAssetObjectKey).mockReturnValue("drafts/draft_1/asset_1/original.png");
	vi.mocked(putPrivateMediaObject).mockResolvedValue({
		bytes: DEFAULT_PRODUCT_CONFIG.uploadLimits.imageBytes,
		sha256: "a".repeat(64),
	} as never);
	vi.mocked(createGenerationDraftTransaction).mockResolvedValue({
		id: "draft_1",
		expiresAt: new Date("2026-08-25T12:00:00.000Z"),
	} as never);
});

afterEach(() => vi.unstubAllEnvs());

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

	it("enforces the configured decoded-byte boundary before storage or business state", async () => {
		const maximumBytes = DEFAULT_PRODUCT_CONFIG.uploadLimits.imageBytes;
		const context = {
			context: {
				headers: new Headers({ origin: "https://marketing.test" }),
				responseHeaders: new Headers(),
			},
		};
		const boundaryInput = {
			...validDraft,
			upload: {
				...validDraft.upload,
				base64: Buffer.alloc(maximumBytes).toString("base64"),
			},
		};

		await expect(
			call(draftProcedureModule.createGenerationDraft, boundaryInput, context),
		).resolves.toMatchObject({ draftId: "draft_1", guestReady: false });
		expect(databaseMocks.queryRaw).toHaveBeenCalledOnce();
		expect(putPrivateMediaObject).toHaveBeenCalledOnce();
		expect(createGenerationDraftTransaction).toHaveBeenCalledOnce();

		vi.clearAllMocks();
		const oversizedInput = {
			...boundaryInput,
			upload: {
				...boundaryInput.upload,
				base64: Buffer.alloc(maximumBytes + 1).toString("base64"),
			},
		};

		await expect(
			call(draftProcedureModule.createGenerationDraft, oversizedInput, context),
		).rejects.toThrow();
		expect(databaseMocks.queryRaw).not.toHaveBeenCalled();
		expect(putPrivateMediaObject).not.toHaveBeenCalled();
		expect(createGenerationDraftTransaction).not.toHaveBeenCalled();
	});
});
