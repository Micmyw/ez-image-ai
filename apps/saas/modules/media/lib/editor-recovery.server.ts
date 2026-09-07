import {
	getCatalogEntry,
	getCatalogImageSpecCell,
	imageAspectRatioSchema,
	imageBackgroundSchema,
	imageOutputFormatSchema,
} from "@repo/ai";
import { imageSkuKeySchema, type ImageAspectRatio, type ImageSkuKey } from "@repo/config";

import {
	type EditorDraftInput,
	type EditorProductKey,
	type EditorRecoveryResult,
	isEditorProductKey,
} from "./editor-recovery";

interface RecoveryCandidate {
	productKey: string | null;
	input: Record<string, unknown>;
}

interface RecoverySourceAsset {
	id: string;
	status: string;
	mimeType: string;
	deletedAt: Date | null;
}

const LEGACY_RECOVERY_TARGETS = {
	"image-fast": {
		productKey: "image-nano-banana-2-lite",
		skuKey: "nano-banana-2-lite-1k",
		aspectRatio: "auto",
	},
	"image-quality": {
		productKey: "image-gpt-image-2",
		skuKey: "gpt-image-2-2k",
		aspectRatio: "1:1",
	},
} as const satisfies Record<
	string,
	{ productKey: EditorProductKey; skuKey: ImageSkuKey; aspectRatio: ImageAspectRatio }
>;

export function buildEditAgainRecoveryCandidate(
	parent: { productKey: string; inputSnapshot: unknown },
	sourceAssetId: string,
): RecoveryCandidate {
	const input = objectRecord(parent.inputSnapshot);
	return {
		productKey: parent.productKey,
		input: {
			kind: "image-to-image",
			prompt: "",
			sourceAssetId,
			...(typeof input?.skuKey === "string" ? { skuKey: input.skuKey } : {}),
			...(typeof input?.aspectRatio === "string" ? { aspectRatio: input.aspectRatio } : {}),
			...(typeof input?.outputFormat === "string" ? { outputFormat: input.outputFormat } : {}),
			...(typeof input?.background === "string" ? { background: input.background } : {}),
		},
	};
}

export function resolveEditorRecovery(input: {
	requested: boolean;
	candidate: RecoveryCandidate | null;
	sourceAsset: RecoverySourceAsset | null;
	allowedProductKeys: EditorProductKey[];
}): EditorRecoveryResult {
	if (!input.requested) return { initialDraft: null, restoreState: "idle", notice: null };
	if (!input.candidate || !input.sourceAsset) return unavailableRecovery();
	if (
		input.sourceAsset.deletedAt ||
		!input.sourceAsset.mimeType.startsWith("image/") ||
		!(["READY", "VERIFYING"] as const).includes(input.sourceAsset.status as "READY" | "VERIFYING")
	) {
		return unavailableRecovery();
	}

	const draft = normalizedDraft(input.candidate);
	if (!draft || draft.input.sourceAssetId !== input.sourceAsset.id) return unavailableRecovery();

	return {
		initialDraft: draft,
		restoreState: input.sourceAsset.status === "READY" ? "ready" : "verifying",
		notice: input.allowedProductKeys.includes(draft.productKey) ? null : "quality-upgrade-required",
	};
}

function normalizedDraft(candidate: RecoveryCandidate): EditorDraftInput | null {
	if (candidate.input.kind !== "image-to-image") return null;
	const sourceAssetId = candidate.input.sourceAssetId;
	if (typeof sourceAssetId !== "string" || sourceAssetId.length === 0) return null;
	const prompt = candidate.input.prompt;
	if (typeof prompt !== "string" || prompt.length > 10_000) return null;

	const legacyKey = candidate.productKey as keyof typeof LEGACY_RECOVERY_TARGETS;
	const legacy = Object.prototype.hasOwnProperty.call(LEGACY_RECOVERY_TARGETS, legacyKey)
		? LEGACY_RECOVERY_TARGETS[legacyKey]
		: undefined;
	const productKey = legacy?.productKey ?? candidate.productKey;
	if (!isEditorProductKey(productKey)) return null;
	const sku = imageSkuKeySchema.safeParse(legacy?.skuKey ?? candidate.input.skuKey);
	if (!sku.success) return null;
	const cell = getCatalogImageSpecCell(getCatalogEntry(productKey), sku.data);
	if (!cell) return null;

	const requestedAspectRatio = imageAspectRatioSchema.safeParse(candidate.input.aspectRatio);
	const fallbackAspectRatio = legacy?.aspectRatio;
	const aspectRatio =
		requestedAspectRatio.success && cell.aspectRatios.includes(requestedAspectRatio.data)
			? requestedAspectRatio.data
			: fallbackAspectRatio && cell.aspectRatios.includes(fallbackAspectRatio)
				? fallbackAspectRatio
				: null;
	if (!aspectRatio) return null;

	return {
		productKey,
		input: {
			kind: "image-to-image",
			prompt: prompt.trim(),
			sourceAssetId,
			skuKey: cell.skuKey,
			aspectRatio,
			...normalizedCellControls(candidate.input, cell.controls),
		},
	};
}

function normalizedCellControls(
	input: Record<string, unknown>,
	controls: NonNullable<ReturnType<typeof getCatalogImageSpecCell>>["controls"],
): Pick<EditorDraftInput["input"], "outputFormat" | "background"> {
	const outputFormat = imageOutputFormatSchema.safeParse(input.outputFormat);
	const outputFormatControl = controls?.find((control) => control.key === "outputFormat");
	const background = imageBackgroundSchema.safeParse(input.background);
	const backgroundControl = controls?.find((control) => control.key === "background");

	return {
		...(outputFormat.success &&
		outputFormatControl?.options.some((option) => option.key === outputFormat.data)
			? { outputFormat: outputFormat.data }
			: {}),
		...(background.success &&
		backgroundControl?.options.some((option) => option.key === background.data)
			? { background: background.data }
			: {}),
	};
}

function objectRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function unavailableRecovery(): EditorRecoveryResult {
	return { initialDraft: null, restoreState: "error", notice: "unavailable" };
}
