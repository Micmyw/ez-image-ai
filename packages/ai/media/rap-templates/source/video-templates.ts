/** Public template contract. Prompts stay server-side; all costs use integer units. */
export const VIDEO_TEMPLATES = [
	{
		id: "curved-ramp-showcase",
		experience: "flyingcar",
		duration: 15,
		aspectRatio: "16:9",
		costCredits: 2,
		referenceImageCount: 6,
		referenceAssetId: "curved-ramp",
		assetPath: "/flyingcar/templates/v1/curved-ramp",
		previewKind: "generated",
		// First-party sample + template preview — never third-party showcase CDNs.
		samplePhoto: "/flyingcar/templates/v1/curved-ramp/sample.png",
		poster: "/flyingcar/templates/v1/curved-ramp/reference-04.jpg",
		preview: "/flyingcar/templates/v1/curved-ramp/preview.mp4",
	},
	{
		id: "curved-ramp",
		experience: "flyingcar",
		duration: 15,
		aspectRatio: "16:9",
		costCredits: 2,
		referenceImageCount: 6,
		referenceAssetId: "curved-ramp",
		assetPath: "/flyingcar/templates/v1/curved-ramp",
		previewKind: "source",
		poster: "/flyingcar/templates/v1/curved-ramp/reference-04.jpg",
		preview: "/flyingcar/templates/v1/curved-ramp/preview.mp4",
	},
	{
		id: "fleet-side",
		experience: "flyingcar",
		duration: 7,
		aspectRatio: "16:9",
		costCredits: 1,
		referenceImageCount: 5,
		referenceAssetId: "fleet-side",
		assetPath: "/flyingcar/templates/v1/fleet-side",
		previewKind: "source",
		poster: "/flyingcar/templates/v1/fleet-side/reference-04.jpg",
		preview: "/flyingcar/templates/v1/fleet-side/preview.mp4",
	},
	{
		id: "fleet-front",
		experience: "flyingcar",
		duration: 7,
		aspectRatio: "16:9",
		costCredits: 1,
		referenceImageCount: 5,
		referenceAssetId: "fleet-front",
		assetPath: "/flyingcar/templates/v1/fleet-front",
		previewKind: "source",
		poster: "/flyingcar/templates/v1/fleet-front/reference-04.jpg",
		preview: "/flyingcar/templates/v1/fleet-front/preview.mp4",
	},
] as const;

export type VideoTemplate = (typeof VIDEO_TEMPLATES)[number];
export type VideoTemplateId = VideoTemplate["id"];
export type VideoExperience = VideoTemplate["experience"];
export type VideoDuration = VideoTemplate["duration"];
export const DEFAULT_VIDEO_TEMPLATE_ID: VideoTemplateId = "curved-ramp-showcase";

export function getExperienceTemplates(experience: VideoExperience) {
	return VIDEO_TEMPLATES.filter((template) => template.experience === experience);
}

export function getExperienceDefault(experience: VideoExperience): VideoTemplateId {
	return getExperienceTemplates(experience)[0]?.id ?? DEFAULT_VIDEO_TEMPLATE_ID;
}

export function isVideoTemplateId(value: unknown): value is VideoTemplateId {
	return VIDEO_TEMPLATES.some((template) => template.id === value);
}

export function getVideoTemplate(id: VideoTemplateId): VideoTemplate {
	const template = VIDEO_TEMPLATES.find((item) => item.id === id);
	if (!template) throw new Error("VIDEO_INVALID_TEMPLATE");
	return template;
}
