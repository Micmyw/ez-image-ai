import prompts from "./templates/prompts.json";
const curvedRampV5Prompt = prompts["flyingcar-curved-ramp-v5.txt"];
const curvedRampV6Prompt = prompts["flyingcar-curved-ramp-v6.txt"];
const fleetFrontPrompt = prompts["flyingcar-fleet-front-v1.txt"];
const fleetSidePrompt = prompts["flyingcar-fleet-side-v1.txt"];
import { getVideoTemplate, type VideoTemplateId } from "../video-templates";

// These files retain the supplied prompts' exact bytes. Only server modules
// import them; every task freezes its prompt and media when accepted.
const PROMPTS: Record<VideoTemplateId, string> = {
	"curved-ramp-showcase": curvedRampV5Prompt,
	"curved-ramp": curvedRampV6Prompt,
	"fleet-side": fleetSidePrompt,
	"fleet-front": fleetFrontPrompt,
};
const PROMPT_TEMPLATE_VERSIONS: Record<VideoTemplateId, string> = {
	"curved-ramp-showcase": "flyingcar-h3-curved-ramp-v5",
	"curved-ramp": "flyingcar-h3-curved-ramp-v6",
	"fleet-side": "flyingcar-h3-v1",
	"fleet-front": "flyingcar-h3-v1",
};
export const FLYINGCAR_ASSET_PATH = "/flyingcar/templates/v1";

export function getVideoPrompt(templateId: VideoTemplateId): string {
	return PROMPTS[templateId];
}

export function getVideoPromptVersion(templateId: VideoTemplateId): string {
	return PROMPT_TEMPLATE_VERSIONS[templateId];
}

export interface H3ReferenceAssets {
	images: string[];
	audio: string;
}

/** A CDN override points to the versioned reference root. Presentation variants
 * can share a source pack; their preview media never becomes model input. */
export function getH3ReferenceAssets(
	configs: Record<string, string>,
	templateId: VideoTemplateId,
): H3ReferenceAssets | null {
	const template = getVideoTemplate(templateId);
	const override = configs.flyingcar_h3_asset_base_url?.trim();
	const base = override || `${configs.app_url?.replace(/\/+$/, "")}${FLYINGCAR_ASSET_PATH}`;
	try {
		const url = new URL(base);
		if (
			/[{}]/.test(base) ||
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			!/\.[a-z]{2,63}$/i.test(url.hostname) ||
			/\.(?:localhost|local|internal)$/i.test(url.hostname) ||
			/(^|\.)cloudflarestorage\.com$/i.test(url.hostname)
		)
			return null;
		url.pathname = `${url.pathname.replace(/\/+$/, "")}/${template.referenceAssetId}/`;
		return {
			images: Array.from(
				{ length: template.referenceImageCount },
				(_, index) => new URL(`reference-${String(index + 1).padStart(2, "0")}.jpg`, url).href,
			),
			audio: new URL("audio.wav", url).href,
		};
	} catch {
		return null;
	}
}
