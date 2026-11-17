import { trackBrowserGrowthEvent } from "@repo/utils/lib/growth-analytics-browser";

import {
	GTA_PAGES,
	GTA_PROMPT_VERSION,
	GTA_SCENES,
	GTA_THEME,
	gtaAspectRatio,
	type GtaIntent,
	type GtaSettings,
} from "./config";

export type GtaToolEventStage =
	| "tool_view"
	| "scene_selected"
	| "sample_download"
	| "result_download_clicked";

/** Only public preset choices enter the event. Optional job identity stays in the hash dispatcher. */
export async function trackGtaToolEvent(
	stage: GtaToolEventStage,
	intent: GtaIntent,
	settings: GtaSettings,
	options?: { dedupeKey?: string; jobKey?: string },
) {
	try {
		if (
			!["tool_view", "scene_selected", "sample_download", "result_download_clicked"].includes(
				stage,
			) ||
			!["wallpaper", "loading-art"].includes(intent) ||
			!GTA_SCENES.some((scene) => scene.id === settings.sceneId) ||
			!["photo", "scene"].includes(settings.sourceMode) ||
			!["phone", "desktop"].includes(settings.format) ||
			(intent === "loading-art" && settings.sourceMode !== "photo")
		)
			return "rejected" as const;
		return await trackBrowserGrowthEvent(
			{
				name: "public_image_tool_observed",
				properties: {
					imageTool: {
						page: GTA_PAGES[intent].path,
						theme: GTA_THEME,
						intent,
						scene: settings.sceneId,
						sourceMode: settings.sourceMode,
						ratio: gtaAspectRatio(settings.format),
						promptVersion: GTA_PROMPT_VERSION,
						stage,
					},
				},
			},
			{
				...(options?.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
				...(options?.jobKey ? { taskKey: options.jobKey } : {}),
			},
		);
	} catch {
		return "failed" as const;
	}
}
