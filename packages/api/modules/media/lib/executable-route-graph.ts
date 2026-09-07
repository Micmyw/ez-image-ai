import {
	getPublicProductCatalog,
	executableRouteGraphOptionsFromEnvironment,
	type ExecutableRouteGraphOptions,
	type PublicCatalogEntry,
} from "@repo/ai";
import {
	DEFAULT_PRODUCT_CONFIG,
	EZPIC_PRODUCT_KEYS,
	IMAGE_ASPECT_RATIOS,
	type ImageAspectRatio,
} from "@repo/config";
import { db } from "@repo/database/client";
import type { PrismaClient } from "@repo/database/generated-client";

type RuntimeConfigDatabase = Pick<PrismaClient, "runtimeConfigOverride">;

export interface ExecutableEzPicProduct {
	key: (typeof EZPIC_PRODUCT_KEYS)[number];
	label: string;
	description: string;
	credits: number;
	aspectRatios: readonly ImageAspectRatio[];
	skuMatrix: NonNullable<PublicCatalogEntry["skuMatrix"]>;
}

const generationConfigKey = "media.generation.enabled";
const productConfigKeys = DEFAULT_PRODUCT_CONFIG.productKeys.map(
	(productKey) => `media.model.${productKey}.enabled`,
);

/** Resolves the server-only graph shared by catalog display, quotes, and admission. */
export async function getCurrentExecutableRouteGraphOptions(
	database: RuntimeConfigDatabase = db,
	environment: Record<string, string | undefined> = process.env,
): Promise<ExecutableRouteGraphOptions> {
	const disabledOverrides = await database.runtimeConfigOverride.findMany({
		where: {
			active: true,
			value: { equals: false },
			configKey: { in: [generationConfigKey, ...productConfigKeys] },
		},
		select: { configKey: true },
	});
	const disabledConfigKeys = new Set(disabledOverrides.map((override) => override.configKey));
	const environmentGraph = executableRouteGraphOptionsFromEnvironment(environment);
	const disabledProductKeys = new Set([
		...(environmentGraph.disabledProductKeys ?? []),
		...DEFAULT_PRODUCT_CONFIG.productKeys.filter((productKey) =>
			disabledConfigKeys.has(`media.model.${productKey}.enabled`),
		),
	]);
	return {
		...environmentGraph,
		generationEnabled:
			environmentGraph.generationEnabled && !disabledConfigKeys.has(generationConfigKey),
		disabledProductKeys,
	};
}

/** Returns only the stable, browser-safe EzPic entries from the quote/admission route graph. */
export async function getCurrentExecutableEzPicProducts(
	database: RuntimeConfigDatabase = db,
	environment: Record<string, string | undefined> = process.env,
): Promise<ExecutableEzPicProduct[]> {
	const catalog = getPublicProductCatalog(
		await getCurrentExecutableRouteGraphOptions(database, environment),
	);
	return catalog.products.flatMap((product) => {
		if (!isEzPicProductKey(product.key) || !product.skuMatrix) return [];
		const defaultCell = product.skuMatrix.cells.find(
			(cell) => cell.skuKey === product.skuMatrix?.defaultSkuKey,
		);
		if (!defaultCell) return [];
		const aspectRatios = defaultCell.aspectRatios.flatMap((value) =>
			isImageAspectRatio(value) ? [value] : [],
		);
		if (aspectRatios.length !== defaultCell.aspectRatios.length) return [];
		return [
			{
				key: product.key,
				label: product.label,
				description: product.description,
				credits: product.credits,
				aspectRatios: Object.freeze(aspectRatios),
				skuMatrix: product.skuMatrix,
			},
		];
	});
}

function isEzPicProductKey(value: string): value is (typeof EZPIC_PRODUCT_KEYS)[number] {
	return EZPIC_PRODUCT_KEYS.includes(value as (typeof EZPIC_PRODUCT_KEYS)[number]);
}

function isImageAspectRatio(value: string): value is ImageAspectRatio {
	return IMAGE_ASPECT_RATIOS.includes(value as ImageAspectRatio);
}
