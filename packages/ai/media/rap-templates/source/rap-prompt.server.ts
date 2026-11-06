import { rapSongKind, type RapPromptRequest } from "./rap-composition";
import { RAP_PRESET_LYRICS } from "./rap-lyrics";
import en from "./rap-prompts/en.json";
import zh from "./rap-prompts/zh.json";

const stages = {
	"orange-studio": "orange",
	"street-cypher": "street",
	"neon-rap": "neon",
	"funny-rap": "funny",
} as const;

/** Server only: used by the authorized preview and actual generation alike. */
export function buildRapPrompt(input: RapPromptRequest): string {
	const { composition, duration, aspectRatio, photoCount } = input;
	const copy = composition.locale === "zh" ? zh : en;
	const kind = rapSongKind(input, composition);
	const song =
		kind === "preset"
			? [copy["rap.prompt.default_song"], RAP_PRESET_LYRICS[composition.stageId].join("\n")]
			: [
					kind === "customer"
						? copy["rap.prompt.customer_song"]
						: copy["rap.prompt.freestyle_song"],
					composition.occasion?.trim() &&
						`${copy["rap.prompt.occasion"]}: ${composition.occasion.trim()}`,
					input.direction.trim() && `${copy["rap.prompt.content"]}: ${input.direction.trim()}`,
				];
	const ratio = aspectRatio === "adaptive" ? copy["rap.prompt.adaptive_ratio"] : aspectRatio;
	return [
		photoCount ? copy["rap.prompt.with_photos"] : copy["rap.prompt.without_photos"],
		`${copy["rap.prompt.scene"]}\n${composition.customStage?.trim() || copy[`rap.gallery.${stages[composition.stageId]}.prompt`]}`,
		`${copy["rap.prompt.song"]}\n${song.filter(Boolean).join("\n")}`,
		copy["rap.prompt.format"].replace("{duration}", String(duration)).replace("{ratio}", ratio),
		copy["rap.prompt.performance"],
	].join("\n\n");
}
