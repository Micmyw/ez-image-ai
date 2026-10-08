import {
	getVideoModel,
	getVideoModelOptions,
	getVideoVariantGroup,
	validateVideoModelSelection,
	videoModelInputSchema,
	type VideoModelInput,
	type VideoModelSelection,
} from "@repo/config/video-models";
import type { VideoRetailDisplay } from "@repo/config/video-pricing.server";
import { videoV1ReceiptInputSchema } from "@repo/config/video-v1";

import type { VideoCreateInput, VideoQuote, VideoRequest, VideoState } from "./api";

export type VideoDraft = VideoModelSelection & {
	prompt: string;
	inputAssetId: string | null;
	/** UI preference only; never included in a quote or receipt. */
	variantSelections?: Record<string, { base: string; selected: string }>;
};
export type VideoErrorKey =
	| "promptRequired"
	| "promptLength"
	| "imageRequired"
	| "invalidImage"
	| "imageTooLarge"
	| "upload"
	| "quoteExpired"
	| "priceUnavailable"
	| "conflict"
	| "insufficientCredits"
	| "busy"
	| "disabled"
	| "unauthorized"
	| "network"
	| "unsupportedSelection"
	| "unavailable";
export type VideoConfirmation = {
	version: 1;
	fingerprint: string;
	quote: VideoQuote;
	input: VideoCreateInput;
};

export const initialVideoDraft: VideoDraft = {
	productKey: "video-kling-2-6-v1",
	mode: "text-to-video",
	prompt: "",
	duration: 5,
	resolution: "default",
	aspectRatio: "16:9",
	sound: false,
	inputAssetId: null,
};

/** Retain compatible choices and resolve coupled model capabilities as one legal tuple. */
function normalizeVideoDraft(current: VideoDraft, patch: Partial<VideoDraft>): VideoDraft {
	const next = { ...current, ...patch };
	const model = getVideoModel(next.productKey);
	if (!model || model.status !== "implemented") return current;
	// Mode also records missing-reference intent while an upload is pending or failed.
	// Only explicit removal clears that intent; unrelated edits must never fall back to text.
	if (next.inputAssetId) next.mode = "image-to-video";
	else if ("inputAssetId" in patch && !("mode" in patch)) next.mode = "text-to-video";
	if (!model.modes.includes(next.mode)) next.mode = model.modes[0]!;
	if (next.productKey !== "video-veo-3-1") delete next.veoTier;
	else if (next.veoTier === undefined)
		next.veoTier = current.productKey === next.productKey ? "fast" : "lite";
	let options = getVideoModelOptions(next.productKey, next.mode);
	if (
		next.productKey !== current.productKey &&
		!options.some((option) => option.duration === next.duration)
	)
		next.duration = model.defaults[next.mode]!.duration;
	const keys = ["veoTier", "duration", "resolution", "aspectRatio", "sound"] as const;
	const priority = [
		...keys.filter((key) => key in patch),
		...keys.filter((key) => !(key in patch)),
	];
	for (const key of priority) {
		const compatible = options.filter((option) => option[key] === next[key]);
		if (compatible.length) options = compatible;
	}
	return options[0] ? { ...next, ...options[0] } : current;
}

function selectedVariant(draft: VideoDraft) {
	return getVideoVariantGroup(draft.productKey)?.variants.find((variant) =>
		Object.entries(variant.selection).every(
			([key, value]) => draft[key as keyof VideoDraft] === value,
		),
	);
}

function baseVariant(draft: VideoDraft, catalog?: SelectionCatalog) {
	const group = getVideoVariantGroup(draft.productKey);
	if (!group) return undefined;
	const candidates = group.variants
		.map((variant) => ({ variant, draft: normalizeVideoDraft(draft, variant.selection) }))
		.filter((entry) =>
			["mode", "duration", "resolution", "aspectRatio", "sound"].every(
				(key) => entry.draft[key as keyof VideoDraft] === draft[key as keyof VideoDraft],
			),
		);
	const available = candidates.flatMap((entry) => {
		const credits = videoSelectionCredits(entry.draft, catalog);
		return credits ? [{ ...entry, credits: BigInt(credits) }] : [];
	});
	available.sort((a, b) => (a.credits < b.credits ? -1 : a.credits > b.credits ? 1 : 0));
	return available[0]?.variant ?? candidates[0]?.variant ?? selectedVariant(draft);
}

export function changeVideoDraft(
	current: VideoDraft,
	patch: Partial<VideoDraft>,
	catalog?: SelectionCatalog,
): VideoDraft {
	let next = normalizeVideoDraft(current, patch);
	const group = getVideoVariantGroup(next.productKey);
	if (!group) return next;
	const preferences = { ...current.variantSelections, ...patch.variantSelections };
	let preference = preferences[group.id];
	if ("productKey" in patch && !("variantSelections" in patch)) {
		const chosen =
			group.variants.find((variant) => variant.id === preference?.selected) ??
			baseVariant(next, catalog);
		if (chosen) {
			next = normalizeVideoDraft(next, chosen.selection);
			preference ??= { base: chosen.id, selected: chosen.id };
		}
	}
	const selected = selectedVariant(next);
	if (selected)
		preferences[group.id] = {
			base: preference?.base ?? baseVariant(next, catalog)?.id ?? selected.id,
			selected: selected.id,
		};
	return { ...next, variantSelections: preferences };
}

export function videoVariantControls(draft: VideoDraft, catalog?: SelectionCatalog) {
	const group = getVideoVariantGroup(draft.productKey);
	if (!group) return null;
	const current =
		selectedVariant(draft) ??
		(draft.productKey === "video-veo-3-1"
			? group.variants.find((variant) => variant.id === "fast")
			: undefined);
	const base =
		group.variants.find((variant) => variant.id === draft.variantSelections?.[group.id]?.base) ??
		baseVariant(draft, catalog) ??
		group.variants[0]!;
	return {
		group,
		current,
		base,
		alternatives: group.variants
			.filter((variant) => variant.id !== base.id)
			.map((variant) => {
				const target = current?.id === variant.id ? base : variant;
				const next = normalizeVideoDraft(draft, target.selection);
				return {
					...variant,
					pressed: current?.id === variant.id,
					credits: videoSelectionCredits(next, catalog),
					patch: {
						...next,
						variantSelections: {
							...draft.variantSelections,
							[group.id]: { base: base.id, selected: target.id },
						},
					},
				};
			}),
	};
}

export function validateVideoDraft(draft: VideoDraft): VideoErrorKey | null {
	const model = getVideoModel(draft.productKey);
	if (!model || model.status !== "implemented") return "unsupportedSelection";
	const length = Array.from(draft.prompt.trim()).length;
	if (!length) return "promptRequired";
	if (
		length < model.minPromptCodePoints ||
		length > model.maxPromptCodePoints ||
		draft.prompt.trim().length > 10000
	)
		return "promptLength";
	if (draft.mode === "image-to-video" && !draft.inputAssetId) return "imageRequired";
	if (!videoModelInputSchema.safeParse(videoRequestFor(draft)).success)
		return "unsupportedSelection";
	return null;
}

export type SelectionCatalog = {
	accessAllowed: boolean;
	models: readonly {
		productKey: string;
		available: boolean;
		options: readonly {
			mode: VideoDraft["mode"];
			duration: number;
			resolution: string;
			sound: boolean;
			veoTier?: VideoDraft["veoTier"];
			available: boolean;
			credits: string | null;
			pricing?: VideoRetailDisplay | null;
		}[];
	}[];
};

/** The protected catalog owns pricing. Prompt and ratio do not alter its retail tuple. */
export function videoSelectionCredits(
	draft: VideoDraft,
	catalog?: SelectionCatalog,
): string | null {
	return videoSelectionOption(draft, catalog)?.credits ?? null;
}

export function videoSelectionPricing(
	draft: VideoDraft,
	catalog?: SelectionCatalog,
): VideoRetailDisplay | null {
	return videoSelectionOption(draft, catalog)?.pricing ?? null;
}

function videoSelectionOption(draft: VideoDraft, catalog?: SelectionCatalog) {
	if (!catalog?.accessAllowed || !validateVideoModelSelection(draft)) return null;
	const model = catalog.models.find((entry) => entry.productKey === draft.productKey);
	if (!model?.available) return null;
	const option = model.options.find(
		(entry) =>
			entry.mode === draft.mode &&
			entry.duration === draft.duration &&
			entry.resolution === draft.resolution &&
			entry.sound === draft.sound &&
			entry.veoTier === draft.veoTier,
	);
	return option?.available && option.credits && /^[1-9]\d*$/.test(option.credits) ? option : null;
}

export function summarizeVideoDurations(durations: readonly number[]) {
	const values = [...new Set(durations)].sort((a, b) => a - b);
	return values.length > 1 && values.every((value, index) => value === values[0]! + index)
		? { kind: "range" as const, min: values[0]!, max: values[values.length - 1]! }
		: { kind: "list" as const, values };
}

export function videoRequestFor(draft: VideoDraft): VideoModelInput {
	return {
		productKey: draft.productKey,
		mode: draft.mode,
		prompt: draft.prompt.trim(),
		duration: draft.duration,
		resolution: draft.resolution,
		aspectRatio: draft.aspectRatio,
		sound: draft.sound,
		...(draft.mode === "image-to-video" ? { inputAssetId: draft.inputAssetId! } : {}),
		...(draft.veoTier === undefined ? {} : { veoTier: draft.veoTier }),
	};
}

export function restoreVideoDraft(request: VideoRequest): VideoDraft {
	// The draft is only a view. Pending confirmation always replays the untouched receipt.
	return "productKey" in request
		? { ...request, inputAssetId: request.inputAssetId ?? null }
		: {
				...initialVideoDraft,
				mode: request.mode,
				prompt: request.prompt,
				aspectRatio: request.mode === "image-to-video" ? "source" : (request.aspectRatio ?? "16:9"),
				inputAssetId: request.mode === "image-to-video" ? request.inputAssetId : null,
			};
}

export function createVideoConfirmation(
	request: VideoRequest,
	quote: VideoQuote,
	createId = () => crypto.randomUUID(),
): VideoConfirmation {
	return {
		version: 1,
		fingerprint: JSON.stringify(request),
		quote,
		input: { quoteId: quote.quoteId, idempotencyKey: createId(), request },
	};
}

export function parseVideoConfirmation(raw: string | null): VideoConfirmation | null {
	if (!raw) return null;
	try {
		const saved = JSON.parse(raw) as VideoConfirmation;
		const input = saved.input;
		const request = input?.request;
		if (
			saved.version !== 1 ||
			!request ||
			typeof input.idempotencyKey !== "string" ||
			!input.idempotencyKey ||
			input.idempotencyKey.length > 200 ||
			input.quoteId !== saved.quote?.quoteId ||
			typeof saved.quote.credits !== "string" ||
			!Number.isFinite(Date.parse(saved.quote.expiresAt))
		)
			return null;
		if (!videoV1ReceiptInputSchema.safeParse(request).success) return null;
		if (saved.fingerprint !== JSON.stringify(request)) return null;
		return saved;
	} catch {
		return null;
	}
}

export function videoPollInterval(
	stage: VideoState["stage"] | undefined,
	visible: boolean,
): 2000 | false {
	return !visible || stage === "READY" || stage === "REJECTED" || stage === "FAILED" ? false : 2000;
}

export function getVideoErrorKey(error: unknown): VideoErrorKey {
	const value =
		error && typeof error === "object"
			? (error as { code?: unknown; message?: unknown; data?: { code?: unknown } })
			: {};
	const codes = [value.code, value.data?.code, value.message].filter(
		(item): item is string => typeof item === "string",
	);
	const code = codes.join(" ");
	if (codes.includes("VIDEO_MODEL_OPTION_UNAVAILABLE")) return "unsupportedSelection";
	if (codes.includes("INVALID_VIDEO_QUOTE")) return "quoteExpired";
	if (/IDEMPOTENCY_CONFLICT/.test(code)) return "conflict";
	if (/QUOTE_EXPIRED|QUOTE_INVALID|STALE_QUOTE|PRICE_CHANGED/.test(code)) return "quoteExpired";
	if (/VIDEO_MODEL_PRICE_EXPIRED|VIDEO_PRICE_EXPIRED/.test(code)) return "priceUnavailable";
	if (/INSUFFICIENT_CREDITS|CREDIT_DEBT/.test(code)) return "insufficientCredits";
	if (/CAPACITY|CONCURRENCY|BUSY|TOO_MANY_REQUESTS/.test(code)) return "busy";
	if (/UNAUTHORIZED|FORBIDDEN/.test(code)) return "unauthorized";
	if (/DISABLED|NOT_ALLOWED|NOT_ENABLED/.test(code)) return "disabled";
	if (/NETWORK|TIMEOUT|fetch|network/i.test(code)) return "network";
	if (/MODEL_SELECTION_UNSUPPORTED|MODEL_NOT_FOUND|MODEL_BLOCKED/.test(code))
		return "unsupportedSelection";
	return "unavailable";
}

export function getVideoFailureRecovery(error: unknown) {
	const reason = getVideoErrorKey(error);
	const value =
		error && typeof error === "object"
			? (error as { code?: unknown; message?: unknown; data?: { code?: unknown } })
			: {};
	const codes = [value.code, value.data?.code, value.message];
	const normalizeDraft =
		codes.includes("VIDEO_MODEL_OPTION_UNAVAILABLE") || codes.includes("INVALID_VIDEO_QUOTE");
	const rejectedBeforeEnqueue = codes.some(
		(code) =>
			typeof code === "string" &&
			/^(INSUFFICIENT_CREDITS|CREDIT_DEBT_OUTSTANDING|VIDEO_OWNER_BUSY|VIDEO_GLOBAL_BUSY|VIDEO_PROVIDER_BUSY)$/.test(
				code,
			),
	);
	return {
		reason,
		// Only definitive rejection permits a new confirmation/key; lost responses keep the receipt.
		clearQuote:
			normalizeDraft ||
			rejectedBeforeEnqueue ||
			reason === "conflict" ||
			reason === "quoteExpired" ||
			reason === "priceUnavailable",
		refreshCatalog: normalizeDraft || reason === "quoteExpired" || reason === "priceUnavailable",
		normalizeDraft,
	};
}
