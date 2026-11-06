import type { GreenBoothTemplate } from "../../green-booth-template";

export const greenBoothFixture: GreenBoothTemplate = {
	revision: "green-booth-h3-v3",
	enabled: true,
	assetsVerified: true,
	prompt:
		"Private fixture: left person raises a hand, right person leads at one stand microphone, both join the ending. Follow the supplied audio for ten seconds.",
	sceneImageUrl: "https://media.example.com/green/scene.png",
	poseImageUrl: "https://media.example.com/green/opening.png",
	endPoseImageUrl: "https://media.example.com/green/ending.png",
	referenceAudioUrl: "https://media.example.com/green/reference.wav",
	previewUrl: "https://media.example.com/green/example.mp4",
	posterUrl: "https://media.example.com/green/poster.webp",
	sourceVideoUrl: "https://media.example.com/green/source.mp4",
	exampleDurationSeconds: 10.041667,
	exampleKind: "provided",
	rightsManifest:
		"User supplied the sample and authorized direct use. References were edited from the sample.",
	referenceFrames: [
		{
			name: "Opening",
			timestampSeconds: 1,
			url: "https://media.example.com/green/frame.png",
		},
	],
	documents: [{ name: "analysis.md", content: "Private source analysis." }],
};
