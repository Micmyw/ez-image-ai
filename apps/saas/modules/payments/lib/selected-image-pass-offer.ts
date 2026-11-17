import { getImageProductSelectionContract, parseImageSelection } from "@repo/config/client";
import {
	IMAGE_PASS_ALL_MODELS_BENEFIT_POLICY,
	IMAGE_PASS_PUBLIC_OFFER,
	imagePassCoversSelection,
} from "@repo/config/image-pass";

/** Coverage of a new purchase, independent of the owner's historical pass grants. */
export function currentImagePassOfferCoversSelection(input: {
	productKey?: string;
	skuKey?: string;
	outputFormat?: string;
}): boolean {
	if (!input.productKey || !input.skuKey) return false;
	const cell = getImageProductSelectionContract(input.productKey)?.cells.find(
		(candidate) => candidate.skuKey === input.skuKey,
	);
	if (!cell) return false;
	// Coverage is independent of the editor's crop. Use a supported ratio for
	// validation, retaining square GIF validation without excluding non-square SKUs.
	const selection = parseImageSelection(input.productKey, {
		skuKey: input.skuKey,
		aspectRatio: cell.aspectRatios.includes("1:1") ? "1:1" : cell.aspectRatios[0],
		...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
	});
	return Boolean(
		selection &&
		imagePassCoversSelection({
			offerSnapshot: IMAGE_PASS_PUBLIC_OFFER,
			benefitPolicy: IMAGE_PASS_ALL_MODELS_BENEFIT_POLICY,
			skuKey: selection.skuKey,
			outputFormat: selection.outputFormat,
		}),
	);
}
