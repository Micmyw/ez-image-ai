import {
	EZPIC_PRODUCT_KEYS,
	IMAGE_ASPECT_RATIOS,
	IMAGE_SKU_KEYS,
	type ImageAspectRatio,
	type ImageSkuKey,
} from "@repo/config";

export type AdminSafeImageProductKey = (typeof EZPIC_PRODUCT_KEYS)[number];

export interface AdminSafeImageSkuDefinition {
	skuKey: ImageSkuKey;
	aspectRatios: readonly ImageAspectRatio[];
}

/**
 * Provider-free view of the canonical image catalog used only to validate Admin projections.
 * Callers must build this from the server-side product matrices; routes, model IDs, costs, and
 * credentials must never be included.
 */
export interface AdminSafeImageProductDefinition {
	productKey: AdminSafeImageProductKey;
	publicName: string;
	skuCells: readonly AdminSafeImageSkuDefinition[];
}

export interface AdminSafeImageSelection {
	productKey: AdminSafeImageProductKey;
	skuKey: ImageSkuKey;
	aspectRatio: ImageAspectRatio;
}

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit < 32 || codeUnit === 127) return true;
	}
	return false;
}

export function validateAdminSafeImageProductDefinitions(
	definitions: readonly AdminSafeImageProductDefinition[],
): readonly AdminSafeImageProductDefinition[] {
	if (definitions.length === 0) throw new Error("Admin image product definitions are required");

	const knownProductKeys = new Set<string>(EZPIC_PRODUCT_KEYS);
	const knownSkuKeys = new Set<string>(IMAGE_SKU_KEYS);
	const knownAspectRatios = new Set<string>(IMAGE_ASPECT_RATIOS);
	const seenProductKeys = new Set<string>();
	const seenSkuKeys = new Set<string>();

	for (const definition of definitions) {
		if (
			!knownProductKeys.has(definition.productKey) ||
			seenProductKeys.has(definition.productKey)
		) {
			throw new Error("Invalid Admin image product definition");
		}
		seenProductKeys.add(definition.productKey);
		if (
			definition.publicName.length === 0 ||
			definition.publicName.length > 128 ||
			hasControlCharacters(definition.publicName) ||
			definition.skuCells.length === 0
		) {
			throw new Error("Invalid Admin image product definition");
		}

		for (const cell of definition.skuCells) {
			if (!knownSkuKeys.has(cell.skuKey) || seenSkuKeys.has(cell.skuKey)) {
				throw new Error("Invalid Admin image SKU definition");
			}
			seenSkuKeys.add(cell.skuKey);
			if (
				cell.aspectRatios.length === 0 ||
				new Set(cell.aspectRatios).size !== cell.aspectRatios.length ||
				cell.aspectRatios.some((aspectRatio) => !knownAspectRatios.has(aspectRatio))
			) {
				throw new Error("Invalid Admin image SKU definition");
			}
		}
	}

	return definitions;
}

export function safeAdminImageSelection(
	definitions: readonly AdminSafeImageProductDefinition[],
	productKey: string,
	inputSnapshot: unknown,
): AdminSafeImageSelection | null {
	if (!inputSnapshot || typeof inputSnapshot !== "object" || Array.isArray(inputSnapshot)) {
		return null;
	}
	const { skuKey, aspectRatio } = inputSnapshot as Record<string, unknown>;
	if (typeof skuKey !== "string" || typeof aspectRatio !== "string") return null;

	const product = definitions.find((candidate) => candidate.productKey === productKey);
	const cell = product?.skuCells.find((candidate) => candidate.skuKey === skuKey);
	if (!product || !cell?.aspectRatios.includes(aspectRatio as ImageAspectRatio)) return null;

	return {
		productKey: product.productKey,
		skuKey: cell.skuKey,
		aspectRatio: aspectRatio as ImageAspectRatio,
	};
}
