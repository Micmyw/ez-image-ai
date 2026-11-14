import type { LandingPromptSelectedDetail } from "../../landing/lib/prompt-selection";
import kieExamples from "./gpt-image-2-6-kie-examples.json";
import type { ImageToolExampleImage } from "./tool-pages";

export type GptImageVariant = "flare" | "sunburst";

export interface GptImageExample extends LandingPromptSelectedDetail {
	id: string;
	title: string;
	category: string;
	description: string;
	model: string;
	resolution: string;
	image: ImageToolExampleImage;
	referenceImage?: ImageToolExampleImage;
	animation?: string;
	source?: "EzImageAI";
	selection: NonNullable<LandingPromptSelectedDetail["selection"]>;
}

// Kie requests and asset hashes are recorded in the November 14 source receipt.
const suppliedExamples = kieExamples as Record<GptImageVariant, readonly GptImageExample[]>;

export const GPT_IMAGE_2_6_ORIGAMI_EXAMPLE: GptImageExample = {
	id: "origami-hummingbird",
	title: "An origami hummingbird",
	category: "Animated GIF",
	description: "An iridescent paper hummingbird in a 9-frame loop.",
	source: "EzImageAI",
	model: "GPT Image 2.6 Sunburst",
	resolution: "512 × 512 · 9-frame GIF",
	prompt:
		"Create a polished looping animated GIF for an AI creative tool showcase. A single small origami hummingbird made of folded iridescent paper hovers in place against a clean deep violet studio background. Its wings beat through one gentle, readable motion cycle and return to the starting pose, with a subtle moving highlight across the folded paper. Keep the bird centered, its body and paper folds consistent, and the entire silhouette inside the middle two-thirds of the frame so it also reads well in a landscape card. Fixed camera, steady lighting, uncluttered background, no camera zoom, no text, no logo, no watermark. Aim for a smooth seamless loop.",
	image: {
		src: "/images/models/gpt-image-2-6/origami-hummingbird.webp",
		alt: "Iridescent origami hummingbird hovering against a deep violet background",
		width: 512,
		height: 512,
	},
	animation: "/images/models/gpt-image-2-6/origami-hummingbird.gif",
	selection: {
		productKey: "image-gpt-image-2-6-sunburst",
		skuKey: "gpt-image-2-6-sunburst-1k",
		aspectRatio: "1:1",
		outputFormat: "gif",
		background: "opaque",
		frameCount: 9,
		frameDurationMs: 200,
	},
};

export const GPT_IMAGE_2_6_EXAMPLES: Record<GptImageVariant, readonly GptImageExample[]> = {
	flare: suppliedExamples.flare,
	sunburst: [...suppliedExamples.sunburst, GPT_IMAGE_2_6_ORIGAMI_EXAMPLE],
};
