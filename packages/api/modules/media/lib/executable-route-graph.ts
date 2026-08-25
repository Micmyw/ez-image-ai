import {
	executableRouteGraphOptionsFromEnvironment,
	type ExecutableRouteGraphOptions,
} from "@repo/ai";
import { DEFAULT_PRODUCT_CONFIG } from "@repo/config";
import { db } from "@repo/database/client";
import type { PrismaClient } from "@repo/database/generated-client";

type RuntimeConfigDatabase = Pick<PrismaClient, "runtimeConfigOverride">;

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
