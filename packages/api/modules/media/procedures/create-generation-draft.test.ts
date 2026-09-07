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
	productKey: "image-gpt-image-2",
	input: {
		kind: "image-to-image",
		prompt: "  Replace the background  ",
		skuKey: "gpt-image-2-2k",
		aspectRatio: "1:1",
	},
	upload: { contentType: "image/png", base64: "c291cmNl" },
} as const;

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://app.test");
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
	it("accepts all 20 current product-owned SKUs and their cell controls", () => {
		expect(inputSchema).toBeDefined();
		if (!inputSchema) return;

		for (const [productKey, skuKey, aspectRatio, controls] of [
			["image-nano-banana-2-lite", "nano-banana-2-lite-1k", "auto", {}],
			["image-nano-banana", "nano-banana-default", "1:1", { outputFormat: "jpeg" }],
			["image-nano-banana-2", "nano-banana-2-1k", "5:4", { outputFormat: "png" }],
			["image-nano-banana-2", "nano-banana-2-2k", "5:4", { outputFormat: "jpeg" }],
			["image-nano-banana-2", "nano-banana-2-4k", "5:4", { outputFormat: "png" }],
			["image-nano-banana-pro", "nano-banana-pro-1k", "4:5", { outputFormat: "jpeg" }],
			["image-nano-banana-pro", "nano-banana-pro-2k", "4:5", { outputFormat: "png" }],
			["image-nano-banana-pro", "nano-banana-pro-4k", "4:5", { outputFormat: "jpeg" }],
			["image-gpt-image-1-5", "gpt-image-1-5-medium", "2:3", {}],
			["image-gpt-image-1-5", "gpt-image-1-5-high", "3:2", {}],
			["image-gpt-image-2", "gpt-image-2-1k", "5:4", { background: "transparent" }],
			["image-gpt-image-2", "gpt-image-2-2k", "1:1", {}],
			["image-gpt-image-2", "gpt-image-2-4k", "5:4", {}],
			["image-seedream-4-5", "seedream-4-5-basic-2k", "16:9", {}],
			["image-seedream-4-5", "seedream-4-5-high-4k", "9:16", {}],
			["image-seedream-5-lite", "seedream-5-lite-basic-2k", "21:9", { outputFormat: "png" }],
			["image-seedream-5-lite", "seedream-5-lite-high-3k", "21:9", { outputFormat: "jpeg" }],
			["image-seedream-5-lite", "seedream-5-lite-ultra-4k", "21:9", { outputFormat: "png" }],
			["image-seedream-5-pro", "seedream-5-pro-basic-1k", "3:2", { outputFormat: "jpeg" }],
			["image-seedream-5-pro", "seedream-5-pro-high-2k", "3:2", { outputFormat: "png" }],
		] as const) {
			const result = inputSchema.safeParse({
				...validDraft,
				productKey,
				input: { ...validDraft.input, skuKey, aspectRatio, ...controls },
			});
			expect(result.success).toBe(true);
			expect(result.data).toEqual({
				...validDraft,
				productKey,
				input: {
					kind: "image-to-image",
					prompt: "Replace the background",
					skuKey,
					aspectRatio,
					...controls,
				},
			});
		}
	});

	it.each([
		[
			"a SKU borrowed from another product",
			{
				...validDraft,
				productKey: "image-nano-banana",
				input: { ...validDraft.input, skuKey: "gpt-image-2-1k" },
			},
		],
		[
			"an aspect ratio outside the selected cell",
			{
				...validDraft,
				input: { ...validDraft.input, skuKey: "gpt-image-2-4k", aspectRatio: "1:1" },
			},
		],
		[
			"a globally valid control unsupported by the selected cell",
			{
				...validDraft,
				input: { ...validDraft.input, background: "transparent" },
			},
		],
	] as const)("rejects %s in the public input schema", (_label, input) => {
		expect(inputSchema?.safeParse(input).success).toBe(false);
	});

	it.each([
		["a text-to-image request", { ...validDraft, input: { kind: "text-to-image", prompt: "x" } }],
		["a missing upload", { productKey: validDraft.productKey, input: validDraft.input }],
		["a legacy product", { ...validDraft, productKey: "image-fast" }],
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
				headers: new Headers({ origin: "https://app.test" }),
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

	it("rejects a SKU borrowed from another model before storage", async () => {
		const context = {
			context: {
				headers: new Headers({ origin: "https://app.test" }),
				responseHeaders: new Headers(),
			},
		};

		await expect(
			call(
				draftProcedureModule.createGenerationDraft,
				{
					...validDraft,
					input: { ...validDraft.input, skuKey: "nano-banana-2-lite-1k" },
				},
				context,
			),
		).rejects.toThrow("Input validation failed");
		expect(putPrivateMediaObject).not.toHaveBeenCalled();
		expect(createGenerationDraftTransaction).not.toHaveBeenCalled();
	});
});
