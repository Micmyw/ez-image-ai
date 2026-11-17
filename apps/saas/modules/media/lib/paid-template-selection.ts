import { getImageProductSelectionContract } from "@repo/config/client";

import { isEditorProductKey } from "./editor-recovery";
import type { PublicImageSpecMatrix } from "./image-sku-selection";

export function paidTemplateSpecMatrix<T extends PublicImageSpecMatrix>(
	matrix: T,
	productKey: string,
): T {
	const cells = matrix.cells.filter((cell) =>
		isPaidTemplateSelection({ productKey, skuKey: cell.skuKey }),
	);
	return {
		...matrix,
		defaultSkuKey:
			cells.find((cell) => cell.skuKey === matrix.defaultSkuKey)?.skuKey ??
			cells[0]?.skuKey ??
			matrix.defaultSkuKey,
		cells,
		dimensions: matrix.dimensions.map((dimension) => ({
			...dimension,
			options: dimension.options.filter((option) =>
				cells.some((cell) => cell.parameterValues[dimension.key] === option.key),
			),
		})),
	};
}

/** Validate the model/tier pair. Paid access is checked independently of model choice. */
export function isPaidTemplateSelection(selection: {
	productKey?: string | null;
	skuKey?: string | null;
}): boolean {
	return Boolean(
		isEditorProductKey(selection.productKey) &&
		getImageProductSelectionContract(selection.productKey)?.cells.some(
			(cell) => cell.skuKey === selection.skuKey,
		),
	);
}
