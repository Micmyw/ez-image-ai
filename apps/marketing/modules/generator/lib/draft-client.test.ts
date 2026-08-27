import { afterEach, describe, expect, it, vi } from "vitest";

const guestUploadMocks = vi.hoisted(() => ({
	uploadGuestDraft: vi.fn(),
}));

vi.mock("./guest-upload-client", () => ({
	uploadGuestDraft: guestUploadMocks.uploadGuestDraft,
}));

import {
	createMarketingDraft,
	DRAFT_HANDOFF_INTENT,
	submitMarketingDraftHandoff,
	uploadGuestDraft,
} from "./draft-client";
import * as draftClientModule from "./draft-client";

type MarketingImageEditDraftBuilder = (input: {
	productKey: "image-fast" | "image-quality";
	prompt: string;
	upload?: {
		contentType: "image/jpeg" | "image/png" | "image/webp";
		base64: string;
	};
}) => unknown;

type MarketingImageFileValidator = (
	file: { size: number; type: string },
	maximumBytes: number,
) => void;

describe("signed guest upload facade", () => {
	afterEach(() => vi.clearAllMocks());

	it("exposes the direct private-upload workflow through the draft client", async () => {
		const input = {
			saasUrl: "https://app.example.com",
			capabilityVersion: "guest-v17",
			file: new File([new Uint8Array(8)], "source.png", { type: "image/png" }),
			prompt: "Replace the background",
			turnstileToken: "turnstile-proof",
		};
		const handoff = {
			action: "https://app.example.com/draft/continue",
			claimToken: "a".repeat(43),
		};
		guestUploadMocks.uploadGuestDraft.mockResolvedValue(handoff);

		await expect(uploadGuestDraft(input)).resolves.toEqual(handoff);
		expect(guestUploadMocks.uploadGuestDraft).toHaveBeenCalledWith(input);
	});
});

describe("buildMarketingImageEditDraft", () => {
	it("builds a selected Standard or Quality image-to-image draft with a required upload", () => {
		const buildMarketingImageEditDraft = (
			draftClientModule as typeof draftClientModule & {
				buildMarketingImageEditDraft?: MarketingImageEditDraftBuilder;
			}
		).buildMarketingImageEditDraft;
		const upload = { contentType: "image/png" as const, base64: "c291cmNl" };

		expect(buildMarketingImageEditDraft).toBeTypeOf("function");
		expect(
			buildMarketingImageEditDraft?.({
				productKey: "image-quality",
				prompt: "  Replace the sky  ",
				upload,
			}),
		).toEqual({
			productKey: "image-quality",
			input: { kind: "image-to-image", prompt: "Replace the sky" },
			upload,
		});
		expect(() =>
			buildMarketingImageEditDraft?.({ productKey: "image-fast", prompt: "", upload }),
		).toThrow("PROMPT_REQUIRED");
		expect(() =>
			buildMarketingImageEditDraft?.({
				productKey: "image-fast",
				prompt: "Replace the sky",
			}),
		).toThrow("SOURCE_IMAGE_REQUIRED");
		expect(() =>
			buildMarketingImageEditDraft?.({
				productKey: "video-fast" as never,
				prompt: "Replace the sky",
				upload,
			}),
		).toThrow("PRODUCT_KEY_UNSUPPORTED");
	});
});

describe("validateMarketingImageFile", () => {
	const validateMarketingImageFile = (
		draftClientModule as typeof draftClientModule & {
			validateMarketingImageFile?: MarketingImageFileValidator;
		}
	).validateMarketingImageFile;

	it("accepts JPEG, PNG, and WebP at the configured byte boundary", () => {
		expect(validateMarketingImageFile).toBeTypeOf("function");
		for (const type of ["image/jpeg", "image/png", "image/webp"]) {
			expect(() => validateMarketingImageFile?.({ size: 20, type }, 20)).not.toThrow();
		}
	});

	it("rejects empty, unsupported, and oversized uploads before a draft request", () => {
		expect(() => validateMarketingImageFile?.({ size: 0, type: "image/png" }, 20)).toThrow(
			"SOURCE_IMAGE_EMPTY",
		);
		expect(() => validateMarketingImageFile?.({ size: 10, type: "image/gif" }, 20)).toThrow(
			"SOURCE_IMAGE_TYPE_UNSUPPORTED",
		);
		expect(() => validateMarketingImageFile?.({ size: 21, type: "image/png" }, 20)).toThrow(
			"SOURCE_IMAGE_TOO_LARGE",
		);
	});
});

describe("createMarketingDraft", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("creates an opaque top-level form handoff without credentialed cross-origin fetch", async () => {
		const claimToken = "a".repeat(43);
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ claimToken, continueUrl: "/draft/continue" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const draft = {
			productKey: "image-fast" as const,
			input: { kind: "image-to-image" as const, prompt: "Secret concept" },
			upload: { contentType: "image/webp" as const, base64: "c291cmNl" },
		};
		const result = await createMarketingDraft("https://app.example.com", draft);

		expect(fetchMock).toHaveBeenCalledWith(
			"https://app.example.com/api/media/drafts",
			expect.objectContaining({ method: "POST", credentials: "omit" }),
		);
		const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(request.body).toBeTypeOf("string");
		const requestBody = request.body as string;
		expect(JSON.parse(requestBody)).toEqual(draft);
		expect(requestBody).not.toMatch(/quote|reservation|provider|job/i);
		expect(result).toEqual({
			action: "https://app.example.com/draft/continue",
			claimToken,
		});
		expect(result.action).not.toContain(claimToken);
		expect(result.action).not.toContain("Secret");
	});

	it.each([
		["a failed response", new Response("unavailable", { status: 503 }), "DRAFT_CREATE_FAILED"],
		[
			"an unapproved continuation path",
			new Response(JSON.stringify({ claimToken: "a".repeat(43), continueUrl: "/unexpected" }), {
				status: 200,
			}),
			"INVALID_CONTINUE_URL",
		],
		[
			"a malformed claim token",
			new Response(
				JSON.stringify({ claimToken: "visible-token", continueUrl: "/draft/continue" }),
				{
					status: 200,
				},
			),
			"INVALID_CLAIM_TOKEN",
		],
	])("rejects %s", async (_label, response, errorCode) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

		await expect(
			createMarketingDraft("https://app.example.com", {
				productKey: "image-fast",
				input: { kind: "image-to-image", prompt: "Change the background" },
				upload: { contentType: "image/png", base64: "c291cmNl" },
			}),
		).rejects.toThrow(errorCode);
	});

	it("submits the token in a hidden POST form instead of a URL", () => {
		const submitted = vi.fn();
		const appended: Array<{ name?: string; value?: string; action?: string }> = [];
		const documentRef = {
			body: { append: (value: object) => appended.push(value) },
			createElement: (tag: string) =>
				tag === "form"
					? {
							style: {},
							append: (...values: object[]) => appended.push(...values),
							submit: submitted,
						}
					: {},
		} as unknown as Document;
		const claimToken = "b".repeat(43);

		submitMarketingDraftHandoff(
			{ action: "https://app.example.com/draft/continue", claimToken },
			documentRef,
		);

		expect(submitted).toHaveBeenCalledOnce();
		expect(appended).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "intent", value: DRAFT_HANDOFF_INTENT }),
				expect.objectContaining({ name: "claimToken", value: claimToken }),
				expect.objectContaining({ action: "https://app.example.com/draft/continue" }),
			]),
		);
		expect(appended.find((entry) => entry.action)?.action).not.toContain(claimToken);
	});

	it("carries only consent and the pseudonymous hash across the POST handoff", () => {
		const submitted = vi.fn();
		const appended: Array<{ name?: string; value?: string; action?: string }> = [];
		const anonymousSessionHash =
			"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
		const documentRef = {
			cookie: `consent=true; ezpic_analytics_session=${anonymousSessionHash}`,
			body: { append: (value: object) => appended.push(value) },
			createElement: (tag: string) =>
				tag === "form"
					? {
							style: {},
							append: (...values: object[]) => appended.push(...values),
							submit: submitted,
						}
					: {},
		} as unknown as Document;

		submitMarketingDraftHandoff(
			{
				action: "https://app.example.com/draft/continue",
				claimToken: "b".repeat(43),
			},
			documentRef,
		);

		expect(appended).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "analyticsConsent", value: "true" }),
				expect.objectContaining({ name: "anonymousSessionHash", value: anonymousSessionHash }),
			]),
		);
		expect(JSON.stringify(appended)).not.toMatch(/prompt|email|provider|model|cost|asset|url/i);
	});
});
