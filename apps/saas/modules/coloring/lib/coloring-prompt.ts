export const COLORING_DETAILS = ["simple", "balanced", "detailed"] as const;
export type ColoringDetail = (typeof COLORING_DETAILS)[number];
export type ColoringBackground = "remove" | "keep";

const detailInstructions: Record<ColoringDetail, string> = {
	simple:
		"Use thick, smooth outlines and large closed areas for easy coloring. Omit small textures, individual hairs and tiny decorations.",
	balanced:
		"Use clear, medium-weight outlines and moderately sized closed shapes. Keep recognizable facial features and a few essential interior contours; simplify fine textures.",
	detailed:
		"Use crisp, thinner outlines and smaller closed shapes for detailed coloring. Retain meaningful clothing, fur and object contours without adding shading or dense texture.",
};

export function buildColoringPrompt(
	detail: ColoringDetail = "balanced",
	background: ColoringBackground = "remove",
): string {
	return [
		"Turn the uploaded photo into a printable black-and-white coloring page. Use the uploaded image as the reference; preserve its main subjects, recognizable features, pose and composition.",
		detailInstructions[detail],
		background === "remove"
			? "Remove the background and replace it with plain white. Keep the main subjects and the objects they are holding; do not add decorations."
			: "Keep the recognizable scene but simplify its background into a few clear outlines with open areas to color.",
		"Draw clean black contour lines on pure white. No color, gray shading, gradients, hatching or large solid black fills. Keep the complete subject inside the frame with a white margin. Do not add text or a border.",
	].join(" ");
}
