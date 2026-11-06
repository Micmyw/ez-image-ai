import type { PetEffectId, PetEffectTemplate } from "../../pet-effect-template";
import { SHORT_EFFECTS } from "../../short-effects";
import { greenBoothFixture } from "./green-booth";

export function petEffectFixture(id: PetEffectId): PetEffectTemplate {
	const base = `https://media.example.com/${id}/`;
	return {
		...greenBoothFixture,
		revision: SHORT_EFFECTS[id].revision,
		prompt:
			"Private pet fixture. Preserve the uploaded animal and follow the original action effects.",
		sceneImageUrl: `${base}scene.png`,
		poseImageUrl: `${base}action.png`,
		endPoseImageUrl: "",
		referenceAudioUrl: `${base}original.wav`,
		previewUrl: `${base}example.mp4`,
		posterUrl: `${base}poster.webp`,
		sourceVideoUrl: `${base}source.mp4`,
		exampleDurationSeconds: SHORT_EFFECTS[id].duration,
		additionalExamples:
			id === "kung-fu-cat-ai"
				? [
						{
							label: "Cat",
							video: `${base}cat.mp4`,
							poster: `${base}cat.webp`,
							durationSeconds: 14,
							aspectRatio: "9:16",
							kind: "provided",
						},
					]
				: [],
	};
}
