import {
	getVideoModel,
	getVideoModelOptions,
	videoModelInputSchema,
	type VideoModelInput,
	type VideoModelSelection,
} from "@repo/config/video-models";
import { videoV1InputSchema } from "@repo/config/video-v1";

import type { VideoCreateInput, VideoQuote, VideoRequest, VideoState } from "./api";

export type VideoDraft = VideoModelSelection & {
	prompt: string;
	inputAssetId: string | null;
};
export type VideoErrorKey =
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
export function changeVideoDraft(current: VideoDraft, patch: Partial<VideoDraft>): VideoDraft {
	const next = { ...current, ...patch };
	const model = getVideoModel(next.productKey);
	if (!model || model.status !== "implemented") return current;
	if (!model.modes.includes(next.mode)) next.mode = model.modes[0]!;
	let options = getVideoModelOptions(next.productKey, next.mode);
	const keys = ["duration", "resolution", "aspectRatio", "sound"] as const;
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

export function validateVideoDraft(draft: VideoDraft): VideoErrorKey | null {
	const model = getVideoModel(draft.productKey);
	if (!model || model.status !== "implemented") return "unsupportedSelection";
	const length = Array.from(draft.prompt.trim()).length;
	if (length < model.minPromptCodePoints || length > model.maxPromptCodePoints)
		return "promptLength";
	if (draft.mode === "image-to-video" && !draft.inputAssetId) return "imageRequired";
	if (!videoModelInputSchema.safeParse(videoRequestFor(draft)).success)
		return "unsupportedSelection";
	return null;
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
		if (!videoV1InputSchema.safeParse(request).success) return null;
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
	const code = [value.code, value.data?.code, value.message]
		.filter((item): item is string => typeof item === "string")
		.join(" ");
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
	const rejectedBeforeEnqueue = [value.code, value.data?.code, value.message].some(
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
			rejectedBeforeEnqueue ||
			reason === "conflict" ||
			reason === "quoteExpired" ||
			reason === "priceUnavailable",
		refreshCatalog: reason === "quoteExpired" || reason === "priceUnavailable",
	};
}
