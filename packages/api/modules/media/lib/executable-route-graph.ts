import { createHash } from "node:crypto";

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

type PublicMediaCatalog = ReturnType<typeof getPublicProductCatalog> & { revision: string };

interface PublicCatalogProjection {
	catalog: PublicMediaCatalog;
	ezPicProducts: readonly ExecutableEzPicProduct[];
}

const generationConfigKey = "media.generation.enabled";
const productConfigKeys = DEFAULT_PRODUCT_CONFIG.productKeys.map(
	(productKey) => `media.model.${productKey}.enabled`,
);
let lastPublicCatalog: { key: string; projection: PublicCatalogProjection } | undefined;

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

export async function getCurrentPublicCatalogProjection(
	database: RuntimeConfigDatabase = db,
	environment: Record<string, string | undefined> = process.env,
): Promise<PublicCatalogProjection> {
	// Read the current switches for every request. Only the synchronous public
	// projection is reused. No database promise or guest state enters this cache.
	const options = await getCurrentExecutableRouteGraphOptions(database, environment);
	const key = JSON.stringify({
		...options,
		enabledProviders: [...options.enabledProviders].sort(),
		disabledProductKeys: [...(options.disabledProductKeys ?? [])].sort(),
	});
	if (lastPublicCatalog?.key === key) return lastPublicCatalog.projection;

	const catalog = getPublicProductCatalog(options);
	const revision = createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
	const projection = Object.freeze({
		catalog: freezeCatalogProjection({ ...catalog, revision }),
		ezPicProducts: Object.freeze(executableEzPicProducts(catalog.products)),
	});
	lastPublicCatalog = { key, projection };
	return projection;
}

/** Returns only the stable, browser-safe EzPic entries from the quote/admission route graph. */
export async function getCurrentExecutableEzPicProducts(
	database: RuntimeConfigDatabase = db,
	environment: Record<string, string | undefined> = process.env,
): Promise<readonly ExecutableEzPicProduct[]> {
	return (await getCurrentPublicCatalogProjection(database, environment)).ezPicProducts;
}

function executableEzPicProducts(
	products: readonly PublicCatalogEntry[],
): ExecutableEzPicProduct[] {
	return products.flatMap((product) => {
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
			Object.freeze({
				key: product.key,
				label: product.label,
				description: product.description,
				credits: product.credits,
				aspectRatios: Object.freeze(aspectRatios),
				skuMatrix: product.skuMatrix,
			}),
		];
	});
}

function freezeCatalogProjection<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freezeCatalogProjection(child);
		Object.freeze(value);
	}
	return value;
}

function isEzPicProductKey(value: string): value is (typeof EZPIC_PRODUCT_KEYS)[number] {
	return EZPIC_PRODUCT_KEYS.includes(value as (typeof EZPIC_PRODUCT_KEYS)[number]);
}

function isImageAspectRatio(value: string): value is ImageAspectRatio {
	return IMAGE_ASPECT_RATIOS.includes(value as ImageAspectRatio);
}
