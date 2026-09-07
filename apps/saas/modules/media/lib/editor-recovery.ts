import {
	EZPIC_PRODUCT_KEYS,
	resolvePlanEntitlement,
	type ImageAspectRatio,
	type ImageBackground,
	type ImageOutputFormat,
	type ImageSkuKey,
} from "@repo/config/client";

export type EditorProductKey = (typeof EZPIC_PRODUCT_KEYS)[number];

export function isEditorProductKey(
	productKey: string | null | undefined,
): productKey is EditorProductKey {
	return EZPIC_PRODUCT_KEYS.includes(productKey as EditorProductKey);
}

export interface EditorDraftInput {
	productKey: EditorProductKey;
	input: {
		kind: "image-to-image";
		prompt: string;
		sourceAssetId: string;
		skuKey: ImageSkuKey;
		aspectRatio?: ImageAspectRatio;
		outputFormat?: ImageOutputFormat;
		background?: ImageBackground;
	};
}

export type EditorRestoreState = "idle" | "ready" | "verifying" | "error";
export type EditorRestoreNotice = "quality-upgrade-required" | "unavailable" | null;

export interface EditorRecoveryResult {
	initialDraft: EditorDraftInput | null;
	restoreState: EditorRestoreState;
	notice: EditorRestoreNotice;
}

export function hasEditorRecoveryRequest(
	filters: {
		draftError?: string;
		asset?: string;
		reuseJob?: string;
		parentJob?: string;
	},
	draftId: string | null | undefined,
): boolean {
	return Boolean(
		filters.draftError || filters.asset || filters.reuseJob || filters.parentJob || draftId,
	);
}

export function resolveEditorAllowedProductKeys(
	metadata: unknown,
	planName: string | undefined,
): EditorProductKey[] {
	return resolvePlanEntitlement(metadata, planName).allowedProducts.filter(
		(productKey): productKey is EditorProductKey => isEditorProductKey(productKey),
	);
}
