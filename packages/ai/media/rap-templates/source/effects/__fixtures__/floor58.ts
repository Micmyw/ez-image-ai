import { FLOOR58_REVISION } from "../../fifty-eighth-floor";
import type { Floor58Template } from "../../floor58-template";
import prompts from "../templates/floor58-h3-v1.json";

export const floor58Fixture: Floor58Template = {
	revision: FLOOR58_REVISION,
	enabled: true,
	prompts,
	sceneImageUrl: "https://media.example.com/effects/58th-floor/references/scene-clean.png",
	poseImageUrl: "https://media.example.com/effects/58th-floor/references/h3-01-duo-pose.png",
	closeupImageUrl:
		"https://media.example.com/effects/58th-floor/references/h3-02-right-closeup.png",
	referenceAudioUrl: "https://media.example.com/effects/58th-floor/reference-audio-15s.wav",
	posterUrl: "https://media.example.com/effects/58th-floor/duo-example.webp",
	previewUrl: "https://media.example.com/effects/58th-floor/duo-example.mp4",
	sourceVideoUrl: "https://media.example.com/effects/58th-floor/source.mp4",
	referenceFrames: [],
	documents: [{ name: "analysis.md", content: "Internal analysis" }],
};
