/** Consumer credits, observed on RapDuo 2026-10-26. Never supplier credits. */
export const RAP_PRICING_VERSION = "rap-2026-10-26";
export const RAP_MODEL_IDS = [
	"seedance-2-mini",
	"seedance-2-fast",
	"seedance-2",
	"seedance-2-5",
] as const;
export type RapModelId = (typeof RAP_MODEL_IDS)[number];
export const RAP_DURATIONS = [5, 8, 10, 12, 15] as const;
export const RAP_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export type RapSaleResolution = (typeof RAP_RESOLUTIONS)[number];
type Quotes = readonly [number, number, number, number, number];
export type RapModel = {
	id: RapModelId;
	tier: "Standard" | "Fast" | "Pro" | "Ultra";
	name: string;
	prices: Partial<Record<RapSaleResolution, Quotes>>;
};
export const RAP_MODELS: readonly RapModel[] = [
	{
		id: "seedance-2-mini",
		tier: "Standard",
		name: "Seedance 2.0 Mini",
		prices: {
			"480p": [3, 4, 5, 5, 7],
			"720p": [5, 7, 9, 10, 13],
		},
	},
	{
		id: "seedance-2-fast",
		tier: "Fast",
		name: "Seedance 2.0 Fast",
		prices: {
			"480p": [4, 6, 7, 8, 10],
			"720p": [8, 12, 15, 17, 22],
		},
	},
	{
		id: "seedance-2",
		tier: "Pro",
		name: "Seedance 2.0",
		prices: {
			"480p": [5, 7, 9, 10, 13],
			"720p": [9, 14, 17, 20, 25],
			"1080p": [21, 34, 42, 50, 63],
		},
	},
	{
		id: "seedance-2-5",
		tier: "Ultra",
		name: "Seedance 2.5",
		prices: {
			"480p": [8, 12, 15, 17, 22],
			"720p": [16, 25, 31, 37, 47],
			"1080p": [39, 62, 78, 93, 116],
		},
	},
];
export function rapModel(id: RapModelId) {
	return RAP_MODELS.find((model) => model.id === id)!;
}
export function rapResolutions(id: RapModelId) {
	return RAP_RESOLUTIONS.filter((resolution) => rapModel(id).prices[resolution]);
}
export function rapAdaptiveRatio(model: RapModelId, mode: string) {
	return model === "seedance-2-5" && mode === "image";
}
export function validRapSettings(value: {
	modelId: RapModelId;
	mode: string;
	resolution: string;
	duration: number;
	aspectRatio: string;
}) {
	return (
		RAP_DURATIONS.some((duration) => duration === value.duration) &&
		rapResolutions(value.modelId).some((resolution) => resolution === value.resolution) &&
		(rapAdaptiveRatio(value.modelId, value.mode)
			? value.aspectRatio === "adaptive"
			: ["9:16", "1:1", "16:9"].includes(value.aspectRatio))
	);
}
