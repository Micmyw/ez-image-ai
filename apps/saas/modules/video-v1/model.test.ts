import {
	VIDEO_MODEL_CATALOG,
	getVideoModelOptions,
	videoModelInputSchema,
} from "@repo/config/video-models";
import { describe, expect, it } from "vitest";

import * as videoModel from "./model";
import {
	createVideoConfirmation,
	changeVideoDraft,
	initialVideoDraft,
	getVideoErrorKey,
	getVideoFailureRecovery,
	parseVideoConfirmation,
	restoreVideoDraft,
	videoPollInterval,
	validateVideoDraft,
	videoRequestFor,
	type VideoDraft,
} from "./model";

const request = {
	productKey: "video-kling-2-6-v1",
	mode: "text-to-video",
	prompt: "A camera moves over a quiet lake",
	duration: 5,
	resolution: "default",
	sound: false,
	aspectRatio: "16:9",
} as const;
const quote = {
	quoteId: "quote-1",
	credits: "23",
	expiresAt: "2030-01-01T00:00:00.000Z",
	requestFingerprint: "fp",
};

describe("video confirmation identity", () => {
	it("retains a historical Kling 3 image receipt exactly after new framing choices close", () => {
		const frozen = {
			...request,
			productKey: "video-kling-3",
			mode: "image-to-video" as const,
			resolution: "720p",
			aspectRatio: "9:16",
			inputAssetId: "sealed-private",
		};
		const receipt = createVideoConfirmation(frozen, quote, () => "frozen-old-key");
		expect(parseVideoConfirmation(JSON.stringify(receipt))).toEqual(receipt);
	});
	it("keeps one identity across lost responses and reloads", () => {
		const confirmed = createVideoConfirmation(request, quote, () => "same-key");
		expect(parseVideoConfirmation(JSON.stringify(confirmed))).toEqual(confirmed);
		expect(confirmed.input).toEqual({
			quoteId: quote.quoteId,
			idempotencyKey: "same-key",
			request,
		});
	});
	it("rejects malformed or changed persisted identities", () => {
		const confirmed = createVideoConfirmation(request, quote, () => "same-key");
		expect(parseVideoConfirmation("not json")).toBeNull();
		expect(
			parseVideoConfirmation(JSON.stringify({ ...confirmed, fingerprint: "different" })),
		).toBeNull();
		expect(
			parseVideoConfirmation(
				JSON.stringify({
					...confirmed,
					input: { ...confirmed.input, request: { ...request, sound: true } },
				}),
			),
		).toBeNull();
	});
	it("restores every model attribute and the original receipt without normalization", () => {
		for (const model of VIDEO_MODEL_CATALOG.filter((entry) => entry.status === "implemented")) {
			for (const mode of model.modes) {
				const options = getVideoModelOptions(model.productKey, mode);
				const fullRequest = {
					productKey: model.productKey,
					mode,
					prompt: "A camera moves over a quiet lake",
					...options[options.length - 1]!,
					...(mode === "image-to-video" ? { inputAssetId: "immutable-sealed-image" } : {}),
				};
				const confirmation = createVideoConfirmation(fullRequest, quote, () => "original-key");
				expect(parseVideoConfirmation(JSON.stringify(confirmation))).toEqual(confirmation);
			}
		}
	});
	it("keeps a legacy pending receipt unchanged while displaying its original Kling settings", () => {
		const legacy = {
			mode: "image-to-video",
			prompt: "Move slowly",
			duration: 5,
			sound: false,
			inputAssetId: "legacy-sealed-image",
		} as const;
		const receipt = createVideoConfirmation(legacy, quote, () => "original-legacy-key");
		const restored = parseVideoConfirmation(JSON.stringify(receipt));
		expect(restored).toEqual(receipt);
		expect(restoreVideoDraft(restored!.input.request)).toEqual({
			...initialVideoDraft,
			...legacy,
			aspectRatio: "source",
		});
		expect(restored!.input.request).not.toHaveProperty("productKey");
		expect(restored!.input.request).not.toHaveProperty("resolution");
	});
});

describe("video form and observable state", () => {
	it("asks for a description before applying the model length bounds", () => {
		for (const prompt of ["", "  \n\t"]) {
			expect(validateVideoDraft({ ...initialVideoDraft, prompt })).toBe("promptRequired");
		}
	});
	it("identifies the application UTF-16 safety limit as a prompt error", () => {
		const draft = changeVideoDraft(initialVideoDraft, { productKey: "video-seedance-2-5" });
		expect(validateVideoDraft({ ...draft, prompt: "🙂".repeat(5001) })).toBe("promptLength");
	});
	it("derives image mode from a sealed reference and text mode from explicit removal", () => {
		const draft = changeVideoDraft(initialVideoDraft, { inputAssetId: "sealed-reference" });
		expect(draft).toMatchObject({ mode: "image-to-video", aspectRatio: "source" });
		expect(changeVideoDraft(draft, { inputAssetId: null })).toMatchObject({
			mode: "text-to-video",
			inputAssetId: null,
			aspectRatio: "16:9",
		});
	});
	it("retains intended image mode through missing, failed or replaced uploads", () => {
		const intended = changeVideoDraft(initialVideoDraft, {
			mode: "image-to-video",
			inputAssetId: null,
		});
		const edited = changeVideoDraft(intended, { prompt: "Keep my reference intent" });
		expect(edited.mode).toBe("image-to-video");
		expect(validateVideoDraft(edited)).toBe("imageRequired");
		const imageOnly = changeVideoDraft(edited, { productKey: "video-seedance-1-pro-fast" });
		expect(changeVideoDraft(imageOnly, { inputAssetId: null })).toMatchObject({
			productKey: "video-seedance-1-pro-fast",
			mode: "image-to-video",
			inputAssetId: null,
		});
	});
	it("reads upfront credits only from the exact available server selection with no prompt", () => {
		const catalog = {
			accessAllowed: true,
			models: [
				{
					productKey: initialVideoDraft.productKey,
					available: true,
					options: [
						{
							mode: "text-to-video" as const,
							duration: 5,
							resolution: "default",
							sound: false,
							available: true,
							credits: "98765432101234567890",
						},
						{
							mode: "text-to-video" as const,
							duration: 10,
							resolution: "default",
							sound: false,
							available: true,
							credits: "41",
						},
					],
				},
			],
		};
		expect(videoModel.videoSelectionCredits?.(initialVideoDraft, catalog)).toBe(
			"98765432101234567890",
		);
		expect(
			videoModel.videoSelectionCredits?.({ ...initialVideoDraft, duration: 10 }, catalog),
		).toBe("41");
		expect(
			videoModel.videoSelectionCredits?.({ ...initialVideoDraft, aspectRatio: "9:16" }, catalog),
		).toBe("98765432101234567890");
		for (const draft of [
			{ ...initialVideoDraft, sound: true },
			{ ...initialVideoDraft, aspectRatio: "invalid" },
			{ ...initialVideoDraft, resolution: "4k" },
		])
			expect(videoModel.videoSelectionCredits?.(draft, catalog)).toBeNull();
		expect(
			videoModel.videoSelectionCredits?.(initialVideoDraft, { ...catalog, accessAllowed: false }),
		).toBeNull();
		catalog.models[0]!.options[0]!.available = false;
		expect(videoModel.videoSelectionCredits?.(initialVideoDraft, catalog)).toBeNull();
	});
	it("summarizes continuous durations as a range and discrete durations without invented values", () => {
		expect(videoModel.summarizeVideoDurations?.([5, 10, 5])).toEqual({
			kind: "list",
			values: [5, 10],
		});
		expect(videoModel.summarizeVideoDurations?.([4, 6, 8, 10])).toEqual({
			kind: "list",
			values: [4, 6, 8, 10],
		});
		expect(videoModel.summarizeVideoDurations?.([4, 5, 6])).toEqual({
			kind: "range",
			min: 4,
			max: 6,
		});
	});
	it("counts Unicode code points and requires one sealed image for image mode", () => {
		expect(
			validateVideoDraft({
				...initialVideoDraft,
				mode: "text-to-video",
				prompt: "🙂".repeat(1000),
				aspectRatio: "16:9",
				inputAssetId: null,
			}),
		).toBeNull();
		expect(
			validateVideoDraft({
				...initialVideoDraft,
				mode: "text-to-video",
				prompt: "🙂".repeat(1001),
				aspectRatio: "16:9",
				inputAssetId: null,
			}),
		).toBe("promptLength");
		expect(
			validateVideoDraft({
				...initialVideoDraft,
				mode: "image-to-video",
				prompt: "Move slowly",
				aspectRatio: "16:9",
				inputAssetId: null,
			}),
		).toBe("imageRequired");
	});
	it("keeps only legal complete tuples when changing a model or input mode", () => {
		let draft: VideoDraft = {
			...initialVideoDraft,
			prompt: "Move slowly",
			inputAssetId: "sealed-image",
		};
		draft = changeVideoDraft(draft, { productKey: "video-seedance-1-pro-fast" });
		expect(draft.mode).toBe("image-to-video");
		expect(draft.aspectRatio).toBe("source");
		expect(draft.sound).toBe(false);
		expect(videoModelInputSchema.safeParse(videoRequestFor(draft)).success).toBe(true);
		draft = changeVideoDraft(draft, { productKey: "video-minimax-h3", duration: 15 });
		expect(draft.duration).toBe(15);
		expect(draft.sound).toBe(true);
		expect(videoModelInputSchema.safeParse(videoRequestFor(draft)).success).toBe(true);
		expect(changeVideoDraft(draft, { productKey: "video-minimax-h3-max" })).toEqual(draft);
	});
	it("stops polling hidden and terminal tasks without driving server execution", () => {
		expect(videoPollInterval("GENERATING", true)).toBe(2000);
		expect(videoPollInterval("SUBMISSION_UNCERTAIN", true)).toBe(2000);
		for (const stage of ["READY", "REJECTED", "FAILED"] as const)
			expect(videoPollInterval(stage, true)).toBe(false);
		expect(videoPollInterval("GENERATING", false)).toBe(false);
	});
	it("provides safe actionable errors without rendering provider payloads", () => {
		expect(getVideoErrorKey({ code: "CONFLICT", message: "IDEMPOTENCY_CONFLICT" })).toBe(
			"conflict",
		);
		expect(getVideoErrorKey({ message: "QUOTE_EXPIRED" })).toBe("quoteExpired");
		expect(getVideoErrorKey({ message: "INSUFFICIENT_CREDITS" })).toBe("insufficientCredits");
		expect(
			getVideoErrorKey({ message: "secret provider error https://private.example/token" }),
		).toBe("unavailable");
	});
	it.each(["code", "data", "message"] as const)(
		"requires a new quote for PRICE_CHANGED reported through %s",
		(field) => {
			const error =
				field === "data" ? { data: { code: "PRICE_CHANGED" } } : { [field]: "PRICE_CHANGED" };
			expect(getVideoErrorKey(error)).toBe("quoteExpired");
		},
	);
	it.each(["VIDEO_MODEL_PRICE_EXPIRED", "VIDEO_PRICE_EXPIRED"])(
		"identifies %s as price unavailable rather than an uncertain request",
		(code) => {
			expect(getVideoErrorKey({ code })).toBe("priceUnavailable");
			expect(getVideoErrorKey({ data: { code } })).toBe("priceUnavailable");
			expect(getVideoErrorKey({ message: code })).toBe("priceUnavailable");
		},
	);
	it.each(["PRICE_CHANGED", "VIDEO_MODEL_PRICE_EXPIRED", "VIDEO_PRICE_EXPIRED"])(
		"clears a definitively rejected quote and refreshes prices after %s",
		(code) => {
			expect(getVideoFailureRecovery({ code })).toMatchObject({
				clearQuote: true,
				refreshCatalog: true,
			});
		},
	);
	it.each([
		"INSUFFICIENT_CREDITS",
		"CREDIT_DEBT_OUTSTANDING",
		"VIDEO_OWNER_BUSY",
		"VIDEO_GLOBAL_BUSY",
		"VIDEO_PROVIDER_BUSY",
	])("unlocks editing after the known pre-enqueue rejection %s", (code) =>
		expect(getVideoFailureRecovery({ message: code }).clearQuote).toBe(true),
	);
	it.each(["code", "data", "message"] as const)(
		"normalizes editable settings only after a definitive option rejection through %s",
		(field) => {
			const code = "VIDEO_MODEL_OPTION_UNAVAILABLE";
			const error = field === "data" ? { code: "BAD_REQUEST", data: { code } } : { [field]: code };
			expect(getVideoFailureRecovery(error)).toMatchObject({
				reason: "unsupportedSelection",
				clearQuote: true,
				refreshCatalog: true,
				normalizeDraft: true,
			});
		},
	);
	it.each([
		"BAD_REQUEST",
		"VIDEO_MODEL_UNAVAILABLE",
		"Failed to read VIDEO_MODEL_OPTION_UNAVAILABLE",
	])("does not treat an ambiguous %s message as a definitive option rejection", (message) => {
		const recovery = getVideoFailureRecovery({ message });
		expect(recovery).toMatchObject({ clearQuote: false, refreshCatalog: false });
		expect(recovery).not.toMatchObject({ normalizeDraft: true });
	});
	it.each(["TIMEOUT", "NETWORK_ERROR", "Request failed", "TOO_MANY_REQUESTS", "CAPACITY"])(
		"preserves the original confirmation for an uncertain %s response",
		(message) => {
			const confirmation = createVideoConfirmation(request, quote, () => "original-key");
			expect(getVideoFailureRecovery({ message })).toMatchObject({
				clearQuote: false,
				refreshCatalog: false,
			});
			expect(parseVideoConfirmation(JSON.stringify(confirmation))?.input).toEqual({
				quoteId: quote.quoteId,
				idempotencyKey: "original-key",
				request,
			});
		},
	);
});
