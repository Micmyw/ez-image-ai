import {
	getImageProductSelectionContract,
	isEzPicProductEnvironmentEnabled,
	parseMediaEnabledProviders,
} from "@repo/config";
import type { VideoEffectTemplateConfig } from "@repo/config/video-effects.server";
import { getActiveRuntimeConfigOverrides } from "@repo/database";
import { db } from "@repo/database/client";

/** Emergency overrides apply before a first paid call, never to querying an accepted attempt. */
export const VIDEO_TEMPLATE_SCENE_PRODUCT_KEY = "image-nano-banana-2-lite";

export function requireVideoTemplateSceneEnvironment(
	template: VideoEffectTemplateConfig,
	environment: Record<string, string | undefined>,
) {
	const contract = getImageProductSelectionContract(VIDEO_TEMPLATE_SCENE_PRODUCT_KEY);
	if (
		environment.MEDIA_GENERATION_ENABLED !== "true" ||
		!isEzPicProductEnvironmentEnabled(VIDEO_TEMPLATE_SCENE_PRODUCT_KEY, environment) ||
		!parseMediaEnabledProviders(environment).includes("kie") ||
		!contract?.cells.some(
			(cell) =>
				cell.skuKey === template.scene.productKey &&
				cell.aspectRatios.includes(template.scene.aspectRatio),
		)
	)
		throw new Error("VIDEO_EFFECT_DISABLED");
}

export async function requireVideoTemplateRuntimeEnabled(
	template: VideoEffectTemplateConfig,
	environment: Record<string, string | undefined> = process.env,
) {
	requireVideoTemplateSceneEnvironment(template, environment);
	const keys = new Set([
		"media.generation.enabled",
		`media.model.${template.scene.productKey}.enabled`,
		`media.model.${VIDEO_TEMPLATE_SCENE_PRODUCT_KEY}.enabled`,
		`media.model.${template.video.productKey}.enabled`,
	]);
	const overrides = await getActiveRuntimeConfigOverrides(db);
	if (overrides.some((row) => keys.has(row.configKey) && row.value === false))
		throw new Error("VIDEO_EFFECT_DISABLED");
}
