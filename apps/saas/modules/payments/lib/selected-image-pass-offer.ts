import { parseImageSelection } from "@repo/config/client";
import {
	IMAGE_PASS_GPT_IMAGE_26_BENEFIT_POLICY,
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
	const selection = parseImageSelection(input.productKey, {
		skuKey: input.skuKey,
		aspectRatio: "1:1",
		...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
	});
	return Boolean(
		selection &&
		imagePassCoversSelection({
			offerSnapshot: IMAGE_PASS_PUBLIC_OFFER,
			benefitPolicy: IMAGE_PASS_GPT_IMAGE_26_BENEFIT_POLICY,
			skuKey: selection.skuKey,
			outputFormat: selection.outputFormat,
		}),
	);
}
