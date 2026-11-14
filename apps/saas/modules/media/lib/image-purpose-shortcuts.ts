import {
	getImageGenerationCredits,
	type ImageOutputFormat,
	type ImageSkuKey,
} from "@repo/config/client";

import type { EditorProductKey } from "./editor-recovery";

export interface ImagePurposeProduct {
	key: string;
	label: string;
	skuMatrix?: {
		cells: readonly {
			skuKey: string;
			credits: number;
			controls?: readonly {
				key: string;
				defaultValue: string;
				options: readonly { key: string }[];
			}[];
		}[];
	};
}

const PURPOSES = [
	{
		key: "everyday",
		selections: [
			["image-minimax-h3", "minimax-h3-1k"],
			["image-nano-banana-2-lite", "nano-banana-2-lite-1k"],
		],
	},
	{ key: "layouts", selections: [["image-gpt-image-2-6-flare", "gpt-image-2-6-flare-1k"]] },
	{
		key: "details",
		selections: [["image-gpt-image-2-6-sunburst", "gpt-image-2-6-sunburst-1k"]],
	},
] as const;

/** Suggestions are presentation choices, never authorization or a hidden model catalog. */
export function getImagePurposeShortcuts(
	products: readonly ImagePurposeProduct[],
	current: { outputFormat?: ImageOutputFormat; frameCount?: number } = {},
) {
	return PURPOSES.flatMap((purpose) => {
		for (const [productKey, skuKey] of purpose.selections) {
			const product = products.find((candidate) => candidate.key === productKey);
			const cell = product?.skuMatrix?.cells.find((candidate) => candidate.skuKey === skuKey);
			if (product && cell && Number.isFinite(cell.credits) && cell.credits >= 0) {
				const formatControl = cell.controls?.find((control) => control.key === "outputFormat");
				const format = formatControl?.options.some((option) => option.key === current.outputFormat)
					? current.outputFormat
					: formatControl?.defaultValue;
				const frameCount =
					Number.isInteger(current.frameCount) &&
					current.frameCount! >= 2 &&
					current.frameCount! <= 16
						? current.frameCount
						: 9;
				const credits =
					format === "svg" || format === "gif"
						? getImageGenerationCredits({ skuKey, outputFormat: format, frameCount })
						: cell.credits;
				return [
					{
						key: purpose.key,
						productKey: productKey as EditorProductKey,
						skuKey: skuKey as ImageSkuKey,
						modelLabel: product.label,
						credits,
					},
				];
			}
		}
		return [];
	});
}
