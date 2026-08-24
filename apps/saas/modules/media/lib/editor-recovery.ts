import { PLAN_ENTITLEMENTS } from "@repo/config/client";

import { buildGenerationInput } from "./form-schema";

export type EditorProductKey = "image-fast" | "image-quality";

export function isEditorProductKey(
	productKey: string | null | undefined,
): productKey is EditorProductKey {
	return productKey === "image-fast" || productKey === "image-quality";
}

export interface EditorDraftInput {
	productKey: EditorProductKey;
	input: {
		kind: "image-to-image";
		prompt: string;
		sourceAssetId: string;
	};
}

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

export type EditorRestoreState = "idle" | "ready" | "verifying" | "error";
export type EditorRestoreNotice = "quality-downgraded" | "unavailable" | null;

export interface EditorRecoveryResult {
	initialDraft: EditorDraftInput | null;
	restoreState: EditorRestoreState;
	notice: EditorRestoreNotice;
}

export function resolveEditorAllowedProductKeys(
	metadata: unknown,
	planName: string | undefined,
): EditorProductKey[] {
	const metadataPlanId =
		metadata && typeof metadata === "object" && !Array.isArray(metadata)
			? (metadata as Record<string, unknown>).planId
			: undefined;
	const planId = [metadataPlanId, planName?.trim().toLowerCase()].find(
		(value) => value === "free" || value === "creator" || value === "studio",
	);
	const entitlement = PLAN_ENTITLEMENTS.find((plan) => plan.id === (planId ?? "free"));
	return (entitlement?.allowedProducts ?? ["image-fast"]).filter(
		(productKey): productKey is EditorProductKey => isEditorProductKey(productKey),
	);
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
	if (!isEditorProductKey(input.candidate.productKey)) {
		return unavailableRecovery();
	}

	let generationInput;
	if (input.candidate.input.prompt === "") {
		if (
			input.candidate.input.kind !== "image-to-image" ||
			typeof input.candidate.input.sourceAssetId !== "string" ||
			input.candidate.input.sourceAssetId.length === 0
		) {
			return unavailableRecovery();
		}
		generationInput = {
			kind: "image-to-image" as const,
			prompt: "",
			sourceAssetId: input.candidate.input.sourceAssetId,
		};
	} else {
		try {
			generationInput = buildGenerationInput(input.candidate.input);
		} catch {
			return unavailableRecovery();
		}
	}
	if (generationInput.sourceAssetId !== input.sourceAsset.id) return unavailableRecovery();

	const qualityDowngraded =
		input.candidate.productKey === "image-quality" &&
		!input.allowedProductKeys.includes("image-quality");
	return {
		initialDraft: {
			productKey: qualityDowngraded ? "image-fast" : input.candidate.productKey,
			input: generationInput,
		},
		restoreState: input.sourceAsset.status === "READY" ? "ready" : "verifying",
		notice: qualityDowngraded ? "quality-downgraded" : null,
	};
}

function unavailableRecovery(): EditorRecoveryResult {
	return { initialDraft: null, restoreState: "error", notice: "unavailable" };
}
