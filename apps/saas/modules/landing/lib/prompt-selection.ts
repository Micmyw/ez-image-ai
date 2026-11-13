import type {
	ImageAspectRatio,
	ImageBackground,
	ImageOutputFormat,
	ImageSkuKey,
} from "@repo/config/client";

export const LANDING_PROMPT_SELECTED_EVENT = "ezpic:landing-prompt-selected";

export interface LandingPromptSelectedDetail {
	prompt: string;
	selection?: {
		productKey: string;
		skuKey: ImageSkuKey;
		aspectRatio: ImageAspectRatio;
		outputFormat?: ImageOutputFormat;
		background?: ImageBackground;
	};
}
