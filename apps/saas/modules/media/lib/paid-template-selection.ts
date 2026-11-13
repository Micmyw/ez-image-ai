import { getPlanEntitlement, planIncludesImageSelection } from "@repo/config/client";

import type { PublicEffectPreset } from "../../effects/lib/types";
import type { PublicImageSpecMatrix } from "./image-sku-selection";

export function paidTemplateSpecMatrix<T extends PublicImageSpecMatrix>(
	matrix: T,
	skuKey: string,
): T {
	const cells = matrix.cells.filter((cell) => cell.skuKey === skuKey);
	return {
		...matrix,
		defaultSkuKey: skuKey,
		cells,
		dimensions: matrix.dimensions.map((dimension) => ({
			...dimension,
			options: dimension.options.filter((option) =>
				cells.some((cell) => cell.parameterValues[dimension.key] === option.key),
			),
		})),
	};
}

/** A paid template never falls back to a free product through model controls or draft recovery. */
export function isPaidTemplateSelection(
	selection: { productKey?: string | null; skuKey?: string | null },
	preset: Pick<PublicEffectPreset, "productKey" | "parameters"> | undefined,
): boolean {
	return Boolean(
		preset &&
		selection.productKey === preset.productKey &&
		selection.skuKey === preset.parameters.skuKey &&
		!planIncludesImageSelection(
			getPlanEntitlement("free"),
			preset.productKey,
			preset.parameters.skuKey,
		),
	);
}
