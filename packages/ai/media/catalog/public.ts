import { DEFAULT_PRODUCT_CONFIG } from "@repo/config";

import { createExecutableRouteGraph } from "./catalog";
import {
	executableRouteGraphOptionsFromEnvironment,
	type ExecutableRouteGraphOptions,
} from "./routing";

export interface PublicCatalogEntry {
	key: string;
	label: string;
	description: string;
	mediaKind: "image" | "video";
	inputKinds: string[];
	credits: number;
	fields: Array<{
		type: "text" | "slider" | "aspect-ratio" | "image-asset";
		key: string;
		label: string;
		required?: boolean;
		min?: number;
		max?: number;
		step?: number;
	}>;
}
export function getPublicProductCatalog(
	options: ExecutableRouteGraphOptions = executableRouteGraphOptionsFromEnvironment(),
): {
	catalogVersion: string;
	pricingVersion: string;
	products: PublicCatalogEntry[];
} {
	return {
		catalogVersion: DEFAULT_PRODUCT_CONFIG.catalogVersion,
		pricingVersion: DEFAULT_PRODUCT_CONFIG.pricingVersion,
		products: createExecutableRouteGraph(options).entries.map(
			({ key, label, description, mediaKind, inputKinds, credits }) => ({
				key,
				label,
				description,
				mediaKind,
				inputKinds: [...inputKinds],
				credits,
				fields: publicFields(key, mediaKind, inputKinds),
			}),
		),
	};
}

function publicFields(
	productKey: string,
	mediaKind: "image" | "video",
	inputKinds: string[],
): PublicCatalogEntry["fields"] {
	return [
		{ type: "text", key: "prompt", label: "Prompt", required: true },
		...(inputKinds.some((kind) => kind.startsWith("image-to-"))
			? [{ type: "image-asset" as const, key: "sourceAssetId", label: "Reference image" }]
			: []),
		...(mediaKind === "image"
			? [{ type: "aspect-ratio" as const, key: "aspectRatio", label: "Format" }]
			: [
					{
						type: "slider" as const,
						key: "durationSeconds",
						label: "Length",
						min: productKey === "video-quality" ? 4 : 1,
						max: productKey === "video-quality" ? 8 : 30,
						step: productKey === "video-quality" ? 2 : 1,
					},
				]),
	];
}
