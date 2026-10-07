import {
	VIDEO_MODEL_CATALOG,
	getVideoModelOptions,
	videoModelInputSchema,
} from "@repo/config/video-models";
import { describe, expect, it } from "vitest";

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
	it.each(["TIMEOUT", "NETWORK_ERROR", "Request failed"])(
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
