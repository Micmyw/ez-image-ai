import { ModelBrandIcon } from "@media/components/ImageModelIcon";
import type { VideoModelDefinition } from "@repo/config/video-models";

const brands = {
	MiniMax: "minimax",
	Seedance: "bytedance",
	Gemini: "gemini",
	Kling: "kling",
	Veo: "google",
} as const;

export function VideoModelIcon({
	family,
	size = 20,
}: {
	family: VideoModelDefinition["family"];
	size?: number;
}) {
	return <ModelBrandIcon brand={brands[family]} size={size} />;
}
