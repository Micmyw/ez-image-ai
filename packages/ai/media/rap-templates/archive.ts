import type { SourceTemplateKey } from "@repo/config/video-template-library";

import originals from "./original-template-configs.json";
import manifest from "./source-manifest.json";
import { defaultBulin47Template } from "./source/effects/bulin47-template.server";
import { flyingCarTemplateIds } from "./source/flyingcar/request";
import { SPIN_DANCE_SCENE_IMAGES } from "./source/spin-dance";

/** RFC-reserved offline names. These are identities, never fetch authorization. */
const archiveOrigin = "https://ezpic-template.example";
const sourceConfigKeys = {
	"58th-floor": "floor58_template_private_key",
	"green-booth-freestyle": "green_booth_template_private_key",
	"kung-fu-cat": "kung_fu_cat_template_private_key",
	"paws-at-you": "paws_at_you_template_private_key",
} as const;

const currentSourceMaterials = manifest.effectiveConfiguration.materialBindings.map((material) => ({
	...material,
	/** Boundaries must replace this identity with a signed private MediaAsset URL. */
	transportUrl:
		material.sourceConfigKey === "spin-me-round"
			? new URL(
					SPIN_DANCE_SCENE_IMAGES[material.role as keyof typeof SPIN_DANCE_SCENE_IMAGES],
					archiveOrigin,
				).href
			: `${archiveOrigin}/source/${material.sha256}`,
}));

const flyingCarMaterials = manifest.assets
	.filter((material) => material.sourcePath.startsWith("public/flyingcar/templates/v1/"))
	.map((material) => {
		const sourcePath = material.sourcePath.slice("public".length);
		const parts = sourcePath.split("/");
		const sourceConfigKey = parts[parts.length - 2]!;
		const role = parts[parts.length - 1]!;
		return {
			sourceConfigKey,
			revision: "flyingcar-source-reference-pack-v1",
			role,
			sourceUrlSha256: null,
			sha256: material.sha256,
			bytes: material.bytes,
			mimeType: role.endsWith(".wav") ? "audio/wav" : "image/jpeg",
			targetPath: material.targetPath,
			targetMediaAssetId: null,
			targetVerifiedAt: null,
			transportUrl: new URL(sourcePath, archiveOrigin).href,
		};
	});

/** Includes all current effect material and exact ordered Flying Car source packs. */
export const archivedSourceMaterials = [...currentSourceMaterials, ...flyingCarMaterials];

/** Offline preparation only: source prompts/settings + opaque material identities. */
export function prepareArchivedSourceTemplateConfig(
	templateKey: SourceTemplateKey,
): Record<string, string> {
	if (templateKey === "bulin-47") {
		const template = defaultBulin47Template({ app_url: archiveOrigin });
		for (const field of ["sceneImageUrl", "poseImageUrl", "referenceAudioUrl"] as const) {
			const material = archivedSourceMaterials.find(
				(item) => item.sourceConfigKey === "bulin47_template_private_key" && item.role === field,
			);
			if (!material) throw new Error("SOURCE_ARCHIVE_MATERIAL_MISSING");
			template[field] = material.transportUrl;
		}
		return { bulin47_template_private_key: JSON.stringify(template) };
	}
	if (templateKey === "spin-me-round") return { app_url: archiveOrigin };
	if (Object.prototype.hasOwnProperty.call(flyingCarTemplateIds, templateKey))
		return { app_url: archiveOrigin };
	if (Object.prototype.hasOwnProperty.call(sourceConfigKeys, templateKey)) {
		const configKey = sourceConfigKeys[templateKey as keyof typeof sourceConfigKeys];
		const template = originals.templates[configKey];
		return {
			...originals.sourceFlags,
			[configKey]: JSON.stringify(template, (_key, value: unknown) => {
				if (typeof value !== "string") return value;
				if (value.startsWith("source-asset:")) {
					const material = archivedSourceMaterials.find(
						(item) => item.sourceConfigKey === configKey && item.sha256 === value.slice(13),
					);
					if (!material) throw new Error("SOURCE_ARCHIVE_MATERIAL_MISSING");
					return material.transportUrl;
				}
				if (value.startsWith("source-metadata:"))
					return `${archiveOrigin}/metadata/${encodeURIComponent(value.slice(16))}`;
				return value;
			}),
		};
	}
	return {};
}
