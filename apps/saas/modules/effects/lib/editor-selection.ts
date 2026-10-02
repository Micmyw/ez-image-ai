import type { GenerationFormValues } from "../../media/lib/form-schema";
import {
	getImageSpecCell,
	resolveImageSpecControlValues,
	type PublicImageSpecMatrix,
} from "../../media/lib/image-sku-selection";
import type { PublicEffectPreset } from "./types";

/** A preset changes editable controls only. The existing upload/asset binding stays intact. */
export function applyEffectPresetToValues(
	current: GenerationFormValues,
	preset: PublicEffectPreset,
): GenerationFormValues {
	return {
		productKey: preset.productKey,
		prompt: preset.prompt,
		sourceAssetId: current.sourceAssetId,
		...preset.parameters,
	};
}

export function needsEffectPresetConfirmation(
	prompt: string,
	selected: PublicEffectPreset,
): boolean {
	return prompt.length > 0 && prompt !== selected.prompt;
}

export function hasEffectPresetChanges(
	values: Omit<GenerationFormValues, "sourceAssetId">,
	preset: PublicEffectPreset,
): boolean {
	return (
		needsEffectPresetConfirmation(values.prompt, preset) ||
		values.productKey !== preset.productKey ||
		values.skuKey !== preset.parameters.skuKey ||
		values.aspectRatio !== preset.parameters.aspectRatio ||
		values.outputFormat !== preset.parameters.outputFormat ||
		values.background !== preset.parameters.background
	);
}

/** Availability is deliberately exact: a missing model or SKU never selects a replacement. */
export function isEffectSelectionAvailable(
	values: Pick<
		GenerationFormValues,
		"productKey" | "skuKey" | "aspectRatio" | "outputFormat" | "background"
	>,
	products: readonly { key: string; skuMatrix?: PublicImageSpecMatrix }[],
): boolean {
	const product = products.find((candidate) => candidate.key === values.productKey);
	const cell = getImageSpecCell(product?.skuMatrix, values.skuKey);
	if (!cell || !cell.aspectRatios.includes(values.aspectRatio)) return false;
	const controls = resolveImageSpecControlValues(cell, values);
	return (
		(values.outputFormat === undefined || controls.outputFormat === values.outputFormat) &&
		(values.background === undefined || controls.background === values.background)
	);
}

export function effectWorkspacePath(pathname: string, presetId?: string): string {
	return presetId ? `${pathname}?preset=${encodeURIComponent(presetId)}` : pathname;
}

/** Only public, bounded IDs and the existing recovery flag can leave the page. */
export function sanitizeEffectEditorReturnPath(value: unknown): string | null {
	if (
		typeof value !== "string" ||
		value.length > 512 ||
		!value.startsWith("/effects/") ||
		value.includes("\\")
	)
		return null;
	let url: URL;
	try {
		url = new URL(value, "https://effect-return.invalid");
	} catch {
		return null;
	}
	if (
		url.origin !== "https://effect-return.invalid" ||
		url.hash ||
		!/^\/effects\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(url.pathname) ||
		url.pathname === "/effects/category"
	)
		return null;
	if ([...url.searchParams.keys()].some((key) => !["preset", "upgrade", "resume"].includes(key)))
		return null;
	for (const key of ["preset", "upgrade", "resume"])
		if (url.searchParams.getAll(key).length > 1) return null;
	const preset = url.searchParams.get("preset");
	if (!preset || preset.length > 96 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(preset)) return null;
	if (url.searchParams.has("upgrade") && url.searchParams.get("upgrade") !== "complete")
		return null;
	if (url.searchParams.has("resume") && url.searchParams.get("resume") !== "text") return null;
	if (url.searchParams.has("upgrade") && url.searchParams.has("resume")) return null;
	return url.pathname + url.search;
}
